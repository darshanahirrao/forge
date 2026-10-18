import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { scheduleTransferFixture } from './fixtures/schedule-transfer.js';
import { ScheduleTransfers } from '../server/schedule-transfers.js';
import { portableSchedule } from '../server/schedule-portability.js';
import type { ScheduleTransferReview } from '../shared/schedule-transfers.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'forge-schedule-transfer-'));
  const from = join(root, 'from'),
    to = join(root, 'to');
  await mkdir(from);
  await mkdir(to);
  const native = scheduleTransferFixture();
  const app = await createApp({
    filename: ':memory:',
    test: true,
    phoneBridge: { origin: 'https://transfer.fixture.ts.net', proof: 'owned-transfer-proof' },
    memoryPressureReader: unknownPressure,
    nativeControlBridge: native.control,
    scheduleTransferBridge: native.transfer,
  });
  t.after(async () => {
    await app.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const source = app.nativeSources.add({
    kind: 'hermes-schedules',
    label: 'Original',
    home: from,
    endpoint: '',
  });
  const target = app.nativeSources.add({
    kind: 'hermes-schedules',
    label: 'Destination',
    home: to,
    endpoint: '',
  });
  const portable = {
    title: 'Reviewed recurring task',
    prompt: 'Use native tools and save local output.',
    schedule: { kind: 'every' as const, minutes: 30 },
  };
  native.jobs(source).set('owned-source', native.definition(portable, 'owned-source', true));
  const transfers = app.scheduleTransfers;
  const prepare = () =>
    transfers.prepare({ sourceId: source.id, jobId: 'owned-source', targetSourceId: target.id });
  const stage = async () => {
    const plan = await prepare();
    return transfers.stage(plan.id, plan.digest, { kind: 'local' });
  };
  const decision = (review: ScheduleTransferReview) => ({
    digest: review.digest,
    revision: review.revision,
    reviewed: true as const,
    sourceActivitySettled: true as const,
  });
  return { ...app, native, source, target, transfers, prepare, stage, decision };
}

test('a schedule transfer stages disabled, keeps a durable source hold and can reverse without replaying a job', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  assert.equal(f.native.stats.creates, 0);
  assert.equal(f.native.stats.controls, 0);
  assert.ok(plan.changes.some((change) => change.includes('interval')));
  const staged = await f.transfers.stage(plan.id, plan.digest, { kind: 'local' });
  assert.equal(staged.state, 'staged');
  assert.equal(f.native.stats.creates, 1);
  assert.equal(f.native.jobs(f.source).get('owned-source').enabled, false);
  assert.equal(f.native.jobs(f.target).get(staged.targetJobId!).enabled, false);
  assert.deepEqual(await f.transfers.stage(plan.id, plan.digest, { kind: 'local' }), staged);
  await assert.rejects(
    f.transfers.stage(plan.id, 'f'.repeat(64), { kind: 'local' }),
    /intent changed/,
  );
  await assert.rejects(
    f.nativeControls.prepare({ sourceId: f.source.id, jobId: 'owned-source', action: 'resume' }),
    /transfer hold/,
  );
  await assert.rejects(
    f.nativeControls.prepare({
      sourceId: f.target.id,
      jobId: staged.targetJobId,
      action: 'resume',
    }),
    /transfer hold/,
  );
  assert.throws(() => f.nativeSources.remove(f.source.id), /Keep both/);
  const review = await f.transfers.review(staged.id);
  assert.equal(review.canActivate, true);
  const active = await f.transfers.decide(
    review.id,
    f.decision(review),
    { kind: 'local' },
    'activate',
  );
  assert.equal(active.state, 'active');
  assert.equal(f.native.jobs(f.target).get(active.targetJobId!).enabled, true);
  await assert.rejects(
    f.transfers.decide(review.id, f.decision(review), { kind: 'local' }, 'activate'),
    /transfer changed/,
  );
  assert.throws(
    () => f.transfers.assertControl(f.source.id, 'owned-source', 'resume'),
    /transfer hold/,
  );
  assert.doesNotThrow(() => f.transfers.assertControl(f.target.id, active.targetJobId!, 'resume'));
  const again = await f.transfers.review(active.id);
  assert.equal(again.canCancel, true);
  assert.equal(
    (await f.transfers.decide(again.id, f.decision(again), { kind: 'local' }, 'cancel')).state,
    'cancelled',
  );
  assert.equal(f.native.jobs(f.target).get(active.targetJobId!).enabled, false);
  assert.equal(f.native.jobs(f.source).get('owned-source').enabled, false);
  assert.doesNotThrow(() => f.transfers.assertControl(f.source.id, 'owned-source', 'resume'));
  assert.equal(f.native.stats.creates, 1);
  assert.equal(JSON.stringify(f.transfers.list()).includes('Use native tools'), false);
});

