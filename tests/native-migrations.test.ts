import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { nativeFileSnapshot } from '../server/native-file-snapshot.js';
import { acquireProfileLease } from '../server/adapters/profile-lease.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { Store } from '../server/store.js';
import { artifactSnapshot } from '../server/continuity.js';
import { openClawWorker } from '../server/adapters/openclaw-worker.js';
import { accountBinding } from '../server/adapters/binding.js';
import type { NativeMigrationBridge } from '../server/adapters/native-migration.js';
import type { Account, Work } from '../shared/types.js';
import type { NativeMigrationReview } from '../shared/native-migrations.js';

const headers = {
  host: '127.0.0.1:4710',
  'x-forge-csrf': 'owned-migration-csrf',
  'content-type': 'application/json',
};
async function fixture(t: test.TestContext, override?: NativeMigrationBridge) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-native-import-')));
  const source = join(root, 'source'),
    filename = join(root, 'state', 'workspace.sqlite');
  await mkdir(join(source, 'memories'), { recursive: true });
  const memory = join(source, 'memories', 'MEMORY.md');
  await writeFile(memory, 'Private native memory marker.\n');
  await writeFile(join(source, 'config.yaml'), 'model: fixture\n');
  const credential = join(root, 'private.json');
  await writeFile(credential, '{"selected":"SYNTHETIC-DO-NOT-EXPORT"}', { mode: 0o600 });
  let calls = 0;
  const bridge: NativeMigrationBridge = async (request) => {
    calls++;
    if (override) return override(request);
    await writeFile(join(request.target, 'MEMORY.md'), await readFile(memory), { mode: 0o644 });
    await writeFile(join(request.operationRoot, 'native-report.json'), '{"fixture":true}', {
      mode: 0o644,
    });
    return {
      nativeVersion: 'Owned inert fixture',
      sourceRoots: [memory],
      sourceDigest: (await nativeFileSnapshot([memory])).digest,
      items: [
        {
          kind: 'memory',
          status: 'migrated',
          source: memory,
          target: join(request.target, 'MEMORY.md'),
          note: 'Native memory imported.',
          overflowedEntries: 2,
        },
        {
          kind: 'cron',
          status: 'archived',
          source: null,
          target: null,
          note: 'Jobs archived.',
          overflowedEntries: 0,
        },
        {
          kind: 'credentials',
          status: 'skipped',
          source: null,
          target: null,
          note: 'Credentials excluded.',
          overflowedEntries: 0,
        },
      ],
    };
  };
  const state = await createApp({
    filename,
    csrf: headers['x-forge-csrf'],
    test: true,
    memoryPressureReader: unknownPressure,
    nativeMigrationBridge: bridge,
    driverFactory: () => {
      throw Error('Native imports must not start model workers.');
    },
    phoneBridge: { origin: 'https://migration.fixture.ts.net', proof: 'owned-migration-proof' },
  });
  t.after(async () => {
    await state.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const accountResponse = await state.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: {
      label: 'Owned Hermes source',
      harness: 'hermes',
      nativeHome: source,
      billingMode: 'api',
      credentialEnv: 'OPENAI_API_KEY',
      credentialReference: { kind: 'private-json', path: credential, key: 'selected' },
    },
  });
  assert.equal(accountResponse.statusCode, 201, accountResponse.body);
  const account = accountResponse.json<Account>();
  const send = (path: string, payload: unknown, extra: Record<string, string> = {}) =>
    state.app.inject({
      method: 'POST',
      url: '/api/native/migrations/' + path,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(payload),
    });
  const prepare = async () => {
    const response = await send('prepare', {
      sourceAccountId: account.id,
      label: 'Imported OpenClaw',
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<NativeMigrationReview>();
  };
  const activate = (row: NativeMigrationReview, reuse = false) =>
    send(row.id + '/activate', {
      revision: row.revision,
      digest: row.digest,
      reviewed: true,
      reuseCredentialReference: reuse,
    });
  return {
    ...state,
    root,
    source,
    memory,
    filename,
    account,
    send,
    prepare,
    activate,
    calls: () => calls,
  };
}

test('native profile review activates exactly once, preserves source/work/profile and reuses only an explicit credential reference', async (t) => {
  const f = await fixture(t);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/work',
    headers,
    payload: {
      title: 'Keep the same work',
      project: 'Owned',
      cwd: f.root,
      goal: 'Keep native context.',
      harness: 'hermes',
      accountId: f.account.id,
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const work = created.json<Work>(),
    before = f.local.work(work.id),
    profile = f.local.get('profiles', work.profileId!);
  const plan = await f.prepare();
  assert.equal(plan.state, 'ready');
  assert.deepEqual(plan.summary, { imported: 1, archived: 1, skipped: 1, overflowed: 2 });
  assert.equal(f.local.all('accounts').length, 1);
  assert.equal(await readFile(f.memory, 'utf8'), 'Private native memory marker.\n');
  assert.equal((await stat(plan.nativeHome)).mode & 0o777, 0o700);
  assert.equal((await stat(join(plan.nativeHome, 'MEMORY.md'))).mode & 0o777, 0o600);
  assert.equal((await stat(plan.reportPath)).mode & 0o777, 0o600);
  const activated = await f.activate(plan, true);
  assert.equal(activated.statusCode, 200, activated.body);
  const account = activated.json<Account>();
  assert.equal(account.harness, 'openclaw');
  assert.equal(account.state, 'configured');
  assert.equal(account.identity, null);
  assert.deepEqual(account.quotas, []);
  assert.deepEqual(account.credentialReference, f.account.credentialReference);
  assert.equal(account.credentialEnv, f.account.credentialEnv);
  assert.deepEqual(f.local.work(work.id), before);
  assert.deepEqual(f.local.get('profiles', work.profileId!), profile);
  assert.deepEqual(f.local.account(f.account.id), f.account);
  assert.equal((await f.activate(plan, true)).json<Account>().id, account.id);
  assert.equal((await f.activate(plan, false)).statusCode, 409);
  assert.equal(f.calls(), 1);
  assert.equal(f.local.all('accounts').length, 2);
  assert.equal(f.local.all('runs').length, 0);
  const snapshot = (await f.app.inject({ url: '/api/snapshot', headers })).body;
  assert(!snapshot.includes('SYNTHETIC-DO-NOT-EXPORT'));
  assert(!snapshot.includes('Private native memory marker'));
  assert(!snapshot.includes('sourceRoots'));
  assert(!snapshot.includes('Native memory imported.'));
});

test('native credentials default to separate setup and review, digest and revisions are mandatory', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  for (const change of [
    { reviewed: false },
    { revision: plan.revision + 1 },
    { digest: '0'.repeat(64) },
  ]) {
    const response = await f.send(plan.id + '/activate', {
      revision: plan.revision,
      digest: plan.digest,
      reviewed: true,
      ...change,
    });
    assert(response.statusCode >= 400, response.body);
  }
  const activated = await f.activate(plan);
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal(activated.json<Account>().credentialReference, undefined);
  assert.equal(activated.json<Account>().credentialEnv, undefined);
});

for (const change of ['source', 'staged', 'source account', 'symlink'] as const)
  test(`changed ${change} holds native profile activation without a partial account`, async (t) => {
    const f = await fixture(t),
      plan = await f.prepare();
    if (change === 'source') await writeFile(f.memory, 'Changed native memory.');
    if (change === 'staged') await writeFile(join(plan.nativeHome, 'MEMORY.md'), 'Changed stage.');
    if (change === 'source account')
      f.local.put('accounts', f.account.id, {
        ...f.account,
        identityKey: 'different-native-identity',
      });
    if (change === 'symlink') {
      await rm(join(plan.nativeHome, 'MEMORY.md'));
      await symlink(f.memory, join(plan.nativeHome, 'MEMORY.md'));
    }
    const response = await f.activate(plan);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(f.local.all('accounts').length, 1);
    assert.equal(f.nativeMigrations.review(plan.id).state, 'ready');
  });

test('original owner fences preparation and activation before native execution', async (t) => {
  const f = await fixture(t);
  let release = await acquireProfileLease(f.source);
  try {
    assert.equal(
      (await f.send('prepare', { sourceAccountId: f.account.id, label: 'Held' })).statusCode,
      409,
    );
  } finally {
    release();
  }
  assert.equal(f.calls(), 0);
  const plan = await f.prepare();
  release = await acquireProfileLease(f.source);
  try {
    assert.equal((await f.activate(plan)).statusCode, 409);
  } finally {
    release();
  }
  assert.equal(f.local.all('accounts').length, 1);
  assert.equal((await f.activate(plan)).statusCode, 200);
});

test('native utility failure retains a failed preparation, exposes no stderr/secret and never registers a profile', async (t) => {
  const f = await fixture(t, async (request) => {
    await writeFile(join(request.target, 'partial.txt'), 'Owned partial native content.');
    throw Error('RAW-SECRET-STDERR');
  });
  const plan = await f.prepare();
  assert.equal(plan.state, 'failed');
  assert(!JSON.stringify(plan).includes('RAW-SECRET-STDERR'));
  assert.equal(f.local.all('accounts').length, 1);
  assert.equal((await f.activate({ ...plan, digest: '0'.repeat(64) })).statusCode, 409);
  assert.equal(
    await readFile(join(plan.nativeHome, 'partial.txt'), 'utf8'),
    'Owned partial native content.',
  );
  const dismissed = await f.send(plan.id + '/dismiss', { revision: plan.revision });
  assert.equal(dismissed.json().state, 'dismissed');
  assert.equal(
    await readFile(join(plan.nativeHome, 'partial.txt'), 'utf8'),
    'Owned partial native content.',
  );
});

test('canonical account and import receipt roll back together when activation persistence fails', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  f.local.db.exec(
    "CREATE TRIGGER block_import_activation BEFORE UPDATE ON records WHEN NEW.collection='native_migrations' AND json_extract(NEW.data,'$.state')='activated' BEGIN SELECT RAISE(ABORT,'owned fixture failure'); END",
  );
  assert.equal((await f.activate(plan)).statusCode, 500);
  assert.equal(f.local.all('accounts').length, 1);
  assert.equal(f.nativeMigrations.review(plan.id).state, 'ready');
  f.local.db.exec('DROP TRIGGER block_import_activation');
  assert.equal((await f.activate(plan)).statusCode, 200);
});

