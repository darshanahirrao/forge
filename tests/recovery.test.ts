import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, rm, realpath, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, id, now } from '../server/store.js';
import { WorkerSupervisions } from '../server/worker-supervision.js';
import {
  scopeHash,
  readWorkerExit,
  writeWorkerExit,
  checkWorkerProfile,
} from '../server/worker-proof.mjs';
import { createApp } from '../server/app.js';
import { ExecutionController } from '../server/execution.js';
import { supervisedContext } from './fixtures/supervised-context.js';
import type { WorkerProofDescriptor, WorkerExitPayload } from '../shared/recovery.js';
import type { Approval, Run } from '../shared/types.js';

async function directory(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-worker-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
async function crashed(t: test.TestContext, killGuardian = false) {
  const root = await directory(t),
    filename = join(root, 'workspace.sqlite');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./fixtures/supervised-host.ts', import.meta.url)),
      filename,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  child.stdout!.resume();
  child.stderr!.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  });
  const [ready] = (await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error('Owned host exited before ready.');
    }),
  ])) as [{ type: string; runId: string; guardianPid: number }];
  assert.equal(ready.type, 'ready');
  await until(
    async () => (await readFile(join(root, 'effect.txt'), 'utf8').catch(() => '')) === 'effect\n',
    'owned native effect',
  );
  if (killGuardian) {
    const killed = once(child, 'message');
    child.send('kill-owned-guardian');
    await killed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  return { root, filename, ...ready };
}

