// Actual compiled coordinator, installed Hermes and OpenClaw, disposable native profiles.
// All jobs are two weeks in the future. No tick, delivery or paid inference is invoked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GatewayClient } from '@openclaw/gateway-client';
import type { Account } from '../../shared/types.js';
import type { ScheduleTransferReview } from '../../shared/schedule-transfers.js';
import type { WorkerProofDescriptor } from '../../shared/recovery.js';

const compiled = '../../dist/server/';
const { createApp } = (await import(
  new URL(compiled + 'app.js', import.meta.url).href
)) as typeof import('../../server/app.js');
const { ownedNativeSpawner } = (await import(
  new URL(compiled + 'owned-native.js', import.meta.url).href
)) as typeof import('../../server/owned-native.js');
const { openClawCompanion } = (await import(
  new URL(compiled + 'companion-providers.js', import.meta.url).href
)) as typeof import('../../server/companion-providers.js');
const { readWorkerExit } = (await import(
  new URL(compiled + 'worker-proof.mjs', import.meta.url).href
)) as typeof import('../../server/worker-proof.mjs');
const { findBinary } = (await import(
  new URL(compiled + 'adapters/discovery.js', import.meta.url).href
)) as typeof import('../../server/adapters/discovery.js');
const { hermesPython } = (await import(
  new URL(compiled + 'adapters/hermes-install.js', import.meta.url).href
)) as typeof import('../../server/adapters/hermes-install.js');
const { hermesEnvironment } = (await import(
  new URL(compiled + 'adapters/hermes-driver.js', import.meta.url).href
)) as typeof import('../../server/adapters/hermes-driver.js');
const { unknownPressure } = (await import(
  new URL(compiled + 'memory-pressure.js', import.meta.url).href
)) as typeof import('../../server/memory-pressure.js');

await mkdir('artifacts', { recursive: true });
const root = await realpath(
  await mkdtemp(join(process.cwd(), 'artifacts', 'forge-native-schedule-transfer-')),
);
const original = join(root, 'original'),
  returned = join(root, 'returned'),
  openclaw = join(root, 'openclaw'),
  project = join(root, 'project'),
  state = join(root, 'state');
for (const path of [original, returned, openclaw, project, state])
  await mkdir(path, { mode: 0o700 });
for (const path of [original, returned])
  await writeFile(join(path, 'config.yaml'), 'timezone: UTC\ncron:\n  provider: builtin\n', {
    mode: 0o600,
  });
let modelRequests = 0;
const inference = createServer((_req, res) => {
  modelRequests++;
  res.writeHead(503);
  res.end('No model request authorized.');
});
await new Promise<void>((resolve) => inference.listen(0, '127.0.0.1', resolve));
const reserve = createServer();
await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const port = (reserve.address() as { port: number }).port;
await new Promise<void>((resolve) => reserve.close(() => resolve()));
const token = 'owned-schedule-transfer-synthetic-bootstrap';
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
            name: 'Unused transfer fixture',
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
await writeFile(join(openclaw, 'openclaw.json'), config, { mode: 0o600 });
let descriptor: WorkerProofDescriptor<object> | undefined;
const save = (record: WorkerProofDescriptor<object>) => {
  descriptor = record;
};
const spawn = ownedNativeSpawner({
  directory: state,
  nativeHome: openclaw,
  scope: { kind: 'native-schedule-transfer-conformance' },
  mayPrepare: () => true,
  mayCommit: () => true,
  prepared: save,
  phaseChanged: save,
});
const account = {
  id: 'owned-schedule-transfer',
  harness: 'openclaw',
  nativeHome: openclaw,
  credentialEnv: '',
} as Account;
const previous = process.env.FORGE_NATIVE_SCHEDULE_TRANSFER;
process.env.FORGE_NATIVE_SCHEDULE_TRANSFER = token;
let loseCreate = false,
  creates = 0;
