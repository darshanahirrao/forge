import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectMemory, Profiles, scopeApplies } from '../server/memory.js';
import { Store } from '../server/store.js';
import { ExecutionController } from '../server/execution.js';
import { Continuity } from '../server/continuity.js';
import { createApp } from '../server/app.js';
import type { DriverContext, NativeDriver } from '../server/adapters/driver.js';
import type { Account, MemorySource, NativeSource, Work } from '../shared/types.js';

async function savedSource(
  profiles: Profiles,
  path: string,
  section: string[],
  scope: MemorySource['scope'] = { kind: 'global' },
  label = 'Native memory',
) {
  const inspection = await inspectMemory(path, section);
  return profiles.addSource(
    { label, owner: 'hermes', path, section, scope },
    inspection.sha256,
    inspection.selectionSha256,
  );
}
async function waitForIdle(controller: ExecutionController) {
  for (let index = 0; index < 100 && controller.activeCount; index++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.activeCount, 0);
}
function work(store: Store, cwd: string, profileId: string): Work {
  const account: Account = {
    id: 'account',
    label: 'Fixture',
    harness: 'codex',
    nativeHome: '',
    billingMode: 'native',
    state: 'configured',
    identity: null,
    identityKey: null,
    plan: null,
    checkedAt: null,
    error: null,
    quotas: [],
    createdAt: new Date().toISOString(),
  };
  store.put('accounts', account.id, account);
  const record: Work = {
    id: 'work',
    profileId,
    title: 'Memory fixture',
    project: 'A',
    cwd,
    goal: 'Preserve scoped native memory.',
    acceptance: '',
    context: '',
    harness: 'codex',
    accountId: account.id,
    status: 'ready',
    priority: 'normal',
    generation: 0,
    revision: 0,
    nativeSessionId: null,
    activeRunId: null,
    createdAt: account.createdAt,
    updatedAt: account.createdAt,
  };
  return store.put('work', record.id, record);
}

