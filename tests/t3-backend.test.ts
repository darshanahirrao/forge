import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { T3Backends } from '../server/backends/t3-backend.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { Account } from '../shared/types.js';
import { rpcFixture } from './fixtures/t3-rpc.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'forge-backend-test-'));
  const store = new Store(join(directory, 'forge.sqlite'));
  const config = {
    environment: { environmentId: 'native-environment', orchestrationProtocolVersion: 2 },
    settings: { environment: { SECRET_DO_NOT_IMPORT: 'synthetic-native-private-setting' } },
    providers: ['one', 'two'].map((instanceId) => ({
      instanceId,
      driver: 'customAcp',
      displayName: instanceId,
      enabled: true,
      installed: true,
      status: 'ready',
      auth: {
        status: 'authenticated',
        email: 'synthetic-user@example.test',
        workspaceId: 'shared-native-workspace',
      },
      models: [{ slug: 'native-model', name: 'Native model', isDefault: true }],
      runtimePaths: { homePath: '/native/home' },
      usageLimits: {
        checkedAt: new Date().toISOString(),
        windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 35 }],
      },
    })),
  };
  const native = rpcFixture((frame, socket) => {
    if (frame._tag !== 'Request') return;
    if (frame.tag === 'server.getConfig') socket.success(frame.id, config);
    else if (frame.tag === 'orchestration.subscribeShell')
      socket.emit({
        _tag: 'Chunk',
        requestId: frame.id,
        values: [
          {
            kind: 'snapshot',
            snapshot: {
              projects: [
                { id: 'native-project', title: 'Native project', workspaceRoot: '/project' },
              ],
            },
          },
        ],
      });
    else socket.success(frame.id, {});
  });
  let scope = 'orchestration:read orchestration:operate';
  const exchanges: URLSearchParams[] = [];
  const manager = new T3Backends(store, directory, {
    rpc: (_endpoint, token) => native.create(token),
    fetch: async (_endpoint, request) => {
      exchanges.push(new URLSearchParams(String(request!.body)));
      return Response.json({
        access_token: 'synthetic-native-human-control',
        token_type: 'Bearer',
        scope,
      });
    },
  });
  return {
    manager,
    directory,
    store,
    config,
    native,
    exchanges,
    setScope: (value: string) => (scope = value),
    connect: () =>
      manager.connect({
        endpoint: 'http://127.0.0.1:3773',
        label: 'Native T3',
        code: 'synthetic-one-time-code',
      }),
    close: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('T3 execution pairing imports dynamic native accounts, preserves shared quota scopes and excludes human control credentials and settings from SQLite', async () => {
  const f = await setup();
  try {
    const backend = await f.connect();
    const accounts = f.store.all<Account>('accounts');
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].harness, 'customAcp');
    assert.equal(accounts[0].identityKey, accounts[1].identityKey);
    assert.equal(accounts[0].quotas[0].scope, accounts[1].quotas[0].scope);
    assert.equal(accounts[0].backend?.model, 'native-model');
    assert.equal(f.exchanges[0].get('scope'), 'orchestration:read orchestration:operate');
    assert.equal(f.exchanges[0].get('subject_token'), 'synthetic-one-time-code');
    const data = JSON.stringify([f.store.all('backends'), accounts, f.store.all('config')]);
    assert(
      !data.includes('synthetic-native-human-control') &&
        !data.includes('synthetic-one-time-code') &&
        !data.includes('synthetic-native-private-setting'),
    );
    const filename = join(f.directory, `.forge-t3-control-${backend.id}.json`);
    assert.equal(
      JSON.parse(await readFile(filename, 'utf8')).token,
      'synthetic-native-human-control',
    );
    if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
    const rpc = await f.manager.rpc(backend.id);
    assert.equal((await f.manager.projects(rpc))[0].id, 'native-project');
    rpc.close();
    assert(
      f.native.sockets.some((socket) => socket.sent.some((frame) => frame._tag === 'Interrupt')),
      'A one-shot catalogue read must release its native subscription.',
    );
  } finally {
    await f.close();
  }
});

