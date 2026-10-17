import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { readFile, realpath, lstat, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  GatewayClient,
  GatewayClientOptions,
  GatewayClientRequestOptions,
  DeviceIdentity,
} from '@openclaw/gateway-client';
import { z } from 'zod';
import type { Account } from '../../shared/types.js';
import { version } from '../../shared/version.js';
import { assert } from '../errors.js';
import { credentialValue, type CredentialMaterial } from '../credentials.js';
import { findBinary } from './discovery.js';
import { acquireProfileLease } from './profile-lease.js';

const exec = promisify(execFile);
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const openClawVersion = '2026.10.4';
export type OpenClawEvent = Parameters<NonNullable<GatewayClientOptions['onEvent']>>[0];
type Hello = Parameters<NonNullable<GatewayClientOptions['onHelloOk']>>[0];
export interface OpenClawConnection {
  readonly pid?: number;
  readonly exited: boolean;
  readonly signal: AbortSignal;
  readonly hello: Hello;
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayClientRequestOptions,
  ): Promise<T>;
  onEvent(listener: (event: OpenClawEvent) => void): () => void;
  /** A receipt for the actual native process exit, after its own cleanup budget. */
  stop(): Promise<{ clean: boolean }>;
}
export type OpenClawFactory = (
  account: Account,
  cwd: string,
  credentials?: CredentialMaterial,
) => Promise<OpenClawConnection>;

/** A dedicated native execution profile. Other accounts' ambient provider keys are excluded. */
export function openClawEnvironment(
  account: Account,
  credentials?: CredentialMaterial,
): NodeJS.ProcessEnv {
  assert(account.nativeHome, 409, 'Choose an explicit native OpenClaw execution profile.');
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    OPENCLAW_HOME: account.nativeHome,
    OPENCLAW_STATE_DIR: account.nativeHome,
    OPENCLAW_CONFIG_PATH: join(account.nativeHome, 'openclaw.json'),
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_DISABLE_BONJOUR: '1',
    // The embedding role is a native control-plane worker, not a second channel supervisor.
    OPENCLAW_SKIP_CHANNELS: '1',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  });
  if (account.credentialEnv) {
    assert(
      !/^(PATH|HOME|CODEX_HOME|XDG_|OPENCLAW_|FORGE_|TMP|TEMP|SystemRoot|COMSPEC)/i.test(
        account.credentialEnv,
      ),
      409,
      'Choose a provider credential variable, not a native runtime setting.',
    );
    assert(
      credentialValue(account, account.credentialEnv, credentials),
      409,
      `Set ${account.credentialEnv} before launching.`,
    );
    env[account.credentialEnv] = credentialValue(account, account.credentialEnv, credentials);
  }
  return env;
}

