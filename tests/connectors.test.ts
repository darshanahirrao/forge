import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NativeConnectors,
  connectorManifestSchema,
  connectorEnvironment,
} from '../server/connectors.js';
import { Store, now } from '../server/store.js';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';
import type { Account, Approval, Work } from '../shared/types.js';
import { connectorTestExecutable } from './fixtures/connector-executable.js';
import { stat } from 'node:fs/promises';

const spec = (executable: string) => ({
  format: 'forge.native-connector' as const,
  version: 1 as const,
  id: 'ext.owned-agent.v1',
  name: 'Owned native agent',
  protocol: 'acp/1' as const,
  executable,
  args: [],
  agent: { name: 'owned-acp-fixture', version: '1.0.0' },
  mode: 'review',
  homeVariables: { FIXTURE_AGENT_HOME: '.' },
});
async function directory(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-connectors-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'owned-never-run');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { root, executable };
}

test('connector manifests are versioned, namespaced and exclude shell/env/escaping-home authority', () => {
  const good = spec('/absolute/native');
  assert.equal(connectorManifestSchema.parse(good).protocol, 'acp/1');
  for (const wrong of [
    { ...good, version: 2 },
    { ...good, id: 'codex' },
    { ...good, protocol: 'acp/2' },
    { ...good, executable: 'relative' },
    { ...good, env: { SECRET: 'excluded' } },
    { ...good, homeVariables: { NODE_OPTIONS_HOME: '.' } },
    { ...good, homeVariables: { AGENT_HOME: '../other' } },
    { ...good, args: ['bad\u0000arg'] },
  ])
    assert.throws(() => connectorManifestSchema.parse(wrong));
});
test('a group-writable CI runtime uses a private test launcher without weakening production checks or chmodding the original', async (t) => {
  if (process.platform === 'win32') return;
  const f = await directory(t);
  await chmod(f.executable, 0o775);
  const owned = await connectorTestExecutable(f.root, f.executable);
  assert.notEqual(owned, f.executable);
  assert.equal((await stat(owned)).mode & 0o777, 0o700);
  assert.equal((await stat(f.executable)).mode & 0o777, 0o775);
  assert.ok((await readFile(owned, 'utf8')).includes(`exec '${f.executable}' "$@"`));
});

test('registration executes nothing, revalidates a reviewed binary and pins immutable history bindings', async (t) => {
  const f = await directory(t),
    store = new Store(':memory:');
  t.after(() => store.close());
  let busy = false;
  const registry = new NativeConnectors(store, () => busy);
  const stale = await registry.prepare(spec(f.executable));
  await writeFile(f.executable, '#!/bin/sh\nexit 1\n');
  await assert.rejects(registry.install(stale.id, stale.connector.digest), /executable changed/);
  assert.equal(registry.list().length, 0);
  const plan = await registry.prepare(spec(f.executable));
  plan.connector.manifest.args.push('tampered-return-copy');
  const connector = await registry.install(plan.id, plan.connector.digest);
  assert.deepEqual(connector.manifest.args, []);
  await assert.rejects(registry.prepare(spec(f.executable)), /immutable/);
  const account = {
    id: 'slot',
    harness: connector.id,
    nativeHome: f.root,
    connector: registry.binding(connector.id, connector.id),
    connectorReady: true,
    billingMode: 'native',
    createdAt: now(),
  } as Account;
  store.put('accounts', account.id, account);
  await registry.validateAccount(account);
  assert.throws(() => registry.remove(connector.id), /history/);
  busy = true;
  await assert.rejects(registry.setEnabled(connector.id, false), /native workers/);
  busy = false;
  await registry.setEnabled(connector.id, false);
  assert.equal(store.account(account.id).connectorReady, false);
  await assert.rejects(registry.validateAccount(account), /unavailable/);
  await registry.setEnabled(connector.id, true);
  await registry.validateAccount(account);
  store.remove('accounts', account.id);
  registry.remove(connector.id);
  assert.equal(await readFile(f.executable, 'utf8'), '#!/bin/sh\nexit 1\n');
});

