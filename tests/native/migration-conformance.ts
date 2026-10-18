// Compiled Forge + installed native importers and native turns. Inference is synthetic loopback only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account, ContextReview, Run, Work, WorkCapsule, Usage } from '../../shared/types.js';
import type { NativeMigrationReview } from '../../shared/native-migrations.js';
import { fixtureProvider } from './provider.js';

const { createApp } = (await import(
  new URL('../../dist/server/app.js', import.meta.url).href
)) as typeof import('../../server/app.js');
const { nativeMigrationBridge } = (await import(
  new URL('../../dist/server/adapters/native-migration.js', import.meta.url).href
)) as typeof import('../../server/adapters/native-migration.js');
const { unknownPressure } = (await import(
  new URL('../../dist/server/memory-pressure.js', import.meta.url).href
)) as typeof import('../../server/memory-pressure.js');
const { OpenClawDriver } = (await import(
  new URL('../../dist/server/adapters/openclaw-driver.js', import.meta.url).href
)) as typeof import('../../server/adapters/openclaw-driver.js');
const { HermesDriver } = (await import(
  new URL('../../dist/server/adapters/hermes-driver.js', import.meta.url).href
)) as typeof import('../../server/adapters/hermes-driver.js');
const { openClawWorker } = (await import(
  new URL('../../dist/server/adapters/openclaw-worker.js', import.meta.url).href
)) as typeof import('../../server/adapters/openclaw-worker.js');

await mkdir('artifacts', { recursive: true });
const root = await realpath(
  await mkdtemp(join(process.cwd(), 'artifacts', 'forge-native-migration-')),
);
const home = join(root, 'hermes-source'),
  project = join(root, 'project'),
  nativeUserHome = join(root, 'os-home');
for (const directory of [
  join(home, 'memories'),
  join(home, 'skills', 'owned-migration'),
  project,
  nativeUserHome,
])
  await mkdir(directory, { recursive: true, mode: 0o700 });
const seed = 'Native migration seed: cobalt-magnolia.',
  learned = 'Native learned continuity: amber-comet.',
  corrected = 'Native corrected continuity: silver-cedar.';
