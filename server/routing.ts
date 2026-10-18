import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { Account, Work } from '../shared/types.js';
import type { AccountRoute, RouteCandidate, RouteReview } from '../shared/routing.js';
import { canExecuteAccount } from '../shared/harnesses.js';
import { accountBinding } from './adapters/binding.js';
import { assert } from './errors.js';
import { Store, id, now } from './store.js';
import type { ExecutionController } from './execution.js';
import type { Continuity } from './continuity.js';

const identifier = z.string().min(1).max(200);
export const routeSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    expectedPolicyRevision: z.number().int().nonnegative(),
    accountIds: z.array(identifier).min(1).max(16),
    allowMetered: z.boolean(),
    allowUnreportedQuota: z.boolean(),
    maxEvidenceAgeSeconds: z.number().int().min(30).max(900).default(300),
  })
  .strict();
export const routePrepareSchema = z
  .object({
    planId: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    reconciled: z.boolean().default(false),
    paths: z.array(z.string().min(1).max(2000)).min(1).max(2000).optional(),
  })
  .strict();
interface StoredRoute extends AccountRoute {
  bindings: Record<string, string>;
}
interface Plan {
  workId: string;
  revision: number;
  evidence: string;
  choice: string;
  digest: string;
  expiresAt: string;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh = (timestamp: string | null | undefined, age: number) => {
  const elapsed = Date.now() - Date.parse(timestamp ?? '');
  return Number.isFinite(elapsed) && elapsed >= -5000 && elapsed <= age * 1000;
};
const metered = (account: Account) =>
  Boolean(account.backend) || account.billingMode !== 'subscription';

/** An ordered admission policy over native accounts, never an inference proxy or retry loop. */
export class AccountRouting {
  private plans = new Map<string, Plan>();
  constructor(
    private store: Store,
    private execution: ExecutionController,
    private continuity: Continuity,
  ) {}
  policy(workId: string): AccountRoute | null {
    const saved = this.store.get<StoredRoute>('account_routes', workId);
    if (!saved) return null;
    const { bindings: _private, ...policy } = saved;
    return policy;
  }
  async configure(workId: string, value: unknown) {
    const input = routeSchema.parse(value),
      work = this.store.work(workId);
    assert(
      !work.activeRunId && !this.execution.hasLiveExecution,
      409,
      'Wait for native execution and checkpoint preparation before changing account routing.',
    );
    assert(
      work.cwd && (await realpath(work.cwd).catch(() => null)) === work.cwd,
      409,
      'Choose an existing canonical project directory before authorizing account routing.',
    );
    return this.store.transaction(() => {
      const current = this.store.work(workId),
        previous = this.policy(workId);
      assert(
        current.revision === input.expectedRevision &&
          !current.activeRunId &&
          !this.execution.hasLiveExecution,
        409,
        'This work changed while checking the routing scope. Review it again.',
      );
      assert(
        (previous?.revision ?? 0) === input.expectedPolicyRevision,
        409,
        'Account routing changed. Reload the current policy.',
      );
      assert(
        new Set(input.accountIds).size === input.accountIds.length,
        400,
        'Choose distinct native account slots in preference order.',
      );
      const accounts = input.accountIds.map((accountId) => this.store.account(accountId));
      assert(
        accounts.every(canExecuteAccount),
        409,
        'Every routed account needs a supported native execution binding.',
      );
      const row: StoredRoute = {
        version: 1,
        workId,
        revision: (previous?.revision ?? 0) + 1,
        cwd: current.cwd,
        profileId: current.profileId ?? null,
        accountIds: input.accountIds,
        allowMetered: input.allowMetered,
        allowUnreportedQuota: input.allowUnreportedQuota,
        maxEvidenceAgeSeconds: input.maxEvidenceAgeSeconds,
        updatedAt: now(),
        bindings: Object.fromEntries(
          accounts.map((account) => [account.id, accountBinding(account)]),
        ),
      };
      this.store.put('account_routes', workId, row);
      const updated = this.store.updateWork(workId, {});
      this.store.event(
        workId,
        'routing',
        'Account routing authorized',
        `${accounts.length} native slots approved in order for this exact project and profile. Metered usage ${input.allowMetered ? 'allowed' : 'excluded'}; unreported quota ${input.allowUnreportedQuota ? 'explicitly allowed' : 'excluded'}. No attempt started.`,
      );
      return { policy: this.policy(workId)!, work: updated };
    });
  }
  remove(workId: string, revision: number) {
    const work = this.store.work(workId);
    assert(
      work.revision === revision && !work.activeRunId && !this.execution.hasLiveExecution,
      409,
      'Wait for native execution, then review the current work before removing its route.',
    );
    return this.store.transaction(() => {
      this.store.remove('account_routes', workId);
      const updated = this.store.updateWork(workId, {});
      this.store.event(
        workId,
        'routing',
        'Account routing removed',
        'Future attempts use the explicitly selected native binding.',
      );
      return updated;
    });
  }
  private decision(work: Work, observed?: Account) {
    const policy = this.store.get<StoredRoute>('account_routes', work.id);
    if (!policy)
      return {
        policy: null,
        candidates: [] as RouteCandidate[],
        choice: null as string | null,
        evidence: '',
      };
    const accounts = this.store
      .all<Account>('accounts')
      .map((account) => (account.id === observed?.id ? observed : account));
    const windows = new Map<string, { used: number; at: string }>();
    for (const account of accounts)
      for (const quota of account.quotas) {
        if (
          quota.source !== 'native' ||
          !fresh(quota.observedAt, policy.maxEvidenceAgeSeconds) ||
          !Number.isFinite(quota.usedPercent)
        )
          continue;
        const key = hash([account.harness, quota.scope]),
          old = windows.get(key);
        if (
          !old ||
          Date.parse(quota.observedAt) > Date.parse(old.at) ||
          (Date.parse(quota.observedAt) === Date.parse(old.at) && quota.usedPercent > old.used)
        )
          windows.set(key, { used: quota.usedPercent, at: quota.observedAt });
      }
    const candidates = policy.accountIds.map((accountId): RouteCandidate => {
      const account = accounts.find((value) => value.id === accountId),
        reasons: string[] = [];
      if (!account)
        return {
          accountId,
          label: 'Missing native account',
          harness: 'unknown',
          eligible: false,
          reasons: ['The saved account no longer exists.'],
          quotaCoverage: 'unreported',
          sharedIdentity: false,
        };
      if (policy.cwd !== work.cwd || policy.profileId !== (work.profileId ?? null))
        reasons.push('Project or profile changed. Authorize this routing scope again.');
      if (accountBinding(account) !== policy.bindings[account.id])
        reasons.push(
          'Native identity, model, credential reference or home changed. Authorize this binding again.',
        );
      if (!canExecuteAccount(account) || account.state === 'unavailable' || account.error)
        reasons.push('This native execution binding is unavailable.');
      if (account.openClawProjectRoot && account.openClawProjectRoot !== work.cwd)
        reasons.push('This OpenClaw account is scoped to a different reviewed project.');
      if (!policy.allowMetered && metered(account))
        reasons.push('Metered or unverifiable billing is excluded by this route.');
      const identityPeers = accounts.filter(
        (other) =>
          other.id === account.id ||
          Boolean(
            account.identityKey &&
            other.harness === account.harness &&
            other.identityKey === account.identityKey,
          ),
      );
      const latestAllowance = identityPeers
        .filter(
          (other) =>
            typeof other.ordinaryUsageAllowed === 'boolean' &&
            fresh(other.checkedAt, policy.maxEvidenceAgeSeconds),
        )
        .sort(
          (a, b) =>
            Date.parse(b.checkedAt!) - Date.parse(a.checkedAt!) ||
            Number(a.ordinaryUsageAllowed) - Number(b.ordinaryUsageAllowed),
        )[0];
      if ((latestAllowance?.ordinaryUsageAllowed ?? account.ordinaryUsageAllowed) === false)
        reasons.push(
          'Native included usage is unavailable. Refresh native evidence; reset time alone cannot restore access.',
        );
      if (account.checkedAt && !fresh(account.checkedAt, policy.maxEvidenceAgeSeconds))
        reasons.push('Native account evidence is stale. Refresh it before routing.');
      const native = account.quotas.filter((window) => window.source === 'native');
      if (native.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0))
        reasons.push('Native quota counters are invalid. Refresh the account.');
      const ownFresh = native.filter((window) =>
        fresh(window.observedAt, policy.maxEvidenceAgeSeconds),
      );
      const coverage =
        native.length === 0 ? 'unreported' : ownFresh.length === native.length ? 'fresh' : 'stale';
      if (
        !policy.allowUnreportedQuota &&
        (coverage !== 'fresh' ||
          !account.identityKey ||
          !account.checkedAt ||
          account.state !== 'verified')
      )
        reasons.push('Fresh quota and native identity evidence are required by this route.');
      const sharedWindows = identityPeers.flatMap((other) =>
        other.quotas.filter((window) => window.source === 'native'),
      );
      if (
        sharedWindows.some(
          (window) =>
            (windows.get(hash([account.harness, window.scope]))?.used ?? window.usedPercent) >= 100,
        )
      )
        reasons.push(
          'A reported native quota bucket is exhausted, including any shared account slot.',
        );
      const shared = Boolean(
        account.identityKey &&
        accounts.some(
          (other) =>
            other.id !== account.id &&
            other.harness === account.harness &&
            other.identityKey === account.identityKey,
        ),
      );
      return {
        accountId,
        label: account.label,
        harness: account.harness,
        eligible: reasons.length === 0,
        reasons,
        quotaCoverage: coverage,
        sharedIdentity: shared,
      };
    });
    const choice = candidates.find((candidate) => candidate.eligible)?.accountId ?? null;
    const evidence = hash({
      policy,
      scope: { cwd: work.cwd, profileId: work.profileId },
      choice,
      candidates,
      accounts: policy.accountIds.map((key) => {
        const account = accounts.find((item) => item.id === key);
        return account
          ? {
              id: key,
              binding: accountBinding(account),
              checkedAt: account.checkedAt,
              state: account.state,
              error: account.error,
              quotas: account.quotas,
              ordinaryUsageAllowed: account.ordinaryUsageAllowed,
              providerReady: account.providerReady,
            }
          : null;
      }),
      windows: [...windows].sort(([a], [b]) => a.localeCompare(b)),
    });
    return { policy, candidates, choice, evidence };
  }
  review(workId: string): RouteReview {
    const work = this.store.work(workId),
      decision = this.decision(work);
    if (!decision.policy)
      return {
        policy: null,
        workRevision: work.revision,
        recommendedAccountId: null,
        candidates: [],
        planId: null,
        digest: null,
        expiresAt: null,
      };
    for (const [key, plan] of this.plans) if (plan.expiresAt <= now()) this.plans.delete(key);
    const planId = id(),
      expiresAt = new Date(Date.now() + 120000).toISOString();
    const digest = hash({ planId, revision: work.revision, evidence: decision.evidence });
    if (decision.choice)
      this.plans.set(planId, {
        workId,
        revision: work.revision,
        evidence: decision.evidence,
        choice: decision.choice,
        digest,
        expiresAt,
      });
    while (this.plans.size > 32) this.plans.delete(this.plans.keys().next().value!);
    return {
      policy: this.policy(workId),
      workRevision: work.revision,
      recommendedAccountId: decision.choice,
      candidates: decision.candidates,
      planId,
      digest,
      expiresAt,
    };
  }
  authorize(work: Work, account: Account, allowMetered: boolean) {
    const decision = this.decision(work, account);
    if (!decision.policy) return;
    assert(
      decision.choice === account.id,
      409,
      'Account routing changed or recommends another binding. Refresh and prepare the current recommendation before starting.',
    );
    assert(
      !metered(account) || (decision.policy.allowMetered && allowMetered),
      409,
      'This route needs its explicit metered billing authorization at launch.',
    );
  }
  async prepare(workId: string, value: unknown) {
    const input = routePrepareSchema.parse(value),
      plan = this.plans.get(input.planId);
    assert(
      plan && plan.workId === workId && plan.digest === input.digest && plan.expiresAt > now(),
      409,
      'This routing review expired. Read the current native recommendation again.',
    );
    const work = this.store.work(workId);
    assert(
      work.revision === plan.revision && !work.activeRunId,
      409,
      'This work changed after routing review. Reopen its recommendation.',
    );
    const authorize = () => {
      const decision = this.decision(this.store.work(workId));
      assert(
        plan.expiresAt > now() &&
          decision.choice === plan.choice &&
          decision.evidence === plan.evidence,
        409,
        'Native routing evidence changed. Refresh the recommendation; no replacement attempt was started.',
      );
    };
    authorize();
    if (work.accountId === plan.choice) return work;
    let updated: Work;
    if (!work.nativeSessionId && !work.capsuleId && work.generation === 0) {
      updated = await this.execution.atCheckpoint(workId, work.revision, async (current) => {
        assert(
          (await realpath(current.cwd).catch(() => null)) === current.cwd,
          409,
          'The project directory changed. Review the routing scope.',
        );
        authorize();
        assert(
          this.store.work(workId).revision === current.revision,
          409,
          'Work changed during directory verification.',
        );
        const account = this.store.account(plan.choice);
        return this.store.transaction(() => {
          const result = this.store.updateWork(workId, {
            accountId: account.id,
            harness: account.harness,
          });
          this.store.event(
            workId,
            'routing',
            'Eligible account selected',
            `${account.label} was the first eligible slot in the approved order. No native input was submitted.`,
          );
          return result;
        });
      });
    } else {
      assert(
        input.reconciled,
        409,
        'Review native activity and external effects before a routed handoff.',
      );
      const prepared = await this.continuity.capture(workId, work.revision, input.paths);
      authorize();
      updated = await this.continuity.handoff(
        workId,
        prepared.work.revision,
        prepared.capsule.id,
        plan.choice,
        true,
        authorize,
      );
    }
    this.plans.delete(input.planId);
    return updated;
  }
}
