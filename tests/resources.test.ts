import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  attributeWorkers,
  captureWorker,
  parseProcessTable,
  processTable,
  type ProcessObservation,
} from '../server/processes.js';
import { Store, now } from '../server/store.js';
import { ExecutionController } from '../server/execution.js';
import type { Account, Run, Work } from '../shared/types.js';
import type { DriverSink } from '../server/adapters/driver.js';

const birth = 'Sat Oct 17 00:00:00 2026';
const worker = {
  version: 1 as const,
  pid: 42,
  ownerPid: 17,
  uid: 501,
  startedAt: birth,
  capturedAt: now(),
};
const run: Run = {
  id: 'run',
  workId: 'work',
  accountId: 'account',
  harness: 'codex',
  generation: 1,
  nativeSessionId: 'session',
  nativeTurnId: 'turn',
  status: 'running',
  startedAt: now(),
  endedAt: null,
  nativeWorker: worker,
};
const rows: ProcessObservation[] = [
  { pid: 42, parentPid: 1, uid: 501, startedAt: birth, name: 'native', rss: 100, cpuPercent: 1 },
  { pid: 43, parentPid: 42, uid: 501, startedAt: birth, name: 'tool', rss: 50, cpuPercent: 2 },
  { pid: 44, parentPid: 43, uid: 501, startedAt: birth, name: 'helper', rss: 25, cpuPercent: 3 },
  { pid: 45, parentPid: 1, uid: 501, startedAt: birth, name: 'foreign', rss: 999, cpuPercent: 9 },
];
test('native ownership includes the observed tree, while other processes retain native control', () => {
  const value = attributeWorkers([run], new Map(), rows, now())[0];
  assert.equal(value.state, 'live');
  assert.deepEqual(value.pids, [42, 43, 44]);
  assert.equal(value.rss, 175);
  assert.equal(value.cpuPercent, 6);
  assert.equal(value.harness, 'codex');
  assert.equal(
    attributeWorkers([{ ...run, status: 'completed', exitConfirmed: true }], new Map(), rows, now())
      .length,
    0,
  );
});
test('PID reuse, absent roots, unknown identity and duplicate observations cannot confer ownership or exit', () => {
  const original = structuredClone(run);
  original.status = 'interrupted';
  original.exitConfirmed = false;
  for (const [table, expected] of [
    [
      rows.map((p) => (p.pid === 42 ? { ...p, startedAt: 'another birth' } : p)),
      'identity-changed',
    ],
    [rows.map((p) => (p.pid === 42 ? { ...p, uid: 777 } : p)), 'identity-changed'],
    [rows.filter((p) => p.pid !== 42), 'not-observed'],
    [null, 'unavailable'],
    [[...rows, rows[0]], 'unavailable'],
  ] as const) {
    const value = attributeWorkers([original], new Map(), table ? [...table] : null, now())[0];
    assert.equal(value.state, expected);
    assert.equal(value.rss, null);
    assert.deepEqual(value.pids, []);
    assert.equal(original.exitConfirmed, false);
  }
});

test('a nested recorded worker forms its own resource boundary', () => {
  const nested = {
    ...run,
    id: 'nested',
    workId: 'other-work',
    nativeWorker: { ...worker, pid: 43 },
  };
  const values = attributeWorkers([run, nested], new Map(), rows, now());
  assert.deepEqual(values[0].pids, [42]);
  assert.equal(values[0].rss, 100);
  assert.deepEqual(values[1].pids, [43, 44]);
  assert.equal(values[1].rss, 75);
});
test('process inventory preserves C-locale identity and excludes arguments and environment collection', () => {
  const parsed = parseProcessTable(
    '42 17 501 Sat Oct 17 00:00:00 2026 100 2.5 /usr/bin/native\n43 42 501 Sat Oct 17 00:00:01 2026 20 0.0 native helper\n',
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'native');
  assert.equal(parsed[0].rss, 102400);
  assert.equal(parsed[0].startedAt, birth);
  assert.equal(parsed[1].parentPid, 42);
});
test(
  'an actual child is captured before input and recovery keeps its receipt without adopting it',
  { skip: process.platform === 'win32' },
  async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const store = new Store(':memory:');
    let sink!: DriverSink;
    const account = { id: 'account', harness: 'codex', label: 'Native fixture' } as Account;
    const work = {
      id: 'work',
      accountId: account.id,
      harness: 'codex',
      title: 'Owned process',
      goal: 'No model calls.',
      cwd: process.cwd(),
      acceptance: '',
      context: '',
      status: 'ready',
      priority: 'normal',
      revision: 0,
      generation: 0,
      nativeSessionId: null,
      activeRunId: null,
      createdAt: now(),
      updatedAt: now(),
    } as Work;
    store.put('accounts', account.id, account);
    store.put('work', work.id, work);
    const execution = new ExecutionController(store, () => ({
      harness: 'codex',
      closed: false,
      start: async (_context, next) => {
        sink = next;
        await next.worker?.(child.pid!);
        next.session('session');
      },
      interrupt: async () => {},
      close: async () => {
        child.kill();
        await exit;
      },
    }));
    try {
      const launched = await execution.launch(work.id, false, false);
      for (let i = 0; i < 100 && !store.get<Run>('runs', launched.id)?.nativeWorker?.startedAt; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const recorded = store.get<Run>('runs', launched.id)!;
      assert.equal(recorded.nativeWorker?.pid, child.pid);
      assert.equal(recorded.nativeWorker?.ownerPid, process.pid);
      assert(recorded.nativeWorker?.startedAt);
      assert.equal(recorded.nativeWorker?.uid, process.getuid?.());
      assert.equal((await captureWorker(child.pid!)).startedAt, recorded.nativeWorker.startedAt);
      assert.equal(
        attributeWorkers([recorded], new Map(), await processTable(), now())[0].state,
        'live',
      );
      store.recoverInterruptedRuns();
      const recovered = store.get<Run>('runs', launched.id)!;
      assert.equal(recovered.exitConfirmed, false);
      assert.equal(recovered.nativeWorker?.pid, child.pid);
      assert.equal(
        attributeWorkers([recovered], new Map(), await processTable(), now())[0].state,
        'live',
      );
      await assert.rejects(sink.worker!(process.pid), /ownership/);
    } finally {
      await execution.close();
      store.close();
    }
  },
);
