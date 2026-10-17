import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type MarkdownIt from 'markdown-it';
import type {
  AgentProfile,
  CompanionGrant,
  ContextReview,
  MemoryInspection,
  MemoryScope,
  MemorySource,
  NativeSource,
  Work,
} from '../shared/types.js';
import { assert, ForgeError } from './errors.js';
import { Store, id, now } from './store.js';
import type { NativeResourceReceipt } from '../shared/resource-governance.js';

let nativeMarkdown: Promise<InstanceType<typeof MarkdownIt>> | undefined;
const markdown = () =>
  (nativeMarkdown ??= import('markdown-it').then(
    ({ default: Parser }) => new Parser('commonmark', { html: false, linkify: false }),
  ));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_SELECTION = 32000;

/** Select native Markdown using its parser's line maps. Never follow links or execute/render HTML. */
export async function inspectMemory(
  filename: string,
  section: string[] = [],
): Promise<MemoryInspection> {
  assert(
    isAbsolute(filename) && /\.md$/i.test(filename) && !/[\x00-\x1f]/.test(filename),
    400,
    'Choose an absolute path to a native Markdown (.md) file.',
  );
  try {
    const path = join(await realpath(dirname(filename)), basename(filename));
    assert(
      !(await lstat(path)).isSymbolicLink(),
      409,
      'Choose the regular memory file rather than a symbolic link.',
    );
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw: Buffer;
    try {
      const before = await file.stat({ bigint: true });
      assert(
        before.isFile() && before.size <= 1024n * 1024n,
        409,
        'Choose a regular memory file within the 1 MiB read limit.',
      );
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      assert(
        length <= 1024 * 1024 &&
          before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeNs === after.mtimeNs &&
          before.ctimeNs === after.ctimeNs,
        409,
        'The memory file changed while being read. Review it again.',
      );
      raw = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r\n?/g, '\n');
    const lines = content.split('\n');
    const tokens = (await markdown()).parse(content, {});
    const headings: { path: string[]; depth: number; start: number; end: number }[] = [];
    const ancestors: { title: string; depth: number }[] = [];
    const ranges: typeof headings = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.type !== 'heading_open' || !token.map || token.level !== 0) continue;
      const depth = Number(token.tag.slice(1));
      while (ancestors.length && ancestors.at(-1)!.depth >= depth) ancestors.pop();
      const title = tokens[index + 1]?.content ?? '';
      while (ranges.length && ranges.at(-1)!.depth >= depth) ranges.pop()!.end = token.map[0];
      ancestors.push({ title, depth });
      const heading = {
        path: ancestors.map((entry) => entry.title),
        depth,
        start: token.map[0],
        end: lines.length,
      };
      headings.push(heading);
      ranges.push(heading);
      assert(
        headings.length <= 2000,
        409,
        'This memory file has too many headings. Choose a smaller curated source.',
      );
    }
    const candidates = headings.filter(
      (heading) => JSON.stringify(heading.path) === JSON.stringify(section),
    );
    assert(
      !section.length || candidates.length === 1,
      409,
      'The selected heading is missing or ambiguous. Choose a unique heading path and review again.',
    );
    const selected = section.length
      ? lines.slice(candidates[0].start, candidates[0].end).join('\n')
      : content;
    return {
      path,
      bytes: raw.length,
      characters: selected.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
      sections: headings.map((heading) => ({
        path: heading.path,
        characters: lines.slice(heading.start, heading.end).join('\n').length,
      })),
      selectionSha256: createHash('sha256').update(selected).digest('hex'),
      content: selected.length <= MAX_SELECTION ? selected : null,
      tooLarge: selected.length > MAX_SELECTION,
    };
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      409,
      'The memory source could not be read as UTF-8 Markdown. Check its location and local access.',
    );
  }
}
export function scopeApplies(scope: MemoryScope, work: Pick<Work, 'id' | 'cwd'>) {
  if (scope.kind === 'global') return true;
  if (scope.kind === 'work') return scope.workId === work.id;
  if (!work.cwd) return false;
  const path = relative(scope.root, work.cwd);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
}
export class Profiles {
  readonly defaultId: string;
  constructor(
    private store: Store,
    private isBusy: () => boolean = () => false,
    private resourceReview: () => NativeResourceReceipt | undefined = () => undefined,
  ) {
    const configured = store.get<{ id: string }>('config', 'default-profile');
    if (configured && store.get('profiles', configured.id)) this.defaultId = configured.id;
    else {
      this.defaultId = store.transaction(() => {
        const profile = this.create({
          name: 'Personal',
          instructions: '',
          companionSourceId: null,
          memorySourceIds: [],
        });
        store.put('config', 'default-profile', { id: profile.id });
        return profile.id;
      });
    }
    for (const work of store.all<Work>('work'))
      if (!work.profileId) store.put('work', work.id, { ...work, profileId: this.defaultId });
  }
  list() {
    return this.store.all<AgentProfile>('profiles');
  }
  sources() {
    return this.store.all<MemorySource>('memory_sources');
  }
  profile(profileId?: string) {
    const profile = this.store.get<AgentProfile>('profiles', profileId ?? this.defaultId);
    assert(profile, 404, 'This profile was not found. Choose an existing profile.');
    return profile;
  }
  private validate(
    input: Pick<AgentProfile, 'name' | 'instructions' | 'companionSourceId' | 'memorySourceIds'>,
  ) {
    assert(
      new Set(input.memorySourceIds).size === input.memorySourceIds.length &&
        input.memorySourceIds.length <= 8,
      400,
      'Choose up to eight distinct memory references.',
    );
    for (const sourceId of input.memorySourceIds)
      assert(
        this.store.get('memory_sources', sourceId),
        404,
        'A selected memory reference was not found.',
      );
    if (input.companionSourceId) {
      const source = this.store.get<NativeSource>('native_sources', input.companionSourceId);
      assert(
        source && ['hermes', 'openclaw'].includes(source.kind),
        400,
        'Choose a Hermes or OpenClaw native companion reference.',
      );
    }
  }
  create(
    input: Pick<AgentProfile, 'name' | 'instructions' | 'companionSourceId' | 'memorySourceIds'>,
  ) {
    this.validate(input);
    const profile: AgentProfile = {
      ...input,
      id: id(),
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.put('profiles', profile.id, profile);
  }
  update(
    profileId: string,
    revision: number,
    input: Pick<AgentProfile, 'name' | 'instructions' | 'companionSourceId' | 'memorySourceIds'>,
    // Internal verified-source installation hooks. Never accepted from an HTTP payload.
    installation: { sources?: MemorySource[]; committed?: () => void } = {},
  ) {
    assert(
      !this.isBusy(),
      409,
      'Wait for managed preparation and native workers to finish before changing a profile.',
    );
    const previous = this.profile(profileId);
    assert(
      previous.revision === revision,
      409,
      'This profile changed. Review its latest version before saving.',
    );
    return this.store.transaction(() => {
      for (const source of installation.sources ?? []) {
        assert(
          !this.store.get('memory_sources', source.id),
          409,
          'A new memory reference identity already exists.',
        );
        this.store.put('memory_sources', source.id, source);
      }
      this.validate(input);
      const updated = this.store.put('profiles', profileId, {
        ...previous,
        ...input,
        revision: revision + 1,
        updatedAt: now(),
      });
      for (const work of this.store
        .all<Work>('work')
        .filter((work) => work.profileId === profileId)) {
        assert(!work.activeRunId, 409, 'A work record still owns a native attempt.');
        this.store.updateWork(work.id, {});
        this.store.event(
          work.id,
          'profile',
          'Profile references updated',
          'Review current memory before the next launch. Native source files were not rewritten.',
        );
      }
      installation.committed?.();
      return updated;
    });
  }
  async addSource(
    input: Pick<MemorySource, 'label' | 'owner' | 'path' | 'section' | 'scope'>,
    expectedSha256: string,
    expectedSelectionSha256: string,
  ) {
    const inspection = await inspectMemory(input.path, input.section);
    assert(
      !inspection.tooLarge,
      409,
      'Select a smaller memory section before saving this reference.',
    );
    assert(
      inspection.sha256 === expectedSha256 &&
        inspection.selectionSha256 === expectedSelectionSha256,
      409,
      'The memory file changed after preview. Inspect it again before saving.',
    );
    const source: MemorySource = {
      ...input,
      path: inspection.path,
      id: id(),
      revision: 0,
      sha256: inspection.sha256,
      selectionSha256: inspection.selectionSha256,
      observedAt: now(),
    };
    return this.store.put('memory_sources', source.id, source);
  }
  removeSource(sourceId: string) {
    assert(!this.isBusy(), 409, 'Wait for managed preparation and native workers to finish.');
    assert(this.store.get('memory_sources', sourceId), 404, 'This memory reference was not found.');
    assert(
      !this.list().some((profile) => profile.memorySourceIds.includes(sourceId)),
      409,
      'Unpin this reference from its profiles before forgetting it.',
    );
    this.store.remove('memory_sources', sourceId);
  }
  removeProfile(profileId: string) {
    assert(
      profileId !== this.defaultId,
      409,
      'Keep the default profile as the workspace fallback.',
    );
    assert(
      !this.store.all<Work>('work').some((work) => work.profileId === profileId),
      409,
      'Work history references this profile. Keep it to preserve identity.',
    );
    assert(
      !this.store
        .all<Pick<CompanionGrant, 'profileId' | 'revokedAt' | 'expiresAt'>>('companion_grants')
        .some(
          (grant) => grant.profileId === profileId && !grant.revokedAt && grant.expiresAt > now(),
        ),
      409,
      'Revoke active companion access before removing its profile.',
    );
    this.store.remove('profiles', this.profile(profileId).id);
  }
  async review(work: Work): Promise<ContextReview> {
    const profile = this.profile(work.profileId);
    const memories: ContextReview['memories'] = [];
    const skipped: ContextReview['skipped'] = [];
    const sources: ContextReview['receipt']['sources'] = [];
    for (const sourceId of profile.memorySourceIds) {
      const source = this.store.get<MemorySource>('memory_sources', sourceId);
      assert(
        source,
        409,
        'A required memory reference is unavailable. Review this profile before launching.',
      );
      if (!scopeApplies(source.scope, work)) {
        skipped.push({
          sourceId,
          label: source.label,
          reason: 'Outside this work or project scope',
        });
        continue;
      }
      const inspection = await inspectMemory(source.path, source.section);
      assert(
        inspection.content !== null,
        409,
        'A selected memory section exceeds the context limit. Choose a smaller section.',
      );
      sources.push({
        ...source,
        sha256: inspection.sha256,
        selectionSha256: inspection.selectionSha256,
      });
      memories.push({ sourceId, label: source.label, content: inspection.content });
    }
    assert(
      profile.instructions.length +
        memories.reduce((total, memory) => total + memory.content.length, 0) <=
        MAX_SELECTION,
      409,
      'This profile exceeds 32,000 characters of selected context. Pin fewer sources or smaller sections.',
    );
    assert(
      this.profile(profile.id).revision === profile.revision &&
        this.store.work(work.id).revision === work.revision,
      409,
      'Work or profile changed while its memory was read. Review the latest selection.',
    );
    const contentDigest = digest({
      profileId: profile.id,
      instructions: profile.instructions,
      sources: sources.map((source) => ({
        id: source.id,
        selectionSha256: source.selectionSha256,
      })),
    });
    const nativeResources = this.resourceReview();
    const reviewDigest = digest({
      workId: work.id,
      revision: work.revision,
      profile,
      sources: sources.map(({ sha256: _fileHash, ...selection }) => selection),
      contentDigest,
      ...(nativeResources ? { nativeResourcePolicyDigest: nativeResources.digest } : {}),
    });
    return {
      ...(nativeResources ? { nativeResources } : {}),
      receipt: {
        ...(nativeResources ? { nativeResourcePolicyDigest: nativeResources.digest } : {}),
        profileId: profile.id,
        profileRevision: profile.revision,
        profileName: profile.name,
        companionSourceId: profile.companionSourceId,
        sources,
        contentDigest,
        reviewDigest,
        preparedAt: now(),
      },
      instructions: profile.instructions,
      memories,
      skipped,
      requiresReview: Boolean(profile.instructions || memories.length || nativeResources),
    };
  }
  async prepare(work: Work, expectedDigest?: string) {
    const review = await this.review(work);
    assert(
      (!review.requiresReview && expectedDigest === undefined) ||
        review.receipt.reviewDigest === expectedDigest,
      409,
      'Review the current profile and memory selection before launching. A source or binding may have changed.',
    );
    return review;
  }
  async discover() {
    const candidates = [
      ...['MEMORY.md', 'USER.md'].map((name) => ({
        owner: 'hermes',
        path: join(process.env.HERMES_HOME ?? join(homedir(), '.hermes'), 'memories', name),
      })),
      ...['MEMORY.md', 'USER.md'].map((name) => ({
        owner: 'openclaw',
        path: join(
          process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw'),
          'workspace',
          name,
        ),
      })),
    ];
    const result = [];
    for (const candidate of candidates)
      if (
        await stat(candidate.path)
          .then((info) => info.isFile())
          .catch(() => false)
      )
        result.push(candidate);
    return result;
  }
}
