import { unknownPressure } from '../../server/memory-pressure.js';
// Real installed OpenClaw Gateway + native tools; inference stays on synthetic loopback providers.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { fixtureProvider } from './provider.js';
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

await mkdir('artifacts', { recursive: true });
const directory = await mkdtemp(join(process.cwd(), 'artifacts', 'forge-native-openclaw-'));
let project = join(directory, 'project');
await mkdir(project);
project = await realpath(project);
const homes = [join(directory, 'native-one'), join(directory, 'native-two')];
const files = ['proof.txt', 'resumed.txt', 'continued.txt'];
const proofs = [
  'Native OpenClaw proof one.\n',
  'Native OpenClaw resumed proof.\n',
  'Native OpenClaw second profile proof.\n',
];
const selectedFact = 'Selected Forge memory: copper-saffron.';
const excludedFact = 'Unselected secret section: never-inject-this.';
const memoryPath = join(directory, 'SHARED.md');
await writeFile(memoryPath, `# Shared\n${selectedFact}\n\n# Other\n${excludedFact}\n`);
let stage = 0;
let capsuleDigest = '';
let approvals = 0;
const sent = [0, 0, 0];
const readSeen = [false, false, false];
let resumedHistory = false;
const providers: Awaited<ReturnType<typeof fixtureProvider>>[] = [];
const rootRequests = [0, 0];
for (let profile = 0; profile < homes.length; profile++) {
  await mkdir(homes[profile]);
  const provider = await fixtureProvider(
    'chat',
    (body) => {
      assert.equal(body.model, 'proof');
      if (!body.tools?.some((t: { function?: { name?: string } }) => t.function?.name === 'exec'))
        return { text: 'Synthetic native helper.' };
      rootRequests[profile]++;
      if (stage === 3)
        return { error: { status: 401, message: 'Synthetic OpenClaw credential rejected.' } };
      if (stage === 4)
        return {
          tool: 'exec',
          id: 'openclawcancel',
          input: {
            command: `/usr/bin/python3 -c 'open("cancelled.txt","w").write("must never run")'`,
            workdir: project,
            yieldMs: 1000,
          },
        };
      const history = JSON.stringify(body.messages);
      assert(history.includes(selectedFact) && !history.includes(excludedFact));
      if (stage === 1)
        resumedHistory ||= history.includes('openclawexec0') && history.includes(proofs[0].trim());
      if (stage === 2) assert(history.includes(capsuleDigest));
      if (stage > 0 && sent[stage] === 0) {
        sent[stage]++;
        return {
          tool: 'read',
          id: `openclawread${stage}`,
          input: { path: join(project, files[stage - 1]) },
        };
      }
      if (sent[stage] === (stage > 0 ? 1 : 0)) {
        if (stage > 0) {
          assert(
            history.includes(`openclawread${stage}`) && history.includes(proofs[stage - 1].trim()),
            `The native read did not return the artifact: ${JSON.stringify(body.messages.at(-1)).slice(0, 3000)}`,
          );
          readSeen[stage] = true;
        }
        sent[stage]++;
        return {
          tool: 'exec',
          id: `openclawexec${stage}`,
          input: {
            command: `/usr/bin/python3 -c 'open(${JSON.stringify(files[stage])},"w").write(${JSON.stringify(proofs[stage])})'`,
            workdir: project,
            yieldMs: 1000,
          },
        };
      }
      return { text: `Native OpenClaw step ${stage} completed.` };
    },
    `synthetic-openclaw-${profile}`,
  );
  providers.push(provider);
  await writeFile(
    join(homes[profile], 'openclaw.json'),
    JSON.stringify({
      gateway: {
        mode: 'local',
        bind: 'loopback',
        auth: { mode: 'token' },
        reload: { mode: 'off' },
      },
      agents: {
        defaults: {
          workspace: project,
          skipBootstrap: true,
          heartbeat: { every: '0m' },
          model: { primary: 'forge/proof' },
        },
      },
      cron: { enabled: false },
      tools: { exec: { host: 'gateway', mode: 'ask' }, fs: { workspaceOnly: true } },
      models: {
        providers: {
          forge: {
            baseUrl: `${provider.endpoint}/v1`,
            apiKey: `synthetic-openclaw-${profile}`,
            api: 'openai-completions',
            models: [
              {
                id: 'proof',
                name: 'Native fixture',
                reasoning: false,
                input: ['text'],
                contextWindow: 32768,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    }),
  );
}
const state = await createApp({
  memoryPressureReader: unknownPressure,
  filename: ':memory:',
  csrf: 'openclaw-conformance',
  test: true,
});
async function post<T>(url: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await state.app.inject({
    method: 'POST',
    url: `/api${url}`,
    headers: {
      host: '127.0.0.1:4710',
      'x-forge-csrf': 'openclaw-conformance',
      'content-type': 'application/json',
    },
    payload,
  });
  assert(response.statusCode < 300, response.body);
  return response.json<T>();
}
async function run(workId: string, expected: Work['status'] = 'completed') {
  const work = state.local.work(workId);
  const review = await post<ContextReview>(`/work/${workId}/context-review`);
  const run = await post<Run>(`/work/${workId}/launch`, {
    expectedRevision: work.revision,
    contextDigest: review.receipt.reviewDigest,
    allowMetered: true,
  });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    for (const p of providers)
      if (p.failure()) console.error('Native fixture failure:', p.failure());
    assert(
      providers.every((p) => p.failure() === null),
      providers.map((p) => p.failure()).join('\n'),
    );
    for (const approval of state.local
      .all<Approval>('approvals')
      .filter((a) => a.status === 'pending')) {
      assert.equal(approval.method, 'openclaw/gateway/exec');
      assert.equal(approval.runId, run.id);
      assert(approval.command.includes(files[stage]));
      assert.equal(approval.cwd, project);
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
    expected,
    JSON.stringify(state.local.recentEvents(workId)),
  );
  assert(
    state.local.get<Run>('runs', run.id)?.exitConfirmed,
    'A finished run must carry an owned-process exit receipt.',
  );
  return run;
}
try {
  const inspected = await post<MemoryInspection>('/memory/inspect', {
    path: memoryPath,
    section: ['Shared'],
  });
  const memory = await post<MemorySource>('/memory/sources', {
    path: memoryPath,
    section: ['Shared'],
    label: 'Shared selected facts',
    owner: 'markdown',
    scope: { kind: 'project', root: project },
    expectedSha256: inspected.sha256,
    expectedSelectionSha256: inspected.selectionSha256,
  });
  const profile = await post<AgentProfile>('/profiles', {
    name: 'Persistent OpenClaw identity',
    memorySourceIds: [memory.id],
  });
  const accounts: Account[] = [];
  for (const home of homes)
    accounts.push(
      await post<Account>('/accounts', {
        label: `Native OpenClaw ${accounts.length + 1}`,
        harness: 'openclaw',
        nativeHome: home,
        billingMode: 'native',
      }),
    );
  for (const account of accounts) {
    const checked = await post<Account>(`/accounts/${account.id}/probe`);
    assert.equal(checked.state, 'configured', checked.error ?? 'Native validation failed.');
    assert.equal(checked.identity, null);
    assert.deepEqual(checked.quotas, []);
    await assert.rejects(stat(join(account.nativeHome, '.forge-openclaw.json')), {
      code: 'ENOENT',
    });
  }
  assert(
    providers.every((p) => p.requests() === 0),
    'Status checks must not prompt a model or start a Gateway.',
  );
  const work = await post<Work>('/work', {
    title: 'Native OpenClaw continuity',
    project: 'Synthetic',
    cwd: project,
    goal: 'Keep this work and selected memory while OpenClaw performs native commands across isolated profiles.',
    acceptance: 'Three verified files, native session resume and a verified profile handoff.',
    harness: 'openclaw',
    accountId: accounts[0].id,
    profileId: profile.id,
  });
  const nativeRequests: number[] = [];
  for (stage = 0; stage < 3; stage++) {
    if (stage === 2) {
      const capsule = await post<{ work: Work; capsule: WorkCapsule }>(
        `/work/${work.id}/capsules`,
        {
          expectedRevision: state.local.work(work.id).revision,
          paths: files.slice(0, 2),
        },
      );
      capsuleDigest = capsule.capsule.artifactDigest;
      assert.equal(
        capsule.capsule.source.nativeSessionKey,
        state.local.work(work.id).nativeSessionKey,
      );
      const moved = await post<Work>(`/work/${work.id}/handoff`, {
        expectedRevision: capsule.work.revision,
        capsuleId: capsule.capsule.id,
        targetAccountId: accounts[1].id,
        reconciled: true,
      });
      assert.equal(moved.profileId, profile.id);
      assert.equal(moved.nativeSessionId, null);
      assert.equal(moved.nativeSessionKey, null);
    }
    const before = rootRequests[stage === 2 ? 1 : 0];
    const previous = state.local.work(work.id);
    await run(work.id);
    const after = state.local.work(work.id);
    assert(after.nativeSessionId && after.nativeSessionKey);
    if (stage === 1) {
      assert.equal(after.nativeSessionId, previous.nativeSessionId);
      assert.equal(after.nativeSessionKey, previous.nativeSessionKey);
    }
    assert.equal(await readFile(join(project, files[stage]), 'utf8'), proofs[stage]);
    nativeRequests.push(rootRequests[stage === 2 ? 1 : 0] - before);
    console.log(JSON.stringify({ stage, artifact: files[stage], verified: true }));
    const identity = JSON.parse(
      await readFile(join(homes[stage === 2 ? 1 : 0], '.forge-openclaw.json'), 'utf8'),
    );
    assert.equal(identity.cleanExit, true);
    assert.equal(
      (await stat(join(homes[stage === 2 ? 1 : 0], '.forge-openclaw.json'))).mode & 0o077,
      0,
    );
  }
  assert(resumedHistory && readSeen[1] && readSeen[2]);
  assert.equal(approvals, 3);
  const usage = state.local
    .all<Usage>('usage')
    .filter((u) => u.workId === work.id)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  assert.equal(usage.length, 3);
  usage.forEach((u, index) => {
    assert.equal(u.source, 'openclaw/gateway');
    assert.equal(u.totalTokens, nativeRequests[index] * 120);
    assert.equal(u.estimatedUsd, 0);
  });
  stage = 4;
  const cancelled = await post<Work>('/work', {
    title: 'Cancel native pending command',
    project: 'Synthetic',
    cwd: project,
    goal: 'Wait at the exact native approval and cancel without executing it.',
    acceptance: 'No cancelled artifact; confirmed native exit.',
    harness: 'openclaw',
    accountId: accounts[1].id,
    profileId: profile.id,
  });
  const cancelReview = await post<ContextReview>(`/work/${cancelled.id}/context-review`);
  const cancelRun = await post<Run>(`/work/${cancelled.id}/launch`, {
    expectedRevision: cancelled.revision,
    contextDigest: cancelReview.receipt.reviewDigest,
    allowMetered: true,
  });
  const cancelDeadline = Date.now() + 60000;
  let held: Approval | undefined;
  while (Date.now() < cancelDeadline && !held) {
    held = state.local
      .all<Approval>('approvals')
      .find((a) => a.runId === cancelRun.id && a.status === 'pending');
    assert(
      !['failed', 'interrupted', 'completed'].includes(state.local.work(cancelled.id).status),
      JSON.stringify(state.local.recentEvents(cancelled.id)),
    );
    if (!held) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(held, 'The native command never reached Forge review.');
  await assert.rejects(readFile(join(project, 'cancelled.txt')), { code: 'ENOENT' });
  const stopping = await post<{ stopping: boolean }>(`/work/${cancelled.id}/interrupt`);
  assert(stopping.stopping);
  assert.equal(state.local.get<Approval>('approvals', held.id)?.status, 'invalidated');
  const exitDeadline = Date.now() + 20000;
  while (Date.now() < exitDeadline && state.local.work(cancelled.id).activeRunId)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    state.local.work(cancelled.id).activeRunId,
    null,
    'Native cancellation did not finish its owned process cleanup.',
  );
  assert.equal(state.local.work(cancelled.id).status, 'interrupted');
  assert(state.local.get<Run>('runs', cancelRun.id)?.exitConfirmed);
  await assert.rejects(readFile(join(project, 'cancelled.txt')), { code: 'ENOENT' });
  assert.equal(
    JSON.parse(await readFile(join(homes[1], '.forge-openclaw.json'), 'utf8')).cleanExit,
    true,
  );
  stage = 3;
  const failed = await post<Work>('/work', {
    title: 'Rejected native credential',
    project: 'Synthetic',
    cwd: project,
    goal: 'Surface an explicit native provider failure.',
    acceptance: 'The native failure must remain failed.',
    harness: 'openclaw',
    accountId: accounts[1].id,
    profileId: profile.id,
  });
  await run(failed.id, 'failed');

  assert(
    providers.every((p) => p.failure() === null),
    providers.map((p) => p.failure()).join('\n'),
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        native: 'OpenClaw 2026.10.4 / Gateway 4',
        runs: 5,
        proofs: 3,
        approvals,
        profileHandoff: true,
        nativeResume: true,
        selectedMemory: true,
        perRunUsage: nativeRequests,
        providerFailure: true,
        pendingCommandCancellation: true,
        inference: 'synthetic loopback only',
      },
      null,
      2,
    ),
  );
} finally {
  await state.app.close();
  for (const provider of providers) await provider.close();
  if (process.env.FORGE_NATIVE_KEEP !== '1') await rm(directory, { recursive: true, force: true });
}