test('preClose aborts and drains import, excludes other setup and persists failure before closing SQLite', async (t) => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, async (request) => {
    started();
    await new Promise<void>((_resolve, reject) =>
      request.signal!.addEventListener(
        'abort',
        () => reject(Error('Owned native utility stopped.')),
        { once: true },
      ),
    );
    throw Error('unreachable');
  });
  const pending = f.prepare();
  await entered;
  assert(f.nativeMigrations.isBusy);
  const account = await f.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: { label: 'Concurrent', harness: 'hermes', nativeHome: f.source },
  });
  assert.equal(account.statusCode, 409);
  await assert.rejects(
    f.controller.atWorkspaceCheckpoint('competing', async () => {}),
    /checkpoint/,
  );
  await f.app.close();
  const result = await pending;
  assert.equal(result.state, 'failed');
  const store = new Store(f.filename);
  try {
    assert.equal(store.all<NativeMigrationReview>('native_migrations')[0].state, 'failed');
    assert.equal(store.all('accounts').length, 1);
  } finally {
    store.close();
  }
});

test('restart marks interrupted preparation failed without invoking native utility or creating an account', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  f.local.put('native_migrations', plan.id, {
    ...f.local.get<Record<string, unknown>>('native_migrations', plan.id),
    state: 'preparing',
  });
  await f.app.close();
  const restarted = await createApp({
    filename: f.filename,
    test: true,
    memoryPressureReader: unknownPressure,
    nativeMigrationBridge: async () => {
      throw Error('Must not replay.');
    },
  });
  try {
    assert.equal(restarted.nativeMigrations.review(plan.id).state, 'failed');
    assert.equal(restarted.local.all('accounts').length, 1);
    assert.equal(f.calls(), 1);
  } finally {
    await restarted.app.close();
  }
});

