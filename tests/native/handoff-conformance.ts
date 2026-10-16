// Actual native tools across one work identity and two credential contexts; inference remains synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createApp } from '../../server/app.js';
import { CodexDriver } from '../../server/adapters/codex-driver.js';
import { ClaudeDriver } from '../../server/adapters/claude-driver.js';
import { NativeRpc } from '../../server/adapters/rpc.js';
import type { Account, Approval, Run, Usage, Work, WorkCapsule } from '../../shared/types.js';
import { fixtureProvider } from './provider.js';

const directory = await mkdtemp(join(tmpdir(), 'forge-native-handoff-'));
const project = join(directory, 'project');
const homes = [
  join(directory, 'codex'),
  join(directory, 'claude-one'),
  join(directory, 'claude-two'),
];
await mkdir(project);
for (const home of homes) await mkdir(home);
const sourceProof = 'Forge native handoff source.\n';
const continuation = 'Verified native Claude continuation.\n';
const finalProof = 'Verified second native account continuation.\n';
const checkpointNote = 'Keep the original proof and continue from its verified content.';
const goal = 'Retain one work identity across native harnesses and accounts.';
let sourceSent = false;
const sourceProvider = await fixtureProvider('responses', (body) => {
  if (!sourceSent && body.tools?.some((t: { name: string }) => t.name === 'exec_command')) {
    sourceSent = true;
    return {
      tool: 'exec_command',
      id: 'handoff-source-tool',
      input: {
        cmd: "printf 'Forge native handoff source.\\n' > proof.txt",
        workdir: project,
        max_output_tokens: 1000,
      },
    };
  }
  return { text: 'The native source artifact was produced.' };
});
const expectedFragments: string[][] = [[], []];
const observedContext = [false, false];
const observedRead = [false, false];
const stages = [0, 0];
function nextProgram(index: number) {
  const sourceName = index === 0 ? 'proof.txt' : 'continuation.txt';
  const destinationName = index === 0 ? 'continuation.txt' : 'final.txt';
  const expected = index === 0 ? sourceProof : continuation;
  return (body: any) => {
    if (!body.tools?.some((t: { name: string }) => t.name === 'Read'))
      return { text: 'Local helper fixture.' };
    const history = JSON.stringify(body.messages);
    if (stages[index] === 0) {
      assert(
        expectedFragments[index].every((fragment) => history.includes(fragment)),
        'The destination did not receive the portable goal, checkpoint and manifest reference.',
      );
      observedContext[index] = true;
      stages[index]++;
      return {
        tool: 'Read',
        id: `handoff-read-${index}`,
        input: { file_path: join(project, sourceName) },
      };
    }
    if (stages[index] === 1) {
      assert(
        history.includes(`handoff-read-${index}`) && history.includes(expected.trim()),
        'The destination did not read the verified source artifact through its native tool.',
      );
      observedRead[index] = true;
      stages[index]++;
      return {
        tool: 'Write',
        id: `handoff-write-${index}`,
        input: {
          file_path: join(project, destinationName),
          content: index === 0 ? continuation : finalProof,
        },
      };
    }
    return { text: 'The native continuation artifact was verified.' };
  };
}
const destinations = [
  await fixtureProvider('messages', nextProgram(0), 'synthetic-profile-one'),
  await fixtureProvider('messages', nextProgram(1), 'synthetic-profile-two'),
];
await writeFile(
  join(homes[0], 'config.toml'),
  `model = "forge-conformance"\nmodel_provider = "fixture"\ncli_auth_credentials_store = "file"\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "${sourceProvider.endpoint}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
);
const refs = ['FORGE_HANDOFF_PROFILE_ONE', 'FORGE_HANDOFF_PROFILE_TWO'];
const saved = refs.map((ref) => process.env[ref]);
process.env[refs[0]] = 'synthetic-profile-one';
process.env[refs[1]] = 'synthetic-profile-two';
const profileIds: string[] = [];
const state = await createApp({
  filename: ':memory:',
  csrf: 'handoff-conformance',
  test: true,
  driverFactory: (context) => {
    if (context.work.harness === 'codex')
      return new CodexDriver(
        (options) =>
          new NativeRpc({
            ...options,
            env: {
              PATH: process.env.PATH,
              HOME: directory,
              TMPDIR: directory,
              CODEX_HOME: context.account.nativeHome,
              LANG: 'en_US.UTF-8',
            },
          }),
      );
    const index = profileIds.indexOf(context.account.id);
    assert(index >= 0);
    return new ClaudeDriver((params) =>
      query({
        ...params,
        options: {
          ...params.options,
          maxTurns: 5,
          model: 'claude-sonnet-4-5-20250929',
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            TMPDIR: directory,
            CLAUDE_CONFIG_DIR: context.account.nativeHome,
            ANTHROPIC_API_KEY: params.options.env?.ANTHROPIC_API_KEY,
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:
              params.options.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
            ANTHROPIC_BASE_URL: destinations[index].endpoint,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
          },
        },
      }),
    );
  },
});
const post = async <T>(path: string, payload: Record<string, unknown>): Promise<T> => {
  const result = await state.app.inject({
    method: 'POST',
    url: `/api${path}`,
    headers: {
      host: '127.0.0.1:4710',
      'x-forge-csrf': 'handoff-conformance',
      'content-type': 'application/json',
    },
    payload,
  });
  assert.ok(result.statusCode < 300, result.body);
  return result.json<T>();
};
let approvals = 0;
async function runNative(workId: string) {
  const work = state.local.work(workId);
  await post(`/work/${workId}/launch`, { expectedRevision: work.revision, allowMetered: true });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const approval of state.local
      .all<Approval>('approvals')
      .filter((a) => a.status === 'pending')) {
      assert(
        [
          'item/commandExecution/requestApproval',
          'claude/canUseTool/Read',
          'claude/canUseTool/Write',
        ].includes(approval.method),
      );
      await post(`/approvals/${approval.id}/decision`, {
        digest: approval.digest,
        decision: 'accept',
      });
      approvals++;
    }
    const current = state.local.work(workId);
    if (['completed', 'failed', 'interrupted'].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    state.local.work(workId).status,
    'completed',
    JSON.stringify(state.local.recentEvents(workId)),
  );
  assert.equal(state.controller.activeCount, 0);
}
try {
  const source = await post<Account>('/accounts', {
    label: 'Native Codex source',
    harness: 'codex',
    nativeHome: homes[0],
  });
  for (let i = 0; i < 2; i++)
    profileIds.push(
      (
        await post<Account>('/accounts', {
          label: `Native API profile ${i + 1}`,
          harness: 'claude',
          billingMode: 'api',
          nativeHome: homes[i + 1],
          credentialEnv: refs[i],
        })
      ).id,
    );
  const work = await post<Work>('/work', {
    title: 'One native work identity',
    project: 'Synthetic',
    cwd: project,
    goal,
    acceptance: 'Read the preceding artifact, preserve it, and produce the next artifact.',
    harness: 'codex',
    accountId: source.id,
  });
  await runNative(work.id);
  assert.equal(await readFile(join(project, 'proof.txt'), 'utf8'), sourceProof);
  const originalSession = state.local.work(work.id).nativeSessionId;
  await post(`/work/${work.id}/checkpoint`, { note: checkpointNote });
  let parent: string | null = null;
  for (let i = 0; i < 2; i++) {
    const prepared = await post<{ capsule: WorkCapsule; work: Work }>(`/work/${work.id}/capsules`, {
      expectedRevision: state.local.work(work.id).revision,
      paths: i === 0 ? ['proof.txt'] : ['proof.txt', 'continuation.txt'],
    });
    assert.equal(prepared.capsule.parentCapsuleId, parent);
    expectedFragments[i] = [goal, checkpointNote, prepared.capsule.artifactDigest];
    const moved = await post<Work>(`/work/${work.id}/handoff`, {
      expectedRevision: prepared.work.revision,
      capsuleId: prepared.capsule.id,
      targetAccountId: profileIds[i],
      reconciled: true,
    });
    assert.equal(moved.id, work.id);
    assert.equal(moved.goal, goal);
    assert.equal(moved.nativeSessionId, null);
    await runNative(work.id);
    assert.notEqual(state.local.work(work.id).nativeSessionId, originalSession);
    assert.equal(observedContext[i], true);
    assert.equal(observedRead[i], true);
    parent = prepared.capsule.id;
  }
  assert.equal(await readFile(join(project, 'proof.txt'), 'utf8'), sourceProof);
  assert.equal(await readFile(join(project, 'continuation.txt'), 'utf8'), continuation);
  assert.equal(await readFile(join(project, 'final.txt'), 'utf8'), finalProof);
  const usage = state.local.all<Usage>('usage').filter((u) => u.workId === work.id);
  assert.equal(usage.length, 3);
  assert.equal(new Set(usage.map((u) => u.accountId)).size, 3);
  assert.equal(
    state.local.all<Run>('runs').filter((r) => r.workId === work.id && r.exitConfirmed).length,
    3,
  );
  assert.equal(state.local.checkpoints(work.id)[0].detail, checkpointNote);
  assert.equal(sourceProvider.failure(), null);
  for (const provider of destinations) assert.equal(provider.failure(), null);
  console.log(
    JSON.stringify({
      status: 'passed',
      workIdentityRetained: true,
      nativeRuns: 3,
      nativeApprovals: approvals,
      harnesses: ['codex', 'claude'],
      isolatedClaudeProfiles: 2,
      artifactCount: 3,
      contextAndCheckpointObserved: true,
      usageScopesRetained: 3,
      paidModelCalls: 0,
    }),
  );
} finally {
  await state.app.close();
  await sourceProvider.close();
  for (const provider of destinations) await provider.close();
  refs.forEach((ref, index) => {
    if (saved[index] === undefined) delete process.env[ref];
    else process.env[ref] = saved[index];
  });
  await rm(directory, { recursive: true, force: true });
}
