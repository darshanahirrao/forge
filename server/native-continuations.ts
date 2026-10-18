import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { ApprovalActor, NativeInventory, Work } from '../shared/types.js';
import type { NativeContinuationReview, NativeChatOrigin } from '../shared/native-continuations.js';
import { assert } from './errors.js';
import { Store, id, now } from './store.js';
import type { NativeSources } from './native-sources.js';
import type { ExecutionController } from './execution.js';
import type { Profiles } from './memory.js';
import { accountBinding } from './adapters/binding.js';
import type { NativeChatReader } from './adapters/codex-history.js';

const input = z
  .object({
    sourceId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    accountId: z.string().min(1).max(200),
    profileId: z.string().min(1).max(200),
    title: z.string().trim().min(1).max(140),
    goal: z.string().trim().min(1).max(20000),
    workId: z.string().min(1).max(200).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
const decision = z
  .object({
    id: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    nativeActivityReviewed: z.literal(true),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Prepared {
  review: NativeContinuationReview;
  origin: NativeChatOrigin;
  profileRevision: number;
  sourceBinding: string;
  workRevision?: number;
}

/** Canonical work is created now; only a later reviewed managed launch forks native history. */
export class NativeContinuations {
  private plans = new Map<string, Prepared>();
  constructor(
    private store: Store,
    private sources: NativeSources,
    private execution: ExecutionController,
    private profiles: Profiles,
    private read: NativeChatReader,
    private admit: () => void | Promise<void> = () => {},
  ) {}
  async prepare(value: unknown, actor: ApprovalActor) {
    assert(actor.kind === 'local', 403, 'Review existing native chats on the local Forge host.');
    const body = input.parse(value);
    return this.sources.atSource(body.sourceId, (source) =>
      this.execution.atWorkspaceCheckpoint('native-chat-review', async () => {
        const existing = body.workId ? this.store.work(body.workId) : undefined;
        assert(
          !existing ||
            (existing.revision === body.expectedRevision &&
              existing.nativeOrigin?.state === 'pending' &&
              existing.nativeOrigin.sourceId === body.sourceId &&
              existing.nativeOrigin.threadId === body.sessionId &&
              existing.accountId === body.accountId &&
              !existing.nativeSessionId &&
              !existing.activeRunId),
          409,
          'Only an unbound native continuation can refresh this exact source and account. Use the normal handoff for another binding.',
        );
        assert(
          source.kind === 'codex' && source.home,
          409,
          'Native history continuation currently requires a Codex chat source.',
        );
        const observed = this.store
          .get<NativeInventory>('native_inventories', source.id)
          ?.sessions.find(
            (row) =>
              row.id === body.sessionId &&
              row.sourceId === source.id &&
              row.source === 'codex/app-server',
          );
        assert(observed, 409, 'Refresh this source and select an observed native Codex chat.');
        const account = this.store.account(body.accountId);
        assert(
          account.harness === 'codex' &&
            !account.backend &&
            !account.connector &&
            !account.nativeProvider &&
            account.nativeHome,
          409,
          'Choose an explicit native Codex account for this source.',
        );
        assert(
          (await realpath(account.nativeHome)) === (await realpath(source.home)),
          409,
          'The native account must use this chat source’s exact profile. Cross-account history transfer needs its own native compatibility review.',
        );
        const profile = this.profiles.profile(body.profileId),
          binding = accountBinding(account),
          sourceBinding = hash(source);
        await this.admit();
        const result = await this.read(account, body.sessionId);
        assert(
          result.history.threadId === body.sessionId &&
            result.account.id === account.id &&
            result.account.nativeHome === account.nativeHome &&
            result.account.harness === 'codex',
          409,
          'The native read changed its requested source or account binding.',
        );
        assert(
          (await stat(result.history.cwd)).isDirectory(),
          409,
          'The native project directory is unavailable. Restore it before continuing.',
        );
        assert(
          accountBinding(this.store.account(account.id)) === binding &&
            hash(this.store.get('native_sources', source.id)) === sourceBinding &&
            this.profiles.profile(profile.id).revision === profile.revision,
          409,
          'Account, source or profile changed during the native read. Prepare a fresh review.',
        );
        this.store.put('accounts', account.id, result.account);
        const identifier = id(),
          reviewedAt = now();
        const origin: NativeChatOrigin = {
          ...result.history,
          reviewId: identifier,
          sourceId: source.id,
          accountId: account.id,
          accountBinding: accountBinding(result.account),
          reviewedAt,
          state: 'pending',
        };
        assert(
          !existing || this.store.work(existing.id).revision === existing.revision,
          409,
          'Work changed while reading native history. Refresh this review.',
        );
        const publicReview = {
          id: identifier,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          source: result.history,
          account: {
            id: account.id,
            label: result.account.label,
            identity: result.account.identity,
            plan: result.account.plan,
            billingMode: result.account.billingMode,
          },
          profileId: profile.id,
          profileName: profile.name,
          title: body.title,
          goal: body.goal,
          ...(existing ? { workId: existing.id } : {}),
        };
        const review: NativeContinuationReview = {
          ...publicReview,
          digest: hash({ publicReview, origin, sourceBinding, profileRevision: profile.revision }),
        };
        for (const [key, plan] of this.plans)
          if (plan.review.expiresAt < now()) this.plans.delete(key);
        assert(
          this.plans.size < 16,
          409,
          'Finish or close an existing native chat review before preparing another.',
        );
        this.plans.set(identifier, {
          review,
          origin,
          profileRevision: profile.revision,
          sourceBinding,
          workRevision: existing?.revision,
        });
        return review;
      }),
    );
  }
  activate(value: unknown, actor: ApprovalActor) {
    assert(actor.kind === 'local', 403, 'Link native chat history on the local Forge host.');
    const body = decision.parse(value);
    const existing = this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='work' AND json_extract(data,'$.nativeOrigin.reviewId')=? LIMIT 1",
      )
      .get(body.id);
    if (existing) {
      const work = JSON.parse(String(existing.data)) as Work;
      assert(
        work.nativeOrigin?.reviewDigest === body.digest,
        409,
        'This native chat review changed.',
      );
      return work;
    }
    const plan = this.plans.get(body.id);
    assert(
      plan && plan.review.digest === body.digest && plan.review.expiresAt > now(),
      409,
      'This native chat review expired or changed. Read its current native history again.',
    );
    const account = this.store.account(plan.origin.accountId),
      profile = this.profiles.profile(plan.review.profileId);
    assert(
      accountBinding(account) === plan.origin.accountBinding &&
        profile.revision === plan.profileRevision &&
        hash(this.store.get('native_sources', plan.origin.sourceId)) === plan.sourceBinding,
      409,
      'The native account, source or profile changed. Prepare a fresh native review.',
    );
    const existingWork = plan.review.workId ? this.store.work(plan.review.workId) : undefined;
    assert(
      !existingWork ||
        (existingWork.revision === plan.workRevision &&
          existingWork.nativeOrigin?.state === 'pending' &&
          !existingWork.nativeSessionId &&
          !existingWork.activeRunId),
      409,
      'Work changed after its native review. Read the current history again.',
    );
    const work: Work = {
      ...(existingWork ?? {}),
      id: existingWork?.id ?? id(),
      title: plan.review.title,
      goal: plan.review.goal,
      project: basename(plan.origin.cwd),
      cwd: plan.origin.cwd,
      acceptance: existingWork?.acceptance ?? '',
      context: existingWork?.context ?? '',
      harness: 'codex',
      accountId: account.id,
      profileId: profile.id,
      priority: existingWork?.priority ?? 'normal',
      status: existingWork?.status ?? 'ready',
      revision: existingWork ? existingWork.revision + 1 : 0,
      generation: existingWork?.generation ?? 0,
      nativeSessionId: null,
      nativeSessionKey: null,
      activeRunId: null,
      nativeOrigin: { ...plan.origin, reviewDigest: body.digest },
      createdAt: existingWork?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.store.transaction(() => {
      this.store.put('work', work.id, work);
      this.store.event(
        work.id,
        'created',
        'Native chat linked for reviewed continuation',
        `${plan.origin.turns} native turns and ${plan.origin.items} items are fingerprinted. A managed launch must recheck and fork this exact history before any new input. The original chat and its external effects retain their native owner.`,
      );
    });
    this.plans.delete(body.id);
    return work;
  }
}
