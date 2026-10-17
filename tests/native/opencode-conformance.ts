import { unknownPressure } from '../../server/memory-pressure.js';
// Opt-in real OpenCode v2 worker. Only a deterministic loopback model endpoint is selected.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, Approval, Usage, Work, Run, WorkCapsule } from '../../shared/types.js';
import {
  openCodeWorker,
  assertIdleOpenCodeProfile,
} from '../../server/adapters/opencode-worker.js';
import { OpenCodeDriver } from '../../server/adapters/opencode-driver.js';
import { createApp } from '../../server/app.js';

const directory = await mkdtemp(join(tmpdir(), 'forge-native-opencode-'));
let project = join(directory, 'project');
const homes = [join(directory, 'native-one'), join(directory, 'native-two')];
await mkdir(project);
project = await realpath(project);
for (const home of homes) await mkdir(join(home, 'config', 'opencode'), { recursive: true });
const proofs = [
  'Forge native OpenCode proof.\n',
  'Forge OpenCode account continuation.\n',
  'Forge native OpenCode resumed context.\n',
];
const artifacts = [
  join(project, 'proof.txt'),
  join(project, 'continuation.txt'),
  join(project, 'resumed.txt'),
];
let stage = 0;
let requests = 0;
const memorySeen = [false, false, false];
let resumedHistorySeen = false;
let unselectedSeen = false;
let precedingArtifactRead = false;
let selectedCredential = true;
let capsuleDigest = '';
let capsuleSeen = false;
let version = '';
const keys = ['FORGE_OPENCODE_PROOF_ONE_KEY', 'FORGE_OPENCODE_PROOF_TWO_KEY'];
const secrets = ['synthetic-profile-one', 'synthetic-profile-two'];
const previous = keys.map((key) => process.env[key]);
keys.forEach((key, i) => {
  process.env[key] = secrets[i];
});
const provider = createServer(async (request, reply) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (!request.url?.includes('/chat/completions')) {
    reply.setHeader('content-type', 'application/json');
    reply.end('{}');
    return;
  }
  requests++;
  const messages = JSON.stringify(body.messages ?? []);
  memorySeen[stage] ||= messages.includes('forge-opencode-selected-memory');
  unselectedSeen ||= messages.includes('forge-opencode-unselected-memory');
  if (stage >= 1) capsuleSeen ||= messages.includes(capsuleDigest);
  if (request.headers.authorization !== `Bearer ${secrets[Math.min(stage, 1)]}`) {
    selectedCredential = false;
    reply.statusCode = 401;
    reply.end('{}');
    return;
  }
  assert.equal(body.model, 'proof');
  if (stage === 2)
    resumedHistorySeen ||=
      messages.includes('forge-native-write-1') && messages.includes(proofs[1].trim());
  const responses = (body.messages ?? []).filter((m: { role: string }) => m.role === 'tool');
  const readReturned = responses.some(
    (m: { tool_call_id: string; content: unknown }) =>
      m.tool_call_id === `forge-native-read-${stage}`,
  );
  if (stage >= 1 && readReturned)
    precedingArtifactRead ||= JSON.stringify(responses).includes(proofs[stage - 1].trim());
  const writeReturned = responses.some(
    (m: { tool_call_id: string }) => m.tool_call_id === `forge-native-write-${stage}`,
  );
  const toolName = stage >= 1 && !readReturned ? 'read' : !writeReturned ? 'write' : null;
  assert(
    !toolName ||
      body.tools?.some((t: { function: { name: string } }) => t.function.name === toolName),
  );
  const argumentsText = JSON.stringify(
    toolName === 'read'
      ? { path: artifacts[Math.max(stage - 1, 0)] }
      : { path: artifacts[stage], content: proofs[stage] },
  );
  const content = toolName ? null : 'The native conformance artifact is ready.';
  const call = {
    id: toolName === 'read' ? `forge-native-read-${stage}` : `forge-native-write-${stage}`,
    type: 'function',
    function: { name: toolName, arguments: argumentsText },
  };
  const base = {
    id: `chatcmpl-forge-${requests}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
  };
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  if (requests > 12) {
    reply.statusCode = 400;
    reply.end('{}');
    return;
  }
  if (!body.stream) {
    reply.setHeader('content-type', 'application/json');
    reply.end(
      JSON.stringify({
        ...base,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content, ...(toolName ? { tool_calls: [call] } : {}) },
            finish_reason: toolName ? 'tool_calls' : 'stop',
          },
        ],
        usage,
      }),
    );
    return;
  }
  reply.setHeader('content-type', 'text/event-stream');
  const send = (delta: unknown, finish_reason: string | null = null, final = false) =>
    reply.write(
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...(final ? { usage } : {}) })}\n\n`,
    );
  send({
    role: 'assistant',
    ...(toolName ? { tool_calls: [{ index: 0, ...call }] } : { content }),
  });
  send({}, toolName ? 'tool_calls' : 'stop', true);
  reply.end('data: [DONE]\n\n');
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
assert(address && typeof address === 'object');
for (let i = 0; i < homes.length; i++)
  await writeFile(
    join(homes[i], 'config', 'opencode', 'opencode.json'),
    JSON.stringify({
      model: 'forge/proof',
      update: 'disable',
      share: 'disabled',
      snapshots: false,
      providers: {
        forge: {
          env: [keys[i]],
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, timeout: 10000 },
          models: {
            proof: {
              name: 'Synthetic local proof',
              cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
              limit: { context: 32768, output: 2048 },
              capabilities: { tools: true, input: ['text'], output: ['text'] },
            },
          },
        },
      },
      permissions: [{ action: 'shell', resource: 'git push *', effect: 'deny' }],
    }),
  );
