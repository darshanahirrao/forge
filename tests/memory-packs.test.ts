import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { Profiles, inspectMemory } from '../server/memory.js';
import { MemoryPacks } from '../server/memory-packs.js';
import { unknownPressure } from '../server/memory-pressure.js';
import type { MemoryPackPlan, MemoryPackReceipt } from '../shared/memory-packs.js';
import type { MemoryScope, Work } from '../shared/types.js';

const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': 'owned-memory-pack-csrf' };
async function fixture(t: test.TestContext, scope: MemoryScope = { kind: 'global' }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-memory-pack-')));
  const native = join(root, 'Owned native home');
  await mkdir(native);
  const filename = join(native, 'MEMORY.md');
  await writeFile(
    filename,
    '# Selected\nPortable shared marker.\n# Excluded\nUNSELECTED-PRIVATE-MARKER\n',
  );
  const state = await createApp({
    filename: join(root, 'state', 'workspace.sqlite'),
    csrf: headers['x-forge-csrf'],
    test: true,
    memoryPressureReader: unknownPressure,
    phoneBridge: { origin: 'https://memory.fixture.ts.net', proof: 'owned-memory-proof' },
  });
  t.after(async () => {
    await state.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const profiles = new Profiles(state.local),
    inspection = await inspectMemory(filename, ['Selected']);
  const source = await profiles.addSource(
    {
      label: 'Owned selected memory',
      owner: 'hermes',
      path: filename,
      section: ['Selected'],
      scope,
    },
    inspection.sha256,
    inspection.selectionSha256,
  );
  const old = profiles.profile();
  const profile = profiles.update(old.id, old.revision, {
    ...old,
    instructions: 'Keep profile identity.',
    memorySourceIds: [source.id],
  });
  const send = (path: string, payload: unknown, extra: Record<string, string> = {}) =>
    state.app.inject({
      method: 'POST',
      url: `/api/memory/packs/${path}`,
      headers: { ...headers, 'content-type': 'application/json', ...extra },
      payload: JSON.stringify(payload),
    });
  const prepare = async () => {
    const p = profiles.profile();
    const r = await send('copy', { profileId: p.id, expectedRevision: p.revision });
    assert.equal(r.statusCode, 200, r.body);
    return r.json<MemoryPackPlan>();
  };
  return { ...state, root, native, filename, profiles, source, profile, send, prepare };
}
const review = (plan: MemoryPackPlan) => ({ planId: plan.id, digest: plan.digest, reviewed: true });

test('portable memory preparation/export includes only selected native text and writes no files or bindings', async (t) => {
  const f = await fixture(t),
    original = await readFile(f.filename, 'utf8');
  const plan = await f.prepare();
  assert.equal(plan.profileId, f.profile.id);
  assert.equal(plan.pack.entries[0].sha256, f.source.selectionSha256);
  assert(plan.pack.entries[0].content.includes('Portable shared marker'));
  assert(!JSON.stringify(plan).includes('UNSELECTED-PRIVATE-MARKER'));
  await assert.rejects(stat(plan.directory));
  assert.equal(f.profiles.profile().revision, f.profile.revision);
  const exported = await f.send('export', review(plan));
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json().format, 'forge.private-memory-pack');
  assert.match(String(exported.headers['content-disposition']), /private-memory-pack/);
  assert.equal(await readFile(f.filename, 'utf8'), original);
  assert.equal(f.memoryPacks.list().length, 0);
});

test('reviewed private Markdown copies retain the same profile, survive removal of the original home and do not replay', async (t) => {
  const f = await fixture(t);
  const workResponse = await f.app.inject({
    method: 'POST',
    url: '/api/work',
    headers,
    payload: {
      title: 'Owned portable work',
      project: 'fixture',
      cwd: f.root,
      goal: 'Use selected portable memory.',
      acceptance: '',
      context: '',
      harness: 'codex',
      accountId: null,
      priority: 'normal',
      profileId: f.profile.id,
    },
  });
  assert.equal(workResponse.statusCode, 201, workResponse.body);
  const work = workResponse.json<Work>();
  const before = await f.profiles.review(work),
    plan = await f.prepare();
  const result = await f.send('apply', review(plan));
  assert.equal(result.statusCode, 200, result.body);
  const receipt = result.json<MemoryPackReceipt>();
  assert.equal(receipt.state, 'applied');
  assert.equal(f.profiles.profile().id, f.profile.id);
  assert.equal(f.profiles.profile().instructions, f.profile.instructions);
  assert.equal(f.profiles.profile().revision, f.profile.revision + 1);
  assert.notEqual(f.profiles.profile().memorySourceIds[0], f.source.id);
  const destination = f.profiles.sources().find((s) => s.id === receipt.sourceIds[0])!;
  assert.equal(destination.owner, 'markdown');
  assert.deepEqual(destination.scope, f.source.scope);
  assert.equal((await stat(destination.path)).mode & 0o777, 0o600);
  assert.equal((await stat(receipt.directory)).mode & 0o777, 0o700);
  await rename(f.native, join(f.root, 'Removed original native home'));
  const current = f.local.work(work.id),
    prepared = await f.profiles.review(current);
  assert.equal(prepared.memories[0].content, before.memories[0].content);
  assert.notEqual(prepared.receipt.reviewDigest, before.receipt.reviewDigest);
  assert.equal(current.profileId, work.profileId);
  assert(current.revision > work.revision);
  const count = f.profiles.sources().length;
  assert.equal((await f.send('apply', review(plan))).json<MemoryPackReceipt>().id, receipt.id);
  assert.equal(f.profiles.sources().length, count);
  await assert.rejects(f.profiles.prepare(current, before.receipt.reviewDigest));
});

test('changed native text, profile revisions, expired review and missing consent cannot activate a portable copy', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  assert.equal((await f.send('apply', { ...review(plan), reviewed: false })).statusCode, 400);
  await writeFile(f.filename, '# Selected\nCorrected selected fact.\n');
  assert.equal((await f.send('apply', review(plan))).statusCode, 409);
  assert.equal(f.profiles.profile().revision, f.profile.revision);
  await assert.rejects(stat(plan.directory));
  const staleProfile = await f.prepare();
  f.profiles.update(f.profile.id, f.profile.revision, {
    ...f.profile,
    instructions: 'Changed after review.',
  });
  assert.equal((await f.send('apply', review(staleProfile))).statusCode, 409);
  const fresh = await f.prepare();
  t.mock.method(Date, 'now', () => Date.parse(fresh.expiresAt) + 1);
  assert.equal((await f.send('apply', review(fresh))).statusCode, 409);
  assert.equal(f.memoryPacks.list().length, 0);
});

