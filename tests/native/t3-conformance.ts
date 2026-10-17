import assert from 'node:assert/strict';
import { spawn, execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, open, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { T3Connections } from '../../server/t3.js';
import { Store } from '../../server/store.js';
import { NativeSources } from '../../server/native-sources.js';
import { findBinary } from '../../server/adapters/discovery.js';
import { processTable, type ProcessObservation } from '../../server/processes.js';

const exec = promisify(execCallback);
const binary = process.env.FORGE_T3_BINARY ?? (await findBinary('t3'));
assert(
  binary && isAbsolute(binary),
  'Set FORGE_T3_BINARY to an existing native T3 Code CLI. This check never installs one.',
);
assert(
  process.platform !== 'win32',
  'This native process check currently requires macOS or Linux.',
);
const directory = await mkdtemp(join(tmpdir(), 'forge-t3-conformance-'));
const home = join(directory, 'home');
const data = join(directory, 't3');
const cwd = join(directory, 'project');
await mkdir(home);
await mkdir(cwd);
await writeFile(join(cwd, 'README.md'), '# Isolated Forge T3 conformance\n');
const env: NodeJS.ProcessEnv = {
  HOME: home,
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  TMPDIR: directory,
  T3CODE_TELEMETRY_ENABLED: 'false',
  DO_NOT_TRACK: '1',
  CODEX_HOME: join(home, 'codex'),
  CLAUDE_CONFIG_DIR: join(home, 'claude'),
  HERMES_HOME: join(home, 'hermes'),
  OPENCLAW_HOME: join(home, 'openclaw'),
  OPENCODE_DATA_DIR: join(home, 'opencode'),
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'),
  XDG_CACHE_HOME: join(home, 'cache'),
};
const cli = (args: string[]) =>
  exec(binary, [...args, '--base-dir', data], { env, cwd, timeout: 20000, maxBuffer: 1024 * 1024 });
const socket = createServer();
await new Promise<void>((done) => socket.listen(0, '127.0.0.1', done));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((done) => socket.close(() => done()));
const origin = `http://127.0.0.1:${port}`;
const log = await open(join(directory, 'native.log'), 'wx', 0o600);
const store = new Store(join(directory, 'forge.sqlite'));
const manager = new T3Connections(store, directory);
const sources = new NativeSources(store, { t3Reader: (source) => manager.read(source) });
let child: ReturnType<typeof spawn> | undefined;
let exited = false;
let forced = false;
let stage = 'native CLI';
let success = false;
const report: Record<string, unknown> = {
  submittedModelTasks: 0,
  providerKeysSupplied: 0,
  modelTraffic: 'Not instrumented; no provider task requested.',
};
let observed: ProcessObservation[] = [];
const nativeClient = async (token: string) => {
  const client = new Client({ name: 'Isolated Forge conformance', version: '0.13.0' });
  const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
};
try {
  report.nativeVersion = (await exec(binary, ['--version'], { env, timeout: 20000 })).stdout.trim();
  const pairing = (
    JSON.parse(
      (await cli(['auth', 'pairing', 'create', '--scope', 'orchestration:read', '--json'])).stdout,
    ) as { credential: string }
  ).credential;
  assert(pairing && !pairing.includes('\n'), 'Native pairing output must be a single credential.');
  child = spawn(
    binary,
    ['serve', '--base-dir', data, '--host', '127.0.0.1', '--port', String(port), '--no-browser'],
    { env, cwd, stdio: ['ignore', log.fd, log.fd] },
  );
  child.once('exit', () => {
    exited = true;
  });
  stage = 'native readiness';
  let ready = false;
  for (let index = 0; index < 80; index++) {
    assert(!exited, 'Native T3 exited before readiness.');
    try {
      if (
        (
          await fetch(origin + '/.well-known/oauth-authorization-server', {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  assert(ready, 'Native T3 did not become ready.');
  stage = 'native OAuth consent and PKCE';
  const flow = await manager.begin(
    { endpoint: origin, label: 'Native T3 conformance' },
    'http://127.0.0.1:4710/api/native/t3/callback',
  );
  const authorization = Object.fromEntries(new URL(flow.authorizationUrl).searchParams);
  const approval = await fetch(origin + '/oauth/mcp/decision', {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authorization,
      decision: { _tag: 'pairing-code', access: 'read-only', code: pairing },
    }),
    signal: AbortSignal.timeout(8000),
  });
  assert(approval.ok, `Native OAuth approval returned HTTP ${approval.status}.`);
  const decision = (await approval.json()) as { redirectTo: string };
  const callback = new URL(decision.redirectTo);
  assert(callback.searchParams.get('code'), 'Native consent did not return an authorization code.');
  const source = await manager.finish(
    callback.searchParams.get('state')!,
    callback.searchParams.get('code')!,
    callback.searchParams.get('iss')!,
  );
  const credential = JSON.parse(
    await readFile(join(directory, `.forge-t3-${source.id}.json`), 'utf8'),
  ) as { tokens: { access_token: string; scope: string } };
  assert.equal(credential.tokens.scope, 'orchestration:read');
  report.oauthPkce = 'native read-only grant completed';
  stage = 'native read-only mutation denial';
  const readonly = await nativeClient(credential.tokens.access_token);
  try {
    const deniedPath = join(directory, 'must-not-exist');
    let denied = false;
    try {
      const result = await readonly.client.callTool({
        name: 't3_project_create',
        arguments: {
          title: 'Must be denied',
          workspaceRoot: deniedPath,
          createWorkspaceRootIfMissing: true,
        },
      });
      denied =
        result.isError === true ||
        /capability_denied|read.only/i.test(
          JSON.stringify(result.structuredContent ?? result.content),
        );
    } catch {
      denied = true;
    }
    assert(denied, 'Native read-only credentials must reject project creation.');
    await assert.rejects(access(deniedPath));
  } finally {
    await readonly.close();
  }
  report.mutationDenied = true;
  stage = 'native project metadata';
  // Native project management remains with T3's own CLI; Forge receives only a read grant.
  await cli(['project', 'add', cwd, '--title', 'Native isolated project']);
  const inventory = await sources.refresh(source.id);
  assert.equal(
    inventory.projects,
    1,
    'Native project metadata must cross the actual MCP boundary.',
  );
  assert.equal(inventory.sessions.length, 0, 'No native agent task was submitted.');
  report.inventory = {
    projectsRead: inventory.projects,
    threads: inventory.sessions.length,
    schedulesImported: inventory.schedules.length,
  };
  // This is a short headless diagnostic trace, not a whole-stack or UI performance benchmark.
  stage = 'headless diagnostic trace';
  const trace: { rss: number; cpuPercent: number; processes: number }[] = [];
  for (let index = 0; index < 6; index++) {
    const table = await processTable();
    assert(table, 'Native OS process metadata is required for this trace.');
    observed = table.filter((row) => row.pid === child!.pid || row.parentPid === child!.pid);
    assert(
      observed.some((row) => row.pid === child!.pid),
      'The native server root must remain observable.',
    );
    trace.push({
      rss: observed.reduce((total, row) => total + row.rss, 0),
      cpuPercent: observed.reduce((total, row) => total + row.cpuPercent, 0),
      processes: observed.length,
    });
    await new Promise((done) => setTimeout(done, 1000));
  }
  report.headlessTrace = {
    samples: trace,
    intervalMs: 1000,
    coverage: 'native server root and direct children; no UI or agent worker',
  };
  stage = 'native revocation';
  const listed = JSON.parse((await cli(['auth', 'session', 'list', '--json'])).stdout) as unknown;
  const sessions = (
    Array.isArray(listed) ? listed : (listed as { sessions: unknown[] }).sessions
  ) as { id?: string; sessionId?: string; subject: string; scopes: string[] }[];
  const grant = sessions.find(
    (session) =>
      session.subject === 'mcp-client' &&
      session.scopes.includes('orchestration:read') &&
      !session.scopes.includes('orchestration:operate'),
  );
  assert(
    grant && (grant.sessionId || grant.id),
    'The native OAuth grant must remain identifiable for revocation.',
  );
  await cli(['auth', 'session', 'revoke', (grant.sessionId || grant.id)!]);
  await assert.rejects(sources.refresh(source.id));
  assert.equal(sources.list()[0].checkedAt, inventory.checkedAt);
  assert.equal(sources.list()[0].state, 'error');
  await manager.forget(source);
  report.revocation = 'native grant revoked; prior observation retained; local credential removed';
  success = true;
} catch (error) {
  await writeFile(
    join(directory, 'failure.log'),
    String(
      (error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : error),
    ),
    { mode: 0o600 },
  );
  console.error(
    `Native T3 check failed during ${stage}: ${error instanceof Error ? error.name : 'unknown failure'}.`,
  );
  console.error(`Private synthetic diagnostics retained in ${directory}`);
  process.exitCode = 1;
} finally {
  await manager.close();
  store.close();
  if (child && !exited) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((done) => child!.once('exit', () => done())),
      new Promise((done) => setTimeout(done, 15000)),
    ]);
    if (!exited) {
      forced = true;
      child.kill('SIGKILL');
      await new Promise((done) => child!.once('exit', done));
    }
  }
  await log.close();
  if (success) {
    assert(!forced && exited, 'The isolated native service must exit gracefully.');
    const remaining = await processTable();
    assert(
      remaining &&
        observed.every(
          (old) =>
            !remaining.some(
              (row) =>
                row.pid === old.pid && row.startedAt === old.startedAt && row.uid === old.uid,
            ),
        ),
      'The observed native root and collector must exit.',
    );
    report.exit = 'native root and observed collector exit confirmed';
    const output = resolve('artifacts/t3code-evaluation/native-conformance.json');
    await mkdir(resolve('artifacts/t3code-evaluation'), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await rm(directory, { recursive: true, force: true });
    console.log(
      'Native T3 OAuth/PKCE, read-only denial, project metadata, revocation, observation retention and native exit pass; zero model tasks.',
    );
    console.log(
      'Headless diagnostic trace saved in artifacts/t3code-evaluation/native-conformance.json.',
    );
  }
}
