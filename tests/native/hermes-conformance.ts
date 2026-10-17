import { unknownPressure } from '../../server/memory-pressure.js';
// Actual native Hermes ACP + tools. The only configured model endpoints are loopback fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Account,
  AgentProfile,
  Approval,
  ContextReview,
  MemoryInspection,
  MemorySource,
  Run,
  Usage,
  Work,
  WorkCapsule,
} from '../../shared/types.js';
import { createApp } from '../../server/app.js';
import { fixtureProvider } from './provider.js';

await mkdir(join(process.cwd(), 'artifacts'), { recursive: true });
const directory = await mkdtemp(join(process.cwd(), 'artifacts', 'forge-native-hermes-'));
let project = join(directory, 'project');
await mkdir(project);
project = await realpath(project);
const homes = [join(directory, 'hermes-one'), join(directory, 'hermes-two')];
for (const home of homes) await mkdir(join(home, 'memories'), { recursive: true });
const sharedFact = 'Forge reviewed shared fact: amber-trellis.';
const learnedFact = 'Hermes native learned fact: silver-orbit.';
const nativeFacts = [
  'Hermes native profile one: cypress-pilot.',
  'Hermes native profile two: cedar-signal.',
];
const excludedFact = 'Unselected private fact: do-not-inject.';
const memoryPath = join(directory, 'SHARED.md');
await writeFile(memoryPath, `# Shared\n${sharedFact}\n\n# Other\n${excludedFact}\n`);
const proofs = [
  'Native Hermes artifact one.\n',
  'Native Hermes resumed artifact.\n',
  'Native Hermes second profile artifact.\n',
];
const files = ['proof.txt', 'resumed.txt', 'continued.txt'];
let stage = 0;
const seen = [false, false, false];
const readSeen = [false, false, false];
let nativeMemorySeen = false;
let resumedHistorySeen = false;
let nativeLearned = false;
let capsuleDigest = '';
const sent = [0, 0, 0];
const providers: Awaited<ReturnType<typeof fixtureProvider>>[] = [];
for (let profile = 0; profile < 2; profile++) {
  const provider = await fixtureProvider(
    'chat',
    (body) => {
      if (
        !body.tools?.some(
          (t: { function?: { name?: string } }) => t.function?.name === 'write_file',
        )
      )
        return { text: 'Synthetic native helper.' };
      assert.equal(body.model, 'forge-conformance');
      const history = JSON.stringify(body.messages);
      assert(history.includes(sharedFact) && !history.includes(excludedFact));
      assert(
        history.includes(nativeFacts[profile]),
        'The selected native Hermes memory was not loaded.',
      );
      if (stage === 3) {
        nativeMemorySeen = JSON.stringify(
          body.messages.filter((m: { role: string }) => m.role === 'system'),
        ).includes(learnedFact);
        assert(
          nativeMemorySeen,
          'A fresh native session must load the fact learned by the native memory tool.',
        );
        return { text: 'Fresh native memory is present.' };
      }
      if (stage === 4)
        return { error: { status: 401, message: 'Synthetic credentials rejected.' } };
      seen[stage] = true;
      if (stage === 1) {
        resumedHistorySeen ||=
          history.includes('hermes-write-0') && history.includes(proofs[0].trim());
      }
      if (stage === 2) assert(history.includes(capsuleDigest) && history.includes(learnedFact));
      const prefix = stage > 0 ? 1 : 0;
      if (stage > 0 && sent[stage] === 0) {
        sent[stage]++;
        return {
          tool: 'read_file',
          id: `hermes-read-${stage}`,
          input: { path: join(project, files[stage - 1]) },
        };
      }
      if (sent[stage] === prefix) {
        if (stage > 0) {
          assert(
            history.includes(`hermes-read-${stage}`) && history.includes(proofs[stage - 1].trim()),
          );
          readSeen[stage] = true;
        }
        sent[stage]++;
        return {
          tool: 'write_file',
          id: `hermes-write-${stage}`,
          input: { path: join(project, files[stage]), content: proofs[stage] },
        };
      }
      if (stage === 0 && sent[stage] === 1) {
        sent[stage]++;
        assert(
          body.tools.some((t: { function: { name: string } }) => t.function.name === 'memory'),
        );
        return {
          tool: 'memory',
          id: 'hermes-native-memory',
          input: { action: 'add', target: 'memory', content: learnedFact },
        };
      }
      return { text: 'The native Hermes conformance step is complete.' };
    },
    `synthetic-hermes-profile-${profile}`,
  );
  providers.push(provider);
  await writeFile(
    join(homes[profile], 'config.yaml'),
    `model:\n  default: forge-conformance\n  provider: custom\n  base_url: ${provider.endpoint}/v1\n  api_mode: chat_completions\n  api_key: synthetic-hermes-profile-${profile}\nplatform_toolsets:\n  acp: [file, memory]\nterminal:\n  backend: local\n  cwd: ${project}\nagent:\n  max_turns: 8\n`,
  );
  await writeFile(join(homes[profile], 'memories', 'MEMORY.md'), `${nativeFacts[profile]}\n`);
}
const state = await createApp({
  memoryPressureReader: unknownPressure,
  filename: ':memory:',
  csrf: 'hermes-conformance',
  test: true,
});
async function post<T>(url: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await state.app.inject({
    method: 'POST',
    url: `/api${url}`,
    headers: {
      host: '127.0.0.1:4710',
      'x-forge-csrf': 'hermes-conformance',
      'content-type': 'application/json',
    },
    payload,
  });
  assert(response.statusCode < 300, response.body);
  return response.json<T>();
}
let approvals = 0;
async function run(workId: string) {
  const current = state.local.work(workId);
  const review = await post<ContextReview>(`/work/${workId}/context-review`);
  await post(`/work/${workId}/launch`, {
    expectedRevision: current.revision,
    allowMetered: true,
    contextDigest: review.receipt.reviewDigest,
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    for (const approval of state.local
      .all<Approval>('approvals')
      .filter((a) => a.status === 'pending')) {
      assert.equal(approval.method, 'hermes/acp/request_permission');
      assert(approval.command.includes(join(project, files[stage])));
      assert(approval.command.includes(proofs[stage].trim()));
      assert(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) <= 55000);
      await assert.rejects(readFile(join(project, files[stage])), { code: 'ENOENT' });
      await post(`/approvals/${approval.id}/decision`, {
        digest: approval.digest,
        decision: 'accept',
      });
      approvals++;
    }
    if (['completed', 'failed', 'interrupted'].includes(state.local.work(workId).status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    state.local.work(workId).status,
    'completed',
    JSON.stringify(state.local.recentEvents(workId)),
  );
  assert.equal(await readFile(join(project, files[stage]), 'utf8'), proofs[stage]);
}
try {
  const inspection = await post<MemoryInspection>('/memory/inspect', {
    path: memoryPath,
    section: ['Shared'],
  });
  const memory = await post<MemorySource>('/memory/sources', {
    path: memoryPath,
    section: ['Shared'],
    label: 'Shared native facts',
    owner: 'markdown',
    scope: { kind: 'project', root: project },
    expectedSha256: inspection.sha256,
    expectedSelectionSha256: inspection.selectionSha256,
  });
  let profile = await post<AgentProfile>('/profiles', {
    name: 'Persistent Hermes identity',
    memorySourceIds: [memory.id],
  });
  const accounts: Account[] = [];
  for (let i = 0; i < 2; i++)
    accounts.push(
      await post<Account>('/accounts', {
        label: `Native Hermes ${i + 1}`,
        harness: 'hermes',
        nativeHome: homes[i],
        billingMode: 'native',
      }),
    );
  for (const account of accounts) {
    const checked = await post<Account>(`/accounts/${account.id}/probe`);
    assert.equal(checked.state, 'configured', checked.error || 'Native ACP check failed.');
    assert.equal(checked.identity, null);
    assert.deepEqual(checked.quotas, []);
  }
  assert(
    providers.every((provider) => provider.requests() === 0),
    'Account probes must not send model prompts.',
  );
  const work = await post<Work>('/work', {
    title: 'Native Hermes continuity',
    project: 'Synthetic',
    cwd: project,
    goal: 'Retain the same work and profile while Hermes performs native tools and learns memory.',
    acceptance: 'Three verified artifacts and native memory continuity.',
    harness: 'hermes',
    accountId: accounts[0].id,
    profileId: profile.id,
  });
  await run(work.id);
  const original = state.local.work(work.id).nativeSessionId;
  const nativeMemory = await readFile(join(homes[0], 'memories', 'MEMORY.md'), 'utf8');
  nativeLearned = nativeMemory.includes(learnedFact);
  assert(nativeLearned, 'Hermes did not persist the fact through its native memory tool.');
  stage = 1;
  await run(work.id);
  assert.equal(state.local.work(work.id).nativeSessionId, original);
  const learnedPath = join(homes[0], 'memories', 'MEMORY.md');
  const inspected = await post<MemoryInspection>('/memory/inspect', { path: learnedPath });
  const learned = await post<MemorySource>('/memory/sources', {
    path: learnedPath,
    section: [],
    label: 'Native Hermes learned facts',
    owner: 'hermes',
    scope: { kind: 'project', root: project },
    expectedSha256: inspected.sha256,
    expectedSelectionSha256: inspected.selectionSha256,
  });
  const update = await state.app.inject({
    method: 'PATCH',
    url: `/api/profiles/${profile.id}`,
    headers: {
      host: '127.0.0.1:4710',
      'x-forge-csrf': 'hermes-conformance',
      'content-type': 'application/json',
    },
    payload: {
      expectedRevision: profile.revision,
      name: profile.name,
      instructions: profile.instructions,
      memorySourceIds: [memory.id, learned.id],
    },
  });
  assert.equal(update.statusCode, 200, update.body);
  profile = update.json<AgentProfile>();
  const prepared = await post<{ work: Work; capsule: WorkCapsule }>(`/work/${work.id}/capsules`, {
    expectedRevision: state.local.work(work.id).revision,
    paths: files.slice(0, 2),
  });
  capsuleDigest = prepared.capsule.artifactDigest;
  const moved = await post<Work>(`/work/${work.id}/handoff`, {
    expectedRevision: prepared.work.revision,
    capsuleId: prepared.capsule.id,
    targetAccountId: accounts[1].id,
    reconciled: true,
  });
  assert.equal(moved.profileId, profile.id);
  assert.equal(moved.nativeSessionId, null);
  stage = 2;
  await run(work.id);
  assert(seen.every(Boolean), 'All runs must receive selected context.');
  assert(readSeen[1] && readSeen[2], 'Native tools must read the prior artifacts.');
  assert(nativeLearned, 'Native memory tool must persist the fact.');
  assert(resumedHistorySeen, 'Native session loading must retain its prior tool history.');
  const usage = state.local.all<Usage>('usage').filter((u) => u.workId === work.id);
  assert.equal(usage.length, 3);
  assert(
    usage.every((u) => u.totalTokens > 0 && u.source === 'hermes/acp' && u.estimatedUsd === null),
  );
  assert.equal(approvals, 3);
  assert(
    state.local
      .all<Run>('runs')
      .filter((r) => r.workId === work.id)
      .every((r) => r.exitConfirmed),
  );
  stage = 3;
  const fresh = await post<Work>('/work', {
    title: 'Fresh native memory session',
    project: 'Synthetic',
    cwd: project,
    goal: 'Recall the native learned fact.',
    harness: 'hermes',
    accountId: accounts[0].id,
    profileId: profile.id,
  });
  const launchFresh = async (id: string) => {
    const review = await post<ContextReview>(`/work/${id}/context-review`);
    await post(`/work/${id}/launch`, {
      expectedRevision: state.local.work(id).revision,
      allowMetered: true,
      contextDigest: review.receipt.reviewDigest,
    });
    const until = Date.now() + 45000;
    while (Date.now() < until && state.local.work(id).activeRunId)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state.local.work(id).activeRunId, null, 'Native worker must exit.');
  };
  await launchFresh(fresh.id);
  assert.equal(
    state.local.work(fresh.id).status,
    'completed',
    JSON.stringify(state.local.recentEvents(fresh.id)),
  );
  assert(nativeMemorySeen);
  stage = 4;
  const failed = await post<Work>('/work', {
    title: 'Native provider failure',
    project: 'Synthetic',
    cwd: project,
    goal: 'Report an explicit native provider failure.',
    harness: 'hermes',
    accountId: accounts[0].id,
    profileId: profile.id,
  });
  await launchFresh(failed.id);
  assert.equal(
    state.local.work(failed.id).status,
    'failed',
    JSON.stringify(state.local.recentEvents(failed.id)),
  );
  assert(
    state.local.recentEvents(failed.id).some((e) => e.title === 'Native Hermes turn ended'),
    'The native outcome report, not a transport failure, must mark the failed turn.',
  );
  for (const provider of providers) assert.equal(provider.failure(), null);
  console.log(
    JSON.stringify({
      harness: 'hermes',
      nativeVersion: '0.17.0',
      protocol: 1,
      nativeRuns: 5,
      nativeProfiles: 2,
      nativeArtifacts: 3,
      nativeApprovals: approvals,
      sameWorkAndProfile: true,
      nativeHistoryResumed: true,
      nativeMemoryLearnedAndReused: true,
      selectedMemoryExcluded: true,
      usageScopes: 3,
      workerExits: true,
      nativeProviderFailureReported: true,
      paidModelCalls: 0,
    }),
  );
} finally {
  await state.app.close();
  for (const provider of providers) await provider.close();
  await rm(directory, { recursive: true, force: true });
}
