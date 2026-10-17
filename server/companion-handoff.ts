import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import type { ApprovalActor, MemorySource, WorkSummary } from '../shared/types.js';
import type {
  CompanionBoundary,
  CompanionHandoff,
  CompanionHandoffPlan,
} from '../shared/companion-handoff.js';
import { Companions, type StoredGrant } from './companions.js';
import { Profiles, inspectMemory } from './memory.js';
import { ExecutionController } from './execution.js';
import { Store, id, now } from './store.js';
import { assert } from './errors.js';
import { accountBinding } from './adapters/binding.js';

export const handoffPrepareSchema = z
  .object({ grantId: z.string().uuid(), label: z.string().trim().min(1).max(80) })
  .strict();
export const handoffDecisionSchema = z
  .object({ digest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative() })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contains = (root: string, path: string) => {
  const child = relative(root, path);
  return (
    isAbsolute(path) &&
    (!child || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep)))
  );
};
const grantBinding = (grant: StoredGrant) =>
  hash({
    id: grant.id,
    lineageId: grant.lineageId,
    root: grant.root,
    profileId: grant.profileId,
    scopes: grant.scopes,
    accountIds: grant.accountIds,
    dispatch: grant.dispatch,
    expiresAt: grant.expiresAt,
    bindings: grant.bindings,
  });

