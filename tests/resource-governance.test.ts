import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, release } from 'node:os';
import { createApp } from '../server/app.js';
import { WorkerSupervisions } from '../server/worker-supervision.js';
import { ownedNativeSpawner, NativeStartRejected } from '../server/owned-native.js';
import {
  validateResourceReceipt,
  resourceCommand,
  ResourceGovernance,
} from '../server/resource-governance.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { id, now } from '../server/store.js';
import type { NativeResourceReceipt } from '../shared/resource-governance.js';
import type { Run } from '../shared/types.js';

const nativeTest =
  process.platform === 'darwin' && release().split('.')[0] === '27' ? test : test.skip;
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-resource-policy-')));
  const home = join(root, 'native');
  await mkdir(home);
  let factories = 0;
  const state = await createApp({
    filename: join(root, 'state.sqlite'),
    test: true,
    csrf: 'native-resource-review-fixture',
    memoryPressureReader: unknownPressure,
    driverFactory: () => {
      factories++;
      return {
        harness: 'codex',
        closed: true,
        async start() {},
        async interrupt() {},
        async close() {},
      };
    },
  });
  t.after(async () => {
    await state.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ) =>
    state.app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:4710',
        'x-forge-csrf': state.csrf,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      payload: data === undefined ? undefined : JSON.stringify(data),
    });
  const account = (
    await call('POST', '/api/accounts', {
      harness: 'codex',
      label: 'Owned policy fixture',
      nativeHome: home,
    })
  ).json();
  const work = (
    await call('POST', '/api/work', {
      title: 'Native policy review fixture',
      project: 'Owned fixture',
      goal: 'No provider or model call.',
      harness: 'codex',
      accountId: account.id,
      cwd: root,
    })
  ).json();
  return { ...state, root, home, account, work, call, factories: () => factories };
}

test('native policy setup is human/revision scoped, explicit and unavailable hosts cannot silently accept limits', async (t) => {
  const f = await fixture(t);
  const baseline = (await f.call('GET', '/api/snapshot')).json();
  assert.equal(baseline.nativeGovernance.policy.revision, 0);
  assert.equal(baseline.nativeGovernance.policy.rootMemoryMiB, null);
  const body = {
    expectedRevision: 0,
    lowPriority: false,
    rootMemoryMiB: null,
    effectsReviewed: true,
  };
  assert.equal(
    (await f.call('PATCH', '/api/resources/policy', { ...body, effectsReviewed: false }))
      .statusCode,
    400,
  );
  assert.equal(
    (await f.call('PATCH', '/api/resources/policy', { ...body, rootMemoryMiB: 0 })).statusCode,
    400,
  );
  assert.equal(
    (await f.call('PATCH', '/api/resources/policy', body, { 'x-forge-csrf': 'wrong' })).statusCode,
    403,
  );
  assert(
    (
      await f.call('PATCH', '/api/resources/policy', body, {
        authorization: 'Bearer native-caller',
      })
    ).statusCode >= 400,
  );
  assert.equal(
    (await f.call('PATCH', '/api/resources/policy', body, { 'x-forge-workspace': 'demo' }))
      .statusCode,
    409,
  );
  const saved = await f.call('PATCH', '/api/resources/policy', body);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().policy.revision, 1);
  assert.equal((await f.call('PATCH', '/api/resources/policy', body)).statusCode, 409);
  if (!baseline.nativeGovernance.supported) {
    assert.equal(
      (
        await f.call('PATCH', '/api/resources/policy', {
          ...body,
          expectedRevision: 1,
          lowPriority: true,
        })
      ).statusCode,
      409,
    );
    assert.equal(f.resourceGovernance.policy().revision, 1);
  }
  assert.equal(f.factories(), 0);
  assert.equal(f.local.all('runs').length, 0);
});

