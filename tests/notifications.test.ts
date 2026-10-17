import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Notifications, notificationSchema } from '../server/notifications.js';
import { Store, id, now } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { Approval, Run } from '../shared/types.js';
import type { NotificationReceipt } from '../shared/notifications.js';

const topic = 'fixture-notification-topic',
  token = 'fixture-notification-token';
const reviewOrigin = 'https://forge.fixture.invalid';
type Message = { url: string; headers: IncomingMessage['headers']; body: string };
async function endpoint(t: test.TestContext, handle?: (res: ServerResponse) => void) {
  const messages: Message[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    messages.push({ url: request.url!, headers: request.headers, body });
    if (handle) handle(response);
    else {
      response.writeHead(200);
      response.end('{"id":"fixture-accepted"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, messages, origin: `http://127.0.0.1:${address.port}` };
}
async function fixture(t: test.TestContext, persistent = false, options = {}) {
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'forge-notify-')) : undefined;
  const store = new Store(directory ? join(directory, 'workspace.sqlite') : ':memory:');
  const notifications = new Notifications(store, directory, reviewOrigin, options);
  t.after(async () => {
    await notifications.close();
    store.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  return { store, notifications, directory };
}
function approval(store: Store): Approval {
  const row: Approval = {
    id: id(),
    workId: id(),
    runId: id(),
    generation: 1,
    nativeRequestId: 'PRIVATE-NATIVE-REQUEST',
    method: 'native/execute',
    digest: 'PRIVATE-DIGEST',
    title: 'PRIVATE-TITLE',
    detail: 'PRIVATE-DETAIL',
    command: 'PRIVATE-COMMAND',
    cwd: '/PRIVATE-PATH',
    status: 'pending',
    createdAt: now(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    resolvedAt: null,
  };
  store.transaction(() => {
    store.put('work', row.workId, { id: row.workId, activeRunId: row.runId, generation: 1 });
    store.put('approvals', row.id, row);
  });
  return row;
}
function terminal(store: Store, status: 'completed' | 'failed' | 'interrupted', endedAt = now()) {
  const row: Run = {
    id: id(),
    workId: id(),
    accountId: id(),
    generation: 1,
    nativeSessionId: 'PRIVATE-SESSION',
    nativeTurnId: null,
    status,
    startedAt: endedAt,
    endedAt,
  };
  store.put('runs', row.id, row);
  return row;
}
const configure = (
  notifications: Notifications,
  serverOrigin: string,
  kinds = ['approval', 'failed', 'interrupted'],
) =>
  notifications.configure({
    expectedRevision: notifications.config()?.revision ?? 0,
    serverOrigin,
    topic,
    token,
    kinds,
  });

test('store observers see only committed changes and cannot undo canonical native receipts', () => {
  const store = new Store(':memory:');
  try {
    const changes: string[][] = [];
    const stop = store.onChange((collections) => {
      assert.equal(store.db.isTransaction, false);
      changes.push([...collections]);
    });
    assert.throws(() =>
      store.transaction(() => {
        store.put('runs', 'rolled-back', { status: 'failed' });
        throw new Error('rollback');
      }),
    );
    assert.equal(store.get('runs', 'rolled-back'), null);
    assert.deepEqual(changes, []);
    store.transaction(() => {
      store.put('runs', 'committed', { status: 'completed' });
      store.put('approvals', 'approved', { status: 'accepted' });
    });
    assert.deepEqual(changes, [['runs', 'approvals']]);
    store.onChange(() => {
      throw new Error('observational failure');
    });
    assert.doesNotThrow(() => store.put('runs', 'durable', { status: 'failed' }));
    assert.deepEqual(store.get('runs', 'durable'), { status: 'failed' });
    stop();
    store.remove('runs', 'durable');
    assert.equal(changes.length, 2);
  } finally {
    store.close();
  }
});

test('notifications are off by default, then publish a pending approval once without native content or decision authority', async (t) => {
  const sink = await endpoint(t),
    f = await fixture(t);
  const request = approval(f.store);
  terminal(f.store, 'failed', '2020-01-01T00:00:00.000Z');
  await f.notifications.idle();
  assert.equal(f.notifications.config(), null);
  assert.equal(f.notifications.snapshot().receipts.length, 0);
  assert.equal(sink.messages.length, 0);
  await configure(f.notifications, sink.origin);
  await f.notifications.idle();
  assert.equal(sink.messages.length, 1);
  const message = sink.messages[0];
  assert.equal(message.url, `/${topic}`);
  assert.equal(message.headers.authorization, `Bearer ${token}`);
  assert.equal(message.headers.click, `${reviewOrigin}/#approvals`);
  assert.equal(message.headers.priority, 'high');
  assert.equal(message.headers.actions, undefined);
  assert.equal(JSON.stringify(message).includes('PRIVATE-'), false);
  const snapshot = f.notifications.snapshot();
  assert.equal(snapshot.receipts[0].state, 'accepted');
  assert.match(snapshot.receipts[0].detail, /device is not confirmed/);
  for (const secret of [topic, token])
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
  for (let i = 0; i < 4; i++) f.store.put('approvals', request.id, request);
  await f.notifications.idle();
  assert.equal(sink.messages.length, 1);
  assert.equal(f.store.get<Approval>('approvals', request.id)?.status, 'pending');
});

test('current work generation, expiry and native withdrawal suppress stale approval alerts', async (t) => {
  const sink = await endpoint(t),
    f = await fixture(t);
  await configure(f.notifications, sink.origin);
  const withdrawn = approval(f.store);
  f.store.put('approvals', withdrawn.id, { ...withdrawn, status: 'invalidated' });
  const expired = approval(f.store);
  f.store.put('approvals', expired.id, { ...expired, expiresAt: '2020-01-01T00:00:00.000Z' });
  const stale = approval(f.store);
  f.store.put('work', stale.workId, { id: stale.workId, activeRunId: stale.runId, generation: 2 });
  await f.notifications.idle();
  assert.equal(sink.messages.length, 0);
  assert.equal(f.notifications.snapshot().receipts[0].state, 'withdrawn');
});

test('only selected terminal runs since opt-in are delivered, with no acceptance or ownership claim', async (t) => {
  const sink = await endpoint(t),
    f = await fixture(t);
  terminal(f.store, 'failed', '2020-01-01T00:00:00.000Z');
  await configure(f.notifications, sink.origin, ['completed', 'interrupted']);
  const completed = terminal(f.store, 'completed');
  terminal(f.store, 'failed');
  terminal(f.store, 'interrupted');
  await f.notifications.idle();
  assert.equal(sink.messages.length, 2);
  assert.match(
    sink.messages.find((m) => m.headers.title === 'Forge attempt completed')!.body,
    /acceptance criteria/,
  );
  assert.match(
    sink.messages.find((m) => m.headers.title === 'Forge native ownership needs review')!.body,
    /exact owner/,
  );
  assert.equal(f.store.get<Run>('runs', completed.id)?.exitConfirmed, undefined);
  assert.equal(f.store.all('work_outcomes').length, 0);
});

test('private topic and token stay outside SQLite and public snapshots and are erased on disconnect', async (t) => {
  const sink = await endpoint(t),
    f = await fixture(t, true);
  await configure(f.notifications, sink.origin);
  const files = (await readdir(f.directory!)).filter((name) => name.startsWith('.forge-notify-'));
  assert.equal(files.length, 1);
  const filename = join(f.directory!, files[0]);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).token, token);
  const { stat } = await import('node:fs/promises');
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const data = JSON.stringify(f.store.db.prepare('SELECT data FROM records').all());
  for (const secret of [topic, token]) assert.equal(data.includes(secret), false);
  await f.notifications.disconnect(1);
  assert.equal(f.notifications.config()?.enabled, false);
  assert.equal((await readdir(f.directory!)).includes(files[0]), false);
  assert.throws(() => f.notifications.test(), /Connect/);
});

test('private reference failures do not attempt network delivery and acknowledgement does not invent success', async (t) => {
  const sink = await endpoint(t),
    f = await fixture(t, true);
  await configure(f.notifications, sink.origin);
  const file = (await readdir(f.directory!)).find((name) => name.startsWith('.forge-notify-'))!;
  if (process.platform === 'win32') await rm(join(f.directory!, file));
  else await chmod(join(f.directory!, file), 0o644);
  const row = f.notifications.test();
  await f.notifications.idle();
  assert.equal(sink.messages.length, 0);
  assert.equal(f.notifications.snapshot().needsReview, 1);
  const receipt = f.notifications.acknowledge(row.id);
  assert.equal(receipt.state, 'failed');
  assert.ok(receipt.acknowledgedAt);
  assert.equal(f.notifications.snapshot().needsReview, 0);
  assert.equal(f.notifications.acknowledge(row.id).acknowledgedAt, receipt.acknowledgedAt);
});

test('lost HTTP acknowledgement is uncertain and never automatically retried after further events or SQLite restart', async (t) => {
  const sink = await endpoint(t, (response) => response.destroy());
  const directory = await mkdtemp(join(tmpdir(), 'forge-notify-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  let store = new Store(filename),
    notifications = new Notifications(store, directory, reviewOrigin);
  try {
    await configure(notifications, sink.origin);
    const request = approval(store);
    await notifications.idle();
    assert.equal(notifications.snapshot().receipts[0].state, 'uncertain');
    store.put('approvals', request.id, request);
    await notifications.idle();
    assert.equal(sink.messages.length, 1);
    await notifications.close();
    store.close();
    store = new Store(filename);
    notifications = new Notifications(store, directory, reviewOrigin);
    await notifications.idle();
    assert.equal(sink.messages.length, 1);
    assert.equal(notifications.snapshot().needsReview, 1);
  } finally {
    await notifications.close();
    store.close();
  }
});

test('HTTP redirects never forward the topic or bearer to a second endpoint', async (t) => {
  const target = await endpoint(t);
  const redirect = await endpoint(t, (response) => {
    response.writeHead(307, { Location: target.origin + '/redirected' });
    response.end();
  });
  const f = await fixture(t);
  await configure(f.notifications, redirect.origin);
  f.notifications.test();
  await f.notifications.idle();
  assert.equal(redirect.messages.length, 1);
  assert.equal(target.messages.length, 0);
  assert.equal(f.notifications.snapshot().receipts[0].state, 'uncertain');
});

test('queued unsent work survives reopen with its private reference, while old review problems stay reachable', async (t) => {
  const sink = await endpoint(t);
  const directory = await mkdtemp(join(tmpdir(), 'forge-notify-queued-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  let store = new Store(filename);
  const original = new Notifications(store, directory, reviewOrigin);
  await configure(original, sink.origin);
  await original.close();
  const queued: NotificationReceipt = {
    id: `${original.config()!.id}:test:queued-fixture`,
    configId: original.config()!.id,
    kind: 'test',
    referenceId: 'queued-fixture',
    workId: null,
    state: 'queued',
    createdAt: now(),
    updatedAt: now(),
    detail: 'Unsent fixture',
  };
  store.put('notifications', queued.id, queued);
  store.close();
  store = new Store(filename);
  const reopened = new Notifications(store, directory, reviewOrigin);
  try {
    await reopened.idle();
    assert.equal(sink.messages.length, 1);
    assert.equal(sink.messages[0].headers.authorization, `Bearer ${token}`);
    assert.equal(store.get<NotificationReceipt>('notifications', queued.id)?.state, 'accepted');
    const problem = { ...queued, id: 'old-problem', state: 'uncertain' as const };
    store.put('notifications', problem.id, problem);
    for (let i = 0; i < 105; i++)
      store.put('notifications', `new-receipt-${i}`, {
        ...queued,
        id: `new-receipt-${i}`,
        state: 'accepted',
      });
    const snapshot = reopened.snapshot();
    assert.equal(snapshot.receipts.length, 100);
    assert.equal(snapshot.receipts[0].id, problem.id);
    assert.equal(snapshot.needsReview, 1);
    reopened.acknowledge(problem.id);
    assert.equal(reopened.snapshot().needsReview, 0);
  } finally {
    await reopened.close();
    store.close();
  }
});

test('configuration replacement, stale revisions and disconnect fence queued sends', async (t) => {
  const sink = await endpoint(t),
    f = await fixture(t);
  await configure(f.notifications, sink.origin);
  await assert.rejects(
    f.notifications.configure({
      expectedRevision: 0,
      serverOrigin: sink.origin,
      topic,
      kinds: ['approval'],
    }),
    /changed/,
  );
  const test = f.notifications.test();
  await f.notifications.disconnect(1);
  await f.notifications.idle();
  assert.equal(sink.messages.length, 0);
  assert.equal(f.store.get<NotificationReceipt>('notifications', test.id)?.state, 'withdrawn');
  assert.throws(() => f.notifications.acknowledge(test.id), /Only a failed/);
  await configure(f.notifications, sink.origin);
  f.notifications.test();
  await f.notifications.idle();
  assert.equal(sink.messages.length, 1);
  assert.equal(f.notifications.config()?.revision, 3);
  for (const serverOrigin of [
    'http://example.com',
    'https://example.com/topic',
    'https://u:p@example.com',
    'https://example.com?token=x',
    'https://example.com/#topic',
  ])
    assert.equal(
      notificationSchema.safeParse({
        expectedRevision: 0,
        serverOrigin,
        topic,
        kinds: ['approval'],
      }).success,
      false,
    );
});

test(
  'SIGKILL after native service receives a message retains sending evidence and recovers without resending',
  { timeout: 20000 },
  async (t) => {
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => (received = resolve));
    const sink = await endpoint(t, () => received());
    const directory = await mkdtemp(join(tmpdir(), 'forge-notify-crash-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, 'workspace.sqlite');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/notification-crash.ts', import.meta.url)),
        filename,
        sink.origin,
      ],
      { stdio: 'ignore' },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await Promise.race([
      requestReceived,
      once(child, 'exit').then(() => {
        throw new Error('Owned notification fixture exited before delivery.');
      }),
    ]);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const store = new Store(filename);
    assert.equal(store.all<NotificationReceipt>('notifications')[0].state, 'sending');
    const notifications = new Notifications(store, directory, reviewOrigin);
    try {
      await notifications.idle();
      assert.equal(sink.messages.length, 1);
      assert.equal(notifications.snapshot().receipts[0].state, 'uncertain');
      assert.match(notifications.snapshot().receipts[0].detail, /lost/);
    } finally {
      await notifications.close();
      store.close();
    }
  },
);

test('human notification endpoints retain CSRF, local provisioning, demo and bearer boundaries', async (t) => {
  const sink = await endpoint(t);
  const bridge = { origin: reviewOrigin, proof: 'fixture-proof' };
  const state = await createApp({ filename: ':memory:', test: true, phoneBridge: bridge });
  t.after(() => state.app.close());
  const headers = {
    host: '127.0.0.1:4710',
    'x-forge-csrf': state.csrf,
    'content-type': 'application/json',
  };
  const payload = {
    expectedRevision: 0,
    serverOrigin: sink.origin,
    topic,
    token,
    kinds: ['approval'],
  };
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url: '/api/notifications/connect',
        payload,
        headers: { host: headers.host },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url: '/api/notifications/connect',
        payload,
        headers: { ...headers, authorization: 'Bearer companion-token' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url: '/api/notifications/connect',
        payload,
        headers: { ...headers, 'x-forge-workspace': 'demo' },
      })
    ).statusCode,
    403,
  );
  const phone = {
    ...headers,
    'x-forge-bridge-proof': bridge.proof,
    'x-forge-bridge-identity': 'alice@example.com',
    origin: reviewOrigin,
  };
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url: '/api/notifications/connect',
        payload,
        headers: phone,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url: '/api/notifications/connect',
        payload,
        headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url: '/api/notifications/test',
        payload: {},
        headers,
      })
    ).statusCode,
    202,
  );
  await state.notifications.idle();
  assert.equal(sink.messages.length, 1);
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url: '/api/notifications/test',
        payload: {},
        headers: phone,
      })
    ).statusCode,
    202,
  );
  await state.notifications.idle();
  assert.equal(sink.messages.length, 2);
  assert.equal(
    (
      await state.app.inject({
        method: 'POST',
        url: '/api/notifications/test',
        payload: {},
        headers: { ...headers, 'x-forge-workspace': 'demo' },
      })
    ).statusCode,
    409,
  );
  const snapshot = (
    await state.app.inject({ method: 'GET', url: '/api/snapshot', headers })
  ).json();
  assert.equal(snapshot.notifications.reviewOrigin, reviewOrigin);
  for (const secret of [topic, token])
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
});