test('native import endpoints require local human mode and CSRF, including private report reads', async (t) => {
  const f = await fixture(t),
    body = { sourceAccountId: f.account.id, label: 'No authority' };
  assert.equal((await f.send('prepare', body, { 'x-forge-csrf': 'wrong' })).statusCode, 403);
  assert.equal((await f.send('prepare', body, { 'x-forge-workspace': 'demo' })).statusCode, 403);
  assert.equal(
    (
      await f.send('prepare', body, {
        'x-forge-bridge-proof': 'owned-migration-proof',
        'x-forge-bridge-identity': 'alice@example.com',
        origin: 'https://migration.fixture.ts.net',
      })
    ).statusCode,
    403,
  );
  const plan = await f.prepare();
  assert.equal(
    (
      await f.app.inject({
        url: '/api/native/migrations/' + plan.id,
        headers: { ...headers, 'x-forge-workspace': 'demo' },
      })
    ).statusCode,
    403,
  );
});

test('native evidence rejects links, hardlinks, parent aliases and oversize files without exposing content', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-native-evidence-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, 'private'),
    alias = join(root, 'alias');
  await writeFile(original, 'Private text.');
  await symlink(original, alias);
  await assert.rejects(nativeFileSnapshot([alias]), /symbolic/);
  await rm(alias);
  await link(original, alias);
  await assert.rejects(nativeFileSnapshot([original]), /regular/);
  await rm(alias);
  await writeFile(original, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(nativeFileSnapshot([original]), /16 MiB/);
  assert.equal((await nativeFileSnapshot([join(root, 'missing')])).files, 0);
});