export async function openClawInstallation(env: NodeJS.ProcessEnv) {
  const candidate = process.env.FORGE_OPENCLAW_BINARY ?? (await findBinary('openclaw'));
  assert(
    candidate && isAbsolute(candidate),
    409,
    'Install OpenClaw, or set FORGE_OPENCLAW_BINARY to its absolute native openclaw.mjs path.',
  );
  const binary = await realpath(candidate);
  const metadata = JSON.parse(await readFile(join(dirname(binary), 'package.json'), 'utf8'));
  assert(
    metadata.name === 'openclaw' && metadata.version === openClawVersion && binary.endsWith('.mjs'),
    409,
    `This adapter requires the evaluated native OpenClaw ${openClawVersion} installation.`,
  );
  const node = process.env.FORGE_OPENCLAW_NODE ?? process.execPath;
  assert(
    isAbsolute(node),
    409,
    'FORGE_OPENCLAW_NODE must be an absolute native Node.js executable.',
  );
  const result = await exec(node, ['-p', 'process.versions.node'], {
    env,
    timeout: 10000,
    maxBuffer: 1024,
  });
  const [major, minor] = result.stdout.trim().split('.').map(Number);
  assert(
    (major === 24 && minor >= 16) || (major === 26 && minor >= 1),
    409,
    'OpenClaw requires native Node.js 24.16+ or 26.1+. Set FORGE_OPENCLAW_NODE when Forge uses another version.',
  );
  return { binary, node };
}
type Installation = Awaited<ReturnType<typeof openClawInstallation>>;
async function nativeJson(installation: Installation, env: NodeJS.ProcessEnv, args: string[]) {
  const result = await exec(installation.node, [installation.binary, ...args, '--json'], {
    env,
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
  }).catch(() => {
    throw new Error(
      'Native OpenClaw configuration could not be verified. Use its native setup for this execution profile.',
    );
  });
  return JSON.parse(result.stdout) as unknown;
}
export async function assertOpenClawExecutionProfile(
  installation: Installation,
  env: NodeJS.ProcessEnv,
) {
  const agents = (await nativeJson(installation, env, ['config', 'get', 'agents'])) as {
    defaults?: { heartbeat?: { every?: string } };
    list?: { heartbeat?: { every?: string } }[];
  };
  const cron = (await nativeJson(installation, env, ['config', 'get', 'cron'])) as {
    enabled?: boolean;
  };
  const gateway = (await nativeJson(installation, env, ['config', 'get', 'gateway'])) as {
    mode?: string;
    reload?: { mode?: string };
  };
  assert(
    cron.enabled === false &&
      agents.defaults?.heartbeat?.every === '0m' &&
      (agents.list ?? []).every(
        (agent) => !agent.heartbeat?.every || agent.heartbeat.every === '0m',
      ) &&
      gateway.mode === 'local' &&
      gateway.reload?.mode === 'off',
    409,
    'Use a dedicated native OpenClaw execution profile: local Gateway, reload off, cron disabled, and heartbeat every 0m. Existing companion schedules and channels retain their native owner.',
  );
}