const state = await createApp({
  memoryPressureReader: unknownPressure,
  filename: ':memory:',
  csrf: 'opencode-conformance',
  test: true,
  driverFactory: () =>
    new OpenCodeDriver(async (account, cwd) => {
      const worker = await openCodeWorker(
        account,
        cwd,
        process.env.FORGE_OPENCODE_CONFORMANCE_BINARY,
      );
      version = worker.version || '';
      return worker;
    }),
});

const call = (url: string, payload: Record<string, unknown> = {}) =>
  state.app.inject({
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:4710',
      'x-forge-csrf': 'opencode-conformance',
      'content-type': 'application/json',
    },
    payload,
  });
try {
  const sourcePath = join(directory, 'MEMORY.md');
  await writeFile(
    sourcePath,
    '# Selected\nforge-opencode-selected-memory\n\n# Unselected\nforge-opencode-unselected-memory\n',
  );
  const inspected = (
    await call('/api/memory/inspect', { path: sourcePath, section: ['Selected'] })
  ).json();
  const source = (
    await call('/api/memory/sources', {
      label: 'Native proof memory',
      owner: 'obsidian',
      path: sourcePath,
      section: ['Selected'],
      scope: { kind: 'project', root: project },
      expectedSha256: inspected.sha256,
      expectedSelectionSha256: inspected.selectionSha256,
    })
  ).json();
  assert(source.id, JSON.stringify(source));
  const profile = (
    await call('/api/profiles', {
      name: 'OpenCode conformance',
      instructions: 'Use the selected native memory.',
      memorySourceIds: [source.id],
    })
  ).json();
  assert(profile.id, JSON.stringify(profile));
  const accounts: Account[] = [];
  for (let i = 0; i < homes.length; i++)
    accounts.push(
      (
        await call('/api/accounts', {
          label: `Native profile ${i + 1}`,
          harness: 'opencode',
          nativeHome: homes[i],
          credentialEnv: keys[i],
          billingMode: 'api',
        })
      ).json<Account>(),
    );
  const account = accounts[0];
  assert(account.id);
  const work = (
    await call('/api/work', {
      title: 'Native OpenCode proof',
      project: 'Synthetic',
      cwd: project,
      goal: 'Produce the proof artifact with the native write tool.',
      acceptance: 'The proof.txt content matches exactly.',
      harness: 'opencode',
      accountId: account.id,
      profileId: profile.id,
    })
  ).json<Work>();
  assert(work.id);
  let decisions = 0;
  let initialSession = '';
  let resumedSession = '';
  for (stage = 0; stage < 3; stage++) {
    if (stage === 1) {
      const prepared = (
        await call(`/api/work/${work.id}/capsules`, {
          expectedRevision: state.local.work(work.id).revision,
          paths: ['proof.txt'],
        })
      ).json<{ capsule: WorkCapsule; work: Work }>();
      assert(prepared.capsule, JSON.stringify(prepared));
      capsuleDigest = prepared.capsule.artifactDigest;
      const handoff = await call(`/api/work/${work.id}/handoff`, {
        expectedRevision: prepared.work.revision,
        capsuleId: prepared.capsule.id,
        targetAccountId: accounts[1].id,
        reconciled: true,
      });
      assert.equal(handoff.statusCode, 200, handoff.body);
      const moved = handoff.json<Work>();
      assert.equal(moved.id, work.id);
      assert.equal(moved.profileId, profile.id);
      assert.equal(moved.nativeSessionId, null);
    }
    const current = state.local.work(work.id);
    const review = (await call(`/api/work/${work.id}/context-review`)).json();
    const launch = await call(`/api/work/${work.id}/launch`, {
      expectedRevision: current.revision,
      allowMetered: true,
      contextDigest: review.receipt.reviewDigest,
    });
    assert.equal(launch.statusCode, 202, launch.body);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      for (const approval of state.local
        .all<Approval>('approvals')
        .filter((a) => a.status === 'pending')) {
        assert(
          ['opencode/permission/edit', 'opencode/permission/read'].includes(approval.method),
          approval.method,
        );
        if (approval.method === 'opencode/permission/edit') {
          assert(approval.command.includes(artifacts[stage]));
          assert(approval.command.includes(proofs[stage].trim()));
          await assert.rejects(readFile(artifacts[stage]), { code: 'ENOENT' });
        } else assert(approval.command.includes(artifacts[Math.max(stage - 1, 0)]));
        const result = await call(`/api/approvals/${approval.id}/decision`, {
          digest: approval.digest,
          decision: 'accept',
        });
        assert.equal(result.statusCode, 200, result.body);
        decisions++;
      }
      const current = state.local.work(work.id);
      if (['completed', 'failed', 'interrupted'].includes(current.status)) {
        assert.equal(
          current.status,
          'completed',
          JSON.stringify(state.local.recentEvents(work.id)),
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const finished = state.local.work(work.id);
    assert.equal(finished.status, 'completed', JSON.stringify(state.local.recentEvents(work.id)));
    assert.equal(finished.profileId, profile.id);
    assert.equal(await readFile(artifacts[stage], 'utf8'), proofs[stage]);
    if (stage === 0) initialSession = finished.nativeSessionId!;
    else if (stage === 1) {
      assert.notEqual(finished.nativeSessionId, initialSession);
      resumedSession = finished.nativeSessionId!;
    } else assert.equal(finished.nativeSessionId, resumedSession);
    await assertIdleOpenCodeProfile(homes[Math.min(stage, 1)]);
  }
  assert.equal(decisions, 5);
  assert(
    memorySeen.every(Boolean) &&
      !unselectedSeen &&
      precedingArtifactRead &&
      capsuleSeen &&
      selectedCredential &&
      resumedHistorySeen,
  );
  const usage = state.local.all<Usage>('usage').filter((u) => u.harness === 'opencode');
  assert.equal(usage.length, 2);
  assert.equal(new Set(usage.map((u) => u.accountId)).size, 2);
  assert(usage.every((u) => u.totalTokens > 0 && u.estimatedUsd !== null && u.estimatedUsd > 0));
  assert(
    state.local
      .all<Run>('runs')
      .filter((r) => r.workId === work.id)
      .every((r) => r.exitConfirmed),
  );
  console.log(
    JSON.stringify({
      harness: 'opencode',
      version,
      requests,
      decisions,
      nativeArtifacts: 3,
      nativeProfiles: 2,
      nativeRuns: 3,
      sameNativeSessionResumed: resumedHistorySeen,
      sameWorkAndMemory: true,
      precedingArtifactRead: true,
      selectedCredentials: true,
      usageScopes: 2,
      workerExits: true,
    }),
  );
} finally {
  await state.app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  });
  await rm(directory, { recursive: true, force: true });
}