test('T3 re-pairing and disconnect preserve account/work identity; missing native providers retain unavailable attribution', async () => {
  const f = await setup();
  try {
    const backend = await f.connect();
    const before = f.store
      .all<Account>('accounts')
      .map((account) => account.id)
      .sort();
    f.config.providers[1].enabled = false;
    await f.manager.refresh(backend.id);
    assert.equal(
      f.store.all<Account>('accounts').find((account) => account.backend?.instanceId === 'two')
        ?.state,
      'unavailable',
    );
    const paired = await f.connect();
    assert.equal(paired.id, backend.id);
    assert.deepEqual(
      f.store
        .all<Account>('accounts')
        .map((account) => account.id)
        .sort(),
      before,
    );
    await f.manager.disconnect(backend.id);
    assert.equal(f.manager.list()[0].state, 'disconnected');
    await assert.rejects(f.manager.rpc(backend.id), /Connect/);
    assert.equal(
      (await readdir(f.directory)).some((name) => name.startsWith('.forge-t3-control-')),
      false,
    );
    assert.equal((await f.connect()).id, backend.id);
  } finally {
    await f.close();
  }
});

test('T3 rejects broadened native grants and changed environment identity without importing replacement authority', async () => {
  const f = await setup();
  try {
    f.setScope('orchestration:read orchestration:operate settings:write');
    await assert.rejects(f.connect(), /exactly/);
    assert.equal(f.store.all('backends').length, 0);
    assert.equal(
      (await readdir(f.directory)).some((name) => name.startsWith('.forge-t3-control-')),
      false,
    );
    f.setScope('orchestration:read orchestration:operate');
    const backend = await f.connect();
    f.config.environment.environmentId = 'different-native-environment';
    await assert.rejects(f.connect(), /different native environment/);
    assert.equal(f.manager.list()[0].environmentId, backend.environmentId);
  } finally {
    await f.close();
  }
});

test('registered dynamic harnesses can save work; changing a native model invalidates an earlier launch review before dispatch', async () => {
  let dispatches = 0;
  const f = await createApp({
    filename: ':memory:',
    test: true,
    driverFactory: () => {
      dispatches++;
      throw Error('An obsolete review must not reach dispatch.');
    },
  });
  const account: Account = {
    id: 'native-account',
    label: 'Native ACP',
    harness: 'customAcp',
    nativeHome: '',
    billingMode: 'native',
    state: 'configured',
    identity: null,
    identityKey: null,
    plan: null,
    checkedAt: null,
    error: null,
    quotas: [],
    createdAt: new Date().toISOString(),
    backend: { id: 'native-backend', instanceId: 'native-acp', model: 'first-model' },
    models: ['first-model', 'second-model'],
    providerReady: true,
  };
  f.local.put('accounts', account.id, account);
  const headers = {
    host: '127.0.0.1:4710',
    'content-type': 'application/json',
    'x-forge-csrf': f.csrf,
  };
  try {
    const body = {
      title: 'Dynamic native work',
      project: 'Fixture',
      goal: 'Retain the work independently of a native model.',
      cwd: process.cwd(),
      harness: account.harness,
      accountId: account.id,
    };
    const unknown = await f.app.inject({
      method: 'POST',
      url: '/api/work',
      headers,
      payload: { ...body, harness: 'unregisteredHarness', accountId: null },
    });
    assert.equal(unknown.statusCode, 400);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/work',
      headers,
      payload: body,
    });
    assert.equal(created.statusCode, 201, created.body);
    const work = created.json<{ id: string; revision: number }>();
    const changed = await f.app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}/backend`,
      headers,
      payload: { model: 'second-model' },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(f.local.work(work.id).revision, work.revision + 1);
    const obsolete = await f.app.inject({
      method: 'POST',
      url: `/api/work/${work.id}/launch`,
      headers,
      payload: { expectedRevision: work.revision, allowMetered: true },
    });
    assert.equal(obsolete.statusCode, 409, obsolete.body);
    assert.equal(dispatches, 0);
    assert.equal(f.local.all('runs').length, 0);
  } finally {
    await f.app.close();
  }
});
