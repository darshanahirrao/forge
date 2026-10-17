import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceMap } from '../server/resource-map.js';
import { attributeWorkers, type ProcessObservation } from '../server/processes.js';
import { MachineMonitor, processSummary } from '../server/machine.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { createApp } from '../server/app.js';
import type { Run } from '../shared/types.js';
import { Store } from '../server/store.js';

const birth = 'Sat Oct 17 00:00:00 2026';
const sampledAt = '2026-10-17T00:00:01.000Z';
const host = { pid: 17, uid: 501 };
function row(
  pid: number,
  parentPid: number,
  name = 'node',
  rss = 10,
  cpuPercent = 1,
): ProcessObservation {
  return { pid, parentPid, name, rss, cpuPercent, uid: host.uid, startedAt: birth };
}
const run = {
  id: 'run-1',
  workId: 'work-1',
  accountId: 'account-1',
  harness: 'codex',
  status: 'running',
  exitConfirmed: false,
  nativeWorker: {
    version: 1,
    pid: 42,
    ownerPid: host.pid,
    uid: host.uid,
    startedAt: birth,
    capturedAt: sampledAt,
  },
} as Run;
function observe(rows: ProcessObservation[] | null, runs: Run[] = [run]) {
  return resourceMap(rows, attributeWorkers(runs, new Map(), rows, sampledAt), sampledAt, host);
}

test('resource queries leave finished history in SQLite while retaining current and every unconfirmed worker', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.transaction(() => {
    for (let index = 0; index < 1000; index++)
      store.put('runs', `history-${index}`, {
        ...run,
        id: `history-${index}`,
        status: 'completed',
        exitConfirmed: true,
      });
  });
  const relevant = [
    run,
    { ...run, id: 'lost-worker', status: 'interrupted', exitConfirmed: false },
    { ...run, id: 'legacy-unknown-exit', status: 'completed', exitConfirmed: undefined },
    { ...run, id: 'current-state-conflict', exitConfirmed: true },
  ];
  for (const item of relevant) store.put('runs', item.id, item);
  store.put('runs', 'no-spawn', { ...run, id: 'no-spawn', nativeWorker: undefined });
  assert.deepEqual(
    store
      .resourceRuns()
      .map((item) => item.id)
      .sort(),
    relevant.map((item) => item.id).sort(),
  );
  assert.equal(store.all('runs').length, 1005);
  assert.equal(store.get<Run>('runs', 'history-999')!.exitConfirmed, true);
});

test('resource map partitions host, managed work, native app trees and other processes exactly once', () => {
  const rows = [
    row(17, 1),
    row(18, 17, 'native-probe'),
    row(42, 17, 'codex', 50, 120),
    row(43, 42, 'tool', 30, 12),
    row(70, 1, 'Codex', 100, 3),
    row(71, 70, 'Codex Helper (Renderer)', 80, 4),
    row(72, 71, 'browser-helper', 60, 5),
    row(73, 70, 'claude', 20, 2),
    row(90, 1, 'node', 300, 8),
    row(91, 1, 'python', 100, 2),
  ];
  const result = observe(rows);
  const group = (id: string) => result.groups.find((item) => item.id === id)!;
  assert.equal(result.coverage, 'observed');
  assert.equal(result.sampledAt, sampledAt);
  assert.equal(group('forge-host').processCount, 2);
  assert.equal(group('forge-host').rss, 20);
  assert.equal(group('run:run-1').processCount, 2);
  assert.equal(group('run:run-1').rss, 80);
  assert.equal(group('native-app:codex').processCount, 3);
  assert.equal(group('native-app:codex').rss, 240);
  assert.equal(group('native-app:claude').processCount, 1);
  assert.equal(group('other').rss, 400);
  assert.equal(result.processCount, rows.length);
  assert.equal(
    result.groups.reduce((sum, item) => sum + item.processCount, 0),
    rows.length,
  );
  assert.equal(
    result.rss,
    rows.reduce((sum, item) => sum + item.rss, 0),
  );
  assert.equal(
    result.cpuPercent,
    rows.reduce((sum, item) => sum + item.cpuPercent, 0),
  );
  assert(result.cpuPercent! > 100);
  assert.deepEqual(group('native-app:codex').rootPids, [70, 71]);
});

test('unconfirmed, reused and missing roots keep unknown resource measurements and do not prove exit', () => {
  const original = structuredClone(run);
  original.status = 'interrupted';
  const rows = [row(17, 1), { ...row(42, 17), startedAt: 'different start' }, row(43, 42)];
  const result = observe(rows, [original]);
  const managed = result.groups.find((item) => item.kind === 'managed')!;
  assert.equal(managed.state, 'identity-changed');
  assert.equal(managed.rss, null);
  assert.equal(managed.cpuPercent, null);
  assert.equal(result.unresolvedWorkers, 1);
  assert.equal(result.groups.find((item) => item.kind === 'host')!.rss, 10);
  assert.equal(result.groups.find((item) => item.kind === 'other')!.rss, 20);
  assert.equal(original.exitConfirmed, false);
  const missing = observe([row(17, 1)], [original]);
  assert.equal(missing.groups.find((item) => item.kind === 'managed')!.state, 'not-observed');
  assert.equal(missing.groups.find((item) => item.kind === 'managed')!.rss, null);
});

