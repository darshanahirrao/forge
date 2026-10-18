// Compiled native operator client + actual Gateway and native CLI. No tick, model or delivery input.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GatewayClient, type GatewayClientOptions } from '@openclaw/gateway-client';
import type { Account } from '../../shared/types.js';
import type { OpenClawScheduleClientFactory } from '../../server/openclaw-schedules.js';
import type { WorkerProofDescriptor } from '../../shared/recovery.js';

const { Store } = (await import(
  new URL('../../dist/server/store.js', import.meta.url).href
)) as typeof import('../../server/store.js');
const { OpenClawSchedules } = (await import(
  new URL('../../dist/server/openclaw-schedules.js', import.meta.url).href
)) as typeof import('../../server/openclaw-schedules.js');
const { NativeSources } = (await import(
  new URL('../../dist/server/native-sources.js', import.meta.url).href
)) as typeof import('../../server/native-sources.js');
const { NativeControls } = (await import(
  new URL('../../dist/server/native-controls.js', import.meta.url).href
)) as typeof import('../../server/native-controls.js');
const { openClawCompanion } = (await import(
  new URL('../../dist/server/companion-providers.js', import.meta.url).href
)) as typeof import('../../server/companion-providers.js');
const { openClawEnvironment, openClawInstallation } = (await import(
  new URL('../../dist/server/adapters/openclaw-worker.js', import.meta.url).href
)) as typeof import('../../server/adapters/openclaw-worker.js');
const { ownedNativeSpawner } = (await import(
  new URL('../../dist/server/owned-native.js', import.meta.url).href
)) as typeof import('../../server/owned-native.js');
const { readWorkerExit } = (await import(
  new URL('../../dist/server/worker-proof.mjs', import.meta.url).href
)) as typeof import('../../server/worker-proof.mjs');

await mkdir('artifacts', { recursive: true });
const root = await realpath(
  await mkdtemp(join(process.cwd(), 'artifacts', 'forge-native-scheduler-')),
);
const profile = join(root, 'native'),
  project = join(root, 'project'),
  data = join(root, 'state'),
  proofs = join(root, 'proofs');
