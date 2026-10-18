import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { NativeRpc } from '../server/adapters/rpc.js';
import { readCodexHistory } from '../server/adapters/codex-history.js';
import { unknownPressure } from '../server/memory-pressure.js';
import type { Work, Approval, Usage, Run } from '../shared/types.js';
import type { NativeContinuationReview } from '../shared/native-continuations.js';

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-chat-continuation-'))),
    home = join(root, 'native'),
    project = join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  let changed = false,
    badFork = false,
    badGoal = false,
    reads = 0;
  const state = await createApp({
    filename: join(root, 'workspace.sqlite'),
    port: 0,
    test: true,
    codexBinary: process.execPath,
    memoryPressureReader: unknownPressure,
    phoneBridge: { origin: 'https://owned-chat.ts.net', proof: 'owned-chat-proof' },
    rpcFactory: (options) => {
      reads++;
      return new NativeRpc({
        ...options,
        binary: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))],
        env: {
          PATH: process.env.PATH,
          FORGE_FIXTURE_PROJECT: project,
          ...(changed ? { FORGE_FIXTURE_HISTORY_CHANGED: '1' } : {}),
          ...(badFork ? { FORGE_FIXTURE_BAD_FORK: '1' } : {}),
          ...(badGoal ? { FORGE_FIXTURE_BAD_GOAL: '1' } : {}),
        },
      });
    },
  });
  t.after(async () => {
    await state.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { host: '127.0.0.1:0', 'x-forge-csrf': state.csrf };
  const call = (url: string, body: unknown, extra = {}) =>
    state.app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/json', ...extra },
      payload: JSON.stringify(body),
    });
  const account = (
    await call('/api/accounts', {
      harness: 'codex',
      label: 'Existing native slot',
      nativeHome: home,
      billingMode: 'native',
    })
  ).json();
  const source = state.nativeSources.add({
    kind: 'codex',
    label: 'Existing native chats',
    home,
    endpoint: '',
  });
  state.local.put('native_inventories', source.id, {
    sourceId: source.id,
    checkedAt: new Date().toISOString(),
    moreAvailable: false,
    schedules: [],
    sessions: [
      {
        id: 'fixture-observed-thread',
        sourceId: source.id,
        source: 'codex/app-server',
        harness: 'codex',
        title: 'Existing native chat',
        status: 'Stored session; live state unknown',
        project: 'Fixture',
        cwd: project,
        control: 'observed',
      },
    ],
  });
  const input = {
    sourceId: source.id,
    sessionId: 'fixture-observed-thread',
    accountId: account.id,
    profileId: state.local.all<{ id: string }>('profiles')[0].id,
    title: 'Continued existing chat',
    goal: 'Keep this native conversation and create a verified result.',
  };
  async function prepare(body: unknown = input) {
    const response = await call('/api/native/continuations/prepare', body);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<NativeContinuationReview>();
  }
  async function activate(review: NativeContinuationReview) {
    const response = await call('/api/native/continuations', {
      id: review.id,
      digest: review.digest,
      nativeActivityReviewed: true,
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<Work>();
  }
  return {
    state,
    root,
    home,
    project,
    source,
    account,
    headers,
    call,
    input,
    prepare,
    activate,
    change: () => {
      changed = true;
    },
    badCopy: () => {
      badFork = true;
    },
    reads: () => reads,
    retainGoal: () => {
      badGoal = true;
    },
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    assert(Date.now() < deadline, 'Owned continuation did not settle.');
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function finish(f: Awaited<ReturnType<typeof setup>>, work: Work) {
  const response = await f.call(`/api/work/${work.id}/launch`, {
    expectedRevision: work.revision,
    reconciled: true,
    allowMetered: true,
  });
  assert.equal(response.statusCode, 202, response.body);
  await until(() =>
    f.state.local
      .all<Approval>('approvals')
      .some((row) => row.workId === work.id && row.status === 'pending'),
  );
  const approval = f.state.local
    .all<Approval>('approvals')
    .find((row) => row.workId === work.id && row.status === 'pending')!;
  const decision = await f.call(`/api/approvals/${approval.id}/decision`, {
    digest: approval.digest,
    decision: 'accept',
  });
  assert.equal(decision.statusCode, 200, decision.body);
  await until(
    () =>
      f.state.local.work(work.id).status === 'completed' && f.state.controller.activeCount === 0,
  );
  return f.state.local.work(work.id);
}

test('existing Codex review links one canonical work without model startup, transcript storage or unreviewed rebinding', async (t) => {
  const f = await setup(t),
    review = await f.prepare();
  assert.equal(review.source.turns, 1);
  assert.equal(review.source.items, 1);
  assert.equal(f.state.local.all('work').length, 0);
  assert.equal(f.state.local.all('runs').length, 0);
  assert(!JSON.stringify(review).includes('Retained native source history'));
  const work = await f.activate(review);
  assert.equal((await f.activate(review)).id, work.id);
  assert.equal(work.nativeOrigin?.state, 'pending');
  assert.equal(work.nativeSessionId, null);
  assert(
    !JSON.stringify(f.state.local.db.prepare('SELECT data FROM records').all()).includes(
      'Retained native source history',
    ),
  );
  assert.throws(() => f.state.nativeSources.remove(f.source.id), /Keep this source/);
  const patch = await f.state.app.inject({
    method: 'PATCH',
    url: `/api/work/${work.id}`,
    headers: f.headers,
    payload: { expectedRevision: work.revision, cwd: f.root },
  });
  assert.equal(patch.statusCode, 409);
});

test('native fork copies the reviewed history and retains one work/session across resume while excluding inherited tokens and duplicate snapshots', async (t) => {
  const f = await setup(t),
    work = await f.activate(await f.prepare());
  assert.equal(
    (
      await f.call(`/api/work/${work.id}/launch`, {
        expectedRevision: work.revision,
        allowMetered: true,
      })
    ).statusCode,
    409,
  );
  let current = await finish(f, work);
  assert.equal(current.nativeOrigin?.state, 'bound');
  assert.notEqual(current.nativeSessionId, work.nativeOrigin?.threadId);
  const nativeId = current.nativeSessionId;
  current = await finish(f, current);
  assert.equal(current.nativeSessionId, nativeId);
  const usage = f.state.local.all<Usage>('usage');
  assert.equal(usage.length, 2);
  assert(usage.every((row) => row.counterScope === 'run' && row.totalTokens === 25));
  assert.equal(
    usage.reduce((sum, row) => sum + row.totalTokens, 0),
    50,
  );
  assert(f.state.local.all<Run>('runs').every((row) => row.exitConfirmed === true));
  assert(
    f.state.local.recentEvents(work.id).some((row) => row.title === 'Native chat history retained'),
  );
  f.state.nativeSources.remove(f.source.id);
});

test('changed source history holds before native input and a fresh review updates the same work instead of creating a duplicate', async (t) => {
  const f = await setup(t),
    work = await f.activate(await f.prepare());
  f.change();
  const launch = await f.call(`/api/work/${work.id}/launch`, {
    expectedRevision: work.revision,
    reconciled: true,
    allowMetered: true,
  });
  assert.equal(launch.statusCode, 202);
  await until(
    () => f.state.local.work(work.id).status === 'failed' && f.state.controller.activeCount === 0,
  );
  assert.equal(f.state.local.work(work.id).nativeSessionId, null);
  assert.equal(f.state.local.all('approvals').length, 0);
  const current = f.state.local.work(work.id),
    review = await f.prepare({ ...f.input, workId: work.id, expectedRevision: current.revision });
  const refreshed = await f.activate(review);
  assert.equal(refreshed.id, work.id);
  assert.equal(f.state.local.all('work').length, 1);
  assert.notEqual(refreshed.nativeOrigin?.digest, work.nativeOrigin?.digest);
  await finish(f, refreshed);
});

test('native chat setup refuses phone/demo/missing CSRF, unobserved sources, other homes and changed account/profile reviews', async (t) => {
  const f = await setup(t),
    readCount = f.reads();
  for (const extra of [
    { 'x-forge-csrf': 'wrong' },
    { 'x-forge-workspace': 'demo' },
    {
      'x-forge-bridge-proof': 'owned-chat-proof',
      'x-forge-bridge-identity': 'owner@example.invalid',
    },
  ])
    assert((await f.call('/api/native/continuations/prepare', f.input, extra)).statusCode >= 400);
  assert(
    (await f.call('/api/native/continuations/prepare', { ...f.input, sessionId: 'not-observed' }))
      .statusCode >= 400,
  );
  const another = (
    await f.call('/api/accounts', {
      harness: 'codex',
      label: 'Other home',
      nativeHome: f.root,
      billingMode: 'native',
    })
  ).json();
  assert.equal(
    (await f.call('/api/native/continuations/prepare', { ...f.input, accountId: another.id }))
      .statusCode,
    409,
  );
  assert.equal(f.reads(), readCount);
  const review = await f.prepare();
  f.state.local.put('accounts', f.account.id, {
    ...f.state.local.account(f.account.id),
    nativeHome: f.root,
  });
  assert.equal(
    (
      await f.call('/api/native/continuations', {
        id: review.id,
        digest: review.digest,
        nativeActivityReviewed: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(f.state.local.all('work').length, 0);
});

test('a native fork with incomplete copied history never receives task input or creates an approval', async (t) => {
  const f = await setup(t),
    work = await f.activate(await f.prepare());
  f.badCopy();
  assert.equal(
    (
      await f.call(`/api/work/${work.id}/launch`, {
        expectedRevision: work.revision,
        reconciled: true,
        allowMetered: true,
      })
    ).statusCode,
    202,
  );
  await until(
    () => f.state.local.work(work.id).status === 'failed' && f.state.controller.activeCount === 0,
  );
  assert.equal(f.state.local.work(work.id).nativeSessionId, null);
  assert.equal(f.state.local.all('approvals').length, 0);
  assert.equal(f.state.local.all('usage').length, 0);
});

test('native history fingerprint refuses partial, duplicate, changing, failed and oversized public pagination without summary fallback', async (t) => {
  const f = await setup(t);
  const turn = {
    id: 'source-turn',
    status: 'completed',
    itemsView: 'full',
    items: [{ type: 'agentMessage', text: 'reference' }],
  };
  const fake = (data: unknown[], nextCursor: string | null = null) =>
    ({
      request: async (method: string) =>
        method === 'thread/read'
          ? {
              thread: {
                id: 'source',
                ephemeral: false,
                cwd: f.project,
                modelProvider: 'openai',
                cliVersion: '0.159.3',
                status: { type: 'notLoaded' },
              },
            }
          : { data, nextCursor },
    }) as unknown as NativeRpc;
  const one = await readCodexHistory(fake([turn]), 'source');
  assert.equal(one.turns, 1);
  for (const row of [
    { ...turn, status: 'inProgress' },
    { ...turn, status: 'failed' },
    { ...turn, itemsView: 'summary' },
    { ...turn, items: [{ text: 'x'.repeat(8 * 1024 * 1024 + 1) }] },
  ])
    await assert.rejects(readCodexHistory(fake([row]), 'source'));
  await assert.rejects(
    readCodexHistory(fake([turn], 'repeated-cursor'), 'source'),
    /changing|pagination/,
  );
  await assert.rejects(readCodexHistory(fake([]), 'source'), /latest turn/);
});

test('a native fork that retains an autonomous goal receives no managed task input', async (t) => {
  const f = await setup(t),
    work = await f.activate(await f.prepare());
  f.retainGoal();
  const launch = await f.call(`/api/work/${work.id}/launch`, {
    expectedRevision: work.revision,
    reconciled: true,
    allowMetered: true,
  });
  assert.equal(launch.statusCode, 202);
  await until(
    () => f.state.local.work(work.id).status === 'failed' && f.state.controller.activeCount === 0,
  );
  assert.equal(f.state.local.work(work.id).nativeSessionId, null);
  assert.equal(f.state.local.all('approvals').length, 0);
  assert.equal(f.state.local.all('usage').length, 0);
});
