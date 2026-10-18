import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedNativeSpawner } from '../server/owned-native.js';
import { acquireProfileLease } from '../server/adapters/profile-lease.js';
import {
  readWorkerExit,
  writeWorkerExit,
  scopeHash,
  checkWorkerProfile,
  armWorkerProfile,
} from '../server/worker-proof.mjs';
import {
  armOpenClawIdentity,
  createOpenClawIdentity,
  newOpenClawIdentity,
  readOpenClawIdentity,
  saveOpenClawIdentity,
} from '../server/adapters/openclaw-identity.js';
import type { WorkerProofDescriptor, WorkerExitPayload } from '../shared/recovery.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-openclaw-identity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'profile'),
    directory = join(root, 'proof');
  await mkdir(home, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const identity = newOpenClawIdentity();
  await createOpenClawIdentity(home, identity);
  identity.cleanExit = false;
  identity.attemptId = randomUUID();
  saveOpenClawIdentity(home, identity);
  const keys = generateKeyPairSync('ed25519');
  const scope = { runId: randomUUID(), harness: 'openclaw' };
  const descriptor: WorkerProofDescriptor<object> = {
    id: randomUUID(),
    scope,
    scopeHash: scopeHash(scope),
    directory,
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    guardianPid: process.pid,
  };
  const proof: WorkerExitPayload = {
    contract: 'forge.worker-exit/1',
    id: descriptor.id,
    scopeHash: descriptor.scopeHash,
    guardianPid: process.pid,
    nativePid: process.pid,
    started: true,
    code: 0,
    signal: null,
    nativeClosed: true,
    stdioClosed: true,
    reason: 'owner-disconnected',
    createdAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
  };
  return {
    root,
    home,
    directory,
    identity,
    descriptor,
    keys,
    proof,
    filename: join(home, '.forge-openclaw.json'),
  };
}
test('only the current private profile/device/attempt and original signed closure recover a version-2 marker', async (t) => {
  const f = await fixture(t);
  armOpenClawIdentity(f.home, f.identity, f.descriptor);
  await assert.rejects(readOpenClawIdentity(f.home), /unconfirmed native exit/);
  writeWorkerExit(f.descriptor, f.proof, f.keys.privateKey);
  const original = JSON.stringify(f.identity);
  const bad = [
    { ...f.identity, attemptId: randomUUID() },
    { ...f.identity, closure: { ...f.identity.closure!, root: f.root } },
    { ...f.identity, closure: { ...f.identity.closure!, deviceId: '0'.repeat(64) } },
    {
      ...f.identity,
      closure: {
        ...f.identity.closure!,
        descriptor: { ...f.identity.closure!.descriptor, id: randomUUID() },
      },
    },
  ];
  for (const value of bad) {
    saveOpenClawIdentity(f.home, value);
    const before = await readFile(f.filename, 'utf8');
    await assert.rejects(readOpenClawIdentity(f.home), /unconfirmed native exit/);
    assert.equal(await readFile(f.filename, 'utf8'), before);
  }
  await writeFile(f.filename, original, { mode: 0o600 });
  const exitPath = join(f.directory, 'exit.json');
  const signed = await readFile(exitPath, 'utf8');
  const forged = JSON.parse(signed);
  forged.signature = Buffer.alloc(64).toString('base64');
  await writeFile(exitPath, JSON.stringify(forged));
  await assert.rejects(readOpenClawIdentity(f.home), /unconfirmed native exit/);
  assert.equal(await readFile(f.filename, 'utf8'), original);
  await writeFile(exitPath, signed);
  const recovered = await readOpenClawIdentity(f.home);
  assert.equal(recovered?.cleanExit, true);
  assert.deepEqual(recovered?.device, f.identity.device);
  assert.equal(recovered?.closure?.descriptor.id, f.descriptor.id);
  assert.equal((await stat(f.filename)).mode & 0o777, 0o600);
  assert.equal(readWorkerExit(f.descriptor).payload.reason, 'owner-disconnected');
});
test('a new unbound attempt and an unclean legacy marker cannot borrow any older valid proof', async (t) => {
  const f = await fixture(t);
  armOpenClawIdentity(f.home, f.identity, f.descriptor);
  const release = armWorkerProfile(f.home, f.descriptor);
  writeWorkerExit(f.descriptor, f.proof, f.keys.privateKey);
  release();
  assert.equal((await readOpenClawIdentity(f.home))?.cleanExit, true);
  f.identity.attemptId = randomUUID();
  delete f.identity.closure;
  saveOpenClawIdentity(f.home, f.identity);
  await assert.rejects(readOpenClawIdentity(f.home), /unconfirmed native exit/);
  const legacy = { version: 1, cleanExit: false, device: f.identity.device };
  await writeFile(f.filename, JSON.stringify(legacy), { mode: 0o600 });
  await assert.rejects(readOpenClawIdentity(f.home), /unconfirmed native exit/);
  assert.deepEqual(JSON.parse(await readFile(f.filename, 'utf8')), legacy);
});
test(
  'signed native close does not grant profile reuse while its original lifetime transaction is still held',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    armOpenClawIdentity(f.home, f.identity, f.descriptor);
    const release = armWorkerProfile(f.home, f.descriptor);
    let prepared = 0;
    try {
      writeWorkerExit(
        f.descriptor,
        { ...f.proof, nativePid: null, started: false, reason: 'bootstrap-aborted' },
        f.keys.privateKey,
      );
      assert.equal((await readOpenClawIdentity(f.home))?.cleanExit, true);
      assert.throws(() => checkWorkerProfile(f.home), /locked|busy/i);
      await assert.rejects(acquireProfileLease(f.home), /locked|busy/i);
      const spawn = ownedNativeSpawner({
        directory: f.directory,
        nativeHome: f.home,
        scope: { harness: 'openclaw', runId: randomUUID() },
        mayPrepare: () => true,
        mayCommit: () => true,
        prepared: () => {
          prepared++;
        },
        phaseChanged: () => {},
      });
      assert.throws(
        () => spawn(process.execPath, ['-e', 'process.exit(0)'], {}, { input: 'ignore' }),
        /locked|busy/i,
      );
      assert.equal(prepared, 0);
    } finally {
      release();
    }
    checkWorkerProfile(f.home);
    const lease = await acquireProfileLease(f.home);
    lease();
    assert.deepEqual((await readOpenClawIdentity(f.home))?.device, f.identity.device);
  },
);
test('clean legacy identities preserve their keys and a private rollback copy; corrupt or linked files stay held', async (t) => {
  const f = await fixture(t);
  const raw = JSON.stringify({ version: 1, cleanExit: true, device: f.identity.device });
  await writeFile(f.filename, raw, { mode: 0o600 });
  const upgraded = await readOpenClawIdentity(f.home);
  assert.equal(upgraded?.version, 2);
  assert.deepEqual(upgraded?.device, f.identity.device);
  assert.equal(await readFile(f.filename + '.before-v2', 'utf8'), raw);
  assert.equal((await stat(f.filename + '.before-v2')).mode & 0o777, 0o600);
  await rm(f.filename);
  await symlink(f.filename + '.before-v2', f.filename);
  await assert.rejects(readOpenClawIdentity(f.home));
  await rm(f.filename);
  await writeFile(
    f.filename,
    JSON.stringify({ ...upgraded, device: { ...f.identity.device, deviceId: '0'.repeat(64) } }),
    { mode: 0o600 },
  );
  await assert.rejects(readOpenClawIdentity(f.home), /does not match/);
});
test(
  'failure to persist an SDK marker prevents native launch and retains an original never-started receipt',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    let committed = false,
      descriptor: WorkerProofDescriptor<object> | undefined;
    const spawn = ownedNativeSpawner({
      directory: f.directory,
      nativeHome: f.home,
      scope: { harness: 'openclaw' },
      mayPrepare: () => true,
      mayCommit: () => true,
      prepared: (record) => {
        descriptor = record;
      },
      phaseChanged: (record) => {
        if (record.phase === 'committed') committed = true;
      },
    });
    const effect = join(f.root, 'never-created');
    const child = spawn(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(effect)},'unexpected')`],
      {},
      {
        input: 'ignore',
        onArmed: () => {
          throw new Error('Owned marker fixture failure');
        },
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    await once(child, 'close');
    assert.equal(committed, false);
    assert.equal(child.nativeExitConfirmed?.(), true);
    assert.equal(readWorkerExit(descriptor!).payload.started, false);
    await assert.rejects(stat(effect), { code: 'ENOENT' });
  },
);
test(
  'original owner closure after a killed host releases only its captured SDK marker and keeps the device identity',
  { skip: process.platform === 'win32', timeout: 15000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-openclaw-cold-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const owner = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/openclaw-profile-owner.ts', import.meta.url)),
        root,
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    owner.stdout!.resume();
    owner.stderr!.resume();
    t.after(async () => {
      if (owner.exitCode === null && owner.signalCode === null) {
        const done = once(owner, 'exit');
        owner.kill('SIGKILL');
        await done;
      }
    });
    await Promise.race([
      once(owner, 'message'),
      once(owner, 'exit').then(() => {
        throw new Error('Owned fixture exited before native readiness');
      }),
    ]);
    const home = join(root, 'profile'),
      filename = join(home, '.forge-openclaw.json');
    const pending = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(pending.cleanExit, false);
    assert(pending.closure);
    await assert.rejects(readOpenClawIdentity(home), /unconfirmed native exit/);
    const ended = once(owner, 'exit');
    owner.kill('SIGKILL');
    await ended;
    let recovered: Awaited<ReturnType<typeof readOpenClawIdentity>> = null;
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      try {
        const identity = await readOpenClawIdentity(home);
        // Native close is published before the original owner commits and
        // releases its lifetime profile transaction. Reuse needs both facts.
        checkWorkerProfile(home);
        recovered = identity;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(recovered?.cleanExit, true);
    assert.deepEqual(recovered?.device, pending.device);
    assert.equal(readWorkerExit(pending.closure.descriptor).payload.reason, 'owner-disconnected');
    checkWorkerProfile(home);
  },
);