await writeFile(join(home, 'memories', 'MEMORY.md'), seed + '\n', { mode: 0o600 });
await writeFile(join(home, 'memories', 'USER.md'), 'Owned synthetic preferences.\n', {
  mode: 0o600,
});
await writeFile(join(home, 'SOUL.md'), 'Owned synthetic persona.\n', { mode: 0o600 });
await writeFile(
  join(home, 'skills', 'owned-migration', 'SKILL.md'),
  '---\nname: owned-migration\ndescription: Inert native migration fixture.\n---\nOwned synthetic skill.\n',
  { mode: 0o600 },
);
await writeFile(join(home, '.env'), 'OPENAI_API_KEY=SYNTHETIC-EXCLUDE-MIGRATION-SECRET\n', {
  mode: 0o600,
});
await writeFile(
  join(project, 'proof.txt'),
  'Owned artifact retained across native memory migration.\n',
);
let stage = 0;
const sent = [false, false, false, false, false];
const seen = [false, false, false, false, false];
const clawSteps = [0, 0, 0, 0, 0];
const hermes = await fixtureProvider(
  'chat',
  (body) => {
    if (
      !body.tools?.some((tool: { function?: { name: string } }) => tool.function?.name === 'memory')
    )
      return { text: 'Owned synthetic helper.' };
    const system = JSON.stringify(
      body.messages.filter((message: { role: string }) => message.role === 'system'),
    );
    assert(system.includes(seed), 'Native Hermes did not load its memory file.');
    if (stage === 0 && !sent[stage]) {
      sent[stage] = true;
      return {
        tool: 'memory',
        id: 'migrationlearn',
        input: { action: 'add', target: 'memory', content: learned },
      };
    }
    if (stage === 2) {
      assert(system.includes(learned), 'Returned native Hermes memory was not loaded.');
      if (!sent[stage]) {
        sent[stage] = true;
        return {
          tool: 'memory',
          id: 'migrationcorrect',
          // The native reverse importer groups a section into one entry. Preserve
          // its unrelated fact and correct the other through Hermes' atomic batch.
          input: {
            target: 'memory',
            operations: [
              { action: 'replace', old_text: learned, content: seed },
              { action: 'add', content: corrected },
            ],
          },
        };
      }
    }
    if (stage === 3) {
      assert(
        system.includes(corrected) && !system.includes(learned),
        'Fresh native memory did not reflect the correction.',
      );
      if (!sent[stage]) {
        sent[stage] = true;
        return {
          tool: 'memory',
          id: 'migrationremove',
          input: { action: 'remove', target: 'memory', old_text: corrected },
        };
      }
    }
    seen[stage] = true;
    return { text: 'Owned native memory operation completed.' };
  },
  'synthetic-migration-key',
);
const claw = await fixtureProvider(
  'chat',
  (body) => {
    if (
      !body.tools?.some(
        (tool: { function?: { name: string } }) => tool.function?.name === 'tool_call',
      )
    )
      return { text: 'Owned synthetic helper.' };
    const system = JSON.stringify(
      body.messages.filter((message: { role: string }) => message.role === 'system'),
    );
    assert(system.includes(seed), 'OpenClaw did not load the imported native memory.');
    assert(stage === 1 || stage === 4);
    if (stage === 1)
      assert(system.includes(learned), 'OpenClaw did not load the fact learned by Hermes.');
    if (stage === 4)
      assert(
        !system.includes(learned) && !system.includes(corrected),
        'Removed native memory returned after migration.',
      );
    if (clawSteps[stage]++ === 0) {
      return {
        tool: 'tool_search',
        id: `migrationsearch${stage}`,
        input: { query: 'memory_get', limit: 2 },
      };
    }
    if (clawSteps[stage] === 2) {
      assert(
        JSON.stringify(body.messages.at(-1)).includes('memory_get'),
        'Native discovery did not expose its memory tool.',
      );
      return {
        tool: 'tool_call',
        id: `migrationnativeget${stage}`,
        input: { id: 'memory_get', args: { path: 'MEMORY.md' } },
      };
    }
    assert(
      JSON.stringify(body.messages.at(-1)).includes(seed),
      'Native memory_get did not return the imported file.',
    );
    seen[stage] = true;
    return { text: 'The migrated native memory was read through its native tool.' };
  },
  'synthetic-migration-key',
);
const configureHermes = (accountHome: string) =>
  writeFile(
    join(accountHome, 'config.yaml'),
    `model:\n  default: forge-conformance\n  provider: custom\n  base_url: ${hermes.endpoint}/v1\n  api_mode: chat_completions\n  api_key: synthetic-migration-key\nplatform_toolsets:\n  acp: [file, memory]\nterminal:\n  backend: local\n  cwd: ${project}\nagent:\n  max_turns: 5\n`,
    { mode: 0o600 },
  );