test('changed definitions, aliases and concurrent checkpoints cannot publish a second schedule', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.transfers.prepare({
      sourceId: f.source.id,
      jobId: 'owned-source',
      targetSourceId: f.source.id,
    }),
    /different native/,
  );
  const alias = f.nativeSources.add({ ...f.source, label: 'Alias', endpoint: 'alias' });
  await assert.rejects(
    f.transfers.prepare({ sourceId: f.source.id, jobId: 'owned-source', targetSourceId: alias.id }),
    /same native/,
  );
  const plan = await f.prepare();
  f.native.jobs(f.source).get('owned-source').prompt = 'Changed after human review.';
  await assert.rejects(
    f.transfers.stage(plan.id, plan.digest, { kind: 'local' }),
    /source changed/,
  );
  assert.equal(f.native.stats.creates, 0);
  const changed = await f.stage();
  const review = await f.transfers.review(changed.id);
  f.native.jobs(f.target).get(changed.targetJobId!).prompt = 'Changed native destination.';
  await assert.rejects(
    f.transfers.decide(review.id, f.decision(review), { kind: 'local' }, 'activate'),
    /native job or authority changed/,
  );
  assert.equal(f.native.jobs(f.target).get(changed.targetJobId!).enabled, false);
});

test('lost create acknowledgement retains both holds; a human reconciles the existing target without recreating it', async (t) => {
  const f = await fixture(t);
  f.native.stats.lostCreate = true;
  const uncertain = await f.stage();
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(f.native.stats.creates, 1);
  assert.equal(JSON.stringify(uncertain).includes('PRIVATE'), false);
  const review = await f.transfers.review(uncertain.id);
  assert.equal(review.canActivate, false);
  f.native.jobs(f.target).get(uncertain.targetJobId!).enabled = true;
  await assert.rejects(
    f.transfers.reconcile(
      review.id,
      {
        ...f.decision(review),
        note: 'A stale review must not record a newly enabled native target.',
      },
      { kind: 'local' },
    ),
    /changed after outcome review/,
  );
  f.native.jobs(f.target).get(uncertain.targetJobId!).enabled = false;
  const reconciled = await f.transfers.reconcile(
    review.id,
    {
      ...f.decision(review),
      note: 'Checked both native stores and no pending create operation remains.',
    },
    { kind: 'local' },
  );
  assert.equal(reconciled.state, 'staged');
  assert.equal(f.native.stats.creates, 1);
  const current = await f.transfers.review(review.id);
  f.native.stats.lostControl = true;
  assert.equal(
    (await f.transfers.decide(current.id, f.decision(current), { kind: 'local' }, 'activate'))
      .state,
    'uncertain',
  );
  const after = await f.transfers.review(review.id),
    controls = f.native.stats.controls;
  assert.equal(after.target?.enabled, true);
  const settled = await f.transfers.reconcile(
    after.id,
    {
      ...f.decision(after),
      note: 'Checked destination run history and source deliveries; the enable committed.',
    },
    { kind: 'local' },
  );
  assert.equal(settled.state, 'active');
  assert.equal(f.native.stats.controls, controls);
  assert.equal(f.native.stats.creates, 1);
});

test('interrupted durable state is held on restart and source scheduling cannot be resumed', async (t) => {
  const f = await fixture(t),
    staged = await f.stage();
  const row = f.local.get<any>('schedule_transfers', staged.id);
  f.local.put('schedule_transfers', staged.id, { ...row, state: 'activating' });
  const recovered = new ScheduleTransfers(
    f.local,
    f.nativeSources,
    f.controller,
    f.native.control,
    () => f.native.transfer,
  );
  assert.equal(recovered.list()[0].state, 'uncertain');
  assert.throws(
    () => recovered.assertControl(f.source.id, 'owned-source', 'resume'),
    /transfer hold/,
  );
  assert.equal(f.native.stats.creates, 1);
});

test('native dependencies and missing timezone are held instead of silently dropped', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  for (const [key, value] of [
    ['skills', ['native-skill']],
    ['workdir', '/native/project'],
    ['model', 'pinned-model'],
    ['deliver', 'telegram'],
  ]) {
    const evidence = {
      ...plan.source,
      definition: JSON.stringify({ ...JSON.parse(plan.source.definition), [String(key)]: value }),
    };
    assert.throws(() => portableSchedule(f.source, evidence), /native|channel/);
  }
  assert.throws(
    () =>
      portableSchedule(f.source, {
        ...plan.source,
        timezone: undefined,
        definition: JSON.stringify({
          ...JSON.parse(plan.source.definition),
          schedule: { kind: 'cron', expr: '0 9 * * *' },
        }),
      }),
    /timezone/,
  );
  for (const expr of ['0 0 9 * * *', '0 9 L * *', '@daily'])
    assert.throws(
      () =>
        portableSchedule(f.source, {
          ...plan.source,
          definition: JSON.stringify({
            ...JSON.parse(plan.source.definition),
            schedule: { kind: 'cron', expr },
          }),
        }),
      /five-field/,
    );
});