test(
  'original child owner signs native close after Forge is killed; exact recovery is idempotent and never replays',
  { skip: process.platform === 'win32', timeout: 20000 },
  async (t) => {
    const f = await crashed(t);
    let factories = 0;
    const bridge = {
      origin: 'https://forge-recovery.fixture.invalid',
      proof: 'owned-private-recovery-proof',
    };
    const app = await createApp({
      phoneBridge: bridge,
      filename: f.filename,
      csrf: 'recovery-fixture',
      test: true,
      driverFactory: () => {
        factories++;
        throw new Error('Unexpected native replay.');
      },
    });
    t.after(() => app.app.close());
    const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': app.csrf };
    const snapshot = () =>
      app.app.inject({ method: 'GET', url: '/api/snapshot', headers }).then((r) => r.json());
    const row = await until(
      async () =>
        (await snapshot()).recovery.rows.find((r: { state: string }) => r.state === 'ready'),
      'signed native close',
    );
    assert.equal(row.method, 'signed-native-close');
    assert.equal(row.native.reason, 'owner-disconnected');
    assert.equal(row.native.nativeClosed, true);
    assert.equal(row.native.stdioClosed, true);
    assert.equal(app.local.get<Run>('runs', f.runId)?.exitConfirmed, false);
    assert.equal(app.local.all<Approval>('approvals')[0].status, 'invalidated');
    const records = JSON.stringify(app.local.db.prepare('SELECT data FROM records').all());
    assert(!records.includes('do-not-persist-worker-configuration'));
    assert(!records.includes('privateKey'));
    const call = (data: { expectedRevision: number; digest: string }, extra = {}) =>
      app.app.inject({
        method: 'POST',
        url: `/api/recovery/${f.runId}/reconcile`,
        headers: { ...headers, ...extra },
        payload: data,
      });
    assert.equal(
      (
        await call(
          { expectedRevision: row.revision, digest: row.digest },
          { 'x-forge-csrf': 'invalid' },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          { expectedRevision: row.revision, digest: row.digest },
          { 'x-forge-workspace': 'demo' },
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await call(
          { expectedRevision: row.revision, digest: row.digest },
          { authorization: 'Bearer companion' },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await call({ expectedRevision: row.revision + 1, digest: row.digest })).statusCode,
      409,
    );
    assert.equal(
      (await call({ expectedRevision: row.revision, digest: '0'.repeat(64) })).statusCode,
      409,
    );
    const response = await call(
      { expectedRevision: row.revision, digest: row.digest },
      {
        origin: bridge.origin,
        'x-forge-bridge-proof': bridge.proof,
        'x-forge-bridge-identity': 'owner@example.invalid',
      },
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().actor, {
      kind: 'tailscale',
      identity: 'owner@example.invalid',
    });
    assert.deepEqual(
      (await call({ expectedRevision: row.revision, digest: row.digest })).json(),
      response.json(),
    );
    assert.equal(app.local.get<Run>('runs', f.runId)?.exitConfirmed, true);
    assert.equal(app.local.get<Run>('runs', f.runId)?.status, 'interrupted');
    assert.equal((await snapshot()).recovery.rows.length, 0);
    assert.equal(
      app.controller.spending.snapshot().attempts.find((attempt) => attempt.runId === f.runId)
        ?.state,
      'unknown',
    );
    await assert.rejects(app.controller.launch(row.workId, true, false), /external effects/);
    assert.equal(factories, 0);
    assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'effect\n');
    checkWorkerProfile(f.root);
  },
);

test(
  'a killed guardian supplies no exit proof and retains its durable profile fence after OS locks release',
  { skip: process.platform === 'win32', timeout: 20000 },
  async (t) => {
    const f = await crashed(t, true);
    const store = new Store(f.filename);
    t.after(() => store.close());
    store.recoverInterruptedRuns();
    const manager = new WorkerSupervisions(store, join(f.root, 'worker-proofs'));
    const row = manager.snapshot().rows[0];
    assert.equal(row.state, 'waiting');
    assert.throws(() => checkWorkerProfile(f.root));
    let factories = 0;
    const c = new ExecutionController(
      store,
      () => {
        factories++;
        throw new Error();
      },
      undefined,
      undefined,
      undefined,
      undefined,
      manager,
    );
    const other = supervisedContext(store, f.root, '-other');
    await assert.rejects(c.launch(other.work.id, true, true), /prior native worker exit/);
    await assert.rejects(
      c.reconcileOwned(row.runId, row.revision, '0'.repeat(64), { kind: 'local' }),
      /unavailable/,
    );
    assert.equal(factories, 0);
    assert.equal(store.get<Run>('runs', f.runId)?.exitConfirmed, false);
  },
);

test(
  'signed exit evidence rejects changed scope, signature, permissive files and symlinks',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await directory(t);
    const keys = generateKeyPairSync('ed25519');
    const scope = { runId: id(), workId: id(), accountId: id(), generation: 1, harness: 'codex' };
    const descriptor: WorkerProofDescriptor = {
      id: id(),
      scope,
      scopeHash: scopeHash(scope),
      directory: root,
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      guardianPid: 54321,
    };
    const payload: WorkerExitPayload = {
      contract: 'forge.worker-exit/1',
      id: descriptor.id,
      scopeHash: descriptor.scopeHash,
      guardianPid: descriptor.guardianPid!,
      nativePid: 54322,
      started: true,
      code: 0,
      signal: null,
      nativeClosed: true,
      stdioClosed: true,
      reason: 'normal',
      createdAt: now(),
      closedAt: now(),
    };
    const proof = writeWorkerExit(descriptor, payload, keys.privateKey);
    const path = join(root, 'exit.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.throws(() => readWorkerExit({ ...descriptor, scope: { ...scope, generation: 2 } }));
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw.replace('"code":0', '"code":1'));
    assert.throws(() => readWorkerExit(descriptor));
    await writeFile(path, raw);
    await chmod(path, 0o644);
    assert.throws(() => readWorkerExit(descriptor));
    await chmod(path, 0o600);
    assert.equal(readWorkerExit(descriptor).digest, proof.digest);
    assert.throws(() => writeWorkerExit(descriptor, payload, keys.privateKey));
    const link = join(root, 'link');
    await symlink(root, link);
    assert.throws(() => readWorkerExit({ ...descriptor, directory: link }));
  },
);

