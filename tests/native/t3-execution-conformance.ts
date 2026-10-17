import assert from 'node:assert/strict';
import { spawn, execFile as execCallback, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, open, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findBinary } from '../../server/adapters/discovery.js';
import { createApp } from '../../server/app.js';
import type {
  Account,
  Approval,
  Run,
  Work,
  WorkspaceBackend,
  Snapshot,
} from '../../shared/types.js';
import { processTable, type ProcessObservation } from '../../server/processes.js';
import { fixtureProvider } from './provider.js';
import { T3Backends } from '../../server/backends/t3-backend.js';
import { t3Projection } from '../../server/backends/t3-contract.js';

const exec = promisify(execCallback);
const binary = process.env.FORGE_T3_BINARY ?? (await findBinary('t3'));
const codex = process.env.FORGE_T3_CODEX_BINARY ?? (await findBinary('codex'));
assert(
  binary && isAbsolute(binary) && codex,
  'Set FORGE_T3_BINARY to a native protocol-2 T3 CLI and install Codex. Nothing is installed by this test.',
);
const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-t3-execution-')));
const home = join(root, 'home'),
  data = join(root, 't3'),
  cwd = join(root, 'project'),
  nativeHome = join(home, 'codex');
for (const folder of [home, join(data, 'userdata'), cwd, nativeHome])
  await mkdir(folder, { recursive: true });
let toolSent = false,
  secondToolSent = false,
  crashToolSent = false,
  phase = 1;
let expectedKey = 'synthetic-slot-one';
let historyRetained = false;
const provider = await fixtureProvider(
  'responses',
  (body) => {
    if (phase === 3 && !crashToolSent) {
      crashToolSent = true;
      return {
        tool: 'exec_command',
        id: 'forge_t3_crash_call',
        input: { cmd: "printf 'MUST-NOT-RUN\\n' > should-not-exist.txt", max_output_tokens: 100 },
      };
    }
    if (phase === 2 && !secondToolSent) {
      historyRetained = JSON.stringify(body.input).includes(
        'Native Forge execution conformance complete.',
      );
      assert(
        historyRetained,
        'The compatible native continuation must retain the preceding assistant message.',
      );
      secondToolSent = true;
      return {
        tool: 'exec_command',
        id: 'forge_t3_second_call',
        input: {
          cmd: "test $(cat phase-one.txt) = FORGE-WORKSPACE-PROOF && printf 'SECOND-ACCOUNT-PROOF\\n' > phase-two.txt",
          max_output_tokens: 100,
        },
      };
    }
    if (
      !toolSent &&
      JSON.stringify(body.input).includes('FORGE_EXEC_PROBE') &&
      body.tools?.some((tool: { name: string }) => tool.name === 'exec_command')
    ) {
      toolSent = true;
      return {
        tool: 'exec_command',
        id: 'forge_t3_native_call',
        input: { cmd: "printf 'FORGE-WORKSPACE-PROOF\\n' > phase-one.txt", max_output_tokens: 100 },
      };
    }
    return { text: 'Native Forge execution conformance complete.' };
  },
  () => expectedKey,
);
await writeFile(
  join(nativeHome, 'config.toml'),
  `model = "forge-conformance"\nmodel_provider = "fixture"\ncli_auth_credentials_store = "file"\n[model_providers.fixture]\nname = "Isolated loopback fixture"\nbase_url = "${provider.endpoint}/v1"\nwire_api = "responses"\nenv_key = "FORGE_SLOT_TOKEN"\nrequires_openai_auth = false\n`,
);
await writeFile(
  join(nativeHome, 'auth.json'),
  JSON.stringify({ OPENAI_API_KEY: 'synthetic-forge-only' }),
  { mode: 0o600 },
);
await writeFile(join(cwd, 'README.md'), '# Isolated Forge native execution\n');
await writeFile(
  join(data, 'userdata', 'settings.json'),
  JSON.stringify({
    providerInstances: {
      codex: { driver: 'codex', enabled: false, config: { enabled: false } },
      claudeAgent: { driver: 'claudeAgent', enabled: false, config: { enabled: false } },
      forge_one: {
        driver: 'codex',
        displayName: 'Isolated Codex one',
        enabled: true,
        environment: [{ name: 'FORGE_SLOT_TOKEN', value: 'synthetic-slot-one' }],
        config: { binaryPath: codex, homePath: nativeHome, customModels: ['forge-conformance'] },
      },
      forge_two: {
        driver: 'codex',
        displayName: 'Isolated Codex two',
        enabled: true,
        environment: [{ name: 'FORGE_SLOT_TOKEN', value: 'synthetic-slot-two' }],
        config: { binaryPath: codex, homePath: nativeHome, customModels: ['forge-conformance'] },
      },
    },
  }),
);
const env: NodeJS.ProcessEnv = {
  HOME: home,
  PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  TMPDIR: root,
  T3CODE_TELEMETRY_ENABLED: 'false',
  DO_NOT_TRACK: '1',
  CODEX_HOME: nativeHome,
  CLAUDE_CONFIG_DIR: join(home, 'claude'),
  HERMES_HOME: join(home, 'hermes'),
  OPENCLAW_HOME: join(home, 'openclaw'),
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'),
  XDG_CACHE_HOME: join(home, 'cache'),
};
const cli = (args: string[]) =>
  exec(binary, [...args, '--base-dir', data], { env, cwd, timeout: 20000, maxBuffer: 1024 * 1024 });
