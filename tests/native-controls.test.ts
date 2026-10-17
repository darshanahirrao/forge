import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id, now } from '../server/store.js';
import { NativeSources } from '../server/native-sources.js';
import { NativeControls, type NativeControlBridge } from '../server/native-controls.js';
import { createApp } from '../server/app.js';
import type { NativeControlReceipt } from '../shared/native-controls.js';

const hash = 'a'.repeat(64);
function fixtureBridge() {
  let enabled = true,
    changed = false,
    loseAck = false,
    writes = 0;
  const bridge: NativeControlBridge = async (_source, request) => {
    if (request.mode === 'preview')
      return {
        state: 'preview',
        contract: 'hermes-builtin-native-flock/1',
        jobsDigest: hash,
        configDigest: null,
        job: {
          id: request.jobId,
          title: 'Owned fixture',
          prompt: 'Native instructions',
          script: null,
          rule: 'every 30m',
          definition: '{"owned":true}',
          noAgent: false,
          enabled,
          state: enabled ? 'scheduled' : 'paused',
          nextRunAt: null,
        },
      };
    if (changed || request.jobsDigest !== hash) return { state: 'rejected', code: 'changed' };
    assert.ok(request.deadline! > Date.now());
    writes++;
    enabled = request.action === 'resume';
    if (loseAck) throw new Error('PRIVATE native exception');
    return {
      state: 'applied',
      observed: {
        enabled,
        state: enabled ? 'scheduled' : 'paused',
        nextRunAt: null,
        jobsDigest: hash,
      },
    };
  };
  return {
    bridge,
    changed: () => {
      changed = true;
    },
    lose: () => {
      loseAck = true;
    },
    writes: () => writes,
  };
}
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'forge-controls-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  let busy = false;
  const sources = new NativeSources(store, { isManagedBusy: () => busy });
  const source = sources.add({
    kind: 'hermes-schedules',
    label: 'Owned source',
    home,
    endpoint: '',
  });
  const native = fixtureBridge();
  const controls = new NativeControls(store, sources, native.bridge);
  return {
    store,
    sources,
    source,
    native,
    controls,
    busy: (value: boolean) => {
      busy = value;
    },
  };
}

test('reviewed native controls are idempotent receipts and do not turn a changed definition into a retry', async (t) => {
  const f = await fixture(t);
  const plan = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'native-job',
    action: 'pause',
  });
  assert.equal(f.native.writes(), 0);
  const result = await f.controls.apply(plan.id, { kind: 'local' });
  assert.equal(result.state, 'applied');
  assert.equal(result.observed?.enabled, false);
  assert.deepEqual(await f.controls.apply(plan.id, { kind: 'local' }), result);
  assert.equal(f.native.writes(), 1);
  const next = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'native-job',
    action: 'resume',
  });
  f.native.changed();
  assert.equal((await f.controls.apply(next.id, { kind: 'local' })).state, 'rejected');
  assert.equal(f.native.writes(), 1);
});

test('lost native acknowledgements keep their evidence, hold the job/source and require a fresh human outcome review', async (t) => {
  const f = await fixture(t);
  f.native.lose();
  const plan = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'native-job',
    action: 'pause',
  });
  const result = await f.controls.apply(plan.id, { kind: 'local' });
  assert.equal(result.state, 'uncertain');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(f.controls.snapshot().needsReview, 1);
  assert.throws(() => f.sources.remove(f.source.id), /uncertain/);
  const next = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'native-job',
    action: 'resume',
  });
  await assert.rejects(f.controls.apply(next.id, { kind: 'local' }), /prior uncertain/);
  await assert.rejects(f.controls.review(result.id, { kind: 'local' }, 'short'), /checked/);
  const reviewed = await f.controls.review(
    result.id,
    { kind: 'tailscale', identity: 'operator@example.com' },
    'Checked the native run history and delivery records.',
  );
  assert.equal(reviewed.state, 'uncertain');
  assert.equal(reviewed.review?.observed.enabled, false);
  assert.equal(f.controls.snapshot().needsReview, 0);
  assert.equal(f.native.writes(), 1);
  assert.deepEqual(await f.controls.apply(result.id, { kind: 'local' }), reviewed);
  f.sources.remove(f.source.id);
});

