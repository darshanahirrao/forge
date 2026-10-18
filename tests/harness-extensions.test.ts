import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { loadExtensions } from '../server/extensions.js';
import { parseMemoryPressure, unknownPressure } from '../server/memory-pressure.js';
import { canExecuteAccount } from '../shared/harnesses.js';
import type { Account, Approval, Run, Usage, Work } from '../shared/types.js';
import { harnessExtensionCode } from './fixtures/harness-extension.mjs';
import { readWorkerExit } from '../server/worker-proof.mjs';
import type { WorkerProofDescriptor } from '../shared/recovery.js';
import { NativeHarnesses } from '../server/harness-providers.js';
import type { DriverContext } from '../server/adapters/driver.js';
import { resolveCredential, type CredentialMaterial } from '../server/credentials.js';

const code = (release = '1.0.0', reader = false) =>
  harnessExtensionCode({
    sdk: new URL('../server/extension-sdk.ts', import.meta.url).href,
    rpc: new URL('../server/adapters/rpc.ts', import.meta.url).href,
    agent: fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url)),
    release,
    ...(reader ? { accountReader: 'codex' as const } : {}),
  });
async function fixture(t: test.TestContext, reader = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-executor-')));
  const module = join(root, 'extension.mjs'),
    home = join(root, 'native'),
    project = join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  await writeFile(module, code('1.0.0', reader), { mode: 0o600 });
  let loaded = await loadExtensions([module]);
  let pressure = unknownPressure();
  const make = () =>
    createApp({
      filename: join(root, 'workspace.sqlite'),
      extensions: loaded,
      port: 0,
      test: true,
      memoryPressureReader: () => pressure,
    });
  let state = await make();
  t.after(async () => {
    await state.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    state.app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:0',
        'x-forge-csrf': state.csrf,
        'content-type': 'application/json',
        ...headers,
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const account = async (extra: Record<string, unknown> = {}) => {
    const response = await call('POST', '/api/accounts', {
      label: 'Extension account',
      harness: 'ext.owned.executor',
      nativeHome: home,
      ...extra,
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<Account>();
  };
  return {
    root,
    home,
    project,
    module,
    call,
    account,
    setPressure(value: ReturnType<typeof unknownPressure>) {
      pressure = value;
    },
    get state() {
      return state;
    },
    async restart(release?: string, missing = false) {
      await state.app.close();
      if (release) await writeFile(module, code(release, reader));
      loaded = missing ? await loadExtensions() : await loadExtensions([module]);
      state = await make();
    },
  };
}
async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) {
    assert(Date.now() < end, 'Owned native execution timed out.');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('an execution-only extension is first-class without starting a worker and rejects mixed-role identity collisions', async (t) => {
  const f = await fixture(t),
    account = await f.account();
  assert(account.nativeExecutor);
  assert(!account.nativeProvider);
  assert(canExecuteAccount(account));
  assert.equal(f.state.local.all('runs').length, 0);
  await assert.rejects(readFile(join(f.home, 'scope.json')), { code: 'ENOENT' });
  const snapshot = (await f.call('GET', '/api/snapshot')).json();
  assert.equal(snapshot.nativeHarnesses[0].id, account.harness);
  assert.equal(snapshot.accounts[0].nativeExecutorReady, true);
  assert.equal(snapshot.runtimeProviders.length, 0);
  assert.equal(
    (
      await f.call('POST', '/api/accounts', {
        label: 'Forbidden subscription wrapper',
        harness: account.harness,
        nativeHome: f.home,
        billingMode: 'subscription',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.call(
        'POST',
        '/api/accounts',
        { label: 'Demo wrapper', harness: account.harness, nativeHome: f.home },
        { 'x-forge-workspace': 'demo' },
      )
    ).statusCode,
    403,
  );
  const bad = join(f.root, 'bad.mjs');
  await writeFile(
    bad,
    code().replace(
      'harnesses:[',
      "companions:[{id:'ext.owned.executor',name:'Wrong role',contract:1,nativeVersion:'1',profileFiles:['config.toml'],connect:async()=>{throw Error('Not started')}}],harnesses:[",
    ),
  );
  await assert.rejects(loadExtensions([bad]), /provider IDs must be unique/);
});

test('owned extension execution retains exact native approval, private credentials, account authority, counters and signed closure', async (t) => {
  const f = await fixture(t),
    key = join(f.root, 'private.json');
  await writeFile(key, JSON.stringify({ LOCAL_NATIVE_KEY: 'synthetic-extension-secret' }), {
    mode: 0o600,
  });
  const account = await f.account({
    billingMode: 'api',
    credentialEnv: 'LOCAL_NATIVE_KEY',
    credentialReference: { kind: 'private-json', path: key, key: 'LOCAL_NATIVE_KEY' },
  });
  const made = await f.call('POST', '/api/work', {
    title: 'Extension native work',
    project: 'Owned execution',
    goal: 'Retain one managed native contract.',
    cwd: f.project,
    harness: account.harness,
    accountId: account.id,
  });
  assert.equal(made.statusCode, 201, made.body);
  let work = made.json<Work>();
  const started = await f.call('POST', `/api/work/${work.id}/launch`, {
    expectedRevision: work.revision,
    allowMetered: true,
  });
  assert.equal(started.statusCode, 202, started.body);
  await until(() => f.state.local.all<Approval>('approvals').some((a) => a.status === 'pending'));
  const approval = f.state.local.all<Approval>('approvals').find((a) => a.status === 'pending')!;
  assert.equal(approval.method, 'item/commandExecution/requestApproval');
  assert.equal(f.state.local.all<Run>('runs')[0].nativeWorker?.version, 2);
  const scope = JSON.parse(await readFile(join(f.home, 'scope.json'), 'utf8'));
  assert.deepEqual(scope, { home: f.home, credential: 'synthetic-extension-secret' });
  const decision = await f.call('POST', `/api/approvals/${approval.id}/decision`, {
    digest: approval.digest,
    decision: 'accept',
  });
  assert.equal(decision.statusCode, 200, decision.body);
  await until(
    () =>
      f.state.local.work(work.id).status === 'completed' && f.state.controller.activeCount === 0,
  );
  work = f.state.local.work(work.id);
  assert.equal(work.harness, account.harness);
  assert(work.nativeSessionId);
  const current = f.state.local.account(account.id);
  assert.equal(current.harness, account.harness);
  assert.deepEqual(current.nativeExecutor, account.nativeExecutor);
  const usage = f.state.local.all<Usage>('usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].harness, account.harness);
  assert.equal(usage[0].totalTokens, 100);
  assert(usage[0].key.startsWith(account.harness + ':'));
  const run = f.state.local.all<Run>('runs')[0];
  assert(run.exitConfirmed);
  assert(run.supervisionId);
  const descriptor = f.state.local.get<WorkerProofDescriptor>(
    'worker_supervisions',
    run.supervisionId,
  )!;
  assert.equal(readWorkerExit(descriptor).payload.nativeClosed, true);
  assert.equal(descriptor.scope.harness, account.harness);
  const beforeProbe = f.state.local.account(account.id);
  assert.equal((await f.call('POST', `/api/accounts/${account.id}/probe`, {})).statusCode, 200);
  assert.deepEqual(f.state.local.account(account.id), beforeProbe);
  assert(
    !JSON.stringify((await f.call('GET', '/api/snapshot')).json()).includes(
      'synthetic-extension-secret',
    ),
  );
  await f.restart();
  assert.equal(f.state.local.work(work.id).nativeSessionId, work.nativeSessionId);
  assert.equal(
    (
      await f.call('POST', `/api/approvals/${approval.id}/decision`, {
        digest: approval.digest,
        decision: 'accept',
      })
    ).statusCode,
    409,
  );
});

test('changed and absent execution modules hold before a new native run while preserving canonical history', async (t) => {
  const f = await fixture(t),
    account = await f.account();
  const made = await f.call('POST', '/api/work', {
    title: 'Held extension work',
    project: 'Owned execution',
    goal: 'Do not substitute missing code.',
    cwd: f.project,
    harness: account.harness,
    accountId: account.id,
  });
  assert.equal(made.statusCode, 201, made.body);
  const work = made.json<Work>();
  for (const missing of [false, true]) {
    await f.restart('2.0.0', missing);
    const snapshot = (await f.call('GET', '/api/snapshot')).json();
    assert.equal(snapshot.accounts[0].nativeExecutorReady, false);
    assert.equal(
      (
        await f.call('POST', `/api/work/${work.id}/launch`, {
          expectedRevision: work.revision,
          allowMetered: true,
        })
      ).statusCode,
      409,
    );
    assert.equal(f.state.local.all('runs').length, 0);
    assert.deepEqual(f.state.local.work(work.id), work);
    assert.equal((await f.call('POST', `/api/accounts/${account.id}/probe`, {})).statusCode, 409);
  }
});

test('native execution factories require original supervision and cannot declare delegated ownership', async (t) => {
  const f = await fixture(t),
    account = await f.account();
  let creates = 0;
  const metadata = (await loadExtensions([f.module])).harnesses![0];
  const registry = new NativeHarnesses({
    [account.harness]: {
      contract: 1,
      id: account.harness,
      name: metadata.name,
      nativeVersion: 'owned',
      profileFiles: ['config.toml'],
      extension: metadata,
      create: () => {
        creates++;
        return {
          harness: account.harness,
          ownership: 'delegated-run',
          closed: true,
          start: async () => {},
          close: async () => {},
          interrupt: async () => {},
        };
      },
    },
  });
  const context = { account } as DriverContext;
  assert.throws(() => registry.driver(context), /persistent workspace/);
  assert.equal(creates, 0);
  context.spawnNative = (() => {
    throw Error('No native spawn is authorized by this fixture.');
  }) as NonNullable<DriverContext['spawnNative']>;
  assert.throws(() => registry.driver(context), /owned execution contract/);
  assert.equal(creates, 1);
});

test('a declared native account reader retains original authority and releases its derived private material', async (t) => {
  const f = await fixture(t, true),
    path = join(f.root, 'reader.json');
  await writeFile(path, JSON.stringify({ LOCAL_NATIVE_KEY: 'synthetic-reader-secret' }), {
    mode: 0o600,
  });
  const account = await f.account({
    billingMode: 'api',
    credentialEnv: 'LOCAL_NATIVE_KEY',
    credentialReference: { kind: 'private-json', path, key: 'LOCAL_NATIVE_KEY' },
  });
  const loaded = await loadExtensions([f.module]);
  let inner!: Account, retained!: CredentialMaterial;
  const registry = new NativeHarnesses(loaded.executors, async (native, material) => {
    assert.equal(native.harness, 'codex');
    assert.equal(native.nativeHome, f.home);
    assert(material);
    assert.equal(material.read(native, 'LOCAL_NATIVE_KEY'), 'synthetic-reader-secret');
    inner = native;
    retained = material;
    return {
      ...native,
      state: 'verified',
      identity: 'Native fixture reader',
      identityKey: 'native-reader-identity',
      checkedAt: '2026-10-18T00:00:00.000Z',
    };
  });
  const material = await resolveCredential(account);
  try {
    const result = await registry.probe(account, material);
    assert.equal(result.harness, account.harness);
    assert.deepEqual(result.nativeExecutor, account.nativeExecutor);
    assert.equal(result.identityKey, 'native-reader-identity');
    assert.equal(result.checkedAt, '2026-10-18T00:00:00.000Z');
    assert(!JSON.stringify(result).includes('synthetic-reader-secret'));
    assert.throws(() => retained.read(inner, 'LOCAL_NATIVE_KEY'), /no longer matches/);
  } finally {
    material?.dispose();
  }
});

test('native reader admission checks quiet mode and fresh pressure before reading even a missing private credential', async (t) => {
  const f = await fixture(t, true);
  const account = await f.account({
    billingMode: 'api',
    credentialEnv: 'LOCAL_NATIVE_KEY',
    credentialReference: {
      kind: 'private-json',
      path: join(f.root, 'absent.json'),
      key: 'LOCAL_NATIVE_KEY',
    },
  });
  await f.call('PATCH', '/api/settings', { quietMode: true });
  let held = await f.call('POST', `/api/accounts/${account.id}/probe`, {});
  assert.equal(held.statusCode, 409);
  assert.match(held.json().error, /Resume managed native reads/);
  await f.call('PATCH', '/api/settings', { quietMode: false });
  f.setPressure(parseMemoryPressure('4'));
  held = await f.call('POST', `/api/accounts/${account.id}/probe`, {});
  assert.equal(held.statusCode, 409);
  assert.match(held.json().error, /critical memory pressure/);
  assert.equal(f.state.local.all('runs').length, 0);
  assert.equal(f.state.local.account(account.id).checkedAt, null);
});