test('private native migration profiles and raw reports cannot enter a work checkpoint', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  const relative = `state/native-migrations/${plan.id}/profile/MEMORY.md`;
  await writeFile(join(f.root, 'proof.txt'), 'Owned project artifact.');
  const result = await artifactSnapshot(f.root, [
    'proof.txt',
    relative,
    `state/native-migrations/${plan.id}/native-report.json`,
  ]);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.excluded.length, 2);
  assert(!JSON.stringify(result).includes('Private native memory marker'));
});

test('native OpenClaw project authority is explicit, exact, local and part of activation idempotency', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  const decision = {
    revision: plan.revision,
    digest: plan.digest,
    reviewed: true,
    openClawProjectRoot: f.root,
  };
  const response = await f.send(plan.id + '/activate', decision);
  assert.equal(response.statusCode, 200, response.body);
  const account = response.json<Account>();
  assert.equal(account.openClawProjectRoot, f.root);
  assert.notEqual(
    accountBinding(account),
    accountBinding({ ...account, openClawProjectRoot: undefined }),
  );
  assert.equal((await f.send(plan.id + '/activate', decision)).json<Account>().id, account.id);
  assert.equal((await f.activate(plan)).statusCode, 409);
  await assert.rejects(openClawWorker(account, f.source), /reviewed project/);
  const alias = join(f.root, 'project-alias');
  await symlink(f.source, alias);
  const second = await f.prepare();
  assert.equal(
    (
      await f.send(second.id + '/activate', {
        ...decision,
        revision: second.revision,
        digest: second.digest,
        openClawProjectRoot: alias,
      })
    ).statusCode,
    409,
  );
  for (const harness of ['hermes', 'codex']) {
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers,
      payload: {
        label: 'Invalid project authority',
        harness,
        nativeHome: f.source,
        openClawProjectRoot: f.root,
      },
    });
    assert.equal(invalid.statusCode, 403);
  }
  const workResponse = await f.app.inject({
    method: 'POST',
    url: '/api/work',
    headers,
    payload: {
      title: 'Mismatched native project',
      project: 'Owned',
      cwd: f.source,
      goal: 'Refuse before spawning.',
      harness: 'openclaw',
      accountId: account.id,
    },
  });
  assert.equal(workResponse.statusCode, 201, workResponse.body);
  const work = workResponse.json<Work>();
  const launch = await f.app.inject({
    method: 'POST',
    url: `/api/work/${work.id}/launch`,
    headers,
    payload: { expectedRevision: work.revision, allowMetered: true },
  });
  assert.equal(launch.statusCode, 409, launch.body);
  assert.equal(f.local.all('runs').length, 0);
});