test('aliases and previously prepared native resume plans cannot bypass a durable transfer hold', async (t) => {
  const f = await fixture(t);
  const preparedResume = await f.nativeControls.prepare({
    sourceId: f.source.id,
    jobId: 'owned-source',
    action: 'resume',
  });
  const alias = f.nativeSources.add({ ...f.source, label: 'Same home alias', endpoint: 'alias' });
  const staged = await f.stage();
  await assert.rejects(
    f.nativeControls.apply(preparedResume.id, { kind: 'local' }),
    /transfer hold/,
  );
  assert.throws(
    () => f.transfers.assertControl(alias.id, 'owned-source', 'resume'),
    /transfer hold/,
  );
  await assert.rejects(
    f.transfers.prepare({ sourceId: alias.id, jobId: 'owned-source', targetSourceId: f.target.id }),
    /existing transfer/,
  );
  const review = await f.transfers.review(staged.id);
  f.native.jobs(f.target).get(staged.targetJobId!).prompt =
    'Native owner edited this paused destination.';
  const changed = await f.transfers.review(staged.id);
  assert.equal(changed.canActivate, false);
  assert.equal(changed.canCancel, true);
  assert.equal(
    (await f.transfers.decide(changed.id, f.decision(changed), { kind: 'local' }, 'cancel')).state,
    'cancelled',
  );
  assert.notEqual(review.digest, changed.digest);
});

test('uncertain native controls block transfer and absent targets need an explicit human outcome review', async (t) => {
  const f = await fixture(t);
  const pause = await f.nativeControls.prepare({
    sourceId: f.source.id,
    jobId: 'owned-source',
    action: 'pause',
  });
  f.native.stats.lostControl = true;
  const unknown = await f.nativeControls.apply(pause.id, { kind: 'local' });
  await assert.rejects(f.prepare(), /prior uncertain native control/);
  await f.nativeControls.review(
    unknown.id,
    { kind: 'local' },
    'Checked pending controls and both native histories.',
  );
  f.native.stats.changedDraft = true;
  const staged = await f.stage();
  assert.equal(staged.state, 'uncertain');
  const review = await f.transfers.review(staged.id);
  assert.equal(review.target, null);
  const input = {
    ...f.decision(review),
    note: 'Checked the native store and pending create operations; no target was created.',
  };
  await assert.rejects(
    f.transfers.reconcile(review.id, input, { kind: 'local' }),
    /absent or hidden/,
  );
  assert.equal(
    (
      await f.transfers.reconcile(
        review.id,
        { ...input, targetAbsenceReviewed: true },
        { kind: 'local' },
      )
    ).state,
    'cancelled',
  );
  assert.equal(f.native.stats.creates, 0);
  assert.equal(f.native.jobs(f.source).get('owned-source').enabled, false);
});

test('schedule transfer uses the workspace checkpoint and source gates during native awaits', async (t) => {
  const f = await fixture(t),
    original = f.native.transfer.draft;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.native.transfer.draft = async (...args) => {
    entered();
    await held;
    return original(...args);
  };
  const pending = f.prepare();
  await started;
  assert.equal(f.nativeSources.isReading, true);
  await assert.rejects(
    f.controller.atWorkspaceCheckpoint('other-operation', async () => {}),
    /Wait for managed/,
  );
  await assert.rejects(f.nativeSources.refresh(f.source.id), /read is in progress/);
  assert.throws(() => f.nativeSources.remove(f.target.id), /read to finish/);
  release();
  await pending;
  assert.equal(f.nativeSources.isReading, false);
  assert.equal(f.controller.hasLiveExecution, false);
});

test('schedule transfer HTTP requires local human authority, CSRF and both explicit review decisions', async (t) => {
  const f = await fixture(t),
    headers = { host: '127.0.0.1:4710', 'x-forge-csrf': f.csrf };
  const payload = { sourceId: f.source.id, jobId: 'owned-source', targetSourceId: f.target.id };
  for (const extra of [
    { 'x-forge-csrf': 'wrong' },
    { 'x-forge-workspace': 'demo' },
    {
      'x-forge-bridge-proof': 'owned-transfer-proof',
      'x-forge-bridge-identity': 'reviewer@example.invalid',
    },
  ]) {
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/native/transfers/prepare',
          headers: { ...headers, ...extra },
          payload,
        })
      ).statusCode,
      403,
    );
  }
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/native/transfers/prepare',
    headers,
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  const plan = response.json();
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/native/transfers/stage',
        headers,
        payload: { id: plan.id, digest: plan.digest },
      })
    ).statusCode,
    400,
  );
  const staged = await f.app.inject({
    method: 'POST',
    url: '/api/native/transfers/stage',
    headers,
    payload: { id: plan.id, digest: plan.digest, reviewed: true },
  });
  assert.equal(staged.statusCode, 200, staged.body);
  const review = (
    await f.app.inject({ method: 'POST', url: `/api/native/transfers/${plan.id}/review`, headers })
  ).json();
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/native/transfers/${plan.id}/activate`,
        headers,
        payload: { revision: review.revision, digest: review.digest, reviewed: true },
      })
    ).statusCode,
    400,
  );
  assert.equal(f.native.stats.creates, 1);
  assert.equal(f.native.jobs(f.target).get(staged.json().targetJobId).enabled, false);
});
