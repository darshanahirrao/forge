import test from 'node:test';
import assert from 'node:assert/strict';
import { publicReceipt, receiptMarkdown } from '../shared/public-receipt.js';
import type { Approval, Run, Usage, Work } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';

const secret = 'PRIVATE-CANARY-must-never-be-shared';
const stamp = '2026-10-18T00:00:00.000Z';
function run(harness: string, generation: number): Run {
  return {
    id: secret,
    workId: secret,
    accountId: secret,
    harness,
    generation,
    nativeSessionId: secret,
    nativeTurnId: secret,
    supervisionId: secret,
    status: 'completed',
    exitConfirmed: true,
    startedAt: stamp,
    endedAt: stamp,
  };
}
function usage(source: Usage['source'], tokens: number, price: number | null): Usage {
  return {
    key: secret,
    workId: secret,
    accountId: secret,
    harness: 'codex',
    source,
    scope: secret,
    inputTokens: tokens,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: tokens,
    estimatedUsd: price,
    observedAt: stamp,
  };
}

test('public receipts omit private identifiers and native text, preserve unknown cost and exclude overlapping aggregate usage', () => {
  const approval = {
    id: secret,
    workId: secret,
    runId: secret,
    status: 'accepted',
    detail: secret,
    command: secret,
    cwd: secret,
  } as Approval;
  const receipt = publicReceipt(
    'local',
    [run('codex', 1), run('hermes', 2), run(secret, 3), run('constructor', 4)],
    [usage('codex/app-server', 18, 0.01), usage('ccusage', 900, 99), usage('hermes/acp', 22, null)],
    [approval],
    2,
  );
  assert.deepEqual(receipt.harnessSequence, ['Codex', 'Hermes', 'Custom harness']);
  assert.equal(receipt.reportedTokens, 40);
  assert.equal(receipt.estimatedUsd, 0.01);
  assert.equal(receipt.usageIncomplete, true);
  assert.equal(receipt.confirmedOriginalClosures, 4);
  assert.equal(receipt.acceptedApprovals, 1);
  assert.equal(receipt.evidence, 'local-records');
  assert(!JSON.stringify(receipt).includes(secret));
  const text = receiptMarkdown(receipt);
  assert(!text.includes(secret));
  assert(!text.includes(stamp));
  assert(text.includes('not an independent attestation'));
  assert(text.includes('coverage incomplete'));
  const delegated = run('codex', 1);
  delegated.settlement = {
    kind: 'delegated-run',
    backendId: secret,
    threadId: secret,
    messageId: secret,
    runId: secret,
    state: secret,
    confirmed: true,
    observedAt: stamp,
  };
  assert.equal(publicReceipt('local', [delegated], [], [], 0).confirmedOriginalClosures, 0);
  assert.equal(publicReceipt('local', [], [], [], 0).usageIncomplete, true);
});

test('the receipt endpoint scopes every record to the selected work, isolates demo and never starts a native driver', async () => {
  let nativeCalls = 0;
  const state = await createApp({
    filename: ':memory:',
    test: true,
    memoryPressureReader: unknownPressure,
    driverFactory: () => {
      nativeCalls++;
      throw new Error('No native execution is authorized.');
    },
  });
  const work: Work = {
    id: secret,
    title: secret,
    project: secret,
    cwd: secret,
    goal: secret,
    context: secret,
    acceptance: secret,
    accountId: secret,
    harness: 'hermes',
    status: 'completed',
    generation: 2,
    revision: 0,
    priority: 'normal',
    nativeSessionId: secret,
    activeRunId: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  try {
    state.local.put('work', work.id, work);
    state.local.put('runs', 'first', run('codex', 1));
    state.local.put('runs', 'second', run('hermes', 2));
    state.local.put('runs', 'other', { ...run('claude', 3), workId: 'another-work' });
    state.local.saveUsage(usage('codex/app-server', 54, 0.02));
    state.local.saveUsage({
      ...usage('claude/agent-sdk', 1000, 88),
      key: 'other',
      workId: 'another-work',
    });
    state.local.event(work.id, 'checkpoint', secret, secret);
    const response = await state.app.inject({
      method: 'GET',
      url: '/api/work/' + work.id + '/public-receipt',
      headers: { host: '127.0.0.1:4710' },
    });
    assert.equal(response.statusCode, 200);
    const receipt = response.json();
    assert.deepEqual(receipt.harnessSequence, ['Codex', 'Hermes']);
    assert.equal(receipt.recordedAttempts, 2);
    assert.equal(receipt.reportedTokens, 54);
    assert.equal(receipt.savedCheckpoints, 1);
    assert(!response.body.includes(secret));
    const demo = await state.app.inject({
      method: 'GET',
      url: '/api/work/demo-continuity/public-receipt',
      headers: { host: '127.0.0.1:4710', 'x-forge-workspace': 'demo' },
    });
    assert.equal(demo.statusCode, 200);
    assert.equal(demo.json().evidence, 'fictional-demo');
    assert(receiptMarkdown(demo.json()).includes('FICTIONAL DEMO'));
    assert.equal(
      (
        await state.app.inject({
          method: 'GET',
          url: '/api/work/demo-continuity/public-receipt',
          headers: { host: '127.0.0.1:4710' },
        })
      ).statusCode,
      404,
    );
    assert.equal(nativeCalls, 0);
    assert.equal(state.controller.activeCount, 0);
  } finally {
    await state.app.close();
  }
});