/** A native companion changes access at a durable boundary; its model loop and scheduler stay native. */
export class CompanionHandoffs {
  private plans = new Map<string, CompanionHandoffPlan & { binding: string }>();
  private busy = false;
  get isBusy() {
    return this.busy;
  }
  constructor(
    private store: Store,
    private companions: Companions,
    private profiles: Profiles,
    private execution: ExecutionController,
    private admit: () => void = () => {},
  ) {
    companions.handoffForGrant = (grantId) => this.forGrant(grantId);
    companions.acknowledgeHandoff = (grantId, handoffId, digest) =>
      this.ready(grantId, handoffId, digest);
    companions.writeFence = () => this.busy;
  }
  list(): CompanionHandoff[] {
    return this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='companion_handoffs' ORDER BY CASE WHEN json_extract(data,'$.state') IN ('staged','ready') THEN 0 ELSE 1 END, rowid DESC LIMIT 50",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as CompanionHandoff);
  }
  private grant(grantId: string) {
    const grant = this.store.get<StoredGrant>('companion_grants', grantId);
    assert(grant, 404, 'This companion access was not found.');
    return grant;
  }
  private receipt(handoffId: string) {
    const receipt = this.store.get<CompanionHandoff>('companion_handoffs', handoffId);
    assert(receipt, 404, 'This companion handoff was not found.');
    return receipt;
  }
  private async checkpoint<T>(action: () => Promise<T>) {
    this.admit();
    assert(!this.busy, 409, 'Another companion handoff is being reviewed.');
    this.busy = true;
    try {
      return await this.execution.atWorkspaceCheckpoint('companion-handoff', action);
    } finally {
      this.busy = false;
    }
  }
  private async boundary(grant: StoredGrant): Promise<CompanionBoundary> {
    assert(
      !grant.revokedAt && grant.expiresAt > now(),
      409,
      'This companion access expired or was revoked.',
    );
    assert(
      (await realpath(grant.root).catch(() => null)) === grant.root,
      409,
      'The project directory changed.',
    );
    const profile = this.profiles.profile(grant.profileId);
    const memory: CompanionBoundary['memory'] = [];
    for (const sourceId of profile.memorySourceIds) {
      const source = this.store.get<MemorySource>('memory_sources', sourceId);
      assert(source, 409, 'A selected memory reference is unavailable.');
      const selected = await inspectMemory(source.path, source.section);
      assert(
        selected.content !== null,
        409,
        'A selected memory excerpt exceeds its supported boundary.',
      );
      memory.push({
        id: source.id,
        label: source.label,
        binding: hash({
          revision: source.revision,
          owner: source.owner,
          path: source.path,
          section: source.section,
          scope: source.scope,
        }),
        sha256: selected.sha256,
        selectionSha256: selected.selectionSha256,
      });
    }
    assert(
      this.profiles.profile(profile.id).revision === profile.revision,
      409,
      'The profile changed during handoff review.',
    );
    const currentBindings = Object.fromEntries(
      grant.accountIds.map((accountId) => [
        accountId,
        accountBinding(this.store.account(accountId)),
      ]),
    );
    assert(
      hash(currentBindings) === hash(grant.bindings),
      409,
      'A native account binding changed. Review the existing access before replacing it.',
    );
    const digest = createHash('sha256');
    const work: CompanionBoundary['work'] = [];
    const scopedWorkIds = new Set<string>();
    let workCount = 0;
    for (const row of this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='work_summaries' AND json_extract(data,'$.profileId')=? ORDER BY id",
      )
      .iterate(profile.id)) {
      const current = JSON.parse(String(row.data)) as WorkSummary;
      if (!contains(grant.root, current.cwd)) continue;
      scopedWorkIds.add(current.id);
      assert(!current.activeRunId, 409, 'Wait for this profile’s native work to settle.');
      digest.update(
        JSON.stringify([
          current.id,
          current.revision,
          current.generation,
          current.harness,
          current.accountId,
          current.status,
        ]),
      );
      if (work.length < 50)
        work.push({ id: current.id, title: current.title, revision: current.revision });
      workCount++;
    }
    assert(
      !this.store.unconfirmedNativeRuns().some((run) => scopedWorkIds.has(run.workId)),
      409,
      'Reconcile this project’s native attempts before replacing its companion.',
    );
    const delegated = this.store.db
      .prepare(
        `SELECT json_extract(data,'$.workId') AS workId FROM records
      WHERE collection='runs' AND json_type(data,'$.settlement')='object'
      AND json_extract(data,'$.settlement.confirmed') IS NOT 1`,
      )
      .iterate();
    for (const row of delegated)
      assert(
        !scopedWorkIds.has(String(row.workId)),
        409,
        'Reconcile this project’s delegated native attempts before replacing its companion.',
      );
    const unresolved = this.store.db
      .prepare(
        `SELECT data FROM records WHERE collection='runs'
      AND (json_extract(data,'$.requestedBy.lineageId')=? OR json_extract(data,'$.requestedBy.grantId')=?)`,
      )
      .iterate(grant.lineageId ?? grant.id, grant.lineageId ?? grant.id);
    for (const row of unresolved) {
      const run = JSON.parse(String(row.data));
      assert(
        run.endedAt && (run.exitConfirmed || run.settlement?.confirmed),
        409,
        'Reconcile the previous companion’s native attempts before replacing it.',
      );
    }
    return {
      profile: { id: profile.id, revision: profile.revision, name: profile.name },
      root: grant.root,
      workCount,
      workDigest: digest.digest('hex'),
      work,
      memory,
      accountBindings: currentBindings,
    };
  }
  async prepare(value: unknown) {
    const input = handoffPrepareSchema.parse(value);
    return this.checkpoint(async () => {
      const grant = this.grant(input.grantId);
      assert(
        !grant.lifecycle || grant.lifecycle === 'active',
        409,
        'Resolve the existing companion handoff first.',
      );
      for (const [key, plan] of this.plans) if (plan.expiresAt <= now()) this.plans.delete(key);
      assert(
        this.plans.size < 32,
        409,
        'Too many pending companion reviews. Finish or let earlier reviews expire.',
      );
      const boundary = await this.boundary(grant);
      const plan = {
        id: id(),
        label: input.label,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        from: this.companions.public(grant),
        boundary,
        binding: grantBinding(grant),
      };
      const digest = hash({ id: plan.id, label: plan.label, boundary, binding: plan.binding });
      this.plans.set(plan.id, { ...plan, digest });
      const { binding: _binding, ...publicPlan } = { ...plan, digest };
      return publicPlan;
    });
  }
  async stage(planId: string, digest: string, actor: ApprovalActor) {
    return this.checkpoint(async () => {
      const previous = this.store.get<CompanionHandoff>('companion_handoffs', planId);
      if (previous) {
        assert(previous.digest === digest, 409, 'This handoff ID was used with different intent.');
        return {
          handoff: previous,
          grant: this.companions.public(this.grant(previous.toGrantId)),
          token: null,
        };
      }
      const plan = this.plans.get(planId);
      assert(
        plan && plan.digest === digest && plan.expiresAt > now(),
        409,
        'This companion review expired or changed.',
      );
      const grant = this.grant(plan.from.id);
      assert(
        (!grant.lifecycle || grant.lifecycle === 'active') && grantBinding(grant) === plan.binding,
        409,
        'The existing companion access changed after review.',
      );
      assert(
        hash(await this.boundary(grant)) === hash(plan.boundary),
        409,
        'Context changed after review. Prepare the handoff again.',
      );
      return this.store.transaction(() => {
        const issued = this.companions.stageReplacement(grant.id, plan.label, plan.id);
        const handoff: CompanionHandoff = {
          id: plan.id,
          digest,
          revision: 0,
          state: 'staged',
          fromGrantId: grant.id,
          toGrantId: issued.grant.id,
          label: plan.label,
          boundary: plan.boundary,
          actor,
          createdAt: now(),
          updatedAt: now(),
        };
        this.store.put('companion_handoffs', handoff.id, handoff);
        this.plans.delete(planId);
        return { ...issued, handoff };
      });
    });
  }
  private forGrant(grantId: string) {
    const row = this.store.db
      .prepare(
        `SELECT data FROM records WHERE collection='companion_handoffs'
      AND (json_extract(data,'$.fromGrantId')=? OR json_extract(data,'$.toGrantId')=?) ORDER BY rowid DESC LIMIT 1`,
      )
      .get(grantId, grantId);
    if (!row) return undefined;
    const receipt = JSON.parse(String(row.data)) as CompanionHandoff;
    // No other memory-source names, hashes, account bindings or project scopes
    // enter MCP. Native clients read permitted text through forge_context.
    return {
      id: receipt.id,
      digest: receipt.digest,
      revision: receipt.revision,
      state: receipt.state,
      role: receipt.toGrantId === grantId ? 'replacement' : 'original',
      profileId: receipt.boundary.profile.id,
      root: receipt.boundary.root,
      workCount: receipt.boundary.workCount,
      work: receipt.boundary.work,
      nativeSchedulesTransferred: false,
    };
  }
  async ready(grantId: string, handoffId: string, digest: string) {
    return this.checkpoint(async () => {
      const receipt = this.receipt(handoffId),
        target = this.grant(grantId);
      assert(
        receipt.toGrantId === grantId &&
          receipt.digest === digest &&
          !target.revokedAt &&
          target.expiresAt > now(),
        409,
        'This readiness acknowledgement does not match the replacement access.',
      );
      if (receipt.state === 'activated') return this.forGrant(grantId);
      assert(
        ['staged', 'ready'].includes(receipt.state),
        409,
        'This companion handoff is no longer staged.',
      );
      const original = this.grant(receipt.fromGrantId);
      assert(
        original.lifecycle === 'draining' && target.lifecycle === 'staged',
        409,
        'The handoff access states changed.',
      );
      assert(
        hash(await this.boundary(original)) === hash(receipt.boundary),
        409,
        'Context changed. Refresh the human handoff review before acknowledging readiness.',
      );
      if (receipt.state !== 'ready')
        this.store.put('companion_handoffs', handoffId, {
          ...receipt,
          state: 'ready',
          readyAt: now(),
          updatedAt: now(),
          revision: receipt.revision + 1,
        });
      return this.forGrant(grantId);
    });
  }
  async refresh(
    handoffId: string,
    digest: string,
    revision: number,
    actor: ApprovalActor = { kind: 'local' },
  ) {
    return this.checkpoint(async () => {
      const receipt = this.receipt(handoffId);
      assert(
        ['staged', 'ready'].includes(receipt.state) &&
          receipt.digest === digest &&
          receipt.revision === revision,
        409,
        'The handoff changed. Review its current state.',
      );
      const original = this.grant(receipt.fromGrantId),
        target = this.grant(receipt.toGrantId);
      assert(
        original.lifecycle === 'draining' && target.lifecycle === 'staged' && !target.revokedAt,
        409,
        'The handoff access states changed.',
      );
      const boundary = await this.boundary(original);
      const updated: CompanionHandoff = {
        ...receipt,
        reviewedBy: actor,
        boundary,
        digest: hash({ id: receipt.id, boundary, revision: receipt.revision + 1 }),
        state: 'staged',
        readyAt: undefined,
        revision: receipt.revision + 1,
        updatedAt: now(),
      };
      return this.store.put('companion_handoffs', handoffId, updated);
    });
  }
  async activate(
    handoffId: string,
    digest: string,
    revision: number,
    actor: ApprovalActor = { kind: 'local' },
  ) {
    return this.checkpoint(async () => {
      const receipt = this.receipt(handoffId);
      if (receipt.state === 'activated' && receipt.digest === digest) return receipt;
      assert(
        receipt.state === 'ready' && receipt.digest === digest && receipt.revision === revision,
        409,
        'The replacement must acknowledge the current context before activation.',
      );
      const original = this.grant(receipt.fromGrantId),
        target = this.grant(receipt.toGrantId);
      assert(
        original.lifecycle === 'draining' &&
          target.lifecycle === 'staged' &&
          !target.revokedAt &&
          target.expiresAt > now(),
        409,
        'The handoff access states changed.',
      );
      assert(
        hash(await this.boundary(original)) === hash(receipt.boundary),
        409,
        'Context changed after readiness. Refresh the handoff before activation.',
      );
      return this.store.transaction(() => {
        this.store.put('companion_grants', original.id, { ...original, revokedAt: now() });
        this.store.put('companion_grants', target.id, { ...target, lifecycle: 'active' });
        return this.store.put('companion_handoffs', handoffId, {
          ...receipt,
          reviewedBy: actor,
          state: 'activated',
          activatedAt: now(),
          updatedAt: now(),
          revision: receipt.revision + 1,
        });
      });
    });
  }
  async abort(
    handoffId: string,
    digest: string,
    revision: number,
    actor: ApprovalActor = { kind: 'local' },
  ) {
    return this.checkpoint(async () => {
      const receipt = this.receipt(handoffId);
      if (receipt.state === 'aborted' && receipt.digest === digest) return receipt;
      assert(
        ['staged', 'ready'].includes(receipt.state) &&
          receipt.digest === digest &&
          receipt.revision === revision,
        409,
        'The handoff changed or was already activated.',
      );
      return this.store.transaction(() => {
        const original = this.grant(receipt.fromGrantId),
          target = this.grant(receipt.toGrantId);
        this.store.put('companion_grants', target.id, {
          ...target,
          revokedAt: target.revokedAt ?? now(),
        });
        if (original.lifecycle === 'draining')
          this.store.put('companion_grants', original.id, { ...original, lifecycle: 'active' });
        return this.store.put('companion_handoffs', handoffId, {
          ...receipt,
          reviewedBy: actor,
          state: 'aborted',
          updatedAt: now(),
          revision: receipt.revision + 1,
        });
      });
    });
  }
}