test('native Markdown sections respect hierarchy and code fences, preserve bytes and reject ambiguous, linked and oversized sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-memory-file-'));
  const path = join(directory, 'MEMORY.md');
  const text =
    '# Agent\r\n## Public\r\nSelected fact.\r\n```md\r\n## Fake heading\r\n```\r\n### Detail\r\nSelected detail.\r\n## Private\r\nExcluded fact.\r\n';
  try {
    await writeFile(path, text);
    const inspection = await inspectMemory(path, ['Agent', 'Public']);
    assert.match(inspection.content!, /Selected fact/);
    assert.match(inspection.content!, /Selected detail/);
    assert.match(inspection.content!, /Fake heading/);
    assert.doesNotMatch(inspection.content!, /Excluded fact/);
    assert.equal(inspection.sections.length, 4);
    assert.equal(await readFile(path, 'utf8'), text);
    await assert.rejects(inspectMemory(path, ['Missing']), /missing or ambiguous/);
    await symlink(path, join(directory, 'linked.md'));
    await assert.rejects(inspectMemory(join(directory, 'linked.md')), /symbolic link/);
    await writeFile(path, '## Same\nFirst\n## Same\nSecond');
    await assert.rejects(inspectMemory(path, ['Same']), /ambiguous/);
    await writeFile(path, 'x'.repeat(33000));
    const large = await inspectMemory(path);
    assert.equal(large.tooLarge, true);
    assert.equal(large.content, null);
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await assert.rejects(inspectMemory(path), /UTF-8/);
    await writeFile(path, 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(inspectMemory(path), /1 MiB/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('memory scope uses directory boundaries and never reads an out-of-scope source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-memory-scope-'));
  const store = new Store(':memory:');
  const profiles = new Profiles(store);
  try {
    const a = join(directory, 'a');
    const b = join(directory, 'ab');
    await mkdir(a);
    await mkdir(b);
    const path = join(directory, 'B.md');
    await writeFile(path, 'Private tenant B fact.');
    const source = await savedSource(profiles, path, [], { kind: 'project', root: b }, 'Tenant B');
    const profile = profiles.profile();
    profiles.update(profile.id, profile.revision, { ...profile, memorySourceIds: [source.id] });
    const record = work(store, a, profile.id);
    await rm(path);
    const review = await profiles.review(record);
    assert.equal(review.memories.length, 0);
    assert.equal(review.receipt.sources.length, 0);
    assert.equal(review.skipped.length, 1);
    assert.equal(scopeApplies({ kind: 'project', root: b }, record), false);
    assert.equal(
      scopeApplies({ kind: 'project', root: a }, { ...record, cwd: join(a, 'child') }),
      true,
    );
    assert.equal(scopeApplies({ kind: 'work', workId: 'other' }, record), false);
    assert.equal(JSON.stringify(review.receipt).includes('Tenant B'), false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('profile and memory references persist across companion replacement with one stable identity and no file copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-memory-profile-'));
  const database = join(directory, 'workspace.sqlite');
  let store = new Store(database);
  try {
    let profiles = new Profiles(store);
    const path = join(directory, 'MEMORY.md');
    await writeFile(path, '# Native\nA durable fact.');
    const source = await savedSource(profiles, path, []);
    for (const kind of ['hermes', 'openclaw'] as const)
      store.put<NativeSource>('native_sources', kind, {
        id: kind,
        kind,
        label: kind,
        home: '',
        endpoint: 'http://127.0.0.1:18888',
        state: 'configured',
        checkedAt: null,
        error: null,
        capabilities: [],
      });
    let profile = profiles.profile();
    profile = profiles.update(profile.id, profile.revision, {
      ...profile,
      memorySourceIds: [source.id],
      companionSourceId: 'hermes',
    });
    const record = work(store, directory, profile.id);
    const before = await profiles.review(record);
    profile = profiles.update(profile.id, profile.revision, {
      ...profile,
      companionSourceId: 'openclaw',
    });
    const after = await profiles.review(store.work(record.id));
    assert.equal(before.receipt.profileId, after.receipt.profileId);
    assert.equal(before.receipt.contentDigest, after.receipt.contentDigest);
    assert.notEqual(before.receipt.reviewDigest, after.receipt.reviewDigest);
    assert.deepEqual(before.memories, after.memories);
    assert.throws(() => profiles.removeSource(source.id), /Unpin/);
    store.close();
    store = new Store(database);
    profiles = new Profiles(store);
    assert.equal(profiles.defaultId, profile.id);
    assert.equal(profiles.profile().companionSourceId, 'openclaw');
    assert.equal(profiles.sources().length, 1);
    assert.equal(await readFile(path, 'utf8'), '# Native\nA durable fact.');
    const raw = String(
      store.db.prepare("SELECT data FROM records WHERE collection='memory_sources'").get()?.data,
    );
    assert.equal(raw.includes('A durable fact'), false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed memory invalidates launch review, starts a fresh native context and excludes earlier facts from handoff excerpts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-memory-launch-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const store = new Store(':memory:');
  const contexts: DriverContext[] = [];
  let profiles: Profiles;
  const controller = new ExecutionController(
    store,
    () => {
      const driver: NativeDriver = {
        harness: 'codex',
        closed: false,
        start: async (context, sink) => {
          contexts.push(context);
          sink.session(`session-${contexts.length}`, `native-route-${contexts.length}`);
          sink.turn(`turn-${contexts.length}`);
          sink.activity(
            'assistant',
            'Fixture result',
            contexts.length === 1 ? 'The previous fact was BLUE.' : 'The current fact is GREEN.',
          );
          sink.ended('completed', 'Fixture complete', 'No native model or tool was called.');
        },
        interrupt: async () => {},
        close: async () => {},
      };
      return driver;
    },
    (record, expected) => profiles.prepare(record, expected),
  );
  profiles = new Profiles(store, () => controller.activeCount > 0);
  try {
    const path = join(directory, 'MEMORY.md');
    await writeFile(path, '# Public\nFact: BLUE\n# Private\nTENANT-SECRET');
    const source = await savedSource(profiles, path, ['Public'], {
      kind: 'project',
      root: project,
    });
    let profile = profiles.profile();
    profile = profiles.update(profile.id, profile.revision, {
      ...profile,
      memorySourceIds: [source.id],
    });
    let record = work(store, project, profile.id);
    const first = await profiles.review(record);
    await controller.launch(record.id, false, false, record.revision, first.receipt.reviewDigest);
    await waitForIdle(controller);
    assert.match(contexts[0].prompt, /BLUE/);
    assert.doesNotMatch(contexts[0].prompt, /TENANT-SECRET/);
    record = store.work(record.id);
    const stale = await profiles.review(record);
    await writeFile(path, '# Public\nFact: BLUE\n# Private\nAn unrelated private edit');
    const unrelated = await profiles.review(record);
    assert.equal(unrelated.receipt.reviewDigest, stale.receipt.reviewDigest);
    assert.notEqual(unrelated.receipt.sources[0].sha256, stale.receipt.sources[0].sha256);
    await writeFile(path, '# Public\nFact: GREEN\n# Private\nTENANT-SECRET');
    await assert.rejects(
      controller.launch(record.id, false, false, record.revision, stale.receipt.reviewDigest),
      /Review the current/,
    );
    assert.equal(contexts.length, 1);
    assert.equal(controller.activeCount, 0);
    const corrected = await profiles.review(record);
    await controller.launch(
      record.id,
      false,
      false,
      record.revision,
      corrected.receipt.reviewDigest,
    );
    await waitForIdle(controller);
    assert.equal(contexts[1].work.nativeSessionId, null);
    assert.equal(contexts[1].work.nativeSessionKey, null);
    assert.match(contexts[1].prompt, /GREEN/);
    assert.doesNotMatch(contexts[1].prompt, /BLUE|TENANT-SECRET/);
    await writeFile(join(project, 'artifact.txt'), 'Verified artifact');
    const continuity = new Continuity(store, controller);
    const capture = await continuity.capture(record.id, store.work(record.id).revision, [
      'artifact.txt',
    ]);
    assert.deepEqual(
      capture.capsule.results.map((result) => result.excerpt),
      ['The current fact is GREEN.'],
    );
    profile = profiles.update(profile.id, profile.revision, { ...profile, memorySourceIds: [] });
    record = store.work(record.id);
    await controller.launch(record.id, false, false, record.revision);
    await waitForIdle(controller);
    assert.equal(contexts[2].work.nativeSessionId, null);
    assert.equal(contexts[2].work.nativeSessionKey, null);
    assert.doesNotMatch(contexts[2].prompt, /BLUE|GREEN|TENANT-SECRET/);
    profiles.removeSource(source.id);
    assert.equal(profiles.sources().length, 0);
  } finally {
    await controller.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('memory preparation reserves admission before yielding and shutdown cannot start a late worker', async () => {
  const store = new Store(':memory:');
  let release: () => void = () => {};
  let profiles: Profiles;
  let created = false;
  const controller = new ExecutionController(
    store,
    () => {
      created = true;
      throw new Error('No late worker may start.');
    },
    async (record) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return profiles.review(record);
    },
  );
  profiles = new Profiles(store, () => controller.activeCount > 0);
  try {
    const record = work(store, process.cwd(), profiles.defaultId);
    const pending = controller.launch(record.id, false, false, record.revision);
    assert.equal(controller.activeCount, 1);
    await assert.rejects(controller.launch(record.id, false, false, record.revision), /occupied/);
    const profile = profiles.profile();
    assert.throws(
      () =>
        profiles.update(profile.id, profile.revision, {
          ...profile,
          name: 'Changed during preparation',
        }),
      /preparation/,
    );
    const closing = controller.close();
    const rejected = assert.rejects(pending, /Preparation ended/);
    release();
    await rejected;
    await closing;
    assert.equal(created, false);
    assert.equal(controller.activeCount, 0);
    assert.equal(store.all('runs').length, 0);
  } finally {
    release();
    await controller.close();
    store.close();
  }
});

test('memory APIs enforce preview hashes, demo isolation, profile revisions and sanitized blueprint export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-memory-api-'));
  const path = join(directory, 'MEMORY.md');
  await writeFile(
    path,
    '# Selected\nPrivate selected fixture text.\n# Other\nExcluded fixture text.',
  );
  const state = await createApp({ filename: ':memory:', csrf: 'memory-api', test: true });
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body: object = {},
    mode = 'local',
  ) =>
    state.app.inject({
      method,
      url: '/api' + url,
      headers: {
        host: '127.0.0.1:4710',
        'x-forge-csrf': 'memory-api',
        'x-forge-workspace': mode,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      payload: method === 'GET' ? undefined : body,
    });
  try {
    assert.equal((await call('POST', '/memory/inspect', { path }, 'demo')).statusCode, 409);
    const inspected = (
      await call('POST', '/memory/inspect', { path, section: ['Selected'] })
    ).json();
    const input = {
      path,
      section: ['Selected'],
      label: 'Private memory label',
      owner: 'obsidian',
      scope: { kind: 'project', root: directory },
      expectedSha256: inspected.sha256,
      expectedSelectionSha256: inspected.selectionSha256,
    };
    assert.equal(
      (await call('POST', '/memory/sources', { ...input, expectedSha256: '0'.repeat(64) }))
        .statusCode,
      409,
    );
    const source = (await call('POST', '/memory/sources', input)).json<MemorySource>();
    assert.ok(source.id);
    const profile = (
      await call('POST', '/profiles', {
        name: 'Private profile label',
        instructions: 'Private profile instructions',
        memorySourceIds: [source.id],
      })
    ).json();
    assert.equal((await call('DELETE', `/memory/sources/${source.id}`)).statusCode, 409);
    assert.equal(
      (
        await call('PATCH', `/profiles/${profile.id}`, {
          ...profile,
          expectedRevision: profile.revision + 1,
        })
      ).statusCode,
      400,
    );
    const stale = await call('PATCH', `/profiles/${profile.id}`, {
      name: 'Changed profile',
      expectedRevision: profile.revision + 1,
    });
    assert.equal(stale.statusCode, 409);
    const blueprint = (await call('GET', '/blueprint')).body;
    for (const fragment of [
      directory,
      'Private selected fixture text',
      'Private profile label',
      'Private profile instructions',
      'Private memory label',
    ])
      assert.equal(blueprint.includes(fragment), false);
    assert.equal(
      JSON.stringify(state.local.all('memory_sources')).includes('Private selected fixture text'),
      false,
    );
    assert.equal(
      await readFile(path, 'utf8'),
      '# Selected\nPrivate selected fixture text.\n# Other\nExcluded fixture text.',
    );
  } finally {
    await state.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
