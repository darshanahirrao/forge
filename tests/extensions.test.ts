import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtensions } from '../server/extensions.js';
import { extensionPaths } from '../server/extension-config.js';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { canExecuteAccount } from '../shared/harnesses.js';
import { Store } from '../server/store.js';
import type { Account } from '../shared/types.js';

const fixtureProvider = new URL('./fixtures/companion-provider.mjs', import.meta.url).href;
const code = (
  release = '1.0.0',
  id = 'ext.owned.runtime',
) => `import {companionProviderFixture} from ${JSON.stringify(fixtureProvider)};
export default {format:'forge.extension',version:1,id:'owned.runtime',name:'Owned native extension',release:${JSON.stringify(release)},companions:[{...companionProviderFixture,id:${JSON.stringify(id)},name:'Owned native runtime'}]};`;
async function directory(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-extension-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('explicit native extension modules publish bounded metadata without starting a runtime and reject aliases, collisions and unknown contracts', async (t) => {
  const root = await directory(t),
    module = join(root, 'runtime.mjs');
  await writeFile(module, code(), { mode: 0o600 });
  const loaded = await loadExtensions([module]);
  assert.equal(loaded.runtimes.length, 1);
  assert.equal(loaded.runtimes[0].id, 'ext.owned.runtime');
  assert.equal(typeof loaded.providers['ext.owned.runtime'].connect, 'function');
  assert.equal(JSON.stringify(loaded.runtimes).includes(module), false);
  assert.equal(Object.isFrozen(loaded.providers), true);
  await assert.rejects(loadExtensions([module, module]), /more than once/);
  const other = join(root, 'other.mjs');
  await writeFile(other, code());
  await assert.rejects(loadExtensions([module, other]), /Extension IDs must be unique/);
  await writeFile(other, code().replace("id:'owned.runtime'", "id:'another.runtime'"));
  await assert.rejects(loadExtensions([module, other]), /provider IDs must be unique/);
  await writeFile(other, code('1.0.0', 'hermes'));
  await assert.rejects(loadExtensions([other]));
  await writeFile(other, code().replace('version:1', 'version:9'));
  await assert.rejects(loadExtensions([other]));
  await writeFile(
    other,
    code().replace("name:'Owned native runtime'", "name:'Owned native runtime',unexpected:true"),
  );
  await assert.rejects(loadExtensions([other]));
});

test('extension startup configuration and entry reads reject unsafe shapes without executing them', async (t) => {
  const root = await directory(t),
    module = join(root, 'owned.mjs'),
    alias = join(root, 'alias.mjs');
  await writeFile(module, code(), { mode: 0o600 });
  assert.deepEqual(extensionPaths(), []);
  for (const raw of [
    '{}',
    'null',
    '["relative.mjs"]',
    JSON.stringify(Array(17).fill(module)),
    '["/tmp/new\\nline.mjs"]',
  ])
    assert.throws(() => extensionPaths(raw));
  await symlink(module, alias);
  await assert.rejects(loadExtensions([alias]));
  if (process.platform !== 'win32') {
    await chmod(module, 0o666);
    await assert.rejects(loadExtensions([module]), /owned regular extension/);
    await chmod(module, 0o600);
  }
  await writeFile(module, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(loadExtensions([module]), /at most 1 MiB/);
});

test('a first-class extension account starts one signed original child, retains profile/grant context and holds changed extension bindings after restart', async (t) => {
  const root = await directory(t),
    module = join(root, 'runtime.mjs'),
    home = join(root, 'native'),
    project = join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  await writeFile(join(home, 'config.yaml'), 'owned: true\n');
  await writeFile(module, code());
  let loaded = await loadExtensions([module]);
  const make = () =>
    createApp({
      filename: join(root, 'workspace.sqlite'),
      port: 0,
      test: true,
      extensions: loaded,
      memoryPressureReader: unknownPressure,
    });
  let state = await make();
  t.after(() => state.app.close());
  const request = (method: 'POST' | 'GET', url: string, payload?: unknown) =>
    state.app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:0',
        'x-forge-csrf': state.csrf,
        'content-type': 'application/json',
      },
      ...(method === 'POST' ? { payload: JSON.stringify(payload ?? {}) } : {}),
    });
  const response = await request('POST', '/api/accounts', {
    label: 'First extension account',
    harness: 'ext.owned.runtime',
    nativeHome: home,
    billingMode: 'native',
  });
  assert.equal(response.statusCode, 201, response.body);
  const account = response.json<Account>();
  assert.equal(account.nativeProvider?.digest, loaded.runtimes[0].digest);
  assert.equal(canExecuteAccount(account), false);
  const checked = await request('POST', `/api/accounts/${account.id}/probe`);
  assert.equal(checked.statusCode, 200, checked.body);
  assert.equal(checked.json().state, 'configured');
  assert.equal(checked.json().identity, null);
  assert.deepEqual(checked.json().quotas, []);
  const profile = state.local.all<{ id: string }>('profiles')[0];
  const grant = await state.companions.create({
    label: 'Generic native context',
    profileId: profile.id,
    root: project,
    scopes: ['context:read', 'work:read', 'work:write'],
    accountIds: [],
  });
  const runtime = state.companionRuntimes.register({
    label: 'Owned extension daemon',
    accountId: account.id,
    grantId: grant.grant.id,
  });
  const work = await state.companions.createWork(grant.grant.id, {
    requestId: 'owned-extension-work',
    title: 'Persistent extension work',
    goal: 'Retain this profile and context through native runtime replacement.',
  });
  const plan = await state.companionRuntimes.prepare(runtime.id);
  const launch = await state.companionRuntimes.start(
    {
      id: plan.id,
      digest: plan.digest,
      nativeActivityReviewed: true,
      nativeSpendingAccepted: true,
    },
    { kind: 'local' },
  );
  const until = async (check: () => boolean) => {
    const until = Date.now() + 8000;
    while (!check()) {
      assert(Date.now() < until, 'Owned native lifecycle timed out.');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };
  await until(() => state.companionRuntimes.snapshot().launches[0].state === 'running');
  const live = state.companionRuntimes.snapshot().launches[0];
  assert(live.nativeWorker);
  assert.equal(live.nativeVersion, 'fixture-native');
  await state.companionRuntimes.stop(
    runtime.id,
    { launchId: launch.id, revision: live.revision },
    { kind: 'local' },
  );
  await until(() => state.companionRuntimes.snapshot().launches[0].exitConfirmed);
  assert.equal(state.companionRuntimes.snapshot().launches[0].exit?.method, 'signed-native-close');
  const local = (await request('GET', '/api/snapshot')).json();
  assert.equal(local.runtimeProviders[0].id, account.harness);
  assert.equal((await state.companions.context(grant.grant.id, work.id)).profileId, profile.id);
  await state.app.close();
  await writeFile(module, code('2.0.0'));
  loaded = await loadExtensions([module]);
  state = await make();
  assert.notEqual(loaded.runtimes[0].digest, account.nativeProvider?.digest);
  await assert.rejects(state.companionRuntimes.prepare(runtime.id), /extension binding changed/);
  assert.equal((await request('POST', `/api/accounts/${account.id}/probe`)).statusCode, 409);
  assert.equal(state.companionRuntimes.snapshot().launches[0].exitConfirmed, true);
  assert.equal(
    state.local.account(account.id).nativeProvider?.digest,
    account.nativeProvider?.digest,
  );
});

