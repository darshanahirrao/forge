import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixtureProvider } from './provider.js';
import type {
  Account,
  AgentProfile,
  Approval,
  ContextReview,
  MemoryInspection,
  MemorySource,
  Run,
  Snapshot,
  Usage,
  Work,
  WorkCapsule,
} from '../../shared/types.js';
import type { WorkerProofDescriptor } from '../../shared/recovery.js';
const { createApp } = (await import(
  new URL('../../dist/server/app.js', import.meta.url).href
)) as typeof import('../../server/app.js');
const { loadExtensions } = (await import(
  new URL('../../dist/server/extensions.js', import.meta.url).href
)) as typeof import('../../server/extensions.js');
const { unknownPressure } = (await import(
  new URL('../../dist/server/memory-pressure.js', import.meta.url).href
)) as typeof import('../../server/memory-pressure.js');
const { readWorkerExit } = (await import(
  new URL('../../dist/server/worker-proof.mjs', import.meta.url).href
)) as typeof import('../../server/worker-proof.mjs');

const root = await realpath(
  await mkdtemp(join(process.cwd(), 'artifacts', 'forge-native-executors-')),
);
const project = join(root, 'project'),
  codexHome = join(root, 'codex'),
  hermesHome = join(root, 'hermes');
for (const path of [project, codexHome, hermesHome]) await mkdir(path);
const fact = 'Selected native extension memory: silver-harbor.',
  excluded = 'UNSELECTED-EXTENSION-MEMORY';
const proof = 'Native Codex extension proof.\n',
  continuation = 'Native Hermes extension continuation.\n';
let codexTool = false,
  hermesStep = 0,
  sourceContext = false,
  targetContext = false,
  readObserved = false;
let expected: string[] = [];
const source = await fixtureProvider(
  'responses',
  (body) => {
    if (!codexTool && body.tools?.some((tool: { name: string }) => tool.name === 'exec_command')) {
      const input = JSON.stringify(body.input);
      assert(input.includes(fact) && !input.includes(excluded));
      sourceContext = true;
      codexTool = true;
      return {
        tool: 'exec_command',
        id: 'native-extension-source',
        input: {
          cmd: "printf 'Native Codex extension proof.\\n' > proof.txt",
          workdir: project,
          max_output_tokens: 1000,
        },
      };
    }
    return { text: 'The native extension source proof is complete.' };
  },
  'synthetic-native-extension',
);
const destination = await fixtureProvider(
  'chat',
  (body) => {
    if (
      !body.tools?.some(
        (tool: { function?: { name?: string } }) => tool.function?.name === 'write_file',
      )
    )
      return { text: 'Native helper fixture.' };
    const input = JSON.stringify(body.messages);
    if (hermesStep === 0) {
      assert(input.includes(fact) && !input.includes(excluded));
      assert(expected.every((part) => input.includes(part)));
      targetContext = true;
      hermesStep++;
      return {
        tool: 'read_file',
        id: 'extension-native-read',
        input: { path: join(project, 'proof.txt') },
      };
    }
    if (hermesStep === 1) {
      assert(input.includes('extension-native-read') && input.includes(proof.trim()));
      readObserved = true;
      hermesStep++;
      return {
        tool: 'write_file',
        id: 'extension-native-write',
        input: { path: join(project, 'hermes.txt'), content: continuation },
      };
    }
    return { text: 'The native extension continuation is complete.' };
  },
  'synthetic-hermes-extension',
);
const codexConfig = `model="forge-extension"\nmodel_provider="fixture"\ncli_auth_credentials_store="file"\n[model_providers.fixture]\nname="Local native extension"\nbase_url="${source.endpoint}/v1"\nwire_api="responses"\nenv_key="LOCAL_NATIVE_KEY"\nrequires_openai_auth=false\n`;
const hermesConfig = `model:\n  default: forge-conformance\n  provider: custom\n  base_url: ${destination.endpoint}/v1\n  api_mode: chat_completions\n  api_key: synthetic-hermes-extension\nterminal:\n  backend: local\n  cwd: ${project}\nagent:\n  max_turns: 5\n`;
const memoryPath = join(root, 'MEMORY.md'),
  secretPath = join(root, 'provider.json');
