// Actual native tools across one work identity and two credential contexts; inference remains synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createApp } from '../../server/app.js';
import { CodexDriver } from '../../server/adapters/codex-driver.js';
import { OpenCodeDriver } from '../../server/adapters/opencode-driver.js';
import { openCodeWorker } from '../../server/adapters/opencode-worker.js';
import { HermesDriver } from '../../server/adapters/hermes-driver.js';
import { ClaudeDriver } from '../../server/adapters/claude-driver.js';
import { NativeRpc } from '../../server/adapters/rpc.js';
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
import { fixtureProvider } from './provider.js';

await mkdir(join(process.cwd(), 'artifacts'), { recursive: true });
const directory = await mkdtemp(join(process.cwd(), 'artifacts', 'forge-native-handoff-'));
let project = join(directory, 'project');
const homes = [
  join(directory, 'codex'),
  join(directory, 'claude-one'),
  join(directory, 'claude-two'),
  join(directory, 'opencode'),
  join(directory, 'hermes'),
];
await mkdir(project);
project = await realpath(project);
for (const home of homes) await mkdir(home);
const sourceProof = 'Forge native handoff source.\n';
const continuation = 'Verified native Claude continuation.\n';
const finalProof = 'Verified second native account continuation.\n';
const checkpointNote = 'Keep the original proof and continue from its verified content.';
const goal = 'Retain one work identity across native harnesses and accounts.';
const memoryFact = 'Portable native memory marker: cobalt-orbit.';
const excludedMemory = 'PRIVATE-OTHER-TENANT-DO-NOT-INJECT';
const memoryPath = join(directory, 'MEMORY.md');
await writeFile(memoryPath, `# Shared\n${memoryFact}\n# Other tenant\n${excludedMemory}\n`);
let sourceMemoryObserved = false;
let sourceSent = false;
const sourceProvider = await fixtureProvider('responses', (body) => {
  if (!sourceSent && body.tools?.some((t: { name: string }) => t.name === 'exec_command')) {
    const nativeInput = JSON.stringify(body.input);
    assert(nativeInput.includes(memoryFact), 'Codex did not receive the selected native memory.');
    assert(!nativeInput.includes(excludedMemory), 'Unselected memory reached Codex.');
    sourceMemoryObserved = true;
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
const expectedFragments: string[][] = [[], [], [], []];
const observedContext = [false, false, false, false];
const observedRead = [false, false, false, false];
const stages = [0, 0, 0, 0];
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
        history.includes(memoryFact),
        'The destination did not receive selected native memory.',
      );
      assert(
        !history.includes(excludedMemory),
        'Unselected native memory reached the destination.',
      );
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
const openCodeProof = 'Verified native OpenCode continuation.\n';
const openCodeProvider = await fixtureProvider(
  'chat',
  (body) => {
    const history = JSON.stringify(body.messages);
    if (stages[2] === 0) {
      assert(body.model === 'proof');
      assert(history.includes(memoryFact) && !history.includes(excludedMemory));
      assert(expectedFragments[2].every((fragment) => history.includes(fragment)));
      observedContext[2] = true;
      stages[2]++;
      return {
        tool: 'read',
        id: 'handoff-opencode-read',
        input: { path: join(project, 'final.txt') },
      };
    }
    if (stages[2] === 1) {
      assert(history.includes('handoff-opencode-read') && history.includes(finalProof.trim()));
      observedRead[2] = true;
      stages[2]++;
      return {
        tool: 'write',
        id: 'handoff-opencode-write',
        input: { path: join(project, 'opencode.txt'), content: openCodeProof },
      };
    }
    return { text: 'The native OpenCode continuation was verified.' };
  },
  'synthetic-profile-three',
);
const hermesProof = 'Verified native Hermes continuation.\n';
const hermesProvider = await fixtureProvider(
  'chat',
  (body) => {
    if (
      !body.tools?.some((t: { function?: { name?: string } }) => t.function?.name === 'write_file')
    )
      return { text: 'Native helper fixture.' };
    const history = JSON.stringify(body.messages);
    if (stages[3] === 0) {
      assert(body.model === 'forge-conformance');
      assert(history.includes(memoryFact) && !history.includes(excludedMemory));
      assert(expectedFragments[3].every((fragment) => history.includes(fragment)));
      observedContext[3] = true;
      stages[3]++;
      return {
        tool: 'read_file',
        id: 'handoff-hermes-read',
        input: { path: join(project, 'opencode.txt') },
      };
    }
    if (stages[3] === 1) {
      assert(history.includes('handoff-hermes-read') && history.includes(openCodeProof.trim()));
      observedRead[3] = true;
      stages[3]++;
      return {
        tool: 'write_file',
        id: 'handoff-hermes-write',
        input: { path: join(project, 'hermes.txt'), content: hermesProof },
      };
    }
    return { text: 'The native Hermes continuation was verified.' };
  },
  'synthetic-profile-four',
);
await writeFile(
  join(homes[4], 'config.yaml'),
  `model:\n  default: forge-conformance\n  provider: custom\n  base_url: ${hermesProvider.endpoint}/v1\n  api_mode: chat_completions\n  api_key: synthetic-profile-four\nterminal:\n  backend: local\n  cwd: ${project}\nagent:\n  max_turns: 5\n`,
);
await mkdir(join(homes[3], 'config', 'opencode'), { recursive: true });
await writeFile(
  join(homes[3], 'config', 'opencode', 'opencode.json'),
  JSON.stringify({
    model: 'forge/proof',
    share: 'disabled',
    update: 'disable',
    snapshots: false,
    providers: {
      forge: {
        env: ['FORGE_HANDOFF_OPENCODE_KEY'],
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${openCodeProvider.endpoint}/v1`, timeout: 10000 },
        models: {
          proof: {
            limit: { context: 32768, output: 2048 },
            capabilities: { tools: true, input: ['text'], output: ['text'] },
          },
        },
      },
    },
  }),
);
await writeFile(
  join(homes[0], 'config.toml'),
  `model = "forge-conformance"\nmodel_provider = "fixture"\ncli_auth_credentials_store = "file"\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "${sourceProvider.endpoint}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
);
const refs = [
  'FORGE_HANDOFF_PROFILE_ONE',
  'FORGE_HANDOFF_PROFILE_TWO',
  'FORGE_HANDOFF_OPENCODE_KEY',
];
const saved = refs.map((ref) => process.env[ref]);
process.env[refs[0]] = 'synthetic-profile-one';
process.env[refs[1]] = 'synthetic-profile-two';
process.env[refs[2]] = 'synthetic-profile-three';
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
    if (context.work.harness === 'opencode')
      return new OpenCodeDriver((account, cwd) =>
        openCodeWorker(account, cwd, process.env.FORGE_OPENCODE_CONFORMANCE_BINARY),
      );
    if (context.work.harness === 'hermes') return new HermesDriver();
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
  const review = await post<ContextReview>(`/work/${workId}/context-review`, {});
  await post(`/work/${workId}/launch`, {
    expectedRevision: work.revision,
    allowMetered: true,
    contextDigest: review.receipt.reviewDigest,
  });
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
          'opencode/permission/read',
          'opencode/permission/edit',
          'hermes/acp/request_permission',
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
  const inspection = await post<MemoryInspection>('/memory/inspect', {
    path: memoryPath,
    section: ['Shared'],
  });
  const memory = await post<MemorySource>('/memory/sources', {
    label: 'Native shared facts',
    owner: 'hermes',
    path: memoryPath,
    section: ['Shared'],
    scope: { kind: 'project', root: project },
    expectedSha256: inspection.sha256,
    expectedSelectionSha256: inspection.selectionSha256,
  });
  const persistentProfile = await post<AgentProfile>('/profiles', {
    name: 'Native portable profile',
    memorySourceIds: [memory.id],
  });
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
  profileIds.push(
    (
      await post<Account>('/accounts', {
        label: 'Native OpenCode target',
        harness: 'opencode',
        nativeHome: homes[3],
        billingMode: 'api',
        credentialEnv: refs[2],
      })
    ).id,
  );
  profileIds.push(
    (
      await post<Account>('/accounts', {
        label: 'Native Hermes target',
        harness: 'hermes',
        nativeHome: homes[4],
        billingMode: 'native',
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
    profileId: persistentProfile.id,
  });
  await runNative(work.id);
  assert(sourceMemoryObserved);
  assert.equal(await readFile(join(project, 'proof.txt'), 'utf8'), sourceProof);
  const originalSession = state.local.work(work.id).nativeSessionId;
  await post(`/work/${work.id}/checkpoint`, { note: checkpointNote });
  let parent: string | null = null;
  for (let i = 0; i < 4; i++) {
    const prepared = await post<{ capsule: WorkCapsule; work: Work }>(`/work/${work.id}/capsules`, {
      expectedRevision: state.local.work(work.id).revision,
      paths: ['proof.txt', 'continuation.txt', 'final.txt', 'opencode.txt'].slice(0, i + 1),
    });
    assert.equal(prepared.capsule.parentCapsuleId, parent);
    assert.equal(prepared.capsule.contextReceipt?.profileId, persistentProfile.id);
    expectedFragments[i] = [
      goal,
      checkpointNote,
      prepared.capsule.artifactDigest,
      persistentProfile.id,
    ];
    const moved = await post<Work>(`/work/${work.id}/handoff`, {
      expectedRevision: prepared.work.revision,
      capsuleId: prepared.capsule.id,
      targetAccountId: profileIds[i],
      reconciled: true,
    });
    assert.equal(moved.id, work.id);
    assert.equal(moved.profileId, persistentProfile.id);
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
  assert.equal(await readFile(join(project, 'opencode.txt'), 'utf8'), openCodeProof);
  assert.equal(await readFile(join(project, 'hermes.txt'), 'utf8'), hermesProof);
  assert.equal(hermesProvider.failure(), null);
  assert.equal(openCodeProvider.failure(), null);
  const usage = state.local.all<Usage>('usage').filter((u) => u.workId === work.id);
  assert.equal(usage.length, 5);
  assert.equal(new Set(usage.map((u) => u.accountId)).size, 5);
  assert.equal(
    state.local.all<Run>('runs').filter((r) => r.workId === work.id && r.exitConfirmed).length,
    5,
  );
  assert.equal(state.local.checkpoints(work.id)[0].detail, checkpointNote);
  assert.equal(sourceProvider.failure(), null);
  for (const provider of destinations) assert.equal(provider.failure(), null);
  console.log(
    JSON.stringify({
      status: 'passed',
      workIdentityRetained: true,
      nativeRuns: 5,
      nativeApprovals: approvals,
      harnesses: ['codex', 'claude', 'opencode', 'hermes'],
      isolatedClaudeProfiles: 2,
      artifactCount: 5,
      contextAndCheckpointObserved: true,
      persistentProfileAndSelectedMemoryObserved: true,
      unselectedMemoryExcluded: true,
      usageScopesRetained: 5,
      paidModelCalls: 0,
    }),
  );
} finally {
  await state.app.close();
  await sourceProvider.close();
  await openCodeProvider.close();
  await hermesProvider.close();
  for (const provider of destinations) await provider.close();
  refs.forEach((ref, index) => {
    if (saved[index] === undefined) delete process.env[ref];
    else process.env[ref] = saved[index];
  });
  await rm(directory, { recursive: true, force: true });
}