for (const directory of [profile, project, data, proofs]) await mkdir(directory, { mode: 0o700 });
let modelRequests = 0;
const inference = createServer((_request, response) => {
  modelRequests++;
  response.writeHead(503);
  response.end('No inference authorized by scheduler conformance.');
});
await new Promise<void>((resolve) => inference.listen(0, '127.0.0.1', resolve));
const reserve = createServer();
await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const port = (reserve.address() as { port: number }).port;
await new Promise<void>((resolve) => reserve.close(() => resolve()));
const token = 'synthetic-scheduler-conformance-only';
const config = JSON.stringify({
  gateway: {
    mode: 'local',
    reload: { mode: 'off' },
    port,
    bind: 'loopback',
    auth: { mode: 'token', token },
  },
  agents: {
    defaults: { workspace: project, heartbeat: { every: '0m' }, model: { primary: 'forge/proof' } },
  },
  cron: { enabled: true },
  models: {
    providers: {
      forge: {
        baseUrl: `http://127.0.0.1:${(inference.address() as { port: number }).port}/v1`,
        apiKey: 'synthetic-unused',
        api: 'openai-completions',
        models: [
          {
            id: 'proof',
            name: 'No-inference scheduler fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
});
await writeFile(join(profile, 'openclaw.json'), config, { mode: 0o600 });
const account = {
  id: 'owned-native-scheduler',
  nativeHome: profile,
  harness: 'openclaw',
  credentialEnv: '',
} as Account;
const store = new Store(join(data, 'workspace.sqlite'));
let descriptor: WorkerProofDescriptor<object> | undefined;
const save = (record: WorkerProofDescriptor<object>) => {
  descriptor = record;
  store.put('worker_supervisions', record.id, record);
};
const spawn = ownedNativeSpawner({
  directory: proofs,
  nativeHome: profile,
  scope: { kind: 'native-scheduler-conformance' },
  mayPrepare: () => true,
  mayCommit: () => true,
  prepared: save,
  phaseChanged: save,
});
const env = openClawEnvironment(account, undefined, 'companion'),
  installation = await openClawInstallation(env),
  exec = promisify(execFile);
const cli = async (args: string[]) =>
  JSON.parse(
    (
      await exec(installation.node, [installation.binary, ...args, '--json'], {
        env,
        cwd: project,
        timeout: 20000,
        maxBuffer: 512 * 1024,
      })
    ).stdout,
  );
let race = false,
  loseAck = false,
  updateRequests = 0;
const requestedScopes: string[][] = [];
const factory: OpenClawScheduleClientFactory = (options: GatewayClientOptions) => {
  requestedScopes.push(options.scopes ?? []);
  const client = new GatewayClient(options),
    call = client.request.bind(client);
  client.request = async <T>(
    method: string,
    params?: unknown,
    requestOptions?: Parameters<GatewayClient['request']>[2],
  ): Promise<T> => {
    if (method === 'cron.update') {
      updateRequests++;
      if (race) {
        race = false;
        await cli([
          'automations',
          'edit',
          (params as { id: string }).id,
          '--name',
          'Changed by native owner during admission',
        ]);
      }
    }
    const result = await call<T>(method, params, requestOptions);
    if (method === 'cron.update' && loseAck) {
      loseAck = false;
      throw new Error('Owned acknowledgement loss after native commit');
    }
    return result;
  };
  return client;
};
let manager = new OpenClawSchedules(data, factory);
const sources = new NativeSources(store, {
  openClawSchedulesReader: (source) => manager.read(source),
});
const controls = new NativeControls(store, sources, (source, request) =>
  manager.control(source, request),
);
const source = sources.add({
  kind: 'openclaw-schedules',
  label: 'Owned native schedule source',
  home: '',
  endpoint: `http://127.0.0.1:${port}`,
  tokenEnv: 'FORGE_NATIVE_SCHEDULER_CONFORMANCE',
});
const previousToken = process.env.FORGE_NATIVE_SCHEDULER_CONFORMANCE;
process.env.FORGE_NATIVE_SCHEDULER_CONFORMANCE = token;
let connection: Awaited<ReturnType<typeof openClawCompanion>> | undefined;
let passed = false;
try {
  connection = await openClawCompanion(account, project, undefined, spawn);
  await sources.refresh(source.id);
  assert.equal(sources.list()[0].state, 'connected');
  assert.deepEqual(requestedScopes.at(-1), ['operator.read']);
  const file = join(data, `.forge-openclaw-source-${source.id}.json`);
  const originalIdentity = JSON.parse(await readFile(file, 'utf8')).device;
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const future = new Date(Date.now() + 14 * 86400000).toISOString();
  const created = await cli([
    'automations',
    'create',
    future,
    'Owned never-run schedule fixture',
    '--name',
    'Owned schedule fixture',
    '--agent',
    'main',
    '--session',
    'isolated',
    '--disabled',
    '--no-deliver',
  ]);
  const jobId = created.id ?? created.job?.id;
  assert.equal(typeof jobId, 'string');
  await assert.rejects(
    controls.prepare({ sourceId: source.id, jobId, action: 'resume' }),
    /Enable reviewed scheduler controls/,
  );
  await manager.close();
  assert.equal(
    connection.signal.aborted,
    false,
    'Closing an operator client must not stop the native Gateway.',
  );
  manager = new OpenClawSchedules(data, factory);
  await sources.refresh(source.id);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).device, originalIdentity);
  const current = sources.list()[0];
  store.put('native_sources', source.id, {
    ...current,
    scheduleControls: true,
    revision: await manager.nextAccessRevision(current),
  });
  const first = await controls.prepare({ sourceId: source.id, jobId, action: 'resume' });
  assert.deepEqual(requestedScopes.at(-1), ['operator.read', 'operator.admin']);
  await cli(['automations', 'edit', jobId, '--name', 'Changed by native owner before submit']);
  assert.equal((await controls.apply(first.id, { kind: 'local' })).state, 'rejected');
  assert.equal(updateRequests, 0);
  const racing = await controls.prepare({ sourceId: source.id, jobId, action: 'resume' });
  race = true;
  assert.equal((await controls.apply(racing.id, { kind: 'local' })).state, 'rejected');
  assert.equal((await cli(['automations', 'get', jobId])).enabled, false);
  const fresh = await controls.prepare({ sourceId: source.id, jobId, action: 'resume' });
  const applied = await controls.apply(fresh.id, { kind: 'local' });
  assert.equal(applied.state, 'applied');
  assert.equal(applied.observed?.enabled, true);
  const beforeReplay = updateRequests;
  await controls.apply(fresh.id, { kind: 'local' });
  assert.equal(updateRequests, beforeReplay);
  const pause = await controls.prepare({ sourceId: source.id, jobId, action: 'pause' });
  loseAck = true;
  const uncertain = await controls.apply(pause.id, { kind: 'local' });
  assert.equal(uncertain.state, 'uncertain');
  assert.equal((await cli(['automations', 'get', jobId])).enabled, false);
  const beforeUncertainReplay = updateRequests;
  await controls.apply(pause.id, { kind: 'local' });
  assert.equal(updateRequests, beforeUncertainReplay);
  assert.throws(() => sources.remove(source.id), /uncertain native controls/);
  await cli(['automations', 'remove', jobId]);
  const controlled = sources.list()[0];
  store.put('native_sources', source.id, {
    ...controlled,
    scheduleControls: false,
    revision: await manager.nextAccessRevision(controlled),
  });
  const reviewed = await controls.review(
    uncertain.id,
    { kind: 'local' },
    'Verified native disabled state and removal through the owned native Gateway; no job or delivery ran.',
  );
  assert.equal(reviewed.state, 'uncertain');
  assert.equal(reviewed.review?.observed.state, 'not-visible-or-absent');
  assert.equal(reviewed.review?.observed.enabled, null);
  assert.deepEqual(requestedScopes.at(-1), ['operator.read']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).device, originalIdentity);
  const canonical = JSON.stringify(store.db.prepare('SELECT data FROM records').all());
  assert(!canonical.includes(token) && !canonical.includes('PRIVATE KEY'));
  assert.equal(await readFile(join(profile, 'openclaw.json'), 'utf8'), config);
  assert.equal(modelRequests, 0);
  const exit = await connection.stop();
  connection = undefined;
  assert.equal(exit.clean, true);
  assert.equal(readWorkerExit(descriptor!).payload.nativeClosed, true);
  passed = true;
  console.log(
    JSON.stringify({
      status: 'passed',
      native: 'OpenClaw 2026.10.4 / Gateway 4',
      compiledOperatorClient: true,
      defaultReadOnly: true,
      samePrivateIdentityAfterRestartAndAccessChange: true,
      nativeAdminRequired: true,
      changedBeforeSubmitRejected: true,
      nativeCasRaceRejected: true,
      idempotentHumanReceipts: true,
      lostAcknowledgementNotReplayed: true,
      nativeMissingOrHiddenReviewWithControlsDisabled: true,
      nativeConfigurationUnchanged: true,
      signedNativeClose: true,
      modelRequests,
      paidModelCalls: 0,
      personalProfileChanged: false,
    }),
  );
} finally {
  await manager.close();
  await sources.close();
  await connection?.stop();
  store.close();
  await new Promise<void>((resolve) => inference.close(() => resolve()));
  if (previousToken === undefined) delete process.env.FORGE_NATIVE_SCHEDULER_CONFORMANCE;
  else process.env.FORGE_NATIVE_SCHEDULER_CONFORMANCE = previousToken;
  if (passed) await rm(root, { recursive: true, force: true });
}