await writeFile(join(codexHome, 'config.toml'), codexConfig, { mode: 0o600 });
await writeFile(join(hermesHome, 'config.yaml'), hermesConfig, { mode: 0o600 });
await writeFile(secretPath, JSON.stringify({ LOCAL_NATIVE_KEY: 'synthetic-native-extension' }), {
  mode: 0o600,
});
await writeFile(memoryPath, `# Shared\n${fact}\n# Other\n${excluded}\n`, { mode: 0o600 });
const extensions = await loadExtensions([resolve('examples/native-harness-extension.mjs')]);
const options = {
  filename: join(root, 'workspace.sqlite'),
  port: 0,
  test: true,
  extensions,
  memoryPressureReader: unknownPressure,
};
let state = await createApp(options);
const post = async <T>(path: string, payload: Record<string, unknown>): Promise<T> => {
  const response = await state.app.inject({
    method: 'POST',
    url: '/api' + path,
    headers: {
      host: '127.0.0.1:0',
      'x-forge-csrf': state.csrf,
      'content-type': 'application/json',
    },
    payload,
  });
  assert(response.statusCode < 300, response.body);
  return response.json<T>();
};
let approvals = 0;
const measured = new Set<string>();
async function run(workId: string) {
  const work = state.local.work(workId),
    review = await post<ContextReview>(`/work/${workId}/context-review`, {});
  const run = await post<Run>(`/work/${workId}/launch`, {
    expectedRevision: work.revision,
    contextDigest: review.receipt.reviewDigest,
    allowMetered: true,
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    assert.equal(source.failure(), null);
    assert.equal(destination.failure(), null);
    for (const approval of state.local
      .all<Approval>('approvals')
      .filter((a) => a.status === 'pending')) {
      const response = await state.app.inject({
        url: '/api/snapshot',
        headers: { host: '127.0.0.1:0' },
      });
      assert.equal(response.statusCode, 200);
      const snapshot = response.json<Snapshot>(),
        worker = snapshot.nativeWorkers?.find((w) => w.runId === run.id);
      if (worker?.state !== 'live') {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      assert.equal(worker.harness, work.harness);
      assert(worker.rss && worker.rss > 0);
      measured.add(run.id);
      assert(
        ['item/commandExecution/requestApproval', 'hermes/acp/request_permission'].includes(
          approval.method,
        ),
      );
      await post(`/approvals/${approval.id}/decision`, {
        digest: approval.digest,
        decision: 'accept',
      });
      approvals++;
    }
    if (state.local.work(workId).status === 'completed' && state.controller.activeCount === 0)
      break;
    if (['failed', 'interrupted'].includes(state.local.work(workId).status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(
    state.local.work(workId).status,
    'completed',
    JSON.stringify(state.local.recentEvents(workId)),
  );
  const closed = state.local.get<Run>('runs', run.id)!;
  assert(closed.exitConfirmed && closed.supervisionId);
  const descriptor = state.local.get<WorkerProofDescriptor>(
    'worker_supervisions',
    closed.supervisionId,
  )!;
  assert.equal(descriptor.scope.harness, work.harness);
  const proof = readWorkerExit(descriptor);
  assert(proof.payload.nativeClosed && proof.payload.stdioClosed);
}
try {
  const inspect = await post<MemoryInspection>('/memory/inspect', {
    path: memoryPath,
    section: ['Shared'],
  });
  const memory = await post<MemorySource>('/memory/sources', {
    label: 'Extension shared memory',
    owner: 'hermes',
    path: memoryPath,
    section: ['Shared'],
    scope: { kind: 'project', root: project },
    expectedSha256: inspect.sha256,
    expectedSelectionSha256: inspect.selectionSha256,
  });
  const profile = await post<AgentProfile>('/profiles', {
    name: 'Portable native extension profile',
    memorySourceIds: [memory.id],
  });
  const first = await post<Account>('/accounts', {
    label: 'Native Codex extension',
    harness: 'ext.example.codex',
    nativeHome: codexHome,
    billingMode: 'api',
    credentialEnv: 'LOCAL_NATIVE_KEY',
    credentialReference: { kind: 'private-json', path: secretPath, key: 'LOCAL_NATIVE_KEY' },
  });
  const second = await post<Account>('/accounts', {
    label: 'Native Hermes extension',
    harness: 'ext.example.hermes-acp',
    nativeHome: hermesHome,
  });
  assert(first.nativeExecutor && second.nativeExecutor);
  assert.equal(state.local.all('runs').length, 0);
  const checked = await post<Account>(`/accounts/${first.id}/probe`, {});
  assert.equal(checked.harness, first.harness);
  assert.equal(codexTool, false, 'A native account check must not submit a model turn.');
  const goal = 'Retain one work across installed native harness extensions.';
  const work = await post<Work>('/work', {
    title: 'Native harness extension continuity',
    project: 'Owned native extension fixture',
    goal,
    cwd: project,
    harness: first.harness,
    accountId: first.id,
    profileId: profile.id,
  });
  await run(work.id);
  assert.equal(await readFile(join(project, 'proof.txt'), 'utf8'), proof);
  const sourceSession = state.local.work(work.id).nativeSessionId;
  await state.app.close();
  state = await createApp(options);
  assert.equal(state.local.work(work.id).nativeSessionId, sourceSession);
  await post(`/work/${work.id}/checkpoint`, {
    note: 'Keep the extension proof and selected native memory.',
  });
  const prepared = await post<{ work: Work; capsule: WorkCapsule }>(`/work/${work.id}/capsules`, {
    expectedRevision: state.local.work(work.id).revision,
    paths: ['proof.txt'],
  });
  expected = [goal, profile.id, prepared.capsule.artifactDigest];
  const moved = await post<Work>(`/work/${work.id}/handoff`, {
    expectedRevision: prepared.work.revision,
    capsuleId: prepared.capsule.id,
    targetAccountId: second.id,
    reconciled: true,
  });
  assert.equal(moved.id, work.id);
  assert.equal(moved.profileId, profile.id);
  await run(work.id);
  assert.equal(await readFile(join(project, 'hermes.txt'), 'utf8'), continuation);
  assert(sourceContext && targetContext && readObserved);
  assert.equal(measured.size, 2);
  const usage = state.local.all<Usage>('usage');
  assert.equal(usage.length, 2);
  assert.deepEqual(new Set(usage.map((u) => u.harness)), new Set([first.harness, second.harness]));
  assert(usage.every((u) => u.key.startsWith(u.harness + ':')));
  const currentCodexConfig = await readFile(join(codexHome, 'config.toml'), 'utf8');
  // The installed native CLI can initialize its Git-root trust record in this disposable profile.
  const initializedCodexConfig =
    codexConfig + '\n[projects.' + JSON.stringify(process.cwd()) + ']\ntrust_level = "trusted"\n';
  assert(
    [codexConfig, initializedCodexConfig].includes(currentCodexConfig),
    'Native provider configuration changed beyond the observed CLI initialization record.',
  );
  assert.equal(await readFile(join(hermesHome, 'config.yaml'), 'utf8'), hermesConfig);
  assert.equal(await readFile(memoryPath, 'utf8'), `# Shared\n${fact}\n# Other\n${excluded}\n`);
  assert(!JSON.stringify(state.local.all('accounts')).includes('synthetic-native-extension'));
  console.log(
    JSON.stringify({
      status: 'passed',
      compiledPublicSDK: true,
      explicitExampleModule: true,
      nativeHarnesses: extensions.harnesses?.map((h) => h.id),
      sameWorkAndProfile: true,
      compiledHostRestartBeforeHandoff: true,
      selectedMemoryAndArtifactRetained: true,
      privateCredentialReachedOnlyNativeProvider: true,
      nativeApprovals: approvals,
      nativeResourceGroups: measured.size,
      signedNativeCloses: 2,
      nativeUsageScopes: usage.length,
      paidModelCalls: 0,
      personalConfigurationChanged: false,
      nativeCodexProfileInitialized: currentCodexConfig !== codexConfig,
    }),
  );
} finally {
  await state.app.close();
  await source.close();
  await destination.close();
  await rm(root, { recursive: true, force: true });
}