const identitySchema = z.object({
  version: z.literal(1),
  cleanExit: z.boolean(),
  device: z.object({
    deviceId: z.string().regex(/^[a-f0-9]{64}$/),
    publicKeyPem: z.string().max(2048),
    privateKeyPem: z.string().max(4096),
  }),
});
type ProfileIdentity = z.infer<typeof identitySchema>;
function rawPublicKey(pem: string) {
  const key = createPublicKey(pem);
  assert(key.asymmetricKeyType === 'ed25519', 409, 'Invalid Forge OpenClaw device key.');
  const raw = key.export({ format: 'jwk' }).x;
  assert(raw, 409, 'Invalid Forge OpenClaw public key.');
  return raw;
}
export function newOpenClawIdentity(): ProfileIdentity {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = createHash('sha256')
    .update(Buffer.from(rawPublicKey(publicKeyPem), 'base64url'))
    .digest('hex');
  return { version: 1, cleanExit: true, device: { deviceId, publicKeyPem, privateKeyPem } };
}
function validateIdentity(value: unknown): ProfileIdentity {
  const identity = identitySchema.parse(value);
  const raw = rawPublicKey(identity.device.publicKeyPem);
  assert(
    rawPublicKey(identity.device.privateKeyPem) === raw &&
      createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex') ===
        identity.device.deviceId,
    409,
    'The Forge OpenClaw device identity does not match its key pair.',
  );
  return identity;
}
async function saveIdentity(filename: string, identity: ProfileIdentity) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function profileIdentity(root: string, installation: Installation, env: NodeJS.ProcessEnv) {
  const filename = join(root, '.forge-openclaw.json');
  const stat = await lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat) {
    assert(
      stat.isFile() && !stat.isSymbolicLink() && stat.size < 16384 && (stat.mode & 0o077) === 0,
      409,
      'Forge OpenClaw identity must be a private regular file.',
    );
    const identity = validateIdentity(JSON.parse(await readFile(filename, 'utf8')));
    assert(
      identity.cleanExit,
      409,
      'This OpenClaw profile has an unconfirmed native exit. Reconcile native work before resetting the Forge ownership receipt.',
    );
    return { filename, identity };
  }
  const sessions = (await nativeJson(installation, env, [
    'sessions',
    '--all-agents',
    '--limit',
    '1',
  ])) as { count?: number; sessions?: unknown[] };
  assert(
    sessions.count === 0 && Array.isArray(sessions.sessions) && sessions.sessions.length === 0,
    409,
    'Initial managed OpenClaw attachment requires an empty dedicated native session profile. Existing native sessions retain their original owner.',
  );
  const identity = newOpenClawIdentity();
  await writeFile(filename, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  return { filename, identity };
}
async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** Supervise the installed native CLI; the official SDK owns framing, auth and correlation. */
export async function openClawWorker(
  account: Account,
  cwd: string,
  credentials?: CredentialMaterial,
): Promise<OpenClawConnection> {
  const env = openClawEnvironment(account, credentials);
  const installation = await openClawInstallation(env);
  const release = await acquireProfileLease(account.nativeHome);
  let handedOff = false;
  try {
    await assertOpenClawExecutionProfile(installation, env);
    const { identity, filename } = await profileIdentity(account.nativeHome, installation, env);
    const port = await unusedPort();
    const token = randomBytes(32).toString('hex');
    const { GatewayClient, isGatewayProtocolResponseError } =
      await import('@openclaw/gateway-client');
    identity.cleanExit = false;
    await saveIdentity(filename, identity);
    const child = spawn(
      installation.node,
      [
        installation.binary,
        'gateway',
        'run',
        '--port',
        String(port),
        '--bind',
        'loopback',
        '--auth',
        'token',
        '--tailscale',
        'off',
      ],
      {
        cwd,
        env: { ...env, OPENCLAW_GATEWAY_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    // Diagnostics are private and bounded; never return native logs or bootstrap credentials.
    child.stdout?.resume();
    child.stderr?.resume();
    let exited = false;
    const exit = new Promise<{ clean: boolean }>((resolve) => {
      child.once('exit', (code, signal) => {
        exited = true;
        resolve({ clean: code === 0 && signal === null });
      });
      child.once('error', () => {
        if (!child.pid) {
          exited = true;
          resolve({ clean: false });
        }
      });
    });
    const lost = new AbortController();
    const listeners = new Set<(event: OpenClawEvent) => void>();
    let client: GatewayClient;
    let authenticated = false;
    let stopping: Promise<{ clean: boolean }> | null = null;
    const ready = deferred<Hello>();
    const lose = () => {
      lost.abort();
      client?.stop();
    };
    const stop = () =>
      (stopping ??= (async () => {
        lost.abort();
        await client?.stopAndWait().catch(() => {});
        if (!exited) child.kill('SIGTERM');
        // Native v2026.10.4 advertises a 330-second shutdown/accepted-command cleanup budget.
        const timer = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, 335000);
        try {
          const receipt = await exit;
          identity.cleanExit = receipt.clean;
          await saveIdentity(filename, identity);
          return receipt;
        } finally {
          clearTimeout(timer);
          release();
        }
      })());
    const timer = setTimeout(
      () =>
        ready.reject(
          new Error(
            'Native OpenClaw did not become ready. Inspect this dedicated profile through OpenClaw.',
          ),
        ),
      30000,
    );
    try {
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        minProtocol: 4,
        maxProtocol: 4,
        clientName: 'cli',
        mode: 'cli',
        clientDisplayName: 'Forge',
        clientVersion: version,
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.approvals'],
        caps: ['tool-events', 'exec-approvals'],
        deviceIdentity: identity.device as DeviceIdentity,
        hostDeps: {
          signDevicePayload: (pem, payload) =>
            sign(null, Buffer.from(payload), pem).toString('base64url'),
          publicKeyRawBase64UrlFromPem: rawPublicKey,
        },
        onHelloOk: (hello) => {
          if (authenticated) lose();
          else {
            authenticated = true;
            ready.resolve(hello);
          }
        },
        onConnectError: () => {},
        onClose: (_code, _reason, info) => {
          if (authenticated || info?.phase === 'post-hello') lose();
        },
        onGap: lose,
        onEvent: (event) => {
          if (event.event === 'shutdown') lose();
          if (!lost.signal.aborted) for (const listener of listeners) listener(event);
        },
      });
      client.start();
      const hello = await Promise.race([
        ready.promise,
        exit.then(() => {
          throw new Error('The owned native OpenClaw Gateway exited during startup.');
        }),
      ]);
      assert(
        hello.protocol === 4 &&
          hello.server.version === openClawVersion &&
          !lost.signal.aborted &&
          !exited,
        409,
        'OpenClaw did not confirm the evaluated native Gateway contract. No input was sent.',
      );
      const methods = hello.features.methods;
      for (const required of [
        'sessions.create',
        'sessions.patch',
        'chat.history',
        'agent',
        'chat.abort',
        'exec.approval.list',
        'exec.approval.resolve',
      ])
        assert(
          methods.includes(required),
          409,
          'OpenClaw is missing a required native execution capability. No input was sent.',
        );
      const anonymous = deferred<void>();
      const unauthenticated = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: randomBytes(32).toString('hex'),
        minProtocol: 4,
        maxProtocol: 4,
        clientName: 'cli',
        mode: 'cli',
        role: 'operator',
        scopes: ['operator.read'],
        deviceIdentity: newOpenClawIdentity().device,
        hostDeps: {
          signDevicePayload: (pem, payload) =>
            sign(null, Buffer.from(payload), pem).toString('base64url'),
          publicKeyRawBase64UrlFromPem: rawPublicKey,
        },
        onHelloOk: () =>
          anonymous.reject(
            new Error('OpenClaw accepted an unauthenticated client. No input was sent.'),
          ),
        onConnectError: (error) => {
          const code = isGatewayProtocolResponseError(error)
            ? (error.details as { code?: string } | undefined)?.code
            : undefined;
          if (code === 'AUTH_TOKEN_MISMATCH') anonymous.resolve();
          else
            anonymous.reject(
              new Error(
                'OpenClaw authentication rejection could not be verified. No input was sent.',
              ),
            );
        },
      });
      const anonymousTimer = setTimeout(
        () => anonymous.reject(new Error('OpenClaw anonymous authentication check timed out.')),
        5000,
      );
      try {
        unauthenticated.start();
        await anonymous.promise;
      } finally {
        clearTimeout(anonymousTimer);
        await unauthenticated.stopAndWait();
      }
      assert(
        !lost.signal.aborted && !exited,
        502,
        'Owned OpenClaw transport changed during authentication checks.',
      );
      handedOff = true;
      return {
        pid: child.pid,
        get exited() {
          return exited;
        },
        signal: lost.signal,
        hello,
        request: (method, params, options) => {
          assert(
            !lost.signal.aborted && !exited && client.connected,
            502,
            'OpenClaw transport was lost. No request was replayed.',
          );
          return client.request(method, params, {
            timeoutMs: 10000,
            ...options,
            signal: AbortSignal.any([lost.signal, ...(options?.signal ? [options.signal] : [])]),
          });
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        stop,
      };
    } catch (error) {
      await stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (!handedOff) release();
  }
}

/** Native setup validation only: status checks never start a Gateway or activate a turn. */
export async function probeOpenClawAccount(
  account: Account,
  credentials?: CredentialMaterial,
): Promise<Account> {
  const env = openClawEnvironment(account, credentials);
  const installation = await openClawInstallation(env);
  await assertOpenClawExecutionProfile(installation, env);
  return {
    ...account,
    state: 'configured',
    identity: null,
    identityKey: null,
    quotas: [],
    plan: 'Native OpenClaw execution profile; provider identity and allowance unknown',
    checkedAt: new Date().toISOString(),
    error: null,
  };
}