test('memory pack import validates integrity and cannot widen project scope or trust embedded authority', async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'forge-pack-project-')));
  t.after(() => rm(project, { recursive: true, force: true }));
  const f = await fixture(t, { kind: 'project', root: project });
  const plan = await f.prepare(),
    pack = structuredClone(plan.pack);
  const base = {
    profileId: f.profile.id,
    expectedRevision: f.profile.revision,
    definition: pack,
    bindings: { 'memory-1': { kind: 'project', root: project } },
    instructions: 'keep',
  };
  assert.equal(
    (await f.send('import', { ...base, definition: { ...pack, accountGrant: 'never-authority' } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await f.send('import', { ...base, bindings: { 'memory-1': { kind: 'global' } } })).statusCode,
    409,
  );
  pack.entries[0].content = 'Altered without updating the digest';
  assert.equal((await f.send('import', base)).statusCode, 409);
  pack.entries[0].sha256 = createHash('sha256').update(pack.entries[0].content).digest('hex');
  const imported = await f.send('import', base);
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json<MemoryPackPlan>().profileId, f.profile.id);
  assert.equal((await f.send('apply', review(imported.json()))).statusCode, 200);
  assert.equal(f.profiles.profile().instructions, f.profile.instructions);
  assert.deepEqual(
    f.profiles.sources().find((s) => s.id === f.profiles.profile().memorySourceIds[0])?.scope,
    { kind: 'project', root: project },
  );
  pack.profile.instructions = 'Explicit imported profile instructions.';
  const replacement = await f.send('import', {
    ...base,
    expectedRevision: f.profiles.profile().revision,
    instructions: 'replace',
  });
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal((await f.send('apply', review(replacement.json()))).statusCode, 200);
  assert.equal(f.profiles.profile().instructions, pack.profile.instructions);
});