const listener = createServer();
await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const log = await open(join(root, 'native.log'), 'wx', 0o600);
await cli(['project', 'add', cwd, '--title', 'Forge execution conformance']);
const native = spawn(
  binary,
  ['serve', '--base-dir', data, '--host', '127.0.0.1', '--port', String(port), '--no-browser'],
  { cwd, env, stdio: ['ignore', log.fd, log.fd] },
);
let exited = false;
native.once('exit', () => (exited = true));
const app = await createApp({ filename: join(root, 'workspace.sqlite'), test: true });
// This isolated crash fixture controls admission; native pressure protection has its own check.
app.local.put('settings', 'workspace', {
  ...app.local.settings(),
  memoryPressurePolicy: 'observe',
});
let appClosed = false;
let forge: ChildProcess | undefined;
let forgeLog: Awaited<ReturnType<typeof open>> | undefined;
let forgeOrigin = '',
  forgeCsrf = '';
let forgePort: number | undefined;
let companionClient: Client | undefined;
async function startForge() {
  if (!forgePort) {
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    forgePort = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
  forgeOrigin = `http://127.0.0.1:${forgePort}`;
  forgeLog = await open(join(root, 'forge.log'), 'a', 0o600);
  forge = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../bin/forge.mjs', import.meta.url)),
      '--data-dir',
      root,
      '--port',
      String(forgePort),
    ],
    { cwd, env, stdio: ['ignore', forgeLog.fd, forgeLog.fd] },
  );
  for (let i = 0; i < 80; i++) {
    assert(forge.exitCode === null && forge.signalCode === null, 'Forge exited before readiness.');
    try {
      const response = await fetch(forgeOrigin + '/api/snapshot', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const snapshot = (await response.json()) as Snapshot;
        forgeCsrf = snapshot.csrf;
        return snapshot;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('The compiled Forge service never became ready.');
}
async function stopForge(signal: 'SIGKILL' | 'SIGTERM') {
  if (forge && forge.exitCode === null && forge.signalCode === null) {
    forge.kill(signal);
    for (let i = 0; i < 60 && forge.exitCode === null && forge.signalCode === null; i++)
      await new Promise((resolve) => setTimeout(resolve, 250));
    if (forge.exitCode === null && forge.signalCode === null) {
      forge.kill('SIGKILL');
      await new Promise((resolve) => forge!.once('exit', resolve));
      assert.fail('The owned Forge service did not settle during teardown.');
    }
    assert.equal(
      signal === 'SIGKILL' ? forge.signalCode : forge.exitCode,
      signal === 'SIGKILL' ? 'SIGKILL' : 0,
    );
  }
  await forgeLog?.close();
  forgeLog = undefined;
  forge = undefined;
}
async function http<T>(url: string, body?: unknown, expectedStatus?: number): Promise<T> {
  const response = await fetch(forgeOrigin + '/api' + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: forgeOrigin, 'content-type': 'application/json', 'x-forge-csrf': forgeCsrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (expectedStatus) assert.equal(response.status, expectedStatus, JSON.stringify(result));
  else assert(response.ok, `${url}: ${JSON.stringify(result)}`);
  return result as T;
}
const request = async <T>(
  url: string,
  body: unknown = {},
  method: 'POST' | 'PATCH' | 'PUT' = 'POST',
): Promise<T> => {
  const response = await app.app.inject({
    method,
    url: '/api' + url,
    headers: {
      host: '127.0.0.1:4710',
      'x-forge-csrf': app.csrf,
      'content-type': 'application/json',
    },
    payload: JSON.stringify(body),
  });
  assert(response.statusCode < 400, `${method} ${url}: ${response.body}`);
  return response.json<T>();
};
const observed = new Map<number, ProcessObservation>();
async function captureNativeTree() {
  const table = await processTable();
  assert(table && native.pid);
  const included = new Set([native.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of table)
      if (included.has(row.parentPid) && !included.has(row.pid)) {
        included.add(row.pid);
        changed = true;
      }
  }
  for (const row of table) if (included.has(row.pid)) observed.set(row.pid, row);
}
let report: Record<string, unknown> = {};
let stage = 'readiness',
  success = false;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    assert(!exited, 'T3 exited before readiness.');
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(ready, 'Native server never became ready.');
  const pairing = JSON.parse(
    (
      await cli([
        'auth',
        'pairing',
        'create',
        '--scope',
        'orchestration:read',
        '--scope',
        'orchestration:operate',
        '--json',
      ])
    ).stdout,
  ).credential as string;
  stage = 'production pairing and provider catalogue';
  const backend = await request<WorkspaceBackend>('/backends/t3', {
    endpoint: origin,
    label: 'Isolated T3',
    code: pairing,
  });
  let account = app.local
    .all<Account>('accounts')
    .find(
      (account) => account.backend?.id === backend.id && account.backend.instanceId === 'forge_one',
    );
  assert(
    account?.providerReady && account.models?.includes('forge-conformance'),
    'The isolated native provider must be available with its configured model.',
  );
  account = await request<Account>(
    `/accounts/${account.id}/backend`,
    { model: 'forge-conformance' },
    'PATCH',
  );
  assert.equal(JSON.stringify(app.local.all('backends')).includes(pairing), false);
  stage = 'production work dispatch';
  const work = await request<Work>('/work', {
    title: 'T3 native artifact',
    project: 'Conformance',
    cwd,
    goal: 'FORGE_EXEC_PROBE: create phase-one.txt, then report completion.',
    harness: account.harness,
    accountId: account.id,
  });
  const run = await request<Run>(`/work/${work.id}/launch`, {
    expectedRevision: work.revision,
    allowMetered: true,
  });
  assert(run.settlement && !run.settlement.confirmed);
  async function finishRun(filename: string) {
    let approved = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const approval = app.local
        .all<Approval>('approvals')
        .find((approval) => approval.workId === work.id && approval.status === 'pending');
      if (approval && !approved) {
        await captureNativeTree();
        assert(approval.command.includes(filename));
        await assert.rejects(
          readFile(join(cwd, filename)),
          'The native tool must wait before the exact decision.',
        );
        await request(`/approvals/${approval.id}/decision`, {
          digest: approval.digest,
          decision: 'accept',
        });
        approved = true;
      }
      const current = app.local.work(work.id);
      if (!current.activeRunId || current.status === 'interrupted') {
        if (current.status !== 'completed')
          console.error(
            app.local
              .recentEvents(work.id)
              .map((event) => ({ title: event.title, detail: event.detail })),
          );
        assert.equal(current.status, 'completed');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(approved, 'The exact native approval was not delivered.');
    assert.equal(app.local.work(work.id).status, 'completed');
    assert.equal(app.controller.activeCount, 0);
  }
  stage = 'first exact production approval';
  await finishRun('phase-one.txt');
  assert.equal(
    (await readFile(join(cwd, 'phase-one.txt'), 'utf8')).trim(),
    'FORGE-WORKSPACE-PROOF',
  );
  const settled = app.local.get<Run>('runs', run.id)!;
  assert(settled.settlement?.confirmed && settled.settlement.runId);
  assert.equal(
    settled.exitConfirmed,
    undefined,
    'A delegated run receipt must not claim native process exit.',
  );
  assert.equal(app.controller.activeCount, 0);
  assert.equal(provider.failure(), null);
  const manager = new T3Backends(app.local, root);
  const rpc = await manager.rpc(backend.id);
  let firstNativeId: string | undefined;
  try {
    const projection = t3Projection.parse(
      await rpc.request('orchestration.getThreadProjection', {
        threadId: settled.settlement.threadId,
      }),
    );
    const nativeRun = projection.runs.find((value) => value.id === settled.settlement!.runId)!;
    firstNativeId = projection.providerThreads.find(
      (value) => value.id === nativeRun.providerThreadId,
    )?.nativeThreadRef?.nativeId;
  } finally {
    rpc.close();
  }
  assert(firstNativeId, 'The first run must have a strong native conversation reference.');
  await request(`/backends/${backend.id}/refresh`);
  let second = app.local
    .all<Account>('accounts')
    .find((value) => value.backend?.instanceId === 'forge_two')!;
  assert(second?.providerReady);
  second = await request<Account>(
    `/accounts/${second.id}/backend`,
    { model: 'forge-conformance' },
    'PATCH',
  );
  stage = 'same-work native account handoff';
  await request(
    `/work/${work.id}/route`,
    {
      expectedRevision: app.local.work(work.id).revision,
      expectedPolicyRevision: 0,
      accountIds: [second.id, account.id],
      allowMetered: true,
      allowUnreportedQuota: true,
      maxEvidenceAgeSeconds: 900,
    },
    'PUT',
  );
  const route = app.routing.review(work.id);
  assert.equal(route.recommendedAccountId, second.id);
  await request(`/work/${work.id}/route/prepare`, {
    planId: route.planId,
    digest: route.digest,
    paths: ['phase-one.txt'],
    reconciled: true,
  });
  assert.equal(app.local.work(work.id).nativeSessionId, settled.settlement.threadId);
  phase = 2;
  expectedKey = 'synthetic-slot-two';
  const secondRun = await request<Run>(`/work/${work.id}/launch`, {
    expectedRevision: app.local.work(work.id).revision,
    allowMetered: true,
  });
  stage = 'second exact production approval and compatible native resume';
  await finishRun('phase-two.txt');
  assert.equal((await readFile(join(cwd, 'phase-two.txt'), 'utf8')).trim(), 'SECOND-ACCOUNT-PROOF');
  assert(historyRetained);
  const secondSettled = app.local.get<Run>('runs', secondRun.id)!;
  assert(secondSettled.settlement?.confirmed);
  const secondRpc = await manager.rpc(backend.id);
  try {
    const projection = t3Projection.parse(
      await secondRpc.request('orchestration.getThreadProjection', {
        threadId: secondSettled.settlement.threadId,
      }),
    );
    const nativeRun = projection.runs.find(
      (value) => value.id === secondSettled.settlement!.runId,
    )!;
    const secondNative = projection.providerThreads.find(
      (value) => value.id === nativeRun.providerThreadId,
    );
    const resumed = secondNative?.nativeThreadRef?.nativeId === firstNativeId;
    assert(secondSettled.settlement.continuity, 'The exact native context coverage must be saved.');
    if (resumed || process.env.FORGE_T3_REQUIRE_NATIVE_RESUME === '1') {
      assert.equal(
        secondNative?.nativeThreadRef?.nativeId,
        firstNativeId,
        'The strict native-resume gate does not permit a summary fallback.',
      );
      assert.equal(secondSettled.settlement.continuity.mode, 'native-resume');
    } else {
      assert(
        projection.contextHandoffs.some(
          (handoff) => handoff.targetRunId === nativeRun.id && handoff.status === 'ready',
        ),
      );
      assert.equal(secondSettled.settlement.continuity.mode, 'portable-handoff');
      assert(
        app.local
          .recentEvents(work.id)
          .some((event) => event.title === 'T3 continued with a context summary'),
      );
    }
  } finally {
    secondRpc.close();
  }
  assert.equal(app.local.all<Run>('runs').filter((value) => value.workId === work.id).length, 2);
  assert.equal(provider.failure(), null);
  stage = 'compiled Forge crash while native approval waits';
  await app.app.close();
  appClosed = true;
  const initial = await startForge();
  phase = 3;
  const beforeCrash = await http<{ work: Work }>(`/work/${work.id}`);
  const access = await http<{ token: string; endpoint: string }>('/companions', {
    label: 'Isolated companion dispatcher',
    root: cwd,
    profileId: initial.defaultProfileId,
    scopes: ['work:read', 'context:read', 'work:dispatch'],
    accountIds: [second.id],
    dispatch: { allowMetered: true, maxRuns: 1 },
  });
  companionClient = new Client({ name: 'isolated-native-companion', version: '1' });
  await companionClient.connect(
    new StreamableHTTPClientTransport(new URL(access.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
    }),
  );
  const context = await companionClient.callTool({
    name: 'forge_context',
    arguments: { workId: work.id },
  });
  assert(!context.isError);
  const launchInput = {
    requestId: 'native-companion-crash-once',
    workId: work.id,
    expectedRevision: beforeCrash.work.revision,
    contextDigest: (context.structuredContent as { reviewDigest: string }).reviewDigest,
  };
  const launched = await companionClient.callTool({
    name: 'forge_start_work',
    arguments: launchInput,
  });
  assert(!launched.isError, 'The granted companion must start native execution through MCP.');
  const crashRun = launched.structuredContent as unknown as Run;
  let heldApproval: Approval | undefined;
  for (let i = 0; i < 200; i++) {
    const snapshot = await http<Snapshot>('/snapshot');
    heldApproval = snapshot.approvals.find(
      (value) => value.runId === crashRun.id && value.status === 'pending',
    );
    if (heldApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const held = heldApproval;
  assert(held, 'The native approval must be observed before the crash.');
  assert(
    held.command.includes('should-not-exist.txt'),
    'The native tool must be held for approval before the crash.',
  );
  await captureNativeTree();
  await assert.rejects(readFile(join(cwd, 'should-not-exist.txt')));
  const requestsAtCrash = provider.requests();
  await stopForge('SIGKILL');
  assert(!exited, 'A Forge crash must not kill the native T3 owner.');
  stage = 'restart, stale decision rejection and exact native reconciliation';
  const recovered = await startForge();
  assert.equal(recovered.work.find((value) => value.id === work.id)?.status, 'interrupted');
  assert.equal(recovered.approvals.find((value) => value.id === held.id)?.status, 'invalidated');
  const detail = await http<{ work: Work; runs: Run[] }>(`/work/${work.id}`);
  const interrupted = detail.runs.find((value) => value.id === crashRun.id)!;
  assert.equal(detail.runs.length, 3);
  assert(interrupted.settlement && !interrupted.settlement.confirmed);
  assert.equal(interrupted.settlement.messageId, crashRun.settlement!.messageId);
  assert.equal(interrupted.exitConfirmed, undefined);
  const repeated = await companionClient.callTool({
    name: 'forge_start_work',
    arguments: launchInput,
  });
  assert(!repeated.isError);
  assert.equal((repeated.structuredContent as unknown as Run).id, crashRun.id);
  assert.equal(
    provider.requests(),
    requestsAtCrash,
    'A repeated MCP request after restart must return its saved run without replay.',
  );
  await http(`/approvals/${held.id}/decision`, { digest: held.digest, decision: 'accept' }, 409);
  await http(`/runs/${crashRun.id}/reconcile`, { interrupt: false }, 409);
  const blocked = await http<Work>('/work', {
    title: 'Blocked during native uncertainty',
    project: 'Conformance',
    cwd,
    goal: 'Do not launch while another native receipt remains unsettled.',
    harness: second.harness,
    accountId: second.id,
  });
  await http(
    `/work/${blocked.id}/launch`,
    { expectedRevision: blocked.revision, allowMetered: true },
    409,
  );
  const reconciled = await http<NonNullable<Run['settlement']>>(`/runs/${crashRun.id}/reconcile`, {
    interrupt: true,
  });
  assert(reconciled.confirmed && reconciled.runId);
  assert.equal(reconciled.threadId, crashRun.settlement!.threadId);
  const after = await http<{ work: Work; runs: Run[] }>(`/work/${work.id}`);
  assert.equal(after.work.activeRunId, null);
  assert.equal(after.runs.find((value) => value.id === crashRun.id)?.exitConfirmed, undefined);
  assert.equal(
    provider.requests(),
    requestsAtCrash,
    'Recovery must never replay a model turn or pending approval.',
  );
  await assert.rejects(
    readFile(join(cwd, 'should-not-exist.txt')),
    'The unapproved native effect must remain absent after recovery.',
  );
  assert.equal(provider.failure(), null);
  await stopForge('SIGTERM');
  success = true;
  report = {
    result: 'passed',
    native: 'T3 protocol 2 / Codex',
    exactApprovals: 2,
    artifacts: 2,
    providerInstances: 2,
    distinctSyntheticCredentials: true,
    contextContinuity: secondSettled.settlement.continuity?.mode,
    syntheticRequests: provider.requests(),
    paidModelCalls: 0,
    settlement: settled.settlement.state,
    processExitClaimed: false,
    crashedAtPendingApproval: true,
    exactRecovery: reconciled.state,
    replayedRequests: 0,
    unapprovedEffectAbsent: true,
    companionDispatch: 'MCP',
    repeatedDispatchAfterRestart: 'same-run',
    nativeAccountRouting: 'ordered-pool and verified handoff',
  };
} catch (error) {
  console.error('T3 execution conformance failed', {
    stage,
    root,
    message: (error as Error).message,
  });
  process.exitCode = 1;
} finally {
  await captureNativeTree();
  if (!appClosed) await app.app.close();
  await companionClient?.close();
  await stopForge('SIGTERM');
  native.kill('SIGTERM');
  for (let i = 0; i < 60 && !exited; i++) await new Promise((resolve) => setTimeout(resolve, 250));
  const forced = !exited;
  if (!exited) {
    native.kill('SIGKILL');
    await new Promise((resolve) => native.once('exit', resolve));
  }
  await provider.close();
  await log.close();
  if (success) {
    assert(!forced, 'The isolated native server must exit gracefully.');
    let remaining = await processTable();
    const alive = () =>
      [...observed.values()].filter((old) =>
        remaining?.some(
          (row) => row.pid === old.pid && row.startedAt === old.startedAt && row.uid === old.uid,
        ),
      );
    for (let i = 0; i < 20 && alive().length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      remaining = await processTable();
    }
    assert(
      remaining && alive().length === 0,
      'Every observed owned native descendant must exit during isolated test teardown.',
    );
    console.log(
      JSON.stringify({ ...report, nativeTreeExit: 'confirmed', observedProcesses: observed.size }),
    );
    await rm(root, { recursive: true, force: true });
  }
}
