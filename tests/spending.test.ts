import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Spending } from '../server/spending.js';
import { Store, id, now } from '../server/store.js';
import { unknownPressure } from '../server/memory-pressure.js';
import type { DriverContext, DriverSink } from '../server/adapters/driver.js';
import type { Run, Usage, Work } from '../shared/types.js';

async function fixture(t: test.TestContext, pressure = async () => unknownPressure()) {
  let factories = 0;
  const contexts: DriverContext[] = [],
    sinks: DriverSink[] = [];
  const state = await createApp({
    filename: ':memory:',
    csrf: 'spending-test',
    test: true,
    memoryPressureReader: pressure,
    driverFactory: (context) => {
      factories++;
      contexts.push(context);
      return {
        harness: 'codex',
        closed: false,
        async start(_context, sink) {
          sinks.push(sink);
          sink.session('spending-session');
          sink.turn(context.run.id);
        },
        async interrupt() {},
        async close() {},
      };
    },
  });
  t.after(() => state.app.close());
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    state.app.inject({
      method,
      url,
      payload: payload === undefined ? undefined : JSON.stringify(payload),
      headers: {
        host: '127.0.0.1:4710',
        'x-forge-csrf': state.csrf,
        'content-type': 'application/json',
      },
    });
  const account = (
    await call('POST', '/api/accounts', { label: 'Spending fixture', harness: 'codex' })
  ).json();
  async function work() {
    return (
      await call('POST', '/api/work', {
        title: 'Spending evidence',
        project: 'Fixture',
        goal: 'Verify conservative admission.',
        cwd: process.cwd(),
        harness: 'codex',
        accountId: account.id,
      })
    ).json() as Work;
  }
  const current = await work();
  async function policy(
    monthlyUsd: number | null,
    workUsd: number | null,
    attemptUsd: number | null,
  ) {
    return call('PATCH', '/api/spending/policy', {
      expectedRevision: state.controller.spending.policy().revision,
      monthlyUsd,
      workUsd,
      attemptUsd,
    });
  }
  function usage(cost: number | null, tokens = 100, key = 'spending:session'): Usage {
    return {
      key,
      workId: contexts.at(-1)!.work.id,
      accountId: account.id,
      harness: 'codex',
      source: 'codex/app-server',
      counterScope: 'session',
      scope: 'Cumulative native session',
      inputTokens: tokens,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: tokens,
      estimatedUsd: cost,
      observedAt: now(),
    };
  }
  const emit = (cost: number | null, tokens = 100, key?: string) =>
    sinks.at(-1)!.usage(usage(cost, tokens, key));
  async function finish() {
    sinks.at(-1)!.ended('completed', 'Fixture completed', 'No inference.');
    for (let i = 0; i < 100 && state.controller.activeCount; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(state.controller.activeCount, 0);
  }
  const launch = (workId = current.id, extra = {}) =>
    call('POST', `/api/work/${workId}/launch`, {
      expectedRevision: state.local.work(workId).revision,
      ...extra,
    });
  return {
    ...state,
    call,
    account,
    current,
    contexts,
    sinks,
    policy,
    usage,
    emit,
    finish,
    launch,
    work,
    factories: () => factories,
  };
}

test('spending policies require finite explicit reservations and protect revisions and human authority', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.policy(5, null, null)).statusCode, 400);
  for (const amount of [-1, 0, 1e9])
    assert.equal((await f.policy(null, null, amount)).statusCode, 400);
  assert.equal((await f.policy(10, 5, 1)).statusCode, 200);
  assert.equal(
    (
      await f.call('PATCH', '/api/spending/policy', {
        expectedRevision: 0,
        monthlyUsd: 20,
        workUsd: null,
        attemptUsd: 1,
      })
    ).statusCode,
    409,
  );
  const bearer = await f.app.inject({
    method: 'PATCH',
    url: '/api/spending/policy',
    headers: {
      host: '127.0.0.1:4710',
      authorization: 'Bearer companion-not-human',
      'x-forge-csrf': f.csrf,
    },
    payload: {},
  });
  assert.equal(bearer.statusCode, 403);
  const demo = await f.app.inject({
    method: 'GET',
    url: '/api/spending',
    headers: { host: '127.0.0.1:4710', 'x-forge-workspace': 'demo' },
  });
  assert.equal(demo.statusCode, 409);
});
test('budget admission reserves before execution and blocks monthly or per-work capacity without a new driver', async (t) => {
  const f = await fixture(t);
  await f.policy(1, 0.8, 0.6);
  assert.equal((await f.launch()).statusCode, 202);
  assert.equal(f.contexts[0].maxBudgetUsd, 0.6);
  assert.equal(f.controller.spending.snapshot().reservedUsd, 0.6);
  f.emit(0.5);
  await f.finish();
  const denied = await f.launch();
  assert.equal(denied.statusCode, 409);
  assert.match(denied.json().error, /monthly budget/);
  assert.equal(f.factories(), 1);
  await f.policy(10, 0.8, 0.6);
  const workDenied = await f.launch();
  assert.equal(workDenied.statusCode, 409);
  assert.match(workDenied.json().error, /work budget/);
  assert.equal(f.controller.spending.snapshot().accountedUsd, 0.5);
});
test('resumed native counters and repeated reports count attempt deltas exactly once', async (t) => {
  const f = await fixture(t);
  await f.policy(20, 20, 5);
  assert.equal((await f.launch()).statusCode, 202);
  f.emit(1, 100);
  f.emit(1, 100);
  f.emit(2, 150);
  await f.finish();
  assert.equal((await f.launch()).statusCode, 202);
  f.emit(3, 200);
  f.emit(4, 250);
  await f.finish();
  const snapshot = f.controller.spending.snapshot();
  assert.equal(snapshot.accountedUsd, 4);
  assert.equal(snapshot.reportedTokens, 250);
  assert.deepEqual(
    snapshot.attempts.map((row) => row.estimatedUsd),
    [2, 2],
  );
  assert.equal(f.local.all<Usage>('usage')[0].estimatedUsd, 4);
});
test('unknown cost retains reservations across months until a settled human review', async (t) => {
  const f = await fixture(t);
  await f.policy(10, 10, 1);
  assert.equal((await f.launch()).statusCode, 202);
  f.emit(null);
  const active = f.controller.spending.attempts()[0];
  assert.equal(
    (
      await f.call('POST', `/api/spending/${active.runId}/review`, {
        expectedRevision: active.revision,
        usd: 0,
        note: 'Not settled yet',
      })
    ).statusCode,
    409,
  );
  await f.finish();
  const unknown = f.controller.spending.attempts()[0];
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.accountedUsd, 1);
  const stored = f.local.get<Record<string, unknown>>('spend_attempts', unknown.runId)!;
  f.local.put('spend_attempts', unknown.runId, { ...stored, period: '2025-01' });
  assert.equal((await f.launch()).statusCode, 409);
  const reviewed = await f.call('POST', `/api/spending/${unknown.runId}/review`, {
    expectedRevision: unknown.revision,
    usd: 0,
    note: 'Provider confirmed this attempt was included.',
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(reviewed.json().accountedUsd, 0);
  assert.deepEqual(reviewed.json().review.actor, { kind: 'local' });
  assert.equal(f.local.all<Usage>('usage')[0].estimatedUsd, null);
  assert.equal((await f.launch()).statusCode, 202);
});
test('missing resumed baselines and decreasing native counters never manufacture zero cost coverage', async (t) => {
  const f = await fixture(t);
  f.local.updateWork(f.current.id, { nativeSessionId: 'spending-session' });
  await f.launch();
  f.emit(4);
  await f.finish();
  let receipt = f.controller.spending.attempts()[0];
  assert.equal(receipt.state, 'unknown');
  assert.equal(receipt.estimatedUsd, null);
  await f.policy(null, null, null);
  await f.launch();
  f.emit(1, 50);
  await f.finish();
  receipt = f.controller.spending.attempts()[0];
  assert.equal(receipt.state, 'unknown');
  assert.match(receipt.issues.join(' '), /reset or decreased/);
  assert.ok(receipt.accountedUsd >= 0);
  assert.ok(receipt.totalTokens >= 0);
});
test('a native estimate above its reservation holds further budgeted launches for explicit review', async (t) => {
  const f = await fixture(t);
  await f.policy(100, 100, 1);
  await f.launch();
  f.emit(1.25);
  await f.finish();
  assert.equal(f.controller.spending.snapshot().accountedUsd, 1.25);
  const denied = await f.launch();
  assert.equal(denied.statusCode, 409);
  assert.match(denied.json().error, /exceeded/);
  assert.equal(f.factories(), 1);
});
test('a changed budget is rechecked after asynchronous admission and before driver construction', async (t) => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async () => {
    enter();
    await pending;
    return unknownPressure();
  });
  const request = f.launch(f.current.id, { spendingRevision: 0 });
  try {
    await entered;
    await f.policy(10, 10, 2);
    release();
    assert.equal((await request).statusCode, 409);
    assert.equal(f.factories(), 0);
    assert.equal(f.controller.spending.attempts().length, 0);
  } finally {
    release();
    await request;
  }
});
test('accepted outcomes require settled native work, retain an operator note and become stale on later edits', async (t) => {
  const f = await fixture(t);
  let revision = f.local.work(f.current.id).revision;
  assert.equal(
    (
      await f.call('POST', `/api/work/${f.current.id}/outcome`, {
        expectedRevision: revision,
        decision: 'accepted',
        note: 'No native work yet',
      })
    ).statusCode,
    409,
  );
  await f.launch();
  f.emit(0.5);
  await f.finish();
  revision = f.local.work(f.current.id).revision;
  const accepted = await f.call('POST', `/api/work/${f.current.id}/outcome`, {
    expectedRevision: revision,
    decision: 'accepted',
    note: 'Verified artifact and acceptance criteria.',
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(f.controller.spending.snapshot().acceptedOutcomes, 1);
  await f.call('POST', `/api/work/${f.current.id}/checkpoint`, {
    note: 'The requirements changed.',
  });
  assert.equal(f.controller.spending.snapshot().acceptedOutcomes, 0);
  assert.equal(f.controller.spending.outcomes()[0].decision, 'accepted');
});
test('SQLite restart retains unknown reservations and never equates crash recovery with native settlement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-spending-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, 'workspace.sqlite');
  let store = new Store(filename),
    spending = new Spending(store);
  const work: Work = {
    id: id(),
    title: 'Crash',
    project: 'Fixture',
    cwd: root,
    goal: 'Retain reservation',
    acceptance: '',
    context: '',
    harness: 'codex',
    accountId: 'slot',
    status: 'running',
    priority: 'normal',
    generation: 1,
    revision: 0,
    nativeSessionId: null,
    activeRunId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  store.put('work', work.id, work);
  spending.configure({ expectedRevision: 0, monthlyUsd: 10, workUsd: 10, attemptUsd: 2 });
  const run: Run = {
    id: id(),
    workId: work.id,
    accountId: 'slot',
    generation: 1,
    nativeSessionId: null,
    nativeTurnId: null,
    status: 'starting',
    startedAt: now(),
    endedAt: null,
  };
  store.transaction(() => {
    store.put('runs', run.id, run);
    spending.reserve(spending.prepare(run));
  });
  store.close();
  store = new Store(filename);
  t.after(() => store.close());
  store.recoverInterruptedRuns();
  spending = new Spending(store);
  spending.recover();
  const receipt = spending.attempts()[0];
  assert.equal(receipt.state, 'unknown');
  assert.equal(receipt.accountedUsd, 2);
  assert.equal(spending.review(store.work(work.id)).allowed, false);
  assert.throws(
    () =>
      spending.reconcile(
        run.id,
        { expectedRevision: receipt.revision, usd: 0, note: 'Cannot clear unconfirmed ownership.' },
        { kind: 'local' },
      ),
    /Confirm native settlement/,
  );
  assert.equal(store.get<Run>('runs', run.id)!.exitConfirmed, false);
});