test('work-scoped imports require an explicit existing work/profile binding and cannot widen scope', async (t) => {
  const f = await fixture(t),
    exported = await f.prepare();
  exported.pack.entries[0].scope = { kind: 'work', workId: 'unavailable-source-work' };
  const input = {
    profileId: f.profile.id,
    expectedRevision: f.profile.revision,
    definition: exported.pack,
    bindings: { 'memory-1': { kind: 'work', workId: 'unavailable-source-work' } },
  };
  assert.equal((await f.send('import', input)).statusCode, 409);
  const workResponse = await f.app.inject({
    method: 'POST',
    url: '/api/work',
    headers,
    payload: {
      title: 'Owned work scope',
      project: 'fixture',
      cwd: f.root,
      goal: 'Retain scope.',
      acceptance: '',
      context: '',
      harness: 'codex',
      accountId: null,
      priority: 'normal',
      profileId: f.profile.id,
    },
  });
  assert.equal(workResponse.statusCode, 201, workResponse.body);
  const work = workResponse.json<Work>();
  input.bindings['memory-1'].workId = work.id;
  const imported = await f.send('import', input);
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal((await f.send('apply', review(imported.json()))).statusCode, 200);
  assert.equal((await f.profiles.review(f.local.work(work.id))).memories.length, 1);
});

test('failed atomic profile activation rolls back new references and records failure without retry', async (t) => {
  const f = await fixture(t);
  const nativeSource = {
    id: 'owned-companion-source',
    kind: 'hermes',
    label: 'Owned companion',
    home: '',
    endpoint: 'http://127.0.0.1:8642',
    state: 'configured',
    checkedAt: null,
    error: null,
    capabilities: [],
  };
  f.local.put('native_sources', nativeSource.id, nativeSource);
  f.profiles.update(f.profile.id, f.profile.revision, {
    ...f.profile,
    companionSourceId: nativeSource.id,
  });
  const plan = await f.prepare(),
    profile = f.profiles.profile(),
    count = f.profiles.sources().length;
  f.local.remove('native_sources', nativeSource.id);
  const applied = await f.send('apply', review(plan));
  assert.equal(applied.statusCode, 400, applied.body);
  assert.equal(f.profiles.sources().length, count);
  assert.deepEqual(f.profiles.profile(), profile);
  const receipt = f.memoryPacks.list()[0];
  assert.equal(receipt.state, 'failed');
  assert((await stat(join(receipt.directory, 'manifest.json'))).isFile());
  assert.equal((await f.send('apply', review(plan))).json<MemoryPackReceipt>().state, 'failed');
  assert.equal(f.profiles.sources().length, count);
});

test('interrupted staging recovery preserves profile bindings and never adopts partial private files', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare();
  const row: MemoryPackReceipt = {
    id: plan.id,
    digest: plan.digest,
    packSha256: '0'.repeat(64),
    state: 'staging',
    profileId: f.profile.id,
    directory: plan.directory,
    sourceIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    detail: 'Owned simulated interrupted stage.',
  };
  f.local.put('memory_packs', row.id, row);
  const recovered = new MemoryPacks(f.local, f.profiles, join(f.root, 'state'), () => false);
  assert.equal(recovered.list()[0].state, 'failed');
  assert.deepEqual(f.profiles.profile().memorySourceIds, [f.source.id]);
  assert.equal((await recovered.apply(row.id, row.digest)).state, 'failed');
  await assert.rejects(stat(row.directory));
});

test('portable memory setup excludes demo, MCP credentials and paired phone authority', async (t) => {
  const f = await fixture(t),
    input = { profileId: f.profile.id, expectedRevision: f.profile.revision };
  const rejectedHeaders: Record<string, string>[] = [
    { 'x-forge-workspace': 'demo' },
    { authorization: 'Bearer no-human-authority' },
    {
      origin: 'https://memory.fixture.ts.net',
      'x-forge-bridge-proof': 'owned-memory-proof',
      'x-forge-bridge-identity': 'alice@example.com',
    },
  ];
  for (const extra of rejectedHeaders)
    assert.equal((await f.send('copy', input, extra)).statusCode, 403);
  assert.equal(f.memoryPacks.list().length, 0);
  const stored = f.local.all<Work>('work');
  assert.equal(stored.length, 0);
});

test('a symlinked private memory root cannot redirect installation outside the workspace', async (t) => {
  const f = await fixture(t),
    plan = await f.prepare(),
    foreign = join(f.root, 'Foreign destination');
  await mkdir(foreign, { mode: 0o700 });
  await symlink(foreign, join(f.root, 'state', 'memory-packs'));
  const result = await f.send('apply', review(plan));
  assert.equal(result.statusCode, 409, result.body);
  assert.deepEqual(await readdir(foreign), []);
  assert.deepEqual(f.profiles.profile().memorySourceIds, [f.source.id]);
  assert.equal(f.memoryPacks.list()[0].state, 'failed');
});