test('policy configuration waits for an admitted native startup instead of racing its profile lease', async (t) => {
  const f = await fixture(t);
  const launch = await f.call('POST', `/api/work/${f.work.id}/launch`, {
    expectedRevision: f.work.revision,
  });
  assert.equal(launch.statusCode, 202, launch.body);
  assert.equal(f.controller.nativeStartPending, true);
  const changed = await f.call('PATCH', '/api/resources/policy', {
    expectedRevision: 0,
    lowPriority: false,
    rootMemoryMiB: null,
    effectsReviewed: true,
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(f.resourceGovernance.policy().revision, 0);
});

test('sealed native resource receipts reject altered policy and unsupported host bindings before native spawn', () => {
  const body = {
    contract: 'forge.native-resources/1' as const,
    policyRevision: 1,
    lowPriority: true,
    rootMemoryMiB: 512,
    backend: {
      kind: 'macos-taskpolicy' as const,
      priority: 'utility-qos' as const,
      release: '27.0.0',
      binarySha256: '0'.repeat(64),
    },
  };
  const receipt: NativeResourceReceipt = {
    ...body,
    digest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
  assert.deepEqual(validateResourceReceipt(receipt), receipt);
  assert.throws(
    () => validateResourceReceipt({ ...receipt, rootMemoryMiB: 1024 }),
    /receipt changed/,
  );
  assert.throws(() => resourceCommand(receipt, process.execPath, []), /support changed/);
  assert.deepEqual(resourceCommand(undefined, process.execPath, ['--version']), {
    command: process.execPath,
    args: ['--version'],
  });
});

nativeTest(
  'policy changes invalidate work review without changing selected memory or resetting a native session',
  async (t) => {
    const f = await fixture(t);
    const before = (await f.call('POST', `/api/work/${f.work.id}/context-review`, {})).json();
    const configured = await f.call('PATCH', '/api/resources/policy', {
      expectedRevision: 0,
      lowPriority: true,
      rootMemoryMiB: 2048,
      effectsReviewed: true,
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const review = (await f.call('POST', `/api/work/${f.work.id}/context-review`, {})).json();
    assert.equal(review.receipt.contentDigest, before.receipt.contentDigest);
    assert.notEqual(review.receipt.reviewDigest, before.receipt.reviewDigest);
    assert.equal(review.requiresReview, true);
    assert.equal(review.nativeResources.rootMemoryMiB, 2048);
    assert.equal(
      (
        await f.call('POST', `/api/work/${f.work.id}/launch`, {
          expectedRevision: f.work.revision,
          contextDigest: before.receipt.reviewDigest,
        })
      ).statusCode,
      409,
    );
    assert.equal(f.factories(), 0);
    assert.equal(f.local.all('runs').length, 0);
    const old = review.nativeResources;
    assert.equal(
      (
        await f.call('PATCH', '/api/resources/policy', {
          expectedRevision: 1,
          lowPriority: false,
          rootMemoryMiB: null,
          effectsReviewed: true,
        })
      ).statusCode,
      200,
    );
    assert.throws(
      () => f.resourceGovernance.assertCurrent(old, f.account),
      /changed after launch review/,
    );
    assert.equal(
      (
        await f.call('POST', `/api/work/${f.work.id}/launch`, {
          expectedRevision: f.work.revision,
          contextDigest: review.receipt.reviewDigest,
        })
      ).statusCode,
      409,
    );
    const after = (await f.call('POST', `/api/work/${f.work.id}/context-review`, {})).json();
    assert.equal(after.nativeResources, undefined);
    assert.equal(after.receipt.contentDigest, before.receipt.contentDigest);
    assert.equal(f.local.work(f.work.id).nativeSessionId, null);
  },
);

nativeTest(
  'native root memory enforcement retains original stdin/PID and signed recovery across a changed policy',
  async (t) => {
    const f = await fixture(t),
      owners = new WorkerSupervisions(f.local, join(f.root, 'policy-proofs'), f.resourceGovernance);
    const code =
      "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({pid:process.pid,input}));const b=Buffer.alloc(96*1024*1024,0x31);console.log(JSON.stringify({bytes:b.length}));setTimeout(()=>process.exit(0),100);});";
    const attempt = async (resources?: NativeResourceReceipt) => {
      const run: Run = {
        id: id(),
        workId: f.work.id,
        accountId: f.account.id,
        harness: 'codex',
        generation: f.local.work(f.work.id).generation + 1,
        nativeSessionId: null,
        nativeTurnId: null,
        status: 'starting',
        startedAt: now(),
        endedAt: null,
        ...(resources ? { nativeResources: resources } : {}),
      };
      f.local.put('runs', run.id, run);
      f.local.updateWork(f.work.id, { generation: run.generation, activeRunId: run.id });
      const spawn = owners.spawner(run, f.account)!;
      const child = spawn(
        process.execPath,
        ['-e', code],
        { cwd: f.home, env: { PATH: process.env.PATH } },
        { input: 'pipe', graceMs: 1000 },
      );
      const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.resume();
      const pid = await child.nativeStarted;
      child.stdin.end('owned-policy-input');
      const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
      await done;
      clearTimeout(timer);
      assert.equal(child.nativeExitConfirmed?.(), true);
      const observed = output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(observed[0].pid, pid);
      assert.equal(observed[0].input, 'owned-policy-input');
      return { run, observed, proof: owners.inspect(run) };
    };
    const control = await attempt();
    assert.equal(control.proof.native?.code, 0);
    assert.equal(control.observed[1].bytes, 96 * 1024 * 1024);
    f.local.put('runs', control.run.id, {
      ...control.run,
      status: 'completed',
      exitConfirmed: true,
      endedAt: now(),
    });
    await f.resourceGovernance.configure(
      { expectedRevision: 0, lowPriority: true, rootMemoryMiB: 64, effectsReviewed: true },
      { kind: 'local' },
    );
    const receipt = f.resourceGovernance.review()!;
    const limited = await attempt(receipt);
    assert.equal(limited.proof.state, 'ready');
    assert.equal(limited.proof.method, 'signed-native-close');
    assert.equal(limited.proof.native?.signal, 'SIGKILL');
    assert.equal(limited.observed.length, 1);
    await f.resourceGovernance.configure(
      { expectedRevision: 1, lowPriority: false, rootMemoryMiB: null, effectsReviewed: true },
      { kind: 'local' },
    );
    assert.equal(
      owners.inspect(limited.run).digest,
      limited.proof.digest,
      'Current policy cannot rewrite original close evidence.',
    );
    assert.equal(
      owners.inspect({ ...limited.run, nativeResources: { ...receipt, rootMemoryMiB: 128 } }).state,
      'unavailable',
    );
    f.local.put('runs', limited.run.id, {
      ...limited.run,
      status: 'failed',
      exitConfirmed: true,
      endedAt: now(),
    });
    assert.equal(f.factories(), 0);
  },
);

nativeTest(
  'configuration cannot commit if native admission changes while the native check is pending',
  async (t) => {
    const f = await fixture(t);
    let checks = 0;
    const governance = new ResourceGovernance(f.local, true, () => ++checks === 1);
    try {
      await assert.rejects(
        governance.configure(
          { expectedRevision: 0, lowPriority: true, rootMemoryMiB: 512, effectsReviewed: true },
          { kind: 'local' },
        ),
        /changed during review/,
      );
      assert.equal(checks, 2);
      assert.equal(governance.policy().revision, 0);
      assert.equal(f.local.all('runs').length, 0);
    } finally {
      await governance.close();
    }
  },
);

test('rejected native admission proves that no child or supervision was created', async (t) => {
  const f = await fixture(t);
  let prepared = 0;
  const spawn = ownedNativeSpawner({
    directory: f.root,
    scope: { kind: 'rejected-policy-fixture' },
    mayPrepare: () => false,
    mayCommit: () => true,
    prepared: () => {
      prepared++;
    },
    phaseChanged: () => {},
  });
  assert.throws(() => spawn(process.execPath, ['-e', 'process.exit(0)'], {}), NativeStartRejected);
  assert.equal(prepared, 0);
  assert.equal(f.local.all('worker_supervisions').length, 0);
});
