import assert from 'node:assert/strict';
import { createApp } from '../../dist/server/app.js';
import { readMemoryPressure } from '../../dist/server/memory-pressure.js';

assert(['darwin', 'linux'].includes(process.platform), 'This check requires macOS or Linux PSI.');
let sample,
  factories = 0;
const state = await createApp({
  filename: ':memory:',
  port: 0,
  csrf: 'native-headroom-fixture',
  memoryPressureReader: async () => (sample = await readMemoryPressure()),
  driverFactory: () => {
    factories++;
    let closed = false;
    // Inert boundary fixture. This check never starts a harness, model or pressure generator.
    return {
      harness: 'codex',
      get closed() {
        return closed;
      },
      async start(_context, sink) {
        sink.ended('completed', 'Inert headroom fixture', 'No native worker or input was created.');
      },
      async interrupt() {},
      async close() {
        closed = true;
      },
    };
  },
});
try {
  const url = await state.app.listen({ host: '127.0.0.1', port: 0 });
  const post = async (path, data) => {
    const response = await fetch(url + '/api' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-csrf': state.csrf, origin: url },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  const account = await post('/accounts', { label: 'Inert headroom fixture', harness: 'codex' });
  assert.equal(account.status, 201);
  const work = await post('/work', {
    title: 'Native pressure query fixture',
    project: 'Native query fixture',
    goal: 'Observe native pressure without applying load.',
    harness: 'codex',
    accountId: account.body.id,
    cwd: process.cwd(),
  });
  assert.equal(work.status, 201);
  const launch = await post(`/work/${work.body.id}/launch`, {
    expectedRevision: work.body.revision,
  });
  assert(sample, 'Admission did not query native pressure.');
  if (process.platform === 'darwin') {
    assert.equal(sample.source, 'macos-sysctl');
    assert(['normal', 'warning', 'critical'].includes(sample.state));
  } else {
    assert.equal(sample.source, 'linux-psi');
    assert(sample.linux?.host, 'The native Linux PSI host interface is unavailable.');
    assert.equal(sample.nativeValue, null, 'Linux health states are a Forge interpretation.');
  }
  const held = ['warning', 'critical'].includes(sample.state);
  assert.equal(launch.status, held ? 409 : 202, JSON.stringify(launch.body));
  assert.equal(factories, held ? 0 : 1);
  if (held) assert.equal(state.local.all('runs').length, 0);
  console.log(
    JSON.stringify({
      status: 'passed',
      nativePressure: sample.state,
      nativeValue: sample.nativeValue,
      source: sample.source,
      ...(sample.linux ? { linux: sample.linux } : {}),
      nativeQueryVerified: true,
      pressureHoldObserved: held,
      driver: 'inert fixture',
      nativeWorkersCreated: 0,
      pressureInjected: false,
      paidModelCalls: 0,
    }),
  );
} finally {
  await state.app.close();
}