test('duplicate managed root receipts become ambiguous without charging the same process twice', () => {
  const rows = [row(17, 1), row(42, 17, 'node', 100), row(43, 42, 'tool', 50)];
  const result = observe(rows, [run, { ...run, id: 'another-run', workId: 'another-work' }]);
  const managed = result.groups.filter((item) => item.kind === 'managed');
  assert.equal(managed.length, 2);
  assert(managed.every((item) => item.state === 'ambiguous' && item.rss === null));
  assert.equal(result.unresolvedWorkers, 2);
  assert.equal(result.rss, 160);
  assert.equal(
    result.groups.reduce((sum, item) => sum + item.processCount, 0),
    rows.length,
  );
  assert.equal(result.groups.find((item) => item.kind === 'other')!.rss, 150);
});

test('unavailable and duplicate native samples never become a zero-cost healthy resource map', () => {
  const rows = [row(17, 1), row(42, 17)];
  for (const table of [null, [...rows, rows[0]]]) {
    const result = observe(table);
    assert.equal(result.coverage, 'unavailable');
    assert.equal(result.rss, null);
    assert.equal(result.cpuPercent, null);
    assert.equal(result.processCount, 0);
    assert(result.groups.every((group) => group.rss === null && group.state === 'unavailable'));
  }
});

test('native app name matching is exact and current-user scoped; generic shared runtimes remain unattributed', () => {
  const result = observe(
    [
      row(17, 1),
      row(50, 1, 'not-codex'),
      row(51, 1, 'python'),
      row(52, 1, 'node'),
      { ...row(53, 1, 'Codex'), uid: 999 },
      row(54, 1, 'OPENCLAW'),
      row(55, 54, 'node'),
    ],
    [],
  );
  assert.deepEqual(
    result.groups.filter((group) => group.kind === 'native-app').map((group) => group.label),
    ['OpenClaw'],
  );
  assert.equal(result.groups.find((group) => group.id === 'native-app:openclaw')!.processCount, 2);
  assert.equal(result.groups.find((group) => group.kind === 'other')!.processCount, 4);
  const privateOutput = JSON.stringify(result);
  for (const excluded of ['startedAt', 'uid', 'parentPid', 'accountId', 'environment', 'argv'])
    assert.equal(privateOutput.includes(`"${excluded}"`), false);
});

test('a nested managed worker is a separate boundary, including when a completed old root is present', () => {
  const rows = [row(17, 1), row(42, 17), row(43, 42), row(44, 43)];
  const nested = {
    ...run,
    id: 'nested',
    workId: 'nested-work',
    nativeWorker: { ...run.nativeWorker!, pid: 43 },
  };
  const old = {
    ...run,
    id: 'old',
    status: 'completed' as const,
    exitConfirmed: true,
    nativeWorker: { ...run.nativeWorker!, pid: 44 },
  };
  const result = observe(rows, [run, nested, old]);
  assert.equal(result.groups.find((group) => group.id === 'run:run-1')!.processCount, 1);
  assert.equal(result.groups.find((group) => group.id === 'run:nested')!.processCount, 2);
  assert.equal(
    result.groups.some((group) => group.id === 'run:old'),
    false,
  );
  assert.equal(result.rss, 40);
});

test('monitor coalesces concurrent resource requests and shares one sample epoch with CPU-ranked processes', async () => {
  let reads = 0,
    release!: (rows: ProcessObservation[]) => void;
  const query = new Promise<ProcessObservation[]>((resolve) => {
    release = resolve;
  });
  const monitor = new MachineMonitor(unknownPressure, async () => {
    reads++;
    return query;
  });
  const requests = Array.from({ length: 8 }, () => monitor.observe([], []));
  const uid = process.getuid?.() ?? 501;
  release([
    { ...row(process.pid, 1, 'node', 200, 1), uid },
    { ...row(876543, 1, 'small-busy-process', 10, 90), uid },
  ]);
  const results = await Promise.all(requests);
  assert.equal(reads, 1);
  for (const result of results) {
    assert.equal(result.resources.sampledAt, result.machine.sampledAt);
    assert.equal(result.machine.processes[0].name, 'node');
    assert.equal(result.machine.busiestProcesses![0].name, 'small-busy-process');
    assert.equal(result.resources.rss, 210);
  }
  await monitor.observe([], []);
  assert.equal(reads, 1);
  assert.equal(processSummary([row(2, 1), row(1, 1)])[0].pid, 1);
});

test('failed process queries preserve machine totals and return explicit unavailable coverage', async () => {
  const monitor = new MachineMonitor(unknownPressure, async () => {
    throw new Error('private diagnostic must not escape');
  });
  const result = await monitor.observe([], []);
  assert.equal(result.machine.processCoverage, 'unavailable');
  assert.equal(result.resources.coverage, 'unavailable');
  assert(result.machine.totalMemory > 0);
  assert.deepEqual(result.machine.processes, []);
  assert.deepEqual(result.machine.busiestProcesses, []);
  assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
});

test('local snapshots share resource timestamps while demo cannot expose managed resource identities', async (t) => {
  const state = await createApp({
    filename: ':memory:',
    test: true,
    memoryPressureReader: unknownPressure,
  });
  t.after(() => state.app.close());
  const local = (
    await state.app.inject({ url: '/api/snapshot', headers: { host: '127.0.0.1:4710' } })
  ).json();
  assert.equal(local.resources.contract, 'forge.resource-observation/1');
  assert.equal(local.resources.sampledAt, local.machine.sampledAt);
  assert(
    local.nativeWorkers.every(
      (worker: { sampledAt: string }) => worker.sampledAt === local.machine.sampledAt,
    ),
  );
  const demo = (
    await state.app.inject({
      url: '/api/snapshot',
      headers: { host: '127.0.0.1:4710', 'x-forge-workspace': 'demo' },
    })
  ).json();
  assert.equal(demo.resources, undefined);
  assert.deepEqual(demo.nativeWorkers, []);
  assert(demo.machine.totalMemory > 0);
});
