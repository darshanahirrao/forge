import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AgentProfile, MemoryScope, MemorySource, Work } from '../shared/types.js';
import type { MemoryPack, MemoryPackPlan, MemoryPackReceipt } from '../shared/memory-packs.js';
import { assert } from './errors.js';
import { Profiles, inspectMemory } from './memory.js';
import { Store, id, now } from './store.js';

const text = (max: number) => z.string().max(max);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^memory-[1-8]$/);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('project'), root: text(2000).min(1) }).strict(),
  z.object({ kind: z.literal('work'), workId: text(200).min(1) }).strict(),
]);
const packSchema = z
  .object({
    format: z.literal('forge.private-memory-pack'),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    profile: z
      .object({ id: text(200).min(1), name: text(100).min(1), instructions: text(8000) })
      .strict(),
    entries: z
      .array(
        z
          .object({
            key,
            label: text(100).min(1),
            scope: scopeSchema,
            content: text(32000),
            sha256: sha,
            provenance: z
              .object({
                sourceId: text(200).min(1),
                owner: z.enum(['hermes', 'openclaw', 'obsidian', 'markdown']),
                path: text(2000).min(1),
                section: z.array(text(500).min(1)).max(12),
                fileSha256: sha,
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const memoryPackImportSchema = z
  .object({
    profileId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    definition: packSchema,
    bindings: z.record(key, scopeSchema),
    instructions: z.enum(['keep', 'replace']).default('keep'),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentHash = (content: string) => createHash('sha256').update(content).digest('hex');
const sizeLimit = 256 * 1024;
interface Prepared {
  plan: MemoryPackPlan;
  fingerprint: string;
}

/** Versioned file exchange over the existing native Markdown reader, with no new memory engine. */
export class MemoryPacks {
  private plans = new Map<string, Prepared>();
  private working = false;
  private closing = false;
  private done: Promise<void> | null = null;
  private release: (() => void) | null = null;
  get isBusy() {
    return this.working || this.closing;
  }
  private begin() {
    assert(
      !this.isBusy,
      409,
      'Another portable memory operation is active or the workspace is closing.',
    );
    this.idle();
    this.working = true;
    this.done = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  private finish() {
    this.working = false;
    this.release?.();
    this.release = null;
    this.done = null;
  }
  async close() {
    this.closing = true;
    await this.done;
  }
  constructor(
    private store: Store,
    private profiles: Profiles,
    private directory: string | undefined,
    private otherBusy: () => boolean,
  ) {
    for (const row of this.store
      .all<MemoryPackReceipt>('memory_packs')
      .filter((row) => row.state === 'staging'))
      this.store.put('memory_packs', row.id, {
        ...row,
        state: 'failed',
        updatedAt: now(),
        detail:
          'Installation ended before its atomic profile activation. No binding was replayed; any partial private files were retained.',
      });
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='memory_packs' ORDER BY rowid DESC LIMIT 50",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as MemoryPackReceipt);
  }
  private idle() {
    assert(
      !this.otherBusy(),
      409,
      'Wait for native work and workspace setup to finish before changing portable memory.',
    );
  }
  private fingerprint(profile: AgentProfile) {
    return hash({
      profile,
      sources: profile.memorySourceIds.map((id) =>
        this.store.get<MemorySource>('memory_sources', id),
      ),
    });
  }
  private validatePack(value: unknown): MemoryPack {
    const pack = packSchema.parse(value);
    assert(
      Buffer.byteLength(JSON.stringify(pack)) <= sizeLimit,
      400,
      'Keep the private memory pack within 256 KiB.',
    );
    assert(
      new Set(pack.entries.map((e) => e.key)).size === pack.entries.length,
      400,
      'Memory pack entry keys must be unique.',
    );
    for (const entry of pack.entries) {
      assert(
        entry.content === entry.content.replace(/\r\n?/g, '\n') &&
          Buffer.from(entry.content, 'utf8').toString('utf8') === entry.content,
        400,
        'Memory pack content must be canonical UTF-8 Markdown with LF line endings.',
      );
      assert(
        contentHash(entry.content) === entry.sha256,
        409,
        'A selected memory content digest does not match its pack.',
      );
    }
    return pack;
  }
  parse(value: unknown) {
    return this.validatePack(value);
  }
  private async sourcePack(profile: AgentProfile, createdAt = now()): Promise<MemoryPack> {
    assert(
      profile.memorySourceIds.length > 0,
      409,
      'Pin selected native memory before preparing a portable copy.',
    );
    const entries: MemoryPack['entries'] = [];
    for (const sourceId of profile.memorySourceIds) {
      const source = this.store.get<MemorySource>('memory_sources', sourceId);
      assert(source, 409, 'A required memory reference is missing. Review this profile first.');
      const inspection = await inspectMemory(source.path, source.section);
      assert(
        inspection.content !== null,
        409,
        'Select a smaller memory section before preparing a portable copy.',
      );
      entries.push({
        key: `memory-${entries.length + 1}`,
        label: source.label,
        scope: source.scope,
        content: inspection.content,
        sha256: inspection.selectionSha256,
        provenance: {
          sourceId,
          owner: source.owner,
          path: inspection.path,
          section: source.section,
          fileSha256: inspection.sha256,
        },
      });
    }
    return this.validatePack({
      format: 'forge.private-memory-pack',
      version: 1,
      createdAt,
      profile: { id: profile.id, name: profile.name, instructions: profile.instructions },
      entries,
    });
  }
  private async scope(
    scope: MemoryScope,
    expected: MemoryScope['kind'],
    profileId: string,
  ): Promise<MemoryScope> {
    assert(
      scope.kind === expected,
      409,
      'A portable memory binding cannot widen or change its original scope kind.',
    );
    if (scope.kind === 'global') return { kind: 'global' };
    if (scope.kind === 'work') {
      assert(
        this.store.get<Work>('work', scope.workId)?.profileId === profileId,
        409,
        'Bind work-scoped memory to an existing work record using this profile.',
      );
      return { ...scope };
    }
    assert(
      isAbsolute(scope.root) && !/[\x00-\x1f]/.test(scope.root),
      400,
      'Select an absolute local project directory for memory scope.',
    );
    const root = await realpath(scope.root);
    assert(
      (await lstat(root)).isDirectory(),
      400,
      'The project binding must be a local directory.',
    );
    return { kind: 'project', root };
  }
  private async root() {
    assert(this.directory, 409, 'Portable memory files require a persistent workspace.');
    const root = await realpath(this.directory),
      info = await lstat(root);
    assert(
      info.isDirectory() &&
        (process.platform === 'win32' ||
          (info.uid === process.getuid?.() && (info.mode & 0o077) === 0)),
      409,
      'Use a private user-owned workspace for portable memory.',
    );
    return join(root, 'memory-packs');
  }
  private async plan(
    profile: AgentProfile,
    pack: MemoryPack,
    mode: MemoryPackPlan['mode'],
    bindings: Record<string, MemoryScope>,
    instructions: MemoryPackPlan['instructions'],
  ) {
    const fingerprint = this.fingerprint(profile);
    assert(
      Object.keys(bindings).length === pack.entries.length,
      400,
      'Bind every memory pack entry explicitly.',
    );
    const planId = id(),
      directory = join(await this.root(), planId);
    const selected: MemoryPackPlan['bindings'] = [];
    for (const entry of pack.entries) {
      assert(Object.hasOwn(bindings, entry.key), 400, 'A memory pack scope binding is missing.');
      selected.push({
        key: entry.key,
        scope: await this.scope(bindings[entry.key], entry.scope.kind, profile.id),
        path: join(directory, `${entry.key}.md`),
      });
    }
    this.idle();
    assert(
      fingerprint === this.fingerprint(this.profiles.profile(profile.id)),
      409,
      'The target profile changed during preparation. Review it again.',
    );
    const unsigned = {
      id: planId,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      mode,
      profileId: profile.id,
      profileName: profile.name,
      profileRevision: profile.revision,
      instructions,
      currentInstructions: profile.instructions,
      pack,
      directory,
      bindings: selected,
    };
    const plan = { ...unsigned, digest: hash(unsigned) };
    for (const [key, saved] of this.plans)
      if (Date.parse(saved.plan.expiresAt) < Date.now()) this.plans.delete(key);
    while (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(planId, { plan: structuredClone(plan), fingerprint });
    return plan;
  }
  async prepareCopy(profileId: string, expectedRevision: number): Promise<MemoryPackPlan> {
    this.begin();
    try {
      const profile = this.profiles.profile(profileId),
        fingerprint = this.fingerprint(profile);
      assert(
        profile.revision === expectedRevision,
        409,
        'The profile changed. Reload before copying its memory.',
      );
      const pack = await this.sourcePack(profile);
      assert(
        fingerprint === this.fingerprint(this.profiles.profile(profileId)),
        409,
        'The profile changed while its selected memory was read.',
      );
      return await this.plan(
        profile,
        pack,
        'native-copy',
        Object.fromEntries(pack.entries.map((e) => [e.key, e.scope])),
        'keep',
      );
    } finally {
      this.finish();
    }
  }
  async prepareImport(value: unknown): Promise<MemoryPackPlan> {
    this.begin();
    try {
      const input = memoryPackImportSchema.parse(value),
        pack = this.validatePack(input.definition),
        profile = this.profiles.profile(input.profileId);
      assert(
        profile.revision === input.expectedRevision,
        409,
        'The profile changed. Reload before importing memory.',
      );
      return await this.plan(profile, pack, 'import', input.bindings, input.instructions);
    } finally {
      this.finish();
    }
  }
  private async fresh(planId: string, digest: string) {
    const saved = this.plans.get(planId);
    assert(
      saved && saved.plan.digest === digest && Date.parse(saved.plan.expiresAt) > Date.now(),
      409,
      'Prepare a fresh portable memory review.',
    );
    const { plan } = saved,
      profile = this.profiles.profile(plan.profileId);
    assert(
      this.fingerprint(profile) === saved.fingerprint,
      409,
      'The profile or pinned references changed after memory review.',
    );
    if (plan.mode === 'native-copy')
      assert(
        hash(await this.sourcePack(profile, plan.pack.createdAt)) === hash(plan.pack),
        409,
        'Selected native memory changed after review. Prepare another copy.',
      );
    for (const binding of plan.bindings)
      assert(
        hash(await this.scope(binding.scope, binding.scope.kind, profile.id)) ===
          hash(binding.scope),
        409,
        'A local memory scope changed after review.',
      );
    assert(
      plan.directory === join(await this.root(), plan.id),
      409,
      'The private memory destination changed after review.',
    );
    this.idle();
    assert(
      this.fingerprint(this.profiles.profile(profile.id)) === saved.fingerprint,
      409,
      'The profile changed during final memory verification.',
    );
    return saved;
  }
  async export(planId: string, digest: string) {
    this.begin();
    try {
      return structuredClone((await this.fresh(planId, digest)).plan.pack);
    } finally {
      this.finish();
    }
  }
  async apply(planId: string, digest: string): Promise<MemoryPackReceipt> {
    const existing = this.store.get<MemoryPackReceipt>('memory_packs', planId);
    if (existing) {
      assert(existing.digest === digest, 409, 'The memory operation digest changed.');
      return existing;
    }
    this.begin();
    let row: MemoryPackReceipt | null = null;
    try {
      const { plan, fingerprint } = await this.fresh(planId, digest);
      row = {
        id: plan.id,
        digest,
        state: 'staging',
        profileId: plan.profileId,
        packSha256: hash(plan.pack),
        directory: plan.directory,
        sourceIds: [],
        createdAt: now(),
        updatedAt: now(),
        detail: 'Writing reviewed private Markdown files before atomic profile activation.',
      };
      this.store.put('memory_packs', row.id, row);
      const root = await this.root();
      await mkdir(root, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(root);
      assert(
        info.isDirectory() &&
          !info.isSymbolicLink() &&
          (process.platform === 'win32' ||
            (info.uid === process.getuid?.() && (info.mode & 0o077) === 0)),
        409,
        'The portable memory root must be a private, owned directory.',
      );
      await mkdir(plan.directory, { mode: 0o700 });
      const files = [
        ...plan.pack.entries.map((e) => ({
          path: join(plan.directory, `${e.key}.md`),
          content: e.content,
        })),
        {
          path: join(plan.directory, 'manifest.json'),
          content: JSON.stringify(plan.pack, null, 2),
        },
      ];
      for (const file of files) {
        const handle = await open(file.path, 'wx', 0o600);
        try {
          await handle.writeFile(file.content);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const sources: MemorySource[] = [];
      for (const binding of plan.bindings) {
        const entry = plan.pack.entries.find((e) => e.key === binding.key)!,
          inspected = await inspectMemory(binding.path);
        assert(
          inspected.selectionSha256 === entry.sha256,
          409,
          'A portable Markdown file changed before activation.',
        );
        sources.push({
          id: id(),
          revision: 0,
          label: entry.label,
          owner: 'markdown',
          path: inspected.path,
          section: [],
          scope: binding.scope,
          sha256: inspected.sha256,
          selectionSha256: inspected.selectionSha256,
          observedAt: now(),
        });
      }
      this.idle();
      await this.fresh(planId, digest);
      const profile = this.profiles.profile(plan.profileId);
      assert(
        this.fingerprint(profile) === fingerprint,
        409,
        'The profile changed before portable memory activation.',
      );
      assert(
        Date.parse(plan.expiresAt) > Date.now(),
        409,
        'The portable memory review expired before activation.',
      );
      const applied: MemoryPackReceipt = {
        ...row,
        state: 'applied',
        sourceIds: sources.map((s) => s.id),
        updatedAt: now(),
        detail:
          'Reviewed Markdown references activated on the same profile. Original native files and unpinned references remain unchanged.',
      };
      this.profiles.update(
        profile.id,
        profile.revision,
        {
          name: profile.name,
          instructions:
            plan.instructions === 'replace' ? plan.pack.profile.instructions : profile.instructions,
          companionSourceId: profile.companionSourceId,
          memorySourceIds: sources.map((s) => s.id),
        },
        {
          sources,
          committed: () => {
            this.store.put('memory_packs', applied.id, applied);
          },
        },
      );
      return applied;
    } catch (error) {
      if (row)
        this.store.put('memory_packs', row.id, {
          ...row,
          state: 'failed',
          updatedAt: now(),
          detail:
            'No profile activation committed. Any partial private copies were retained; this operation will not replay.',
        });
      throw error;
    } finally {
      this.finish();
    }
  }
}