test(
  'uncommitted launches recover without PID inference; native close waits for inherited stdio',
  { skip: process.platform === 'win32', timeout: 15000 },
  async (t) => {
    const root = await directory(t),
      store = new Store(':memory:');
    t.after(() => store.close());
    const { work, account } = supervisedContext(store, root);
    const run: Run = {
      id: id(),
      workId: work.id,
      accountId: account.id,
      harness: 'codex',
      generation: 1,
      nativeSessionId: null,
      nativeTurnId: null,
      status: 'starting',
      startedAt: now(),
      endedAt: null,
    };
    store.put('runs', run.id, run);
    store.updateWork(work.id, { activeRunId: run.id, generation: 1 });
    const manager = new WorkerSupervisions(store, join(root, 'proofs'));
    const child = manager.spawner(run, account)!(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/supervised-native.mjs', import.meta.url)),
        join(root, 'effect.txt'),
        'inherited-stdio',
      ],
      { cwd: root, env: {} },
    );
    child.stdout.resume();
    child.stderr.resume();
    const exited = once(child, 'exit');
    const begin = Date.now();
    await exited;
    assert(Date.now() - begin >= 300, 'Guardian exited before inherited native stdio closed.');
    const proof = manager.inspect(run);
    assert.equal(proof.state, 'ready');
    assert.equal(proof.native?.code, 0);
    const saved = store.get<any>('worker_supervisions', run.supervisionId!)!;
    store.put('worker_supervisions', saved.id, { ...saved, phase: 'armed' });
    const uncommitted = manager.inspect(run);
    assert.equal(uncommitted.state, 'ready');
    assert.equal(uncommitted.method, 'not-committed');
    store.put('worker_supervisions', saved.id, {
      ...saved,
      scope: { ...saved.scope, workId: 'other' },
    });

    assert.equal(manager.inspect(run).state, 'unavailable');
  },
);

test(
  'native stop escalation targets the owned child and still produces a signed wait receipt; failed exec is never claimed as started',
  { skip: process.platform === 'win32', timeout: 15000 },
  async (t) => {
    const root = await directory(t),
      store = new Store(':memory:');
    t.after(() => store.close());
    const { work, account } = supervisedContext(store, root);
    const manager = new WorkerSupervisions(store, join(root, 'proofs'));
    async function start(command: string, args: string[]) {
      const run: Run = {
        id: id(),
        workId: work.id,
        accountId: account.id,
        harness: 'codex',
        generation: 1,
        nativeSessionId: null,
        nativeTurnId: null,
        status: 'starting',
        startedAt: now(),
        endedAt: null,
      };
      store.put('runs', run.id, run);
      store.updateWork(work.id, { activeRunId: run.id });
      const child = manager.spawner(run, account)!(
        command,
        args,
        { cwd: root, env: {} },
        { input: 'ignore', graceMs: 100 },
      );
      child.stdout.resume();
      child.stderr.resume();
      return { run, child, closed: once(child, 'close') };
    }
    const forced = await start(process.execPath, [
      fileURLToPath(new URL('./fixtures/supervised-native.mjs', import.meta.url)),
      join(root, 'effect.txt'),
      'ignore-stop',
    ]);
    await forced.child.nativeStarted;
    await until(
      async () => readFile(join(root, 'effect.txt'), 'utf8').catch(() => ''),
      'native signal handler ready',
    );
    // Native startup installs its handler in the same synchronous module turn as its effect.
    forced.child.kill('SIGTERM');
    await forced.closed;
    assert.equal(forced.child.signalCode, null);
    assert.equal(manager.inspect(forced.run).native?.signal, 'SIGKILL');
    const failed = await start(join(root, 'no-native-executable'), []);
    assert.equal(await failed.child.nativeStarted, null);
    await failed.closed;
    const proof = manager.inspect(failed.run);
    assert.equal(proof.state, 'ready');
    assert.equal(proof.native?.started, false);
    assert.equal(proof.native?.code, null);
    assert.equal(proof.native?.reason, 'spawn-error');
  },
);

test('legacy recorded workers without an exit flag remain visible and hold unrelated admission', async (t) => {
  const root = await directory(t),
    store = new Store(':memory:');
  t.after(() => store.close());
  const { work, account } = supervisedContext(store, root);
  const legacy: Run = {
    id: id(),
    workId: work.id,
    accountId: account.id,
    harness: 'codex',
    generation: 1,
    nativeSessionId: null,
    nativeTurnId: null,
    status: 'interrupted',
    startedAt: now(),
    endedAt: now(),
    nativeWorker: {
      version: 1,
      pid: 54321,
      ownerPid: 54320,
      uid: null,
      startedAt: null,
      capturedAt: now(),
    },
  };
  store.put('runs', legacy.id, legacy);
  const manager = new WorkerSupervisions(store);
  assert.equal(manager.snapshot().rows[0].state, 'unsupported');
  let factories = 0;
  const controller = new ExecutionController(store, () => {
    factories++;
    throw new Error();
  });
  const other = supervisedContext(store, root, '-other');
  await assert.rejects(controller.launch(other.work.id, true, false), /prior native worker exit/);
  assert.equal(factories, 0);
  assert.equal(store.get<Run>('runs', legacy.id)?.exitConfirmed, undefined);
});