await configureHermes(home);
const state = await createApp({
  driverFactory: (context) =>
    context.work.harness === 'hermes'
      ? new HermesDriver()
      : new OpenClawDriver(async (...args) => {
          const connection = await openClawWorker(...args),
            original = connection.request.bind(connection);
          connection.request = async (method, params, options) => {
            try {
              return await original(method, params, options);
            } catch (error) {
              console.error('Native migration RPC failed:', method);
              throw error;
            }
          };
          return connection;
        }),
  filename: join(root, 'state', 'workspace.sqlite'),
  test: true,
  csrf: 'native-migration-conformance',
  memoryPressureReader: unknownPressure,
  nativeMigrationBridge: (request) => nativeMigrationBridge({ ...request, nativeUserHome }),
});
const post = async <T>(path: string, payload: Record<string, unknown> = {}): Promise<T> => {
  const response = await state.app.inject({
    method: 'POST',
    url: '/api' + path,
    headers: { host: '127.0.0.1:4710', 'x-forge-csrf': 'native-migration-conformance' },
    payload,
  });
  assert(response.statusCode < 300, response.body);
  return response.json<T>();
};
const run = async (identifier: string) => {
  const review = await post<ContextReview>(`/work/${identifier}/context-review`);
  const run = await post<Run>(`/work/${identifier}/launch`, {
    expectedRevision: state.local.work(identifier).revision,
    contextDigest: review.receipt.reviewDigest,
    allowMetered: true,
  });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && state.local.work(identifier).activeRunId) {
    assert.equal(hermes.failure(), null);
    assert.equal(claw.failure(), null);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    state.local.work(identifier).status,
    'completed',
    JSON.stringify(state.local.recentEvents(identifier).slice(0, 6)),
  );
  assert(
    state.local.get<Run>('runs', run.id)?.exitConfirmed,
    'Native worker closure must be confirmed.',
  );
  assert(seen[stage], `Native stage ${stage} did not use memory.`);
};
let transfers = 0;
async function excludeSecret(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await excludeSecret(path);
    else if (entry.isFile())
      assert(
        !(await readFile(path)).includes(Buffer.from('SYNTHETIC-EXCLUDE-MIGRATION-SECRET')),
        'Native migration copied an excluded credential.',
      );
  }
}
const migrate = async (source: Account) => {
  const requests = hermes.requests() + claw.requests();
  const plan = await post<NativeMigrationReview>('/native/migrations/prepare', {
    sourceAccountId: source.id,
    label: `Migrated native ${++transfers}`,
  });
  assert.equal(plan.state, 'ready', JSON.stringify(plan));
  assert.equal(plan.summary?.overflowed, 0);
  assert.equal((await stat(plan.nativeHome)).mode & 0o777, 0o700);
  assert(!JSON.stringify(plan).includes('SYNTHETIC-EXCLUDE-MIGRATION-SECRET'));
  assert(
    plan.items.some((item) => item.kind.includes('skill') && item.status === 'migrated'),
    'The native importer did not report a migrated skill.',
  );
  const skillFiles = await Promise.allSettled(
    plan.items
      .filter(
        (item) =>
          item.kind === 'skill' &&
          item.status === 'migrated' &&
          item.target?.startsWith(plan.nativeHome + '/'),
      )
      .map((item) => readFile(join(item.target!, 'SKILL.md'), 'utf8')),
  );
  assert(
    skillFiles.some(
      (result) => result.status === 'fulfilled' && result.value.includes('Owned synthetic skill.'),
    ),
    'The target native skill content was not retained.',
  );
  await excludeSecret(plan.nativeHome);
  const target = await post<Account>(`/native/migrations/${plan.id}/activate`, {
    revision: plan.revision,
    digest: plan.digest,
    reviewed: true,
    ...(plan.targetHarness === 'openclaw' ? { openClawProjectRoot: project } : {}),
  });
  assert.equal(
    hermes.requests() + claw.requests(),
    requests,
    'Native migration must not invoke a model.',
  );
  assert.equal(target.credentialReference, undefined);
  return target;
};
const move = async (work: Work, account: Account) => {
  const checkpoint = await post<{ work: Work; capsule: WorkCapsule }>(`/work/${work.id}/capsules`, {
    expectedRevision: state.local.work(work.id).revision,
    paths: ['proof.txt'],
  });
  const moved = await post<Work>(`/work/${work.id}/handoff`, {
    expectedRevision: checkpoint.work.revision,
    capsuleId: checkpoint.capsule.id,
    targetAccountId: account.id,
    reconciled: true,
  });
  assert.equal(moved.id, work.id);
  assert.equal(moved.profileId, work.profileId);
  assert.equal(moved.goal, work.goal);
};
const configureClaw = async (account: Account) => {
  const path = join(account.nativeHome, 'openclaw.json'),
    config = JSON.parse(await readFile(path, 'utf8'));
  // Only this disposable fixture is configured. Native memory/skills and the importer-selected workspace stay native.
  config.gateway = {
    mode: 'local',
    bind: 'loopback',
    auth: { mode: 'token' },
    reload: { mode: 'off' },
  };
  config.agents.defaults.model = { primary: 'forge/proof' };
  config.agents.defaults.heartbeat = { every: '0m' };
  config.cron = { enabled: false };
  config.models = {
    providers: {
      forge: {
        baseUrl: `${claw.endpoint}/v1`,
        apiKey: 'synthetic-migration-key',
        api: 'openai-completions',
        models: [
          {
            id: 'proof',
            name: 'Owned native fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
};
try {
  const source = await post<Account>('/accounts', {
    label: 'Original native Hermes',
    harness: 'hermes',
    nativeHome: home,
    billingMode: 'native',
  });
  const work = await post<Work>('/work', {
    title: 'Native memory migration continuity',
    project: 'Owned synthetic fixture',
    cwd: project,
    goal: 'Keep this work and native memory across runtime replacement.',
    harness: 'hermes',
    accountId: source.id,
  });
  await run(work.id);
  assert((await readFile(join(home, 'memories', 'MEMORY.md'), 'utf8')).includes(learned));
  const target = await migrate(source);
  await configureClaw(target);
  await move(work, target);
  stage = 1;
  await run(work.id);
  const returned = await migrate(target);
  await configureHermes(returned.nativeHome);
  await move(work, returned);
  stage = 2;
  await run(work.id);
  assert(
    (await readFile(join(returned.nativeHome, 'memories', 'MEMORY.md'), 'utf8')).includes(
      corrected,
    ),
  );
  // A fresh native conversation must observe the correction, then remove it through the native tool.
  const fresh = await post<Work>('/work', {
    title: 'Fresh corrected native memory',
    project: 'Owned',
    cwd: project,
    goal: 'Remove the corrected fact through the native memory tool.',
    harness: 'hermes',
    accountId: returned.id,
    profileId: work.profileId,
  });
  stage = 3;
  await run(fresh.id);
  const memory = await readFile(join(returned.nativeHome, 'memories', 'MEMORY.md'), 'utf8');
  assert(!memory.includes(learned) && !memory.includes(corrected));
  const final = await migrate(returned);
  await configureClaw(final);
  await move(work, final);
  stage = 4;
  await run(work.id);
  assert(seen.every(Boolean));
  assert(
    (await readFile(join(home, 'memories', 'MEMORY.md'), 'utf8')).includes(learned),
    'The original native memory was changed by later corrections in the target.',
  );
  assert.equal(state.local.all<Usage>('usage').filter((row) => row.workId === work.id).length, 4);
  assert.equal(
    await readFile(join(project, 'proof.txt'), 'utf8'),
    'Owned artifact retained across native memory migration.\n',
  );
  assert.equal(hermes.failure(), null);
  assert.equal(claw.failure(), null);
  console.log(
    JSON.stringify({
      passed: true,
      compiledFramework: true,
      nativeImporters: ['Hermes 0.17.0', 'OpenClaw 2026.10.4'],
      nativeMigrations: transfers,
      nativeRuns: 5,
      sameWorkAndProfile: true,
      nativeMemoryLearnedReadCorrectedRemoved: true,
      nativeMemoryGet: true,
      sourceRetained: true,
      nativeSkillsImported: true,
      credentialsExcluded: true,
      migrationModelRequests: 0,
      paidModelCalls: 0,
    }),
  );
} finally {
  await state.app.close();
  await hermes.close();
  await claw.close();
  if (process.env.FORGE_NATIVE_KEEP !== '1') await rm(root, { recursive: true, force: true });
}
