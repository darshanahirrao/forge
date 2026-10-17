import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { id, now } from '../server/store.js';
import type { Account, Work, Run } from '../shared/types.js';
import type { DriverContext, DriverSink } from '../server/adapters/driver.js';

async function fixture(
  t: test.TestContext,
  options: {
    pressure?: () => Promise<ReturnType<typeof unknownPressure>>;
    observed?: (account: Account) => Account;
    probe?: (account: Account) => Promise<Account>;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-routing-')));
  await writeFile(join(root, 'proof.txt'), 'Stable project evidence.');
  const contexts: DriverContext[] = [],
    sinks: DriverSink[] = [];
  let inputs = 0,
    factories = 0,
    probes = 0;
  const state = await createApp({
    filename: ':memory:',
    csrf: 'route-test',
    test: true,
    memoryPressureReader: options.pressure ?? unknownPressure,
    accountProbe: async (account) => {
      probes++;
      return options.probe
        ? options.probe(account)
        : {
            ...account,
            state: 'verified',
            checkedAt: now(),
            quotas: account.quotas.map((q) => ({ ...q, observedAt: now() })),
          };
    },
    driverFactory: (context) => {
      factories++;
      contexts.push(context);
      return {
        harness: context.account.harness,
        closed: false,
        async start(_context, sink) {
          sinks.push(sink);
          sink.account(options.observed ? options.observed(context.account) : context.account);
          inputs++;
          sink.session(`session-${context.run.id}`);
          sink.turn('native-turn');
        },
        async interrupt() {},
        async close() {},
      };
    },
  });
  t.after(async () => {
    await state.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    state.app.inject({
      method,
      url,
      payload: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
      headers: {
        host: '127.0.0.1:4710',
        'x-forge-csrf': state.csrf,
        'content-type': 'application/json',
      },
    });
  async function account(label: string, group = label, used = 20) {
    const account = (
      await call('POST', '/api/accounts', { label, harness: 'codex', billingMode: 'subscription' })
    ).json<Account>();
    return state.local.put<Account>('accounts', account.id, {
      ...account,
      state: 'verified',
      identity: label,
      identityKey: `native:${group}`,
      checkedAt: now(),
      ordinaryUsageAllowed: true,
      quotas: [
        {
          label: 'Native window',
          scope: `bucket:${group}`,
          source: 'native',
          observedAt: now(),
          usedPercent: used,
          resetsAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    });
  }
  const a = await account('First'),
    b = await account('Second');
  const work = (
    await call('POST', '/api/work', {
      title: 'One work through a route',
      project: 'Fixture',
      cwd: root,
      goal: 'Keep the same durable goal.',
      context: 'Keep this context.',
      harness: 'codex',
      accountId: a.id,
    })
  ).json<Work>();
  const save = (accounts = [a.id, b.id], extra = {}) =>
    call('PUT', `/api/work/${work.id}/route`, {
      expectedRevision: state.local.work(work.id).revision,
      expectedPolicyRevision: state.routing.policy(work.id)?.revision ?? 0,
      accountIds: accounts,
      allowMetered: false,
      allowUnreportedQuota: false,
      maxEvidenceAgeSeconds: 300,
      ...extra,
    });
  const review = () => state.routing.review(work.id);
  const prepare = (extra = {}) => {
    const plan = review();
    return call('POST', `/api/work/${work.id}/route/prepare`, {
      planId: plan.planId,
      digest: plan.digest,
      ...extra,
    });
  };
  const launch = () =>
    call('POST', `/api/work/${work.id}/launch`, {
      expectedRevision: state.local.work(work.id).revision,
    });
  async function finish() {
    sinks.at(-1)!.ended('completed', 'Settled', 'Fixture only.');
    for (let i = 0; i < 100 && state.controller.activeCount; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(state.controller.activeCount, 0);
  }
  return {
    ...state,
    root,
    account,
    a,
    b,
    work,
    call,
    save,
    review,
    prepare,
    launch,
    finish,
    contexts,
    sinks,
    inputs: () => inputs,
    factories: () => factories,
    probes: () => probes,
  };
}
test('ordered routing skips exhausted shared buckets without adding alias capacity or starting a native attempt', async (t) => {
  const f = await fixture(t);
  f.local.put('accounts', f.a.id, {
    ...f.a,
    quotas: f.a.quotas.map((q) => ({ ...q, usedPercent: 100 })),
  });
  const alias = await f.account('Alias', 'First');
  f.local.put('accounts', alias.id, { ...alias, quotas: [] });
  assert.equal((await f.save([f.a.id, alias.id, f.b.id])).statusCode, 200);
  const review = f.review();
  assert.equal(review.recommendedAccountId, f.b.id);
  assert.equal(review.candidates[1].eligible, false);
  assert.equal(review.candidates[0].sharedIdentity, true);
  const prepared = await f.prepare();
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json().id, f.work.id);
  assert.equal(prepared.json().accountId, f.b.id);
  assert.equal(prepared.json().goal, f.work.goal);
  assert.equal(prepared.json().context, f.work.context);
  assert.equal(f.inputs(), 0);
  assert.equal(f.factories(), 0);
  assert.equal(f.local.all<Run>('runs').length, 0);
  assert.equal((await f.launch()).statusCode, 202);
  assert.equal(f.contexts[0].account.id, f.b.id);
});
test('latest native shared-window evidence is authoritative while a reset timestamp alone never restores capacity', async (t) => {
  const f = await fixture(t);
  const old = new Date(Date.now() - 1000).toISOString();
  f.local.put('accounts', f.a.id, {
    ...f.a,
    quotas: [{ ...f.a.quotas[0], scope: 'shared', usedPercent: 100, observedAt: old }],
  });
  f.local.put('accounts', f.b.id, {
    ...f.b,
    quotas: [{ ...f.b.quotas[0], scope: 'shared', usedPercent: 20, observedAt: now() }],
  });
  await f.save();
  assert.equal(f.review().recommendedAccountId, f.a.id);
  const b = f.local.account(f.b.id);
  f.local.put('accounts', b.id, {
    ...b,
    quotas: [{ ...b.quotas[0], usedPercent: 100, observedAt: now() }],
  });
  assert.equal(f.review().recommendedAccountId, null);
});

test('fresh native included-usage denial applies to every alias of the same identity', async (t) => {
  const f = await fixture(t),
    alias = await f.account('Alias', 'First');
  f.local.put('accounts', f.a.id, {
    ...f.a,
    ordinaryUsageAllowed: false,
    checkedAt: new Date(Date.now() + 100).toISOString(),
  });
  await f.save([alias.id, f.b.id]);
  const review = f.review();
  assert.equal(review.candidates[0].eligible, false);
  assert.match(review.candidates[0].reasons.join(' '), /included usage is unavailable/);
  assert.equal(review.recommendedAccountId, f.b.id);
});
test('stale evidence, changed identity/home/billing/model and profile scope invalidate routing authority', async (t) => {
  const f = await fixture(t);
  await f.save([f.a.id]);
  for (const patch of [
    { identityKey: 'different-native-id' },
    { nativeHome: '/changed-home' },
    { billingMode: 'api' },
    { credentialEnv: 'CHANGED_REFERENCE' },
    {
      backend: { id: 'backend', instanceId: 'instance', model: 'changed-model' },
      providerReady: true,
    },
    { checkedAt: new Date(Date.now() - 3600000).toISOString() },
  ]) {
    f.local.put('accounts', f.a.id, { ...f.a, ...patch });
    assert.equal(f.review().recommendedAccountId, null, JSON.stringify(patch));
  }
  f.local.put('accounts', f.a.id, f.a);
  f.local.updateWork(f.work.id, { profileId: 'changed-profile' });
  assert.equal(f.review().recommendedAccountId, null);
  assert.equal(f.factories(), 0);
});
test('unreported evidence and metered billing require distinct opt-ins and example quotas never establish native allowance', async (t) => {
  const f = await fixture(t);
  f.local.put('accounts', f.a.id, {
    ...f.a,
    identityKey: null,
    billingMode: 'api',
    quotas: [{ ...f.a.quotas[0], source: 'example' }],
  });
  await f.save([f.a.id]);
  assert.equal(f.review().recommendedAccountId, null);
  await f.save([f.a.id], { allowUnreportedQuota: true });
  assert.equal(f.review().recommendedAccountId, null);
  await f.save([f.a.id], { allowUnreportedQuota: true, allowMetered: true });
  assert.equal(f.review().recommendedAccountId, f.a.id);
  const denied = await f.launch();
  assert.equal(denied.statusCode, 409);
  assert.match(denied.json().error, /metered billing/);
  assert.equal(f.factories(), 0);
});
test('reviewed routing evidence cannot be reused after work or native evidence changes', async (t) => {
  const f = await fixture(t);
  await f.save([f.b.id]);
  const plan = f.review();
  f.local.put('accounts', f.b.id, { ...f.b, checkedAt: new Date(Date.now() + 1).toISOString() });
  let response = await f.call('POST', `/api/work/${f.work.id}/route/prepare`, {
    planId: plan.planId,
    digest: plan.digest,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(f.local.work(f.work.id).accountId, f.a.id);
  const current = f.review();
  f.local.updateWork(f.work.id, { context: 'Corrected context.' });
  response = await f.call('POST', `/api/work/${f.work.id}/route/prepare`, {
    planId: current.planId,
    digest: current.digest,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(f.inputs(), 0);
});
test('account routing is checked after asynchronous admission before driver construction', async (t) => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
  const f = await fixture(t, {
    pressure: async () => {
      enter();
      await pending;
      return unknownPressure();
    },
  });
  await f.save([f.a.id]);
  const request = f.launch();
  try {
    await entered;
    f.local.put('accounts', f.a.id, { ...f.a, ordinaryUsageAllowed: false });
    release();
    assert.equal((await request).statusCode, 409);
    assert.equal(f.factories(), 0);
  } finally {
    release();
    await request;
  }
});
test('a native login change after a worker starts is rejected before model input and never silently changes approved authority', async (t) => {
  const f = await fixture(t, {
    observed: (account) => ({ ...account, identityKey: 'native-changed-after-probe' }),
  });
  await f.save([f.a.id]);
  assert.equal((await f.launch()).statusCode, 202);
  for (let i = 0; i < 100 && f.controller.activeCount; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.inputs(), 0);
  assert.equal(f.local.account(f.a.id).identityKey, f.a.identityKey);
  assert.equal(f.local.work(f.work.id).status, 'failed');
  assert.equal(f.local.all<Run>('runs')[0].exitConfirmed, true);
});
test('routed continuation reuses verified capsules and preserves one work, selected artifacts and native source history', async (t) => {
  const f = await fixture(t);
  await f.save();
  await f.launch();
  await f.finish();
  const source = f.local.work(f.work.id);
  assert.ok(source.nativeSessionId);
  f.local.put('accounts', f.a.id, {
    ...f.a,
    quotas: f.a.quotas.map((q) => ({ ...q, usedPercent: 100 })),
  });
  assert.equal((await f.prepare()).statusCode, 409);
  const moved = await f.prepare({ reconciled: true, paths: ['proof.txt'] });
  assert.equal(moved.statusCode, 200, moved.body);
  const current = moved.json<Work>();
  assert.equal(current.id, source.id);
  assert.equal(current.profileId, source.profileId);
  assert.equal(current.accountId, f.b.id);
  assert.equal(current.nativeSessionId, null);
  assert.ok(current.capsuleId);
  const capsule = f.local.get<{ source: { nativeSessionId: string } }>(
    'capsules',
    current.capsuleId!,
  );
  assert.equal(capsule!.source.nativeSessionId, source.nativeSessionId);
  assert.equal((await f.call('DELETE', `/api/accounts/${f.a.id}`)).statusCode, 409);
  assert.equal(f.inputs(), 1);
  assert.equal(f.local.all<Run>('runs').length, 1);
});
test('unconfirmed source ownership blocks routed continuation without a new native request', async (t) => {
  const f = await fixture(t);
  await f.save([f.b.id]);
  const run: Run = {
    id: id(),
    workId: f.work.id,
    accountId: f.a.id,
    generation: 1,
    nativeSessionId: 'old-session',
    nativeTurnId: 'old-turn',
    status: 'interrupted',
    startedAt: now(),
    endedAt: now(),
    exitConfirmed: false,
  };
  f.local.put('runs', run.id, run);
  f.local.updateWork(f.work.id, {
    generation: 1,
    nativeSessionId: 'old-session',
    status: 'interrupted',
  });
  const response = await f.prepare({ reconciled: true, paths: ['proof.txt'] });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /exit was not confirmed/);
  assert.equal(f.inputs(), 0);
});
test('native route refresh is sequential, bounded and preserves one admission owner without resident workers', async (t) => {
  const f = await fixture(t, {
    probe: async (account) => ({ ...account, checkedAt: now(), ordinaryUsageAllowed: false }),
  });
  const accounts = [
    f.a,
    f.b,
    await f.account('Third'),
    await f.account('Fourth'),
    await f.account('Fifth'),
  ];
  const stale = new Date(Date.now() - 3600000).toISOString();
  for (const account of accounts)
    f.local.put('accounts', account.id, { ...account, checkedAt: stale });
  await f.save(accounts.map((account) => account.id));
  const refreshed = await f.call('POST', `/api/work/${f.work.id}/route/refresh`, {});
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(refreshed.json().refreshedAccountIds.length, 4);
  assert.equal(f.probes(), 4);
  assert.equal(f.inputs(), 0);
  assert.equal(f.controller.activeCount, 0);
  assert.equal(f.local.account(accounts[4].id).checkedAt, stale);
});