test('restart never replays a submitted control and preserves the original actor', async (t) => {
  const f = await fixture(t);
  const receipt: NativeControlReceipt = {
    id: id(),
    sourceId: f.source.id,
    jobId: 'native-job',
    action: 'resume',
    title: 'Interrupted receipt',
    state: 'submitted',
    actor: { kind: 'tailscale', identity: 'operator@example.com' },
    createdAt: now(),
    updatedAt: now(),
    detail: 'Before external acknowledgement',
  };
  f.store.put('native_controls', receipt.id, receipt);
  const restarted = new NativeControls(f.store, f.sources, f.native.bridge);
  assert.equal(restarted.snapshot().needsReview, 1);
  assert.equal((await restarted.apply(receipt.id, { kind: 'local' })).state, 'uncertain');
  assert.deepEqual(restarted.snapshot().receipts[0].actor, receipt.actor);
  assert.equal(f.native.writes(), 0);
});

test('native controls share source admission, fence bindings and refuse unsupported source owners', async (t) => {
  const f = await fixture(t);
  f.busy(true);
  await assert.rejects(
    f.controls.prepare({ sourceId: f.source.id, jobId: 'native-job', action: 'pause' }),
    /current native/,
  );
  f.busy(false);
  const other = f.sources.add({ ...f.source, kind: 'codex-schedules' });
  await assert.rejects(
    f.controls.prepare({ sourceId: other.id, jobId: 'native-job', action: 'pause' }),
    /supported/,
  );
  const plan = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'native-job',
    action: 'pause',
  });
  f.store.put('native_sources', f.source.id, {
    ...f.source,
    home: join(f.source.home, 'different'),
  });
  await assert.rejects(f.controls.apply(plan.id, { kind: 'local' }));
  assert.equal(f.native.writes(), 0);
});

test('resume admission holds the source and does not submit when pressure protection rejects it', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controls = new NativeControls(f.store, f.sources, f.native.bridge, async () => {
    await held;
    throw new Error('critical memory pressure');
  });
  const plan = await controls.prepare({
    sourceId: f.source.id,
    jobId: 'native-job',
    action: 'resume',
  });
  const pending = controls.apply(plan.id, { kind: 'local' });
  // The source gate is synchronous, before pressure or filesystem awaits.
  assert.equal(f.sources.isReading, true);
  assert.throws(() => f.sources.remove(f.source.id), /read to finish/);
  await assert.rejects(
    f.controls.prepare({ sourceId: f.source.id, jobId: 'native-job', action: 'pause' }),
    /current native/,
  );
  release();
  await assert.rejects(pending, /critical/);
  assert.equal(controls.snapshot().receipts.length, 0);
  assert.equal(f.sources.isReading, false);
  assert.equal(f.native.writes(), 0);
});

test('native control API requires human CSRF authority, explicit review and normal admission for resume', async (t) => {
  const native = fixtureBridge();
  let critical = false;
  const state = await createApp({
    filename: ':memory:',
    test: true,
    nativeControlBridge: native.bridge,
    memoryPressureReader: () => ({
      state: critical ? 'critical' : 'normal',
      source: 'macos-sysctl',
      nativeValue: critical ? 4 : 1,
      checkedAt: now(),
    }),
  });
  t.after(() => state.app.close());
  const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': state.csrf };
  const source = (
    await state.app.inject({
      method: 'POST',
      url: '/api/native/sources',
      headers,
      payload: {
        kind: 'hermes-schedules',
        label: 'Owned API source',
        home: process.cwd(),
        endpoint: '',
      },
    })
  ).json();
  const input = { sourceId: source.id, jobId: 'native-job', action: 'resume' };
  for (const extra of [
    { authorization: 'Bearer companion' },
    { 'x-forge-csrf': 'wrong' },
    { 'x-forge-workspace': 'demo' },
  ]) {
    assert.ok(
      [403, 409].includes(
        (
          await state.app.inject({
            method: 'POST',
            url: '/api/native/controls/prepare',
            headers: { ...headers, ...extra },
            payload: input,
          })
        ).statusCode,
      ),
    );
  }
  const plan = (
    await state.app.inject({
      method: 'POST',
      url: '/api/native/controls/prepare',
      headers,
      payload: input,
    })
  ).json();
  const url = `/api/native/controls/${plan.id}/apply`;
  assert.equal(
    (await state.app.inject({ method: 'POST', url, headers, payload: { reviewed: false } }))
      .statusCode,
    400,
  );
  critical = true;
  assert.equal(
    (await state.app.inject({ method: 'POST', url, headers, payload: { reviewed: true } }))
      .statusCode,
    409,
  );
  assert.equal(native.writes(), 0);
  critical = false;
  assert.equal(
    (await state.app.inject({ method: 'POST', url, headers, payload: { reviewed: true } })).json()
      .state,
    'applied',
  );
  assert.equal(native.writes(), 1);
  const snapshot = (
    await state.app.inject({ method: 'GET', url: '/api/snapshot', headers })
  ).json();
  assert.equal(snapshot.nativeControls.receipts[0].state, 'applied');
});