test('native runtime extension accounts require local binding authority and cannot masquerade as ACP or builtin identities', async (t) => {
  const root = await directory(t),
    module = join(root, 'runtime.mjs');
  await writeFile(module, code());
  const loaded = await loadExtensions([module]);
  const state = await createApp({
    filename: ':memory:',
    test: true,
    extensions: loaded,
    phoneBridge: { origin: 'https://extension.fixture.ts.net', proof: 'owned-extension-proof' },
    memoryPressureReader: unknownPressure,
  });
  t.after(() => state.app.close());
  const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': state.csrf };
  const payload = {
    label: 'Owned native runtime',
    harness: 'ext.owned.runtime',
    nativeHome: root,
    billingMode: 'native',
  };
  for (const change of [
    {
      headers: {
        ...headers,
        'x-forge-bridge-proof': 'owned-extension-proof',
        'x-forge-bridge-identity': 'owner@example.invalid',
      },
      payload,
    },
    { headers, payload: { ...payload, connectorId: payload.harness } },
    { headers, payload: { ...payload, billingMode: 'subscription' } },
    { headers, payload: { ...payload, harness: 'ext.missing.runtime' } },
  ]) {
    assert(
      (await state.app.inject({ method: 'POST', url: '/api/accounts', ...change })).statusCode >=
        400,
    );
  }
  const demo = await state.app.inject({
    url: '/api/snapshot',
    headers: { ...headers, 'x-forge-workspace': 'demo' },
  });
  assert.deepEqual(demo.json().runtimeProviders, []);
  const blocked = await state.app.inject({
    method: 'POST',
    url: '/api/connectors/prepare',
    headers,
    payload: { id: payload.harness },
  });
  assert.equal(blocked.statusCode, 409);
  const filename = join(root, 'existing-connector.sqlite');
  const previous = new Store(filename);
  previous.put('connectors', payload.harness, { id: payload.harness });
  previous.close();
  await assert.rejects(
    createApp({ filename, test: true, extensions: loaded }),
    /conflicts with an installed ACP connector/,
  );
  const retained = new Store(filename);
  assert.equal(retained.get<{ id: string }>('connectors', payload.harness)?.id, payload.harness);
  retained.close();
});