const workspace = await createApp({
  memoryPressureReader: unknownPressure,
  filename: join(state, 'workspace.sqlite'),
  openClawScheduleClientFactory(options) {
    const client = new GatewayClient(options),
      request = client.request.bind(client);
    client.request = async <T>(
      method: string,
      params?: unknown,
      options?: Parameters<GatewayClient['request']>[2],
    ): Promise<T> => {
      if (method === 'cron.add') creates++;
      const result = await request<T>(method, params, options);
      if (method === 'cron.add' && loseCreate) {
        loseCreate = false;
        throw new Error('Owned lost native create acknowledgement');
      }
      return result;
    };
    return client;
  },
});
let connection: Awaited<ReturnType<typeof openClawCompanion>> | undefined,
  passed = false;
const exec = promisify(execFile);
const binary = await findBinary('hermes');
assert(binary);
const python = await hermesPython(binary);
const native = async (home: string, code: string) =>
  (
    await exec(python, ['-c', code], {
      cwd: home,
      env: { ...hermesEnvironment({ nativeHome: home }), PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 10000,
      maxBuffer: 262144,
    })
  ).stdout.trim();
const decision = (r: ScheduleTransferReview) => ({
  revision: r.revision,
  digest: r.digest,
  reviewed: true as const,
  sourceActivitySettled: true as const,
});
try {
  connection = await openClawCompanion(account, project, undefined, spawn);
  const from = workspace.nativeSources.add({
    kind: 'hermes-schedules',
    label: 'Owned original',
    home: original,
    endpoint: '',
  });
  const to = workspace.nativeSources.add({
    kind: 'hermes-schedules',
    label: 'Owned return',
    home: returned,
    endpoint: '',
  });
  const gateway = workspace.nativeSources.add({
    kind: 'openclaw-schedules',
    label: 'Owned OpenClaw',
    home: '',
    endpoint: `http://127.0.0.1:${port}`,
    tokenEnv: 'FORGE_NATIVE_SCHEDULE_TRANSFER',
    scheduleControls: true,
  });
  const future = new Date(Date.now() + 14 * 86400000).toISOString();
  const jobId = await native(
    original,
    `import contextlib, io\nwith contextlib.redirect_stdout(io.StringIO()):\n import cron.jobs as jobs\n job = jobs.create_job(prompt='Owned portable task, never run by this fixture.', schedule=${JSON.stringify(future)}, name='Owned portable schedule', deliver='local')\nprint(job['id'])`,
  );
  const move = async (sourceId: string, selectedJobId: string, targetSourceId: string) => {
    const plan = await workspace.scheduleTransfers.prepare({
      sourceId,
      jobId: selectedJobId,
      targetSourceId,
    });
    const receipt = await workspace.scheduleTransfers.stage(plan.id, plan.digest, {
      kind: 'local',
    });
    assert.equal(receipt.state, 'staged', JSON.stringify(receipt));
    const review = await workspace.scheduleTransfers.review(receipt.id);
    assert.equal(review.canActivate, true);
    assert.equal(review.source.enabled, false);
    assert.equal(review.target?.enabled, false);
    assert.equal(
      (
        await workspace.scheduleTransfers.decide(
          review.id,
          decision(review),
          { kind: 'local' },
          'activate',
        )
      ).state,
      'active',
    );
    return receipt;
  };
  const first = await move(from.id, jobId, gateway.id);
  const undo = await workspace.scheduleTransfers.review(first.id);
  assert.equal(undo.target?.enabled, true);
  assert.equal(undo.source.enabled, false);
  assert.equal(
    (await workspace.scheduleTransfers.decide(undo.id, decision(undo), { kind: 'local' }, 'cancel'))
      .state,
    'cancelled',
  );
  const second = await move(gateway.id, first.targetJobId!, to.id);
  const returnedJobs = JSON.parse(await readFile(join(returned, 'cron', 'jobs.json'), 'utf8')).jobs;
  assert.equal(returnedJobs.length, 1);
  assert.equal(returnedJobs[0].enabled, true);
  assert.equal(returnedJobs[0].prompt, 'Owned portable task, never run by this fixture.');
  assert.equal(Date.parse(returnedJobs[0].schedule.run_at), Date.parse(future));
  for (const rule of ['every 45m', '0 11 * * *']) {
    const recurrenceId = await native(
      original,
      `import contextlib, io\nwith contextlib.redirect_stdout(io.StringIO()):\n import cron.jobs as jobs\n job = jobs.create_job(prompt='Owned recurring native task, never run.', schedule=${JSON.stringify(rule)}, name=${JSON.stringify('Owned ' + rule)}, deliver='local')\nprint(job['id'])`,
    );
    const outbound = await move(from.id, recurrenceId, gateway.id);
    const held = await workspace.scheduleTransfers.review(outbound.id);
    await workspace.scheduleTransfers.decide(held.id, decision(held), { kind: 'local' }, 'cancel');
    const inbound = await move(gateway.id, outbound.targetJobId!, to.id);
    const proof = await workspace.scheduleTransfers.review(inbound.id);
    assert.equal(proof.portable.schedule.kind, rule.startsWith('every') ? 'every' : 'cron');
    assert.equal(proof.target?.enabled, true);
    await workspace.scheduleTransfers.decide(
      proof.id,
      decision(proof),
      { kind: 'local' },
      'cancel',
    );
  }
  loseCreate = true;
  const lostPlan = await workspace.scheduleTransfers.prepare({
    sourceId: from.id,
    jobId,
    targetSourceId: gateway.id,
  });
  const lost = await workspace.scheduleTransfers.stage(lostPlan.id, lostPlan.digest, {
    kind: 'local',
  });
  assert.equal(lost.state, 'uncertain');
  assert.equal(lost.targetJobId, undefined);
  assert.equal(creates, 4);
  const found = await workspace.scheduleTransfers.review(lost.id);
  assert(found.targetJobId);
  assert.equal(found.target?.enabled, false);
  const reconciled = await workspace.scheduleTransfers.reconcile(
    found.id,
    {
      ...decision(found),
      note: 'Read actual native store and verified this existing disabled marker; no pending RPC, tick, run or delivery.',
    },
    { kind: 'local' },
  );
  assert.equal(reconciled.state, 'staged');
  assert.equal(creates, 4);
  const readAgain = await workspace.scheduleTransfers.review(reconciled.id);
  await workspace.scheduleTransfers.decide(
    readAgain.id,
    decision(readAgain),
    { kind: 'local' },
    'cancel',
  );
  const finish = await workspace.scheduleTransfers.review(second.id);
  await workspace.scheduleTransfers.decide(
    finish.id,
    decision(finish),
    { kind: 'local' },
    'cancel',
  );
  assert.equal(modelRequests, 0);
  assert.equal(await readFile(join(openclaw, 'openclaw.json'), 'utf8'), config);
  const exit = await connection.stop();
  connection = undefined;
  assert.equal(exit.clean, true);
  assert.equal(readWorkerExit(descriptor!).payload.nativeClosed, true);
  passed = true;
  console.log(
    JSON.stringify({
      status: 'passed',
      native: ['Hermes 0.17.0', 'OpenClaw 2026.10.4 / Gateway 4'],
      compiledCoordinator: true,
      directions: ['Hermes → OpenClaw', 'OpenClaw → Hermes'],
      nativeDisabledStaging: true,
      exactOneShotInstantPreserved: true,
      nativeCronAndIntervalBothDirections: true,
      lostNativeCreateLocatedWithoutReplay: true,
      nativeCreates: creates,
      sourceResumeHolds: true,
      nativeDefinitionsRetained: true,
      signedGatewayClose: true,
      modelRequests,
      paidModelCalls: 0,
      personalProfilesChanged: false,
    }),
  );
} finally {
  await workspace.app.close();
  await connection?.stop();
  await new Promise<void>((resolve) => inference.close(() => resolve()));
  if (previous === undefined) delete process.env.FORGE_NATIVE_SCHEDULE_TRANSFER;
  else process.env.FORGE_NATIVE_SCHEDULE_TRANSFER = previous;
  if (passed && !process.env.FORGE_NATIVE_KEEP) await rm(root, { recursive: true, force: true });
}