test('connector environment contains only native runtime basics, reviewed profile roots and a selected credential', async (t) => {
  const f = await directory(t),
    store = new Store(':memory:');
  t.after(() => store.close());
  const registry = new NativeConnectors(store, () => false),
    plan = await registry.prepare(spec(f.executable));
  const original = process.env.FORGE_CONNECTOR_EXCLUDED_KEY;
  process.env.FORGE_CONNECTOR_EXCLUDED_KEY = 'excluded-parent-key';
  t.after(() => {
    if (original === undefined) delete process.env.FORGE_CONNECTOR_EXCLUDED_KEY;
    else process.env.FORGE_CONNECTOR_EXCLUDED_KEY = original;
  });
  const env = connectorEnvironment(plan.connector, { nativeHome: f.root } as Account);
  assert.equal(env.FIXTURE_AGENT_HOME, f.root);
  assert.equal(env.FORGE_CONNECTOR_EXCLUDED_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  const escaped = {
    ...plan.connector,
    manifest: { ...plan.connector.manifest, homeVariables: { FIXTURE_AGENT_HOME: '../escape' } },
  };
  assert.throws(() => connectorEnvironment(escaped, { nativeHome: f.root } as Account), /escaped/);
});

test('connector API remains local human authority, requires review, refuses broad-write binaries and does not turn installation into execution', async (t) => {
  const f = await directory(t),
    state = await createApp({
      filename: ':memory:',
      test: true,
      memoryPressureReader: unknownPressure,
    });
  t.after(() => state.app.close());
  const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': state.csrf };
  const post = (url: string, payload: Record<string, unknown>, extra = {}) =>
    state.app.inject({ method: 'POST', url, headers: { ...headers, ...extra }, payload });
  for (const extra of [
    { authorization: 'Bearer companion' },
    { 'x-forge-csrf': 'wrong' },
    { 'x-forge-workspace': 'demo' },
  ])
    assert.equal(
      (await post('/api/connectors/prepare', spec(f.executable), extra)).statusCode,
      403,
    );
  if (process.platform !== 'win32') {
    await chmod(f.executable, 0o777);
    assert.equal((await post('/api/connectors/prepare', spec(f.executable))).statusCode, 409);
    await chmod(f.executable, 0o700);
  }
  const plan = (await post('/api/connectors/prepare', spec(f.executable))).json();
  assert.equal(
    (
      await post('/api/connectors/install', {
        planId: plan.id,
        digest: plan.connector.digest,
        reviewed: false,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await post('/api/connectors/install', {
        planId: plan.id,
        digest: plan.connector.digest,
        reviewed: true,
      })
    ).statusCode,
    200,
  );
  assert.equal(state.local.all('runs').length, 0);
  assert.equal(
    (await post('/api/accounts', { harness: 'ext.missing', label: 'Unbound' })).statusCode,
    400,
  );
});

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The owned native connector did not reach the expected state.');
}

test('an installed connector runs through shared exact approvals, durable work, native profile/session resume and account-scoped private material', async (t) => {
  const f = await directory(t),
    home = join(f.root, 'native'),
    project = join(f.root, 'project');
  await mkdir(home);
  await mkdir(project);
  const secret = join(f.root, 'private.json');
  await writeFile(secret, '{"selected":"synthetic-owned-connector-key"}', { mode: 0o600 });
  const state = await createApp({
    filename: ':memory:',
    test: true,
    memoryPressureReader: unknownPressure,
  });
  t.after(() => state.app.close());
  const manifest = {
    ...spec(await connectorTestExecutable(f.root, process.execPath, true)),
    model: 'fixture/proof',
    args: [fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))],
  };
  const plan = await state.connectors.prepare(manifest);
  const connector = await state.connectors.install(plan.id, plan.connector.digest);
  const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': state.csrf };
  const accountResponse = await state.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: {
      label: 'Owned connector slot',
      harness: connector.id,
      connectorId: connector.id,
      nativeHome: home,
      billingMode: 'api',
      credentialEnv: 'FIXTURE_API_KEY',
      credentialReference: { kind: 'private-json', path: secret, key: 'selected' },
    },
  });
  assert.equal(accountResponse.statusCode, 201, accountResponse.body);
  const account = accountResponse.json() as Account;
  const probe = await state.app.inject({
    method: 'POST',
    url: `/api/accounts/${account.id}/probe`,
    headers,
    payload: {},
  });
  assert.equal(probe.statusCode, 200, probe.body);
  assert.equal(probe.json().identity, null);
  const workResponse = await state.app.inject({
    method: 'POST',
    url: '/api/work',
    headers,
    payload: {
      title: 'Owned connector continuity',
      project: 'Owned fixture',
      cwd: project,
      goal: 'Write an owned proof after human review.',
      harness: connector.id,
      accountId: account.id,
    },
  });
  assert.equal(workResponse.statusCode, 201, workResponse.body);
  const work = workResponse.json() as Work;
  for (let turn = 0; turn < 2; turn++) {
    await state.controller.launch(work.id, true, false, state.local.work(work.id).revision);
    await until(() =>
      state.local
        .all<Approval>('approvals')
        .some((a) => a.workId === work.id && a.status === 'pending'),
    );
    const approval = state.local
      .all<Approval>('approvals')
      .find((a) => a.workId === work.id && a.status === 'pending')!;
    assert.equal(approval.method, `${connector.id}/acp/request_permission`);
    assert.ok(approval.command.includes('owned-connector-proof.json'));
    await state.controller.decide(approval.id, approval.digest, 'accept', { kind: 'local' });
    await until(() => !state.local.work(work.id).activeRunId);
    assert.equal(state.local.work(work.id).status, 'completed');
    assert.equal(
      JSON.parse(await readFile(join(project, 'owned-connector-proof.json'), 'utf8'))
        .credentialPresent,
      true,
    );
  }
  assert.equal(
    new Set(state.local.all<{ nativeSessionId: string }>('runs').map((r) => r.nativeSessionId))
      .size,
    1,
  );
  assert.equal(state.local.all('usage').length, 0, 'Missing billable usage was fabricated.');
  assert.equal(
    JSON.stringify(state.local.all('accounts')).includes('synthetic-owned-connector-key'),
    false,
  );
});