test('a nonresponding extension start can be stopped before readiness and releases the checkpoint without creating a worker', async (t) => {
  const root = await directory(t),
    module = join(root, 'hang.mjs'),
    home = join(root, 'native');
  await mkdir(home);
  await writeFile(join(home, 'config.yaml'), 'owned: true\n');
  await writeFile(
    module,
    code().replace(
      "name:'Owned native runtime'",
      "name:'Owned native runtime',connect:async()=>new Promise(()=>{})",
    ),
  );
  const extensions = await loadExtensions([module]);
  const state = await createApp({
    filename: join(root, 'state.sqlite'),
    extensions,
    port: 0,
    test: true,
    memoryPressureReader: unknownPressure,
  });
  t.after(() => state.app.close());
  const created = await state.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { host: '127.0.0.1:0', 'x-forge-csrf': state.csrf },
    payload: {
      label: 'Unresponsive owned runtime',
      harness: 'ext.owned.runtime',
      nativeHome: home,
      billingMode: 'native',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const profile = state.local.all<{ id: string }>('profiles')[0];
  const grant = await state.companions.create({
    label: 'Owned context',
    profileId: profile.id,
    root,
    scopes: ['context:read', 'work:read'],
    accountIds: [],
  });
  const runtime = state.companionRuntimes.register({
    label: 'Unresponsive native start',
    accountId: created.json().id,
    grantId: grant.grant.id,
  });
  const review = await state.companionRuntimes.prepare(runtime.id);
  const launch = await state.companionRuntimes.start(
    {
      id: review.id,
      digest: review.digest,
      nativeActivityReviewed: true,
      nativeSpendingAccepted: true,
    },
    { kind: 'local' },
  );
  const current = state.companionRuntimes.snapshot().launches[0];
  await state.companionRuntimes.stop(
    runtime.id,
    { launchId: launch.id, revision: current.revision },
    { kind: 'local' },
  );
  const deadline = Date.now() + 2000;
  while (state.controller.hasLiveExecution) {
    assert(Date.now() < deadline, 'Stopped extension did not release the checkpoint.');
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state.companionRuntimes.snapshot().launches[0].exitConfirmed, true);
  assert.equal(state.companionRuntimes.snapshot().launches[0].exit, undefined);
  assert.equal(state.local.all('companion_supervisions').length, 0);
});
