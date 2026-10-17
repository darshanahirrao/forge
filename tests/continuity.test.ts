import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { Continuity, artifactSnapshot } from '../server/continuity.js';
import { ExecutionController } from '../server/execution.js';
import type { Account, Run, Usage, Work } from '../shared/types.js';
import type { DriverContext, DriverSink } from '../server/adapters/driver.js';
const exec = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'forge-continuity-'));
  await writeFile(join(directory, 'proof.txt'), 'Verified source artifact.\n');
  await writeFile(join(directory, 'auth.json'), 'synthetic-credential-data');
  const store = new Store(':memory:');
  const account: Account = {
    id: 'source-account',
    harness: 'codex',
    nativeHome: '',
    label: 'Source',
    billingMode: 'native',
    state: 'configured',
    identity: null,
    identityKey: null,
    plan: null,
    checkedAt: null,
    error: null,
    quotas: [],
    createdAt: now(),
  };
  const target: Account = {
    ...account,
    id: 'target-account',
    harness: 'claude',
    billingMode: 'api',
    label: 'Destination',
    credentialEnv: 'SYNTHETIC_REFERENCE',
  };
  store.put('accounts', account.id, account);
  store.put('accounts', target.id, target);
  const work: Work = {
    id: 'work',
    title: 'One work identity',
    project: 'Fixture',
    cwd: directory,
    goal: 'Retain the goal.',
    acceptance: 'Verify the file.',
    context: 'Use the shared project.',
    harness: 'codex',
    accountId: account.id,
    nativeSessionId: 'source-native-session',
    nativeSessionKey: 'source-native-route',
    activeRunId: null,
    generation: 1,
    revision: 2,
    status: 'completed',
    priority: 'normal',
    createdAt: now(),
    updatedAt: now(),
  };
  const run: Run = {
    id: 'source-run',
    workId: work.id,
    accountId: account.id,
    generation: 1,
    nativeSessionId: work.nativeSessionId,
    nativeSessionKey: work.nativeSessionKey,
    nativeTurnId: 'source-turn',
    status: 'completed',
    startedAt: now(),
    endedAt: now(),
    exitConfirmed: true,
  };
  store.put('work', work.id, work);
  store.put('runs', run.id, run);
  store.event(work.id, 'checkpoint', 'User checkpoint', 'Keep the chosen design.');
  store.event(work.id, 'assistant', 'Source report', 'The source produced proof.txt.');
  const usage: Usage = {
    key: 'source-usage',
    workId: work.id,
    accountId: account.id,
    harness: 'codex',
    source: 'codex/app-server',
    scope: 'Source session',
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    totalTokens: 15,
    estimatedUsd: null,
    observedAt: now(),
  };
  store.saveUsage(usage);
  let launched: DriverContext | undefined;
  const execution = new ExecutionController(store, (context) => ({
    harness: context.work.harness,
    closed: false,
    start: async (ctx: DriverContext, sink: DriverSink) => {
      launched = ctx;
      sink.session('destination-session');
      sink.turn('destination-turn');
    },
    interrupt: async () => {},
    close: async () => {},
  }));
  const continuity = new Continuity(store, execution);
  return {
    store,
    work,
    account,
    target,
    run,
    execution,
    continuity,
    directory,
    launched: () => launched,
    close: async () => {
      await execution.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('handoff retains one work, goals, checkpoints, files and usage while starting a fresh native binding', async () => {
  const f = await fixture();
  try {
    const { capsule, work } = await f.continuity.capture(f.work.id, f.work.revision, [
      'proof.txt',
      'auth.json',
    ]);
    assert.equal(capsule.artifacts.length, 1);
    assert.equal(capsule.excluded[0].path, 'auth.json');
    assert.equal(JSON.stringify(capsule).includes('synthetic-credential-data'), false);
    assert.equal(capsule.source.nativeSessionId, 'source-native-session');
    assert.equal(capsule.source.nativeSessionKey, 'source-native-route');
    await assert.rejects(
      f.continuity.handoff(work.id, work.revision, capsule.id, f.target.id, false),
      /Review native activity/,
    );
    const moved = await f.continuity.handoff(work.id, work.revision, capsule.id, f.target.id, true);
    assert.equal(moved.id, f.work.id);
    assert.equal(moved.goal, f.work.goal);
    assert.equal(moved.harness, 'claude');
    assert.equal(moved.accountId, f.target.id);
    assert.equal(moved.nativeSessionId, null);
    assert.equal(moved.nativeSessionKey, null);
    assert.equal(moved.status, 'ready');
    assert.equal(f.store.get<Run>('runs', f.run.id)?.nativeSessionId, 'source-native-session');
    assert.equal(f.store.all<Usage>('usage')[0].accountId, f.account.id);
    assert.equal(f.store.checkpoints(work.id)[0].detail, 'Keep the chosen design.');
    assert.equal(
      await readFile(join(f.directory, 'proof.txt'), 'utf8'),
      'Verified source artifact.\n',
    );
    await f.execution.launch(moved.id, true, false, moved.revision);
    assert.equal(f.launched()?.work.nativeSessionId, null);
    assert.match(f.launched()!.prompt, /Retain the goal/);
    assert.match(f.launched()!.prompt, /Keep the chosen design/);
    assert.match(f.launched()!.prompt, /The source produced proof.txt/);
    assert.match(f.launched()!.prompt, new RegExp(capsule.artifactDigest));
    await assert.rejects(
      f.continuity.handoff(work.id, work.revision, capsule.id, f.target.id, true),
      /workers|changed/,
    );
  } finally {
    await f.close();
  }
});

test('changed files and changed work invalidate the checkpoint without moving its binding', async () => {
  const f = await fixture();
  try {
    const first = await f.continuity.capture(f.work.id, f.work.revision, ['proof.txt']);
    await writeFile(join(f.directory, 'proof.txt'), 'Changed after preparation.');
    await assert.rejects(
      f.continuity.handoff(f.work.id, first.work.revision, first.capsule.id, f.target.id, true),
      /files changed/,
    );
    assert.equal(f.store.work(f.work.id).accountId, f.account.id);
    const next = await f.continuity.capture(f.work.id, first.work.revision, ['proof.txt']);
    f.store.updateWork(f.work.id, { context: 'A newer user decision.' });
    await assert.rejects(
      f.continuity.handoff(
        f.work.id,
        f.store.work(f.work.id).revision,
        next.capsule.id,
        f.target.id,
        true,
      ),
      /stale/,
    );
    assert.equal(f.store.work(f.work.id).nativeSessionId, 'source-native-session');
  } finally {
    await f.close();
  }
});

test('a later exit receipt cannot hide an older unconfirmed native worker', async () => {
  const f = await fixture();
  try {
    f.store.put('runs', 'earlier-unknown-run', {
      ...f.run,
      id: 'earlier-unknown-run',
      generation: 0,
      exitConfirmed: false,
    });
    await assert.rejects(
      f.continuity.capture(f.work.id, f.work.revision, ['proof.txt']),
      /prior native worker exit/,
    );
    await assert.rejects(
      f.execution.launch(f.work.id, true, true, f.work.revision),
      /prior native worker exit/,
    );
    assert.equal(f.launched(), undefined);
    assert.equal(f.store.work(f.work.id).nativeSessionId, 'source-native-session');
  } finally {
    await f.close();
  }
});

test('an unconfirmed source exit and an unsupported target cannot become a verified transfer', async () => {
  const f = await fixture();
  try {
    f.store.put('runs', f.run.id, { ...f.run, exitConfirmed: false });
    await assert.rejects(
      f.continuity.capture(f.work.id, f.work.revision, ['proof.txt']),
      /exit was not confirmed/,
    );
    f.store.put('runs', f.run.id, f.run);
    const prepared = await f.continuity.capture(f.work.id, f.work.revision, ['proof.txt']);
    f.store.put('accounts', f.target.id, { ...f.target, billingMode: 'subscription' });
    await assert.rejects(
      f.continuity.handoff(
        f.work.id,
        prepared.work.revision,
        prepared.capsule.id,
        f.target.id,
        true,
      ),
      /no compatible managed execution route/,
    );
    assert.equal(f.store.work(f.work.id).harness, 'codex');
  } finally {
    await f.close();
  }
});

test('Git inventory records deleted files and detects a newly added artifact before transfer', async () => {
  const f = await fixture();
  try {
    await exec('git', ['init', '-q'], { cwd: f.directory });
    await exec('git', ['add', 'proof.txt'], { cwd: f.directory });
    await unlink(join(f.directory, 'proof.txt'));
    const prepared = await f.continuity.capture(f.work.id, f.work.revision);
    assert.equal(prepared.capsule.artifacts.find((a) => a.path === 'proof.txt')?.state, 'missing');
    await writeFile(join(f.directory, 'new.txt'), 'New artifact.');
    await assert.rejects(
      f.continuity.handoff(
        f.work.id,
        prepared.work.revision,
        prepared.capsule.id,
        f.target.id,
        true,
      ),
      /files changed/,
    );
  } finally {
    await f.close();
  }
});

test('checkpoint selection rejects traversal, symbolic links and oversized content', async () => {
  const f = await fixture();
  try {
    await assert.rejects(artifactSnapshot(f.directory, ['../outside']), /cannot escape/);
    await symlink(join(f.directory, 'proof.txt'), join(f.directory, 'link.txt'));
    await assert.rejects(artifactSnapshot(f.directory, ['link.txt']), /symbolic link/);
    await writeFile(join(f.directory, 'large.bin'), Buffer.alloc(6 * 1024 * 1024));
    await assert.rejects(artifactSnapshot(f.directory, ['large.bin']), /5 MB limit/);
    await assert.rejects(
      artifactSnapshot(f.directory, ['auth.json']),
      /only contain excluded data/,
    );
  } finally {
    await f.close();
  }
});

test('checkpoint ownership excludes native launch while files are being verified', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const capture = f.execution.atCheckpoint(f.work.id, f.work.revision, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await assert.rejects(f.execution.launch(f.work.id, false, false), /slots are occupied/);
    await assert.rejects(
      f.continuity.capture(f.work.id, f.work.revision, ['proof.txt']),
      /other checkpoint operations/,
    );
    release();
    await capture;
    const prepared = await f.continuity.capture(f.work.id, f.work.revision, ['proof.txt']);
    assert.equal(prepared.capsule.artifacts.length, 1);
  } finally {
    release?.();
    await f.close();
  }
});

test('another account for the same harness also starts with a fresh native session', async () => {
  const f = await fixture();
  try {
    f.store.put('accounts', f.target.id, {
      ...f.target,
      harness: 'codex',
      billingMode: 'native',
      nativeHome: '/synthetic/second-native-context',
    });
    const prepared = await f.continuity.capture(f.work.id, f.work.revision, ['proof.txt']);
    const moved = await f.continuity.handoff(
      f.work.id,
      prepared.work.revision,
      prepared.capsule.id,
      f.target.id,
      true,
    );
    await f.execution.launch(moved.id, false, false, moved.revision);
    assert.equal(f.launched()?.work.harness, 'codex');
    assert.equal(f.launched()?.work.nativeSessionId, null);
    assert.equal(f.launched()?.account.nativeHome, '/synthetic/second-native-context');
    assert.equal(f.store.get<Run>('runs', f.run.id)?.accountId, f.account.id);
  } finally {
    await f.close();
  }
});
