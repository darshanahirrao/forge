import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { resolveCredential, credentialValue } from '../server/credentials.js';
import { nativeEnvironment } from '../server/adapters/accounts.js';
import { openCodeEnvironment } from '../server/adapters/opencode-worker.js';
import { hermesEnvironment } from '../server/adapters/hermes-driver.js';
import { openClawEnvironment } from '../server/adapters/openclaw-worker.js';
import { accountBinding } from '../server/adapters/binding.js';
import { Store, id, now } from '../server/store.js';
import { unknownPressure } from '../server/memory-pressure.js';
import type { Account, Work } from '../shared/types.js';
import type { DriverContext, DriverSink } from '../server/adapters/driver.js';

const target = 'FIXTURE_PROVIDER_API_KEY';
async function file(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-credential-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'private.json');
  await writeFile(
    filename,
    JSON.stringify({
      selected: 'fixture-first-private-value',
      other: 'fixture-excluded-private-value',
    }),
    { mode: 0o600 },
  );
  return { directory, filename };
}
function account(path: string, harness = 'codex'): Account {
  return {
    id: id(),
    label: 'Private reference fixture',
    harness,
    nativeHome: '/fixture/native-home',
    credentialEnv: target,
    credentialReference: { kind: 'private-json', path, key: 'selected' },
    billingMode: 'api',
    state: 'configured',
    identity: null,
    identityKey: null,
    plan: null,
    checkedAt: null,
    error: null,
    quotas: [],
    createdAt: now(),
  };
}

test('private credentials stay invocation-local, cannot cross account/binding/variable scope, serialize nothing and release their material', async (t) => {
  const f = await file(t),
    a = account(f.filename),
    b = account(f.filename);
  const before = process.env[target];
  const material = (await resolveCredential(a))!;
  assert.equal(credentialValue(a, target, material), 'fixture-first-private-value');
  assert.throws(() => credentialValue(b, target, material), /binding/);
  assert.throws(() => credentialValue(a, 'OTHER_API_KEY', material), /binding/);
  assert.throws(
    () => credentialValue({ ...a, nativeHome: '/different' }, target, material),
    /binding/,
  );
  assert.equal(JSON.stringify({ material }), '{}');
  assert.equal(inspect(material).includes('fixture-first'), false);
  assert.equal(process.env[target], before);
  material.dispose();
  assert.throws(() => credentialValue(a, target, material), /binding/);
  assert.throws(() => credentialValue(a, target), /Resolve/);
  await writeFile(f.filename, JSON.stringify({ selected: 'fixture-rotated-private-value' }), {
    mode: 0o600,
  });
  const rotated = (await resolveCredential(a))!;
  assert.equal(credentialValue(a, target, rotated), 'fixture-rotated-private-value');
  rotated.dispose();
});

test('all built-in native environments use only the selected reference, with no ambient fallback', async (t) => {
  const f = await file(t);
  for (const harness of ['codex', 'claude', 'opencode', 'hermes', 'openclaw']) {
    const a = account(f.filename, harness),
      material = (await resolveCredential(a))!;
    const env =
      harness === 'opencode'
        ? openCodeEnvironment(a, material)
        : harness === 'hermes'
          ? hermesEnvironment(a, material)
          : harness === 'openclaw'
            ? openClawEnvironment(a, material)
            : nativeEnvironment(a, material);
    assert.equal(
      env[harness === 'claude' ? 'ANTHROPIC_API_KEY' : target],
      'fixture-first-private-value',
    );
    assert.equal(JSON.stringify(env).includes('fixture-excluded'), false);
    material.dispose();
  }
  const a = account(f.filename);
  const original = accountBinding({ ...a, credentialReference: undefined });
  assert.notEqual(accountBinding(a), original);
  assert.equal(accountBinding({ ...a, credentialReference: undefined }), original);
});

test('unsafe/missing references, unsupported platforms and runtime variables fail without leaking values or falling back to the environment', async (t) => {
  const f = await file(t),
    a = account(f.filename);
  const link = join(f.directory, 'link.json');
  await symlink(f.filename, link);
  await assert.rejects(
    resolveCredential({
      ...a,
      credentialReference: { kind: 'private-json', path: link, key: 'selected' },
    }),
  );
  if (process.platform !== 'win32') {
    await chmod(f.filename, 0o644);
    await assert.rejects(resolveCredential(a), /private/);
    await chmod(f.filename, 0o600);
  }
  await assert.rejects(
    resolveCredential({
      ...a,
      credentialReference: { kind: 'private-json', path: f.filename, key: 'missing' },
    }),
    /not found/,
  );
  for (const credentialEnv of [
    'NODE_OPTIONS',
    'PATH',
    'HERMES_HOME',
    'FORGE_DATA_DIR',
    'HTTP_PROXY',
  ])
    await assert.rejects(resolveCredential({ ...a, credentialEnv }), /runtime/);
  for (const value of ['fixture-value\nsecret', { token: 'fixture-value' }, 'x'.repeat(17000)]) {
    await writeFile(f.filename, JSON.stringify({ selected: value }));
    await assert.rejects(
      resolveCredential(a),
      (error: Error) => !error.message.includes('fixture-value'),
    );
  }
  if (process.platform !== 'darwin')
    await assert.rejects(
      resolveCredential({
        ...a,
        credentialReference: { kind: 'macos-keychain', service: 'fixture', account: 'fixture' },
      }),
      /macOS/,
    );
});

