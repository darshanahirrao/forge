import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, now } from '../server/store.js';
import { NativeSources } from '../server/native-sources.js';
import { parseSchedulerObservation, readSchedulerObservation } from '../server/scheduler-health.js';
import { schedulerEvidence, type SchedulerObservation } from '../shared/scheduler.js';
import { createApp } from '../server/app.js';

const observation = (extra: Partial<SchedulerObservation> = {}): SchedulerObservation => ({
  contract: 'hermes-native-ticker/1',
  provider: 'builtin',
  loopAgeSeconds: 5,
  successAgeSeconds: 10,
  cadenceSeconds: 60,
  observedAt: now(),
  ...extra,
});

test('scheduler evidence ages without another process and never infers health from missing markers or an external provider', () => {
  const o = observation();
  const at = Date.parse(o.observedAt);
  assert.equal(schedulerEvidence(o, at).state, 'recent');
  assert.equal(schedulerEvidence(o, at + 201000).state, 'loop-stale');
  assert.equal(
    schedulerEvidence(observation({ successAgeSeconds: 500 }), at).state,
    'success-stale',
  );
  assert.equal(schedulerEvidence(observation({ loopAgeSeconds: null }), at).state, 'unknown');
  assert.equal(schedulerEvidence(observation({ successAgeSeconds: null }), at).state, 'unknown');
  assert.equal(schedulerEvidence(observation({ provider: 'chronos' }), at).state, 'external');
  assert.equal(schedulerEvidence(o, at - 10000).state, 'unknown');
  assert.equal(schedulerEvidence().state, 'unknown');
});

test('native observation parsing refuses malformed, private and replayed payloads without silently treating zero or missing evidence as healthy', () => {
  const input = {
    contract: 1,
    provider: 'builtin',
    loopAgeSeconds: 0,
    successAgeSeconds: 0,
    cadenceSeconds: 60,
    sampledAt: Date.now() / 1000,
  };
  assert.equal(schedulerEvidence(parseSchedulerObservation(input)).state, 'recent');
  assert.equal(parseSchedulerObservation({ ...input, sampledAt: 1 }).provider, null);
  assert.equal(
    parseSchedulerObservation({ ...input, sampledAt: Date.now() / 1000 + 60 }).provider,
    null,
  );
  for (const value of [
    { ...input, loopAgeSeconds: -1 },
    { ...input, successAgeSeconds: Infinity },
    { ...input, cadenceSeconds: 0 },
    { ...input, provider: 'PRIVATE/unsafe' },
    { ...input, secret: 'excluded' },
    { ...input, contract: 2 },
  ])
    assert.throws(() => parseSchedulerObservation(value));
});

test('on-demand scheduler checks share native admission, retain the last successful evidence on unavailability and never alter native job definitions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-scheduler-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'cron'));
  const filename = join(directory, 'cron', 'jobs.json');
  const definitions = JSON.stringify({
    jobs: [{ id: 'native-job', prompt: 'PRIVATE-INSTRUCTIONS', enabled: true }],
  });
  await writeFile(filename, definitions);
  const store = new Store(':memory:');
  t.after(() => store.close());
  let busy = false,
    probes = 0,
    unavailable = false;
  let release!: () => void;
  let held: Promise<void> | null = null;
  const sources = new NativeSources(store, {
    isManagedBusy: () => busy,
    schedulerProbe: async () => {
      probes++;
      if (held) await held;
      return observation(
        unavailable ? { provider: null, loopAgeSeconds: null, successAgeSeconds: null } : {},
      );
    },
  });
  const source = sources.add({
    kind: 'hermes-schedules',
    label: 'Fixture scheduler',
    home: directory,
    endpoint: '',
  });
  assert.equal(probes, 0);
  assert.equal(sources.list()[0].scheduler, undefined);
  busy = true;
  await assert.rejects(sources.scheduler(source.id), /current native worker/);
  assert.equal(probes, 0);
  busy = false;
  held = new Promise<void>((resolve) => (release = resolve));
  const first = sources.scheduler(source.id);
  assert.equal(sources.isReading, true);
  await assert.rejects(sources.scheduler(source.id), /current native worker/);
  assert.throws(() => sources.remove(source.id), /read to finish/);
  release();
  await first;
  held = null;
  const saved = sources.list()[0].scheduler;
  assert.equal(sources.isReading, false);
  assert.equal(saved?.provider, 'builtin');
  unavailable = true;
  const result = await sources.scheduler(source.id);
  assert.deepEqual(result.scheduler, saved);
  assert.equal(result.schedulerCheck?.available, false);
  assert.equal(await readFile(filename, 'utf8'), definitions);
  assert.equal(JSON.stringify(result).includes('PRIVATE-INSTRUCTIONS'), false);
  const unsupported = sources.add({
    kind: 'codex-schedules',
    label: 'Unsupported',
    home: directory,
    endpoint: '',
  });
  await assert.rejects(sources.scheduler(unsupported.id), /only for a Hermes/);
  assert.equal((await readSchedulerObservation(unsupported)).provider, null);
  sources.remove(source.id);
  assert.equal(await readFile(filename, 'utf8'), definitions);
});

test('scheduler inspection uses human workspace authority and cannot be triggered through demo or companion credentials', async (t) => {
  let probes = 0;
  const state = await createApp({
    filename: ':memory:',
    test: true,
    nativeSourcesOptions: {
      schedulerProbe: async () => {
        probes++;
        return observation();
      },
    },
  });
  t.after(() => state.app.close());
  const headers = {
    host: '127.0.0.1:4710',
    'x-forge-csrf': state.csrf,
    'content-type': 'application/json',
  };
  const source = (
    await state.app.inject({
      method: 'POST',
      url: '/api/native/sources',
      headers,
      payload: {
        kind: 'hermes-schedules',
        label: 'API fixture',
        home: process.cwd(),
        endpoint: '',
      },
    })
  ).json();
  const url = `/api/native/sources/${source.id}/scheduler`;
  for (const extra of [{ 'x-forge-csrf': 'wrong' }, { authorization: 'Bearer companion' }])
    assert.equal(
      (
        await state.app.inject({
          method: 'POST',
          url,
          headers: { ...headers, ...extra },
          payload: {},
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'x-forge-workspace': 'demo' },
        payload: {},
      })
    ).statusCode,
    409,
  );
  assert.equal(probes, 0);
  assert.equal(
    (await state.app.inject({ method: 'POST', url, headers, payload: {} })).statusCode,
    200,
  );
  assert.equal(probes, 1);
  const snapshot = (
    await state.app.inject({ method: 'GET', url: '/api/snapshot', headers })
  ).json();
  assert.equal(snapshot.nativeSources[0].scheduler.provider, 'builtin');
});
