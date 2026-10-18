import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { parseMemoryPressure, unknownPressure } from '../server/memory-pressure.js';
import type { MemoryPressure, Run, Work } from '../shared/types.js';
import { readLinuxMemoryPressure } from '../server/linux-memory-pressure.js';

async function fixture(
  t: test.TestContext,
  reader: () => MemoryPressure | Promise<MemoryPressure>,
) {
  let factories = 0,
    starts = 0,
    interrupts = 0,
    closes = 0;
  const state = await createApp({
    filename: ':memory:',
    csrf: 'headroom-fixture',
    test: true,
    memoryPressureReader: reader,
    driverFactory: () => {
      factories++;
      let closed = false;
      return {
        harness: 'codex',
        get closed() {
          return closed;
        },
        async start(_context, sink) {
          starts++;
          sink.session('fixture-session');
          sink.turn('fixture-turn');
        },
        async interrupt() {
          interrupts++;
        },
        async close() {
          closes++;
          closed = true;
        },
      };
    },
  });
  t.after(() => state.app.close());
  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    state.app.inject({
      method,
      url,
      payload: payload === undefined ? undefined : JSON.stringify(payload),
      headers: {
        host: '127.0.0.1:4710',
        'x-forge-csrf': 'headroom-fixture',
        'content-type': 'application/json',
      },
    });
  const account = (
    await call('POST', '/api/accounts', { label: 'Headroom fixture', harness: 'codex' })
  ).json();
  const work = (
    await call('POST', '/api/work', {
      title: 'Headroom boundary fixture',
      project: 'Fixture',
      goal: 'Do not create a native worker under reported pressure.',
      harness: 'codex',
      accountId: account.id,
      cwd: process.cwd(),
    })
  ).json() as Work;
  const launch = () =>
    call('POST', `/api/work/${work.id}/launch`, { expectedRevision: work.revision });
  return {
    ...state,
    work,
    account,
    call,
    launch,
    counts: () => ({ factories, starts, interrupts, closes }),
  };
}
test('macOS pressure uses native Dispatch flags and never mistakes unknown/internal enum values for healthy coverage', () => {
  assert.equal(parseMemoryPressure('1\n').state, 'normal');
  assert.equal(parseMemoryPressure('2\n').state, 'warning');
  assert.equal(parseMemoryPressure('4\n').state, 'critical');
  for (const value of ['0', '3', '5', '2 4', 'warning', '4\nother output', '']) {
    const pressure = parseMemoryPressure(value);
    assert.equal(pressure.state, 'unknown');
    assert.equal(pressure.nativeValue, null);
  }
});
test('warning and critical reports reject native launch before factory creation without creating a run or changing work', async (t) => {
  for (const value of ['2', '4']) {
    const f = await fixture(t, () => parseMemoryPressure(value));
    const response = await f.launch();
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.json().error, /No native attempt was created/);
    assert.equal(f.counts().factories, 0);
    assert.equal(f.controller.activeCount, 0);
    assert.equal(f.local.all<Run>('runs').length, 0);
    assert.deepEqual(f.local.work(f.work.id), f.work);
  }
});
test('native Linux PSI interpretation uses the same no-run admission boundary and observe-only policy', async (t) => {
  const pressure = await readLinuxMemoryPressure(async (path) => {
    if (path === '/proc/pressure/memory')
      return 'some avg10=22.00 avg60=1.00 avg300=0.00 total=900\nfull avg10=11.00 avg60=1.00 avg300=0.00 total=800\n';
    throw new Error('Cgroup discovery unavailable');
  });
  const f = await fixture(t, () => pressure);
  assert.equal((await f.launch()).statusCode, 409);
  assert.equal(f.counts().factories, 0);
  assert.equal(f.local.all<Run>('runs').length, 0);
  assert.deepEqual(f.local.work(f.work.id), f.work);
  assert.equal(
    (await f.call('PATCH', '/api/settings', { memoryPressurePolicy: 'observe' })).statusCode,
    200,
  );
  assert.equal((await f.launch()).statusCode, 202);
  assert.equal(f.counts().factories, 1);
});
test('admission refreshes pressure after a healthy UI sample and updates that sample without admitting a worker', async (t) => {
  let value = '1';
  const f = await fixture(t, () => parseMemoryPressure(value));
  assert.equal(
    (await f.call('GET', '/api/snapshot')).json().machine.memoryPressure.state,
    'normal',
  );
  value = '4';
  assert.equal((await f.launch()).statusCode, 409);
  assert.equal(f.counts().factories, 0);
  assert.equal(
    (await f.call('GET', '/api/snapshot')).json().machine.memoryPressure.state,
    'critical',
  );
});
test('pressure observation leaves an existing managed worker and its native controls running', async (t) => {
  let value = '1';
  const f = await fixture(t, () => parseMemoryPressure(value));
  assert.equal((await f.launch()).statusCode, 202);
  value = '2';
  const snapshot = (await f.call('GET', '/api/snapshot')).json();
  assert.equal(snapshot.machine.memoryPressure.state, 'warning');
  assert.equal(f.local.work(f.work.id).status, 'running');
  assert.deepEqual(f.counts(), { factories: 1, starts: 1, interrupts: 0, closes: 0 });
});
test('observe-only policy is explicit and persisted while invalid policies are rejected', async (t) => {
  const f = await fixture(t, () => parseMemoryPressure('4'));
  assert.equal(
    (await f.call('PATCH', '/api/settings', { memoryPressurePolicy: 'invalid' })).statusCode,
    400,
  );
  assert.equal(
    (await f.call('PATCH', '/api/settings', { memoryPressurePolicy: 'observe' })).statusCode,
    200,
  );
  assert.equal(f.local.settings().memoryPressurePolicy, 'observe');
  assert.equal((await f.launch()).statusCode, 202);
  assert.equal(f.counts().factories, 1);
});
test('admission holds capacity through a pressure read and rechecks quiet mode before constructing a native driver', async (t) => {
  let finish!: (value: MemoryPressure) => void;
  let reading!: () => void;
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const pending = new Promise<MemoryPressure>((resolve) => {
    finish = resolve;
  });
  const f = await fixture(t, () => {
    reading();
    return pending;
  });
  const request = f.launch();
  try {
    await entered;
    assert.equal(f.controller.activeCount, 1);
    assert.equal((await f.launch()).statusCode, 409);
    assert.equal((await f.call('POST', `/api/accounts/${f.account.id}/probe`, {})).statusCode, 409);
    await f.call('PATCH', '/api/settings', { quietMode: true });
    finish(parseMemoryPressure('1'));
    assert.equal((await request).statusCode, 409);
    assert.equal(f.counts().factories, 0);
    assert.equal(f.controller.activeCount, 0);
  } finally {
    finish(unknownPressure());
    await request;
  }
});
test('the latest resource policy is used after a pending pressure query', async (t) => {
  let finish!: (value: MemoryPressure) => void;
  let reading!: () => void;
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const pending = new Promise<MemoryPressure>((resolve) => {
    finish = resolve;
  });
  const f = await fixture(t, () => {
    reading();
    return pending;
  });
  await f.call('PATCH', '/api/settings', { memoryPressurePolicy: 'observe' });
  const request = f.launch();
  try {
    await entered;
    await f.call('PATCH', '/api/settings', { memoryPressurePolicy: 'protect' });
    finish(parseMemoryPressure('2'));
    assert.equal((await request).statusCode, 409);
    assert.equal(f.counts().factories, 0);
  } finally {
    finish(unknownPressure());
    await request;
  }
});
test('unavailable and failed pressure queries remain unknown without fabricating a healthy report', async (t) => {
  for (const reader of [
    unknownPressure,
    () => {
      throw new Error('fixture query unavailable');
    },
  ]) {
    const f = await fixture(t, reader);
    const sample = (await f.call('GET', '/api/snapshot')).json().machine.memoryPressure;
    assert.equal(sample.state, 'unknown');
    assert.equal(sample.source, 'unavailable');
    assert.equal((await f.launch()).statusCode, 202);
  }
});
