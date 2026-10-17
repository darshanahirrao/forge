import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Blueprints } from '../server/blueprints.js';
import { Store } from '../server/store.js';
import { Profiles, inspectMemory } from '../server/memory.js';
import { unknownPressure } from '../server/memory-pressure.js';
import type { Account, Work, AgentProfile } from '../shared/types.js';
import type { BlueprintDefinition, BlueprintBindings } from '../shared/blueprints.js';

async function fixture(disk = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-blueprint-')));
  const project = join(root, 'project');
  await mkdir(project);
  const state = await createApp({
    filename: disk ? join(root, 'workspace.sqlite') : ':memory:',
    test: true,
    memoryPressureReader: unknownPressure,
  });
  const call = (
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    state.app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:4710',
        'x-forge-csrf': state.csrf,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  const account = (
    await call('POST', '/api/accounts', { label: 'Local native slot', harness: 'codex' })
  ).json<Account>();
  const profiles = new Profiles(state.local);
  const memoryFile = join(root, 'memory.md');
  await writeFile(
    memoryFile,
    '# Shared\nselected-blueprint-fact\n# Private\nexcluded-blueprint-fact\n',
  );
  const selected = await inspectMemory(memoryFile, ['Shared']);
  const source = await profiles.addSource(
    {
      label: 'Selected native memory',
      owner: 'markdown',
      path: memoryFile,
      section: ['Shared'],
      scope: { kind: 'global' },
    },
    selected.sha256,
    selected.selectionSha256,
  );
  const definition: BlueprintDefinition = {
    format: 'forge.workspace-blueprint',
    version: 1,
    name: 'Reusable developer setup',
    harnesses: ['codex'],
    accounts: [{ role: 'coding', harness: 'codex', billingMode: 'native' }],
    settings: { maxConcurrent: 1, memoryPressurePolicy: 'observe' },
    profiles: [
      {
        role: 'developer',
        name: 'Portable developer',
        instructions: 'Retain source-attributed checkpoints.',
        memoryOwners: [{ owner: 'markdown', scope: 'global' }],
        preferredCompanion: null,
      },
    ],
    requirements: ['Connect your own native accounts'],
    workTemplates: [
      {
        role: 'first-work',
        title: 'Imported work',
        goal: 'Review the project and its native instructions.',
        accountRole: 'coding',
        profileRole: 'developer',
        projectRole: 'project',
      },
    ],
  };
  const bindings: BlueprintBindings = {
    accounts: { coding: account.id },
    profiles: {},
    memories: { 'developer:memory:1': source.id },
    companions: {},
    projects: { project },
    applySettings: false,
  };
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      await state.app.close();
      stopped = true;
    }
  };
  return {
    ...state,
    root,
    project,
    memoryFile,
    account,
    profiles,
    source,
    definition,
    bindings,
    call,
    stop,
    close: async () => {
      await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('an existing setup export imports through explicit local roles, without native execution, secrets or overwritten preferences', async () => {
  const f = await fixture();
  try {
    const exported = (await f.call('GET', '/api/blueprint')).json();
    const parsed = await f.call('POST', '/api/blueprints/parse', { definition: exported });
    assert.equal(parsed.statusCode, 200, parsed.body);
    assert.equal((await f.call('GET', '/api/blueprints/schema')).json().type, 'object');
    const before = JSON.stringify(f.local.settings());
    const inspected = await f.call('POST', '/api/blueprints/inspect', {
      definition: f.definition,
      bindings: f.bindings,
    });
    assert.equal(inspected.statusCode, 200, inspected.body);
    const plan = inspected.json();
    assert.equal(f.local.all('work').length, 0);
    assert.equal(f.profiles.list().length, 1);
    assert.equal(plan.settings, null);
    assert(!JSON.stringify(plan).includes('excluded-blueprint-fact'));
    const [applied, repeated] = await Promise.all([
      f.call('POST', '/api/blueprints/apply', { planId: plan.id, digest: plan.digest }),
      f.call('POST', '/api/blueprints/apply', { planId: plan.id, digest: plan.digest }),
    ]);
    assert.equal(applied.statusCode, 200, applied.body);
    const receipt = applied.json();
    assert.equal(repeated.json().id, receipt.id);
    assert.equal(f.local.all('work').length, 1);
    assert.equal(f.local.all('runs').length, 0);
    assert.equal(f.local.all('companion_grants').length, 0);
    assert.equal(f.controller.activeCount, 0);
    assert.equal(JSON.stringify(f.local.settings()), before);
    const work = f.local.work(receipt.work['first-work']);
    assert.equal(work.status, 'ready');
    assert.equal(work.accountId, f.account.id);
    assert.equal(work.nativeSessionId, null);
    assert.equal(work.generation, 0);
    const context = await f.profiles.review(work);
    assert(context.memories[0].content.includes('selected-blueprint-fact'));
    assert(!context.memories[0].content.includes('excluded-blueprint-fact'));
    assert.equal(f.profiles.profile(receipt.profiles.developer).memorySourceIds[0], f.source.id);
    assert.equal((await f.blueprints.apply(plan.id, plan.digest)).id, receipt.id);
    assert.equal(f.profiles.list().length, 2);
    // Reopening the importer retains the activation outcome; it never needs to replay the plan.
    const reopened = new Blueprints(f.local, f.profiles, () => false);
    assert.equal((await reopened.apply(plan.id, plan.digest)).id, receipt.id);
    assert.equal(
      await readFile(f.memoryFile, 'utf8'),
      '# Shared\nselected-blueprint-fact\n# Private\nexcluded-blueprint-fact\n',
    );
  } finally {
    await f.close();
  }
});

test('a persisted import and rollback tombstone survive SQLite reopen with the same canonical IDs and no replay', async () => {
  const f = await fixture(true);
  let reopened: Store | undefined;
  try {
    const plan = await f.blueprints.inspect({ definition: f.definition, bindings: f.bindings });
    const receipt = await f.blueprints.apply(plan.id, plan.digest);
    await f.stop();
    reopened = new Store(join(f.root, 'workspace.sqlite'));
    const profiles = new Profiles(reopened);
    const imports = new Blueprints(reopened, profiles, () => false);
    assert.deepEqual(await imports.apply(plan.id, plan.digest), receipt);
    assert.equal(reopened.all('work').length, 1);
    assert.equal(profiles.profile(receipt.profiles.developer).id, receipt.profiles.developer);
    assert.equal(reopened.all('runs').length, 0);
    const rolled = imports.rollback(receipt.id);
    reopened.close();
    reopened = new Store(join(f.root, 'workspace.sqlite'));
    const again = new Blueprints(reopened, new Profiles(reopened), () => false);
    assert.equal((await again.apply(plan.id, plan.digest)).rolledBackAt, rolled.rolledBackAt);
    assert.equal(reopened.all('work').length, 0);
    assert.equal(reopened.all('memory_sources').length, 1);
  } finally {
    reopened?.close();
    await f.close();
  }
});

test('stale memory, changed native identity and redirected project directories invalidate a preview before activation', async () => {
  const f = await fixture();
  try {
    const memoryPlan = await f.blueprints.inspect({
      definition: f.definition,
      bindings: f.bindings,
    });
    await writeFile(f.memoryFile, '# Shared\nchanged-selected-fact\n');
    await assert.rejects(
      f.blueprints.apply(memoryPlan.id, memoryPlan.digest),
      /changed after preview/,
    );
    assert.equal(f.local.all('work').length, 0);
    const nativePlan = await f.blueprints.inspect({
      definition: f.definition,
      bindings: f.bindings,
    });
    f.local.put('accounts', f.account.id, { ...f.account, identityKey: 'changed-native-identity' });
    await assert.rejects(
      f.blueprints.apply(nativePlan.id, nativePlan.digest),
      /changed after preview/,
    );
    const target = join(f.root, 'other');
    await mkdir(target);
    const link = join(f.root, 'project-link');
    await symlink(f.project, link);
    const linked = { ...f.bindings, projects: { project: link } };
    const directoryPlan = await f.blueprints.inspect({
      definition: f.definition,
      bindings: linked,
    });
    await unlink(link);
    await symlink(target, link);
    await assert.rejects(
      f.blueprints.apply(directoryPlan.id, directoryPlan.digest),
      /changed after preview/,
    );
    assert.equal(f.local.all('work').length, 0);
    assert.equal(f.profiles.list().length, 1);
  } finally {
    await f.close();
  }
});

test('activation commits profile/work/receipt atomically and an unused import rolls back while preserving native sources', async () => {
  const f = await fixture();
  try {
    const plan = await f.blueprints.inspect({
      definition: f.definition,
      bindings: { ...f.bindings, applySettings: true },
    });
    f.local.db.exec(
      "CREATE TEMP TRIGGER fail_import BEFORE INSERT ON records WHEN NEW.collection='work' BEGIN SELECT RAISE(ABORT,'synthetic import fault'); END;",
    );
    await assert.rejects(f.blueprints.apply(plan.id, plan.digest), /synthetic import fault/);
    assert.equal(f.profiles.list().length, 1);
    assert.equal(f.local.all('work').length, 0);
    assert.equal(f.blueprints.list().length, 0);
    f.local.db.exec('DROP TRIGGER fail_import');
    const receipt = await f.blueprints.apply(plan.id, plan.digest);
    assert.equal(f.local.settings().memoryPressurePolicy, 'observe');
    assert.equal(f.local.all('work').length, 1);
    const rolled = f.blueprints.rollback(receipt.id);
    assert(rolled.rolledBackAt);
    assert.equal(f.blueprints.rollback(receipt.id).rolledBackAt, rolled.rolledBackAt);
    assert.equal(f.local.all('work').length, 0);
    assert.equal(f.profiles.list().length, 1);
    assert.equal(f.local.all('memory_sources').length, 1);
    assert.equal(f.local.all('accounts').length, 1);
    assert.equal(f.local.settings().memoryPressurePolicy, undefined);
    assert.equal(
      (await f.blueprints.apply(plan.id, plan.digest)).rolledBackAt,
      rolled.rolledBackAt,
    );
  } finally {
    await f.close();
  }
});

test('edited work, profile references, active grants and changed preferences prevent destructive rollback', async () => {
  for (const reason of ['work', 'profile', 'reference', 'grant', 'settings']) {
    const f = await fixture();
    try {
      const plan = await f.blueprints.inspect({
        definition: f.definition,
        bindings: { ...f.bindings, applySettings: true },
      });
      const receipt = await f.blueprints.apply(plan.id, plan.digest);
      const workId = receipt.work['first-work'],
        profileId = receipt.profiles.developer;
      if (reason === 'work') f.local.updateWork(workId, { context: 'Keep this user edit.' });
      if (reason === 'profile') {
        const p = f.profiles.profile(profileId);
        f.profiles.update(p.id, p.revision, { ...p, instructions: 'Keep this changed profile.' });
      }
      if (reason === 'reference') {
        const w = f.local.work(workId);
        f.local.put('work', 'another-work', { ...w, id: 'another-work' });
      }
      if (reason === 'grant')
        await f.companions.create({
          label: 'Native companion',
          profileId,
          root: f.project,
          scopes: ['work:read'],
        });
      if (reason === 'settings')
        f.local.put('settings', 'workspace', { ...f.local.settings(), quietMode: true });
      assert.throws(() => f.blueprints.rollback(receipt.id));
      assert(f.local.get<Work>('work', workId));
      assert(f.local.get<AgentProfile>('profiles', profileId));
      assert.equal(f.blueprints.list()[0].rolledBackAt, null);
    } finally {
      await f.close();
    }
  }
});

test('blueprint schemas reject authority, unknown roles and incompatible bindings while safely handling ordinary object-property role names', async () => {
  const f = await fixture();
  try {
    for (const extra of [
      { token: 'not-a-real-secret' },
      { commands: ['do not execute'] },
      { grants: [] },
      { version: 99 },
    ])
      assert.throws(() => f.blueprints.parse({ ...f.definition, ...extra }));
    assert.throws(
      () =>
        f.blueprints.parse({
          ...f.definition,
          profiles: [...f.definition.profiles, ...f.definition.profiles],
        }),
      /unique/,
    );
    await assert.rejects(
      f.blueprints.inspect({
        definition: f.definition,
        bindings: { ...f.bindings, accounts: { unknown: f.account.id } },
      }),
      /unknown blueprint roles/,
    );
    await assert.rejects(
      f.blueprints.inspect({
        definition: {
          ...f.definition,
          accounts: [{ ...f.definition.accounts[0], billingMode: 'api' }],
        },
        bindings: f.bindings,
      }),
      /billing mode/,
    );
    const definition = {
      ...f.definition,
      profiles: [
        { ...f.definition.profiles[0], role: 'constructor', name: undefined, memoryOwners: [] },
      ],
      workTemplates: [],
    };
    const plan = await f.blueprints.inspect({ definition, bindings: {} });
    assert.equal(plan.profiles[0].name, 'Imported constructor');
    const receipt = await f.blueprints.apply(plan.id, plan.digest);
    assert.equal(
      f.profiles.profile(Object.values(receipt.profiles)[0]).name,
      'Imported constructor',
    );
    const longRole = 'p'.repeat(80);
    const longDefinition = {
      ...f.definition,
      profiles: [{ ...f.definition.profiles[0], role: longRole }],
      workTemplates: f.definition.workTemplates!.map((work) => ({
        ...work,
        profileRole: longRole,
      })),
    };
    const longPlan = await f.blueprints.inspect({
      definition: longDefinition,
      bindings: { ...f.bindings, memories: { [`${longRole}:memory:1`]: f.source.id } },
    });
    const longReceipt = await f.blueprints.apply(longPlan.id, longPlan.digest);
    assert.equal(
      f.profiles.profile(longReceipt.profiles[longRole]).memorySourceIds[0],
      f.source.id,
    );
    const missing = await f.call(
      'POST',
      '/api/blueprints/apply',
      { planId: plan.id, digest: plan.digest },
      { 'x-forge-csrf': '' },
    );
    assert.equal(missing.statusCode, 403);
    const demo = await f.call(
      'POST',
      '/api/blueprints/inspect',
      { definition: f.definition, bindings: f.bindings },
      { 'x-forge-workspace': 'demo' },
    );
    assert.equal(demo.statusCode, 409);
    assert.equal(f.local.all('runs').length, 0);
  } finally {
    await f.close();
  }
});

test('import keeps project-scoped memory private, clips only the project label and preserves selected context when unselected native content changes', async () => {
  const f = await fixture();
  try {
    const other = join(f.root, 'other-project');
    await mkdir(other);
    const selected = await inspectMemory(f.memoryFile, ['Shared']);
    const source = await f.profiles.addSource(
      {
        label: 'Other project fact',
        owner: 'markdown',
        path: f.memoryFile,
        section: ['Shared'],
        scope: { kind: 'project', root: other },
      },
      selected.sha256,
      selected.selectionSha256,
    );
    const directory = join(f.root, 'p'.repeat(150));
    await mkdir(directory);
    const definition = {
      ...f.definition,
      profiles: [
        {
          ...f.definition.profiles[0],
          memoryOwners: [{ owner: 'markdown' as const, scope: 'project' as const }],
        },
      ],
    };
    const plan = await f.blueprints.inspect({
      definition,
      bindings: {
        ...f.bindings,
        memories: { 'developer:memory:1': source.id },
        projects: { project: directory },
      },
    });
    assert(plan.warnings.some((warning) => warning.includes("another project's scope")));
    await writeFile(
      f.memoryFile,
      '# Shared\nselected-blueprint-fact\n# Private\nchanged-unselected-private-fact\n',
    );
    const receipt = await f.blueprints.apply(plan.id, plan.digest);
    const work = f.local.work(receipt.work['first-work']);
    assert.equal(work.cwd, directory);
    assert.equal(work.project.length, 80);
    const review = await f.profiles.review(work);
    assert.equal(review.memories.length, 0);
    assert.equal(review.skipped.length, 1);
    assert(!JSON.stringify(review).includes('changed-unselected-private-fact'));
  } finally {
    await f.close();
  }
});

test('an active native owner blocks preview or activation without reserving or replaying a native run', async () => {
  const f = await fixture();
  try {
    let busy = false;
    const imports = new Blueprints(f.local, f.profiles, () => busy);
    const plan = await imports.inspect({ definition: f.definition, bindings: f.bindings });
    busy = true;
    await assert.rejects(
      imports.inspect({ definition: f.definition, bindings: f.bindings }),
      /Wait for native/,
    );
    await assert.rejects(imports.apply(plan.id, plan.digest), /Wait for native/);
    assert.equal(f.local.all('work').length, 0);
    assert.equal(f.profiles.list().length, 1);
    busy = false;
    await imports.apply(plan.id, plan.digest);
    assert.equal(f.local.all('runs').length, 0);
  } finally {
    await f.close();
  }
});
