import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import type { BackgroundRuntime } from '../shared/types.js';
import { phoneConfig, type PhoneConfig } from './phone.js';
import { assert } from './errors.js';

const exec = promisify(execFile);
const receiptName = '.forge-service.json';
const nativeOverrides = ['FORGE_HERMES_PYTHON', 'FORGE_OPENCLAW_BINARY', 'FORGE_OPENCLAW_NODE'];
let runtime: BackgroundRuntime = { mode: 'foreground' };
export const backgroundRuntime = () => runtime;
export const defaultDataDirectory = () =>
  process.env.FORGE_DATA_DIR ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Forge')
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? homedir(), 'Forge')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'forge'));

export interface ServiceReceipt {
  version: 1;
  configurationHash: string;
  id: string;
  label: string;
  dataDirectory: string;
  agentDirectory: string;
  node: string;
  runner: string;
  root: string;
  port: number;
  phone: PhoneConfig | null;
  environment: Record<string, string>;
}
export interface ServiceContext {
  platform: string;
  uid: number;
  home: string;
  root: string;
  agentDirectory: string;
  control: (args: string[]) => Promise<string | null>;
  settleTimeoutMs?: number;
}
export interface ServiceOptions {
  dataDirectory: string;
  port?: number;
  phone?: PhoneConfig | null;
  environment?: NodeJS.ProcessEnv;
}
export interface ServiceStatus {
  state: 'not-installed' | 'installed' | 'starting' | 'running' | 'stopping' | 'unverified';
  label?: string;
  url?: string;
  version?: string;
  pid?: number;
  scope?: 'user-login';
}
async function nativeControl(args: string[]) {
  try {
    return (
      await exec('/bin/launchctl', args, {
        timeout: 8000,
        maxBuffer: 256 * 1024,
        env: { HOME: homedir(), PATH: '/usr/bin:/bin', LANG: 'C' },
      })
    ).stdout;
  } catch (error) {
    const e = error as { code?: number; stderr?: string };
    if (args[0] === 'print' && e.code === 113 && /Could not find service/.test(e.stderr ?? ''))
      return null;
    throw new Error(
      'Native service control failed. Check the current macOS login session and service status before retrying.',
    );
  }
}
export function serviceContext(overrides: Partial<ServiceContext> = {}): ServiceContext {
  const home = overrides.home ?? homedir();
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    home,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    agentDirectory: process.env.FORGE_SERVICE_AGENT_DIR ?? join(home, 'Library', 'LaunchAgents'),
    control: nativeControl,
    ...overrides,
  };
}
function supported(c: ServiceContext) {
  assert(
    pathValue(c.agentDirectory),
    400,
    'Select an absolute native service definition directory.',
  );
  assert(
    c.platform === 'darwin' && c.uid > 0,
    409,
    'Background service control currently supports macOS user login sessions. Run Forge in the foreground on this platform.',
  );
}
function pathValue(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
}
function labelFor(directory: string) {
  return `org.forgeworkspace.forge.${createHash('sha256').update(directory).digest('hex').slice(0, 20)}`;
}
const plistPath = (r: ServiceReceipt) => join(r.agentDirectory, `${r.label}.plist`);
const target = (r: ServiceReceipt, c: ServiceContext) => `gui/${c.uid}/${r.label}`;
function configurationHash(r: ServiceReceipt) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: r.version,
        id: r.id,
        label: r.label,
        dataDirectory: r.dataDirectory,
        agentDirectory: r.agentDirectory,
        node: r.node,
        runner: r.runner,
        root: r.root,
        port: r.port,
        phone: r.phone,
        environment: Object.fromEntries(
          Object.entries(r.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      }),
    )
    .digest('hex');
}
function xml(value: string) {
  assert(
    !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value),
    400,
    'Service settings contain unsupported control characters.',
  );
  return value.replace(
    /[&<>"']/g,
    (v) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[v]!,
  );
}
export function servicePlist(r: ServiceReceipt) {
  const args = [
    r.node,
    r.runner,
    join(r.dataDirectory, receiptName),
    r.id,
    r.agentDirectory,
    r.configurationHash,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(r.label)}</string>
<key>ProgramArguments</key><array>${args.map((v) => `<string>${xml(v)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(r.root)}</string>
<key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string></string><key>NODE_PATH</key><string></string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>360</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(r.dataDirectory, '.forge-service.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(r.dataDirectory, '.forge-service.stderr.log'))}</string>
</dict></plist>
`;
}
async function privateRead(filename: string, uid: number) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() && stat.uid === uid && (stat.mode & 0o077) === 0 && stat.size <= 65536,
      409,
      'The service file must be a private, user-owned regular file. No service action was taken.',
    );
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
async function directory(value: string, c: ServiceContext, create = false) {
  assert(
    pathValue(value),
    400,
    'Select an absolute service data directory without control characters.',
  );
  if (create) await mkdir(value, { recursive: true, mode: 0o700 });
  const canonical = await realpath(value);
  const stat = await lstat(canonical);
  assert(
    stat.isDirectory() && stat.uid === c.uid && (stat.mode & 0o077) === 0,
    409,
    'The service data directory must be private and owned by the current user.',
  );
  return canonical;
}
async function receipt(directory: string, c: ServiceContext): Promise<ServiceReceipt | null> {
  let raw;
  try {
    raw = await privateRead(join(directory, receiptName), c.uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let r: ServiceReceipt;
  try {
    r = JSON.parse(raw);
  } catch {
    throw new Error('The service receipt is invalid. Review the installation before changing it.');
  }
  assert(
    r &&
      r.version === 1 &&
      /^[0-9a-f-]{36}$/.test(r.id) &&
      r.dataDirectory === directory &&
      r.label === labelFor(directory) &&
      [r.node, r.runner, r.root, r.agentDirectory].every(pathValue) &&
      r.agentDirectory === resolve(c.agentDirectory) &&
      r.runner === join(r.root, 'bin', 'service-runner.mjs') &&
      Number.isInteger(r.port) &&
      r.port >= 1024 &&
      r.port <= 65535,
    409,
    'The saved service ownership/settings do not match this workspace. No service action was taken.',
  );
  assert(
    r.environment &&
      Object.keys(r.environment).every((k) =>
        ['HOME', 'PATH', 'LANG', ...nativeOverrides].includes(k),
      ) &&
      r.environment.HOME === c.home &&
      Object.values(r.environment).every(
        (v) => typeof v === 'string' && !/[\x00-\x1f\x7f]/.test(v),
      ),
    409,
    'The saved service environment is unsupported. Secrets are not loaded from this file.',
  );
  for (const key of nativeOverrides)
    assert(
      !r.environment[key] || pathValue(r.environment[key]),
      409,
      'Native runtime overrides must be absolute paths.',
    );
  const checked = phoneConfig(
    r.phone
      ? {
          FORGE_PHONE_ORIGIN: r.phone.origin,
          FORGE_PHONE_USERS: r.phone.users.join(','),
          FORGE_PHONE_PORT: String(r.phone.port),
        }
      : {},
    r.port,
  );
  assert(
    JSON.stringify(checked) === JSON.stringify(r.phone),
    409,
    'The phone settings need review before service control.',
  );
  const actual = await privateRead(plistPath(r), c.uid);
  assert(
    typeof r.configurationHash === 'string' &&
      /^[a-f0-9]{64}$/.test(r.configurationHash) &&
      r.configurationHash === configurationHash(r),
    409,
    'The saved service configuration changed. Review the installation before controlling it.',
  );
  assert(
    actual === servicePlist(r),
    409,
    'The native service definition changed. No replacement, stop or deletion was attempted.',
  );
  return r;
}
async function loaded(r: ServiceReceipt, c: ServiceContext) {
  const output = await c.control(['print', target(r, c)]);
  if (output === null) return null;
  const source = output.match(/^\s*path = (.+)$/m)?.[1];
  const program = output.match(/^\s*program = (.+)$/m)?.[1];
  const sourceMatches =
    source && (await realpath(source).catch(() => null)) === (await realpath(plistPath(r)));
  const args =
    output
      .match(/\n[\t ]*arguments = \{\n([\s\S]*?)\n[\t ]*\}/)?.[1]
      .split('\n')
      .map((v) => v.trim()) ?? [];
  const expected = [
    r.node,
    r.runner,
    join(r.dataDirectory, receiptName),
    r.id,
    r.agentDirectory,
    r.configurationHash,
  ];
  assert(
    sourceMatches && program === r.node && JSON.stringify(args) === JSON.stringify(expected),
    409,
    'The native label belongs to a different or unverified service. No control was sent.',
  );
  return { pid: Number(output.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
}
async function health(r: ServiceReceipt) {
  try {
    const response = await fetch(`http://127.0.0.1:${r.port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.service?.installationId === r.id &&
      body.service?.label === r.label &&
      body.service?.mode === 'launchd'
      ? body
      : null;
  } catch {
    return null;
  }
}
function workspaceIdle(r: ServiceReceipt) {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(r.dataDirectory, 'workspace.sqlite'), { readOnly: true });
    db.prepare('PRAGMA user_version').get();
    return true;
  } catch (error) {
    return (
      (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' &&
      /unable to open database file/.test(String((error as Error).message))
    );
  } finally {
    db?.close();
  }
}
async function freePort(port: number) {
  const server = createServer();
  await new Promise<void>((ok, reject) => {
    server.once('error', () =>
      reject(
        new Error(
          'A configured service port is already in use. Stop its current owner before starting Forge.',
        ),
      ),
    );
    server.listen(port, '127.0.0.1', ok);
  });
  await new Promise<void>((ok) => server.close(() => ok()));
}
async function locked<T>(directory: string, action: () => Promise<T>) {
  const filename = join(directory, '.forge-service-control.sqlite');
  const file = await open(
    filename,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const stat = await file.stat();
  await file.close();
  assert(
    stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
    409,
    'The service control lock must be private and user-owned.',
  );
  const db = new DatabaseSync(filename);
  try {
    db.exec(
      'PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE',
    );
    return await action();
  } finally {
    db.close();
  }
}
export async function serviceStatus(
  dataDirectory: string,
  context = serviceContext(),
): Promise<ServiceStatus> {
  supported(context);
  let dir;
  try {
    dir = await directory(dataDirectory, context);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'not-installed' };
    throw error;
  }
  const r = await receipt(dir, context);
  if (!r) return { state: 'not-installed' };
  const native = await loaded(r, context);
  const h = await health(r);
  return {
    state: native
      ? h
        ? native.pid === h.processId
          ? 'running'
          : 'unverified'
        : 'starting'
      : h || !workspaceIdle(r)
        ? 'unverified'
        : 'installed',
    label: r.label,
    url: `http://127.0.0.1:${r.port}`,
    ...(h ? { version: h.version } : {}),
    ...(native?.pid ? { pid: native.pid } : {}),
    scope: 'user-login',
  };
}
async function buildDefinition(
  options: ServiceOptions,
  c: ServiceContext,
  dir: string,
): Promise<ServiceReceipt> {
  const env = options.environment ?? process.env;
  const port = options.port ?? 4710;
  assert(
    Number.isInteger(port) && port >= 1024 && port <= 65535,
    400,
    'The service port must be between 1024 and 65535.',
  );
  const r: ServiceReceipt = {
    version: 1,
    configurationHash: '',
    id: randomUUID(),
    label: labelFor(dir),
    dataDirectory: dir,
    agentDirectory: resolve(c.agentDirectory),
    node: await realpath(process.execPath),
    runner: join(c.root, 'bin', 'service-runner.mjs'),
    root: resolve(c.root),
    port,
    phone: options.phone ?? null,
    environment: {
      HOME: c.home,
      PATH: env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: env.LANG ?? 'en_US.UTF-8',
    },
  };
  for (const key of nativeOverrides)
    if (env[key]) {
      assert(pathValue(env[key]), 400, 'Native runtime overrides must be absolute paths.');
      await access(env[key]);
      r.environment[key] = env[key];
    }
  r.phone = phoneConfig(
    r.phone
      ? {
          FORGE_PHONE_ORIGIN: r.phone.origin,
          FORGE_PHONE_USERS: r.phone.users.join(','),
          FORGE_PHONE_PORT: String(r.phone.port),
        }
      : {},
    port,
  );
  assert(
    Object.values(r.environment).every((v) => !/[\x00-\x1f\x7f]/.test(v)),
    400,
    'The service environment contains unsupported control characters.',
  );
  r.configurationHash = configurationHash(r);
  await access(join(c.root, 'dist', 'server', 'index.js'));
  await access(join(c.root, 'dist', 'client', 'index.html'));
  await access(r.runner);
  return r;
}
export async function prepareService(
  options: ServiceOptions,
  c = serviceContext(),
): Promise<ServiceReceipt> {
  supported(c);
  return buildDefinition(options, c, await directory(options.dataDirectory, c));
}
export async function verifyServiceDefinition(
  value: ServiceReceipt,
  c = serviceContext(),
): Promise<ServiceReceipt> {
  const checked = await prepareService(
    {
      dataDirectory: value.dataDirectory,
      port: value.port,
      phone: value.phone,
      environment: value.environment,
    },
    c,
  );
  assert(/^[0-9a-f-]{36}$/.test(value.id), 409, 'The reviewed service installation ID changed.');
  checked.id = value.id;
  checked.configurationHash = configurationHash(checked);
  assert(
    checked.configurationHash === value.configurationHash,
    409,
    'The reviewed native service configuration changed.',
  );
  return checked;
}
export async function installedServiceDefinition(dataDirectory: string, c = serviceContext()) {
  supported(c);
  return receipt(await directory(dataDirectory, c), c);
}
export async function serviceDefinitionLoaded(definition: ServiceReceipt, c = serviceContext()) {
  supported(c);
  return (await loaded(definition, c)) !== null;
}
export function workspaceAvailable(dataDirectory: string) {
  return workspaceIdle({ dataDirectory } as ServiceReceipt);
}

export async function installService(
  options: ServiceOptions,
  c = serviceContext(),
  reviewed?: ServiceReceipt,
) {
  supported(c);
  const dir = await directory(options.dataDirectory, c, true);
  return locked(dir, async () => {
    assert(
      !(await receipt(dir, c)),
      409,
      'A service is already installed for this workspace. Review its status; uninstall it explicitly before changing configuration.',
    );
    const r = reviewed
      ? await verifyServiceDefinition(reviewed, c)
      : await buildDefinition(options, c, dir);
    assert(
      r.dataDirectory === dir &&
        r.port === (options.port ?? 4710) &&
        JSON.stringify(r.phone) === JSON.stringify(options.phone ?? null),
      409,
      'The reviewed service does not match this workspace configuration.',
    );
    assert(
      (await c.control(['print', target(r, c)])) === null,
      409,
      'The native label is already loaded. No service was overwritten.',
    );
    await mkdir(r.agentDirectory, { recursive: true, mode: 0o700 });
    // Exclusive creation preserves any unrelated definition, even if registration raced.
    const created: string[] = [];
    try {
      for (const log of ['.forge-service.stdout.log', '.forge-service.stderr.log']) {
        const name = join(dir, log);
        try {
          const f = await open(name, 'wx', 0o600);
          await f.close();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const f = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await f.stat();
            assert(
              stat.isFile() && stat.uid === c.uid && (stat.mode & 0o077) === 0,
              409,
              'Existing service logs must remain private user-owned regular files.',
            );
          } finally {
            await f.close();
          }
        }
      }
      for (const [name, content] of [
        [join(dir, receiptName), JSON.stringify(r, null, 2) + '\n'],
        [plistPath(r), servicePlist(r)],
      ]) {
        const f = await open(name, 'wx', 0o600);
        created.push(name);
        try {
          await f.writeFile(content);
        } finally {
          await f.close();
        }
      }
    } catch (error) {
      for (const name of created.reverse()) await unlink(name);
      throw error;
    }
    return {
      state: 'installed',
      label: r.label,
      url: `http://127.0.0.1:${r.port}`,
      scope: 'user-login',
    } as ServiceStatus;
  });
}
async function stopOwned(r: ServiceReceipt, c: ServiceContext): Promise<boolean> {
  const native = await loaded(r, c);
  if (native) await c.control(['bootout', target(r, c)]);
  const deadline = Date.now() + (c.settleTimeoutMs ?? 10000);
  do {
    if (!(await loaded(r, c)) && workspaceIdle(r) && !(await health(r))) return true;
    await new Promise((ok) => setTimeout(ok, 200));
  } while (Date.now() < deadline);
  return false;
}
export async function controlService(
  command: 'start' | 'stop' | 'restart' | 'uninstall',
  dataDirectory: string,
  c = serviceContext(),
): Promise<ServiceStatus> {
  supported(c);
  const dir = await directory(dataDirectory, c);
  return locked(dir, async () => {
    const r = await receipt(dir, c);
    assert(
      r,
      409,
      'No verified service installation exists for this workspace. Run forge service install first.',
    );
    if (command !== 'start') {
      if (!(await stopOwned(r, c)))
        return { state: 'stopping', label: r.label, scope: 'user-login' };
      if (command === 'uninstall') {
        await unlink(plistPath(r));
        await unlink(join(dir, receiptName));
        return { state: 'not-installed' };
      }
      if (command === 'stop') return { state: 'installed', label: r.label, scope: 'user-login' };
    }
    if (await loaded(r, c)) return serviceStatus(dir, c);
    assert(
      workspaceIdle(r),
      409,
      'This workspace still has an active or unconfirmed service owner. Review it before starting another service.',
    );
    await freePort(r.port);
    if (r.phone) await freePort(r.phone.port);
    // The server still takes its native SQLite exclusive lock after these observational checks.
    await c.control(['enable', target(r, c)]);
    await c.control(['bootstrap', `gui/${c.uid}`, plistPath(r)]);
    const deadline = Date.now() + (c.settleTimeoutMs ?? 10000);
    do {
      const status = await serviceStatus(dir, c);
      if (status.state === 'running') return status;
      await new Promise((ok) => setTimeout(ok, 200));
    } while (Date.now() < deadline);
    return {
      state: 'starting',
      label: r.label,
      url: `http://127.0.0.1:${r.port}`,
      scope: 'user-login',
    };
  });
}
export async function launchInstalledService(
  filename: string,
  installationId: string,
  agentDirectory: string,
  expectedConfigurationHash: string,
) {
  assert(pathValue(agentDirectory), 409, 'The native service definition directory did not match.');
  const c = serviceContext({ agentDirectory });
  supported(c);
  const dir = await directory(dirname(filename), c);
  assert(filename === join(dir, receiptName), 409, 'Service runner receipt path did not match.');
  const r = await receipt(dir, c);
  assert(
    r &&
      r.configurationHash === expectedConfigurationHash &&
      r.id === installationId &&
      r.node === (await realpath(process.execPath)) &&
      r.root === resolve(c.root),
    409,
    'The native service runner does not match its installation.',
  );
  // No shell profile, .env file, launchctl provider keys or inherited Node injection is loaded.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, r.environment, {
    FORGE_DATA_DIR: r.dataDirectory,
    FORGE_PORT: String(r.port),
  });
  if (r.phone)
    Object.assign(process.env, {
      FORGE_PHONE_ORIGIN: r.phone.origin,
      FORGE_PHONE_USERS: r.phone.users.join(','),
      FORGE_PHONE_PORT: String(r.phone.port),
    });
  runtime = {
    mode: 'launchd',
    installationId: r.id,
    label: r.label,
    scope: 'user-login',
    definitionDirectory: r.agentDirectory,
  };
  await import('./index.js');
}
export async function runServiceCommand(args: string[]) {
  const command = args.shift();
  assert(
    command && ['install', 'status', 'start', 'stop', 'restart', 'uninstall'].includes(command),
    400,
    'Use forge service install, status, start, stop, restart or uninstall.',
  );
  let dataDirectory = defaultDataDirectory();
  let port = Number(process.env.FORGE_PORT ?? 4710);
  const env = { ...process.env };
  const users: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i],
      value = args[i + 1];
    assert(
      value && !value.startsWith('--'),
      400,
      'A service option needs a value. Run forge --help.',
    );
    if (flag === '--data-dir') dataDirectory = resolve(args[++i]);
    else if (command === 'install' && flag === '--port') port = Number(args[++i]);
    else if (command === 'install' && flag === '--phone-origin') env.FORGE_PHONE_ORIGIN = args[++i];
    else if (command === 'install' && flag === '--phone-port') env.FORGE_PHONE_PORT = args[++i];
    else if (command === 'install' && flag === '--phone-user') users.push(args[++i]);
    else throw new Error('Unknown service option. Run forge --help for supported options.');
  }
  if (users.length) env.FORGE_PHONE_USERS = users.join(',');
  const result =
    command === 'install'
      ? await installService({
          dataDirectory: resolve(dataDirectory),
          port,
          phone: phoneConfig(env, port),
          environment: env,
        })
      : command === 'status'
        ? await serviceStatus(resolve(dataDirectory))
        : await controlService(
            command as 'start' | 'stop' | 'restart' | 'uninstall',
            resolve(dataDirectory),
          );
  console.log(JSON.stringify(result, null, 2));
  if (command === 'install')
    console.log(
      'Installed for the next login. Run forge service start to start now. Provider keys and shell environment were not copied.',
    );
  if (result.state === 'stopping')
    console.log(
      'Native shutdown is still pending. Configuration is retained. Check status before restarting or uninstalling.',
    );
}