async function application(t: test.TestContext, filename: string) {
  let factories = 0;
  const contexts: DriverContext[] = [],
    sinks: DriverSink[] = [];
  const state = await createApp({
    filename: ':memory:',
    test: true,
    memoryPressureReader: unknownPressure,
    driverFactory(context) {
      factories++;
      contexts.push(context);
      let closed = false;
      return {
        harness: context.work.harness,
        get closed() {
          return closed;
        },
        async start(_context, sink) {
          sinks.push(sink);
          assert.equal(
            nativeEnvironment(context.account, context.credentials)[target],
            'fixture-first-private-value',
          );
        },
        async interrupt() {},
        async close() {
          closed = true;
        },
      };
    },
  });
  t.after(() => state.app.close());
  const headers = {
    host: '127.0.0.1:4710',
    'x-forge-csrf': state.csrf,
    'content-type': 'application/json',
  };
  const call = (method: 'GET' | 'POST', url: string, payload?: object, extra = {}) =>
    state.app.inject({ method, url, headers: { ...headers, ...extra }, payload });
  const input = {
    label: 'Native private slot',
    harness: 'codex',
    billingMode: 'api',
    credentialEnv: target,
    credentialReference: { kind: 'private-json', path: filename, key: 'selected' },
  };
  const added = await call('POST', '/api/accounts', input);
  assert.equal(added.statusCode, 201, added.body);
  const a = added.json<Account>();
  const work = (
    await call('POST', '/api/work', {
      title: 'Private credential launch',
      project: 'Fixture',
      goal: 'No inference',
      cwd: process.cwd(),
      harness: 'codex',
      accountId: a.id,
    })
  ).json<Work>();
  return { ...state, call, a, work, contexts, sinks, input, factories: () => factories };
}

test('the human reference check returns no credential, and native launch resolves before factories and never persists its value', async (t) => {
  const f = await file(t),
    app = await application(t, f.filename);
  const check = await app.call('POST', `/api/accounts/${app.a.id}/credential/check`, {});
  assert.equal(check.statusCode, 200, check.body);
  assert.equal(check.json().available, true);
  assert.equal(check.body.includes('fixture-first'), false);
  assert.equal(app.factories(), 0);
  const launched = await app.call('POST', `/api/work/${app.work.id}/launch`, {
    expectedRevision: 0,
  });
  assert.equal(launched.statusCode, 202, launched.body);
  for (let i = 0; i < 30 && !app.sinks.length; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(app.factories(), 1);
  assert.equal(
    JSON.stringify(app.local.db.prepare('SELECT data FROM records').all()).includes(
      'fixture-first',
    ),
    false,
  );
  assert.equal((await app.call('GET', '/api/snapshot')).body.includes('fixture-first'), false);
  assert.equal(
    (await app.call('GET', '/api/blueprint')).body.includes('credentialReference'),
    false,
  );
  app.sinks[0].ended('completed', 'Fixture complete', 'No inference.');
  for (let i = 0; i < 30 && app.controller.activeCount; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(app.controller.activeCount, 0);
  assert.throws(() => credentialValue(app.a, target, app.contexts[0].credentials), /binding/);
});

test('missing references hold admission before reserving spending or constructing a native driver, and provisioning remains local-human only', async (t) => {
  const f = await file(t),
    app = await application(t, f.filename);
  await rm(f.filename);
  const launch = await app.call('POST', `/api/work/${app.work.id}/launch`, { expectedRevision: 0 });
  assert.equal(launch.statusCode, 409, launch.body);
  assert.equal(app.factories(), 0);
  assert.equal(app.local.all('runs').length, 0);
  assert.equal(app.local.all('spend_attempts').length, 0);
  assert.equal(
    (await app.call('POST', '/api/accounts', app.input, { 'x-forge-workspace': 'demo' }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.call(
        'POST',
        `/api/accounts/${app.a.id}/credential/check`,
        {},
        { authorization: 'Bearer companion' },
      )
    ).statusCode,
    403,
  );
});

test('state 5 upgrades with private rollback and retains reference metadata without putting its value in SQLite', async (t) => {
  const f = await file(t),
    filename = join(f.directory, 'workspace.sqlite'),
    a = account(f.filename);
  let store = new Store(filename);
  store.put('accounts', a.id, a);
  store.db.exec('PRAGMA user_version = 5');
  store.close();
  store = new Store(filename);
  try {
    assert.match(store.migrationBackup!, /before-v6/);
    if (process.platform !== 'win32')
      assert.equal((await stat(store.migrationBackup!)).mode & 0o777, 0o600);
    const backup = new DatabaseSync(store.migrationBackup!, { readOnly: true });
    try {
      assert.equal(
        (backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        5,
      );
    } finally {
      backup.close();
    }
    assert.deepEqual(store.account(a.id).credentialReference, a.credentialReference);
    assert.equal(
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      6,
    );
    assert.equal(
      JSON.stringify(store.db.prepare('SELECT data FROM records').all()).includes('fixture-first'),
      false,
    );
    assert.match(await readFile(f.filename, 'utf8'), /fixture-first/);
  } finally {
    store.close();
  }
});
