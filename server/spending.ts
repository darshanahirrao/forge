import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApprovalActor, Run, Usage, Work } from '../shared/types.js';
import type {
  SpendAttempt,
  SpendReview,
  SpendingPolicy,
  SpendingSnapshot,
  WorkOutcome,
} from '../shared/spending.js';
import { assert } from './errors.js';
import { Store, now } from './store.js';

const amount = z.number().finite().min(0.000001).max(1_000_000).nullable();
export const spendingPolicySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    monthlyUsd: amount,
    workUsd: amount,
    attemptUsd: amount,
  })
  .strict();
export const spendReconciliationSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    usd: z.number().finite().min(0).max(1_000_000),
    note: z.string().trim().min(5).max(2000),
  })
  .strict();
export const outcomeSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    decision: z.enum(['accepted', 'needs-work']),
    note: z.string().trim().min(5).max(2000),
  })
  .strict();
const micros = (usd: number) => Math.ceil(usd * 1_000_000 - 0.00000001);
const dollars = (value: number) => value / 1_000_000;
const period = () => now().slice(0, 7);
interface StoredAttempt {
  runId: string;
  workId: string;
  accountId: string;
  revision: number;
  period: string;
  startedAt: string;
  endedAt: string | null;
  state: SpendAttempt['state'];
  reserve: number | null;
  known: number;
  totalTokens: number;
  scopes: number;
  unknownScopes: number;
  issues: string[];
  resumed: boolean;
  review?: SpendAttempt['review'];
}
interface Counter {
  baseUsd: number | null;
  baseTokens: number | null;
  lastUsd: number | null;
  lastTokens: number;
  known: number;
  tokens: number;
  unknown: boolean;
}
const complete = (row: StoredAttempt) => row.scopes > 0 && !row.unknownScopes && !row.issues.length;
const accounted = (row: StoredAttempt) =>
  row.review
    ? micros(row.review.usd)
    : row.state === 'reported'
      ? row.known
      : Math.max(row.reserve ?? 0, row.known);
const accountedSql = `CASE WHEN json_type(data,'$.review')='object'
  THEN ROUND(json_extract(data,'$.review.usd')*1000000)
  WHEN json_extract(data,'$.state')='reported' THEN json_extract(data,'$.known')
  ELSE MAX(COALESCE(json_extract(data,'$.reserve'),0),json_extract(data,'$.known')) END`;

/** Cross-runtime admission accounting. Native estimates are never presented as an invoice. */
export class Spending {
  constructor(private store: Store) {
    if (!store.get('config', 'spending-policy'))
      store.put<SpendingPolicy>('config', 'spending-policy', {
        version: 1,
        revision: 0,
        monthlyUsd: null,
        workUsd: null,
        attemptUsd: null,
        updatedAt: now(),
      });
  }
  policy() {
    return this.store.get<SpendingPolicy>('config', 'spending-policy')!;
  }
  configure(value: unknown) {
    const input = spendingPolicySchema.parse(value);
    const old = this.policy();
    assert(
      old.revision === input.expectedRevision,
      409,
      'Spending policy changed. Reload it before saving.',
    );
    assert(
      (input.monthlyUsd === null && input.workUsd === null) || input.attemptUsd !== null,
      400,
      'Choose an attempt reservation before enabling a monthly or work budget.',
    );
    const { expectedRevision: _revision, ...settings } = input;
    return this.store.put<SpendingPolicy>('config', 'spending-policy', {
      ...settings,
      version: 1,
      revision: old.revision + 1,
      updatedAt: now(),
    });
  }
  private totals(workId = '') {
    return this.store.db
      .prepare(
        `SELECT
      COALESCE(SUM(CASE WHEN json_extract(data,'$.period')=? THEN ${accountedSql} ELSE 0 END),0) AS month,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.workId')=? THEN ${accountedSql} ELSE 0 END),0) AS work,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.state') IN ('reserved','unknown')
        THEN MAX(COALESCE(json_extract(data,'$.reserve'),0),json_extract(data,'$.known')) ELSE 0 END),0) AS reserved,
      COALESCE(SUM(json_extract(data,'$.totalTokens')),0) AS tokens,
      COALESCE(SUM(json_extract(data,'$.state')='unknown'),0) AS unknown,
      COALESCE(SUM(json_type(data,'$.review') IS NULL AND json_extract(data,'$.known')>json_extract(data,'$.reserve')),0) AS exceeded
      FROM records WHERE collection='spend_attempts'`,
      )
      .get(period(), workId) as {
      month: number;
      work: number;
      reserved: number;
      tokens: number;
      unknown: number;
      exceeded: number;
    };
  }
  private public(row: StoredAttempt): SpendAttempt {
    return {
      runId: row.runId,
      workId: row.workId,
      accountId: row.accountId,
      revision: row.revision,
      period: row.period,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      state: row.state,
      reservedUsd: row.reserve === null ? null : dollars(row.reserve),
      estimatedUsd: complete(row) ? dollars(row.known) : null,
      accountedUsd: dollars(accounted(row)),
      totalTokens: row.totalTokens,
      issues: [
        ...row.issues,
        ...(!row.scopes ? ['No native usage report.'] : []),
        ...(row.unknownScopes ? ['Some native dollar counters or baselines are unavailable.'] : []),
      ],
      ...(row.review ? { review: row.review } : {}),
    };
  }
  attempts(workId?: string) {
    const rows = workId
      ? this.store.db
          .prepare(
            "SELECT data FROM records WHERE collection='spend_attempts' AND json_extract(data,'$.workId')=? ORDER BY rowid DESC LIMIT 100",
          )
          .all(workId)
      : this.store.db
          .prepare(
            "SELECT data FROM records WHERE collection='spend_attempts' ORDER BY rowid DESC LIMIT 100",
          )
          .all();
    return rows.map((row) => this.public(JSON.parse(String(row.data)) as StoredAttempt));
  }
  snapshot(): SpendingSnapshot {
    const totals = this.totals();
    return {
      policy: this.policy(),
      period: period(),
      accountedUsd: dollars(totals.month),
      reservedUsd: dollars(totals.reserved),
      unknownAttempts: totals.unknown,
      reportedTokens: totals.tokens,
      acceptedOutcomes: this.outcomes().filter(
        (r) => r.decision === 'accepted' && this.outcomeCurrent(r),
      ).length,
      attempts: this.attempts().slice(0, 50),
    };
  }
  review(work: Work): SpendReview {
    const policy = this.policy(),
      totals = this.totals(work.id);
    const month = totals.month,
      workTotal = totals.work;
    let reason: string | null = null;
    if (policy.attemptUsd !== null) {
      if (totals.unknown)
        reason =
          'Review unresolved native spending before another budgeted attempt. Unknown costs remain held across month boundaries.';
      else if (totals.exceeded)
        reason =
          'A native estimate exceeded its attempt reservation. Review that spending receipt before another budgeted attempt.';
      else if (
        policy.monthlyUsd !== null &&
        month + micros(policy.attemptUsd) > micros(policy.monthlyUsd)
      )
        reason = 'The next attempt reservation exceeds the remaining monthly budget.';
      else if (
        policy.workUsd !== null &&
        workTotal + micros(policy.attemptUsd) > micros(policy.workUsd)
      )
        reason = 'The next attempt reservation exceeds this work budget.';
    }
    return {
      allowed: reason === null,
      reason,
      reserveUsd: policy.attemptUsd,
      policyRevision: policy.revision,
      period: period(),
      monthAccountedUsd: dollars(month),
      workAccountedUsd: dollars(workTotal),
    };
  }
  prepare(run: Run): StoredAttempt {
    const review = this.review(this.store.work(run.workId));
    assert(review.allowed, 409, review.reason!);
    return {
      runId: run.id,
      workId: run.workId,
      accountId: run.accountId,
      revision: 0,
      period: review.period,
      startedAt: run.startedAt,
      endedAt: null,
      state: 'reserved',
      reserve: review.reserveUsd === null ? null : micros(review.reserveUsd),
      known: 0,
      totalTokens: 0,
      scopes: 0,
      unknownScopes: 0,
      issues: [],
      resumed: Boolean(run.nativeSessionId),
    };
  }
  reserve(row: StoredAttempt) {
    this.store.put('spend_attempts', row.runId, row);
  }
  observe(run: Run, usage: Usage) {
    const row = this.store.get<StoredAttempt>('spend_attempts', run.id);
    if (!row) {
      this.store.saveUsage(usage);
      return;
    }
    assert(
      Number.isSafeInteger(usage.totalTokens) &&
        usage.totalTokens >= 0 &&
        (usage.estimatedUsd === null ||
          (Number.isFinite(usage.estimatedUsd) &&
            usage.estimatedUsd >= 0 &&
            usage.estimatedUsd <= 1_000_000)),
      502,
      'Native usage returned unsupported counters. Spending remains reserved.',
    );
    const key = `${run.id}:${createHash('sha256').update(usage.key).digest('hex')}`;
    const previous = this.store.get<Usage>('usage', usage.key);
    assert(
      !previous || (previous.workId === usage.workId && previous.accountId === usage.accountId),
      502,
      'Native usage scope belongs to another binding. Original attribution was retained.',
    );
    let old = this.store.get<Counter>('spend_counters', key);
    if (!old && row.scopes >= 512) {
      if (!row.issues.includes('Native usage scope limit reached.'))
        row.issues.push('Native usage scope limit reached.');
      this.store.transaction(() => {
        this.store.saveUsage(usage);
        this.store.put('spend_attempts', run.id, { ...row, revision: row.revision + 1 });
      });
      return;
    }
    if (!old) {
      const session =
        usage.counterScope === 'session' ||
        (!usage.counterScope &&
          ['codex/app-server', 'claude/agent-sdk', 'opencode/v2'].includes(usage.source));
      const unknown = !previous && session && row.resumed;
      old = {
        baseUsd: unknown
          ? null
          : previous
            ? previous.estimatedUsd === null
              ? null
              : micros(previous.estimatedUsd)
            : 0,
        baseTokens: unknown ? null : (previous?.totalTokens ?? 0),
        lastUsd:
          previous?.estimatedUsd === null ? null : previous ? micros(previous.estimatedUsd!) : 0,
        lastTokens: previous?.totalTokens ?? 0,
        known: 0,
        tokens: 0,
        unknown: true,
      };
      row.scopes++;
      row.unknownScopes++;
    }
    const usd = usage.estimatedUsd === null ? null : micros(usage.estimatedUsd);
    if (
      (usd !== null && old.lastUsd !== null && usd < old.lastUsd) ||
      usage.totalTokens < old.lastTokens
    ) {
      if (!row.issues.includes('Native cumulative counters reset or decreased.'))
        row.issues.push('Native cumulative counters reset or decreased.');
    }
    const counter: Counter = {
      ...old,
      lastUsd: usd,
      lastTokens: usage.totalTokens,
      known: Math.max(old.known, usd === null || old.baseUsd === null ? 0 : usd - old.baseUsd),
      tokens: Math.max(
        old.tokens,
        old.baseTokens === null ? 0 : usage.totalTokens - old.baseTokens,
      ),
      unknown: usd === null || old.baseUsd === null || old.baseTokens === null,
    };
    row.known += counter.known - old.known;
    row.totalTokens += counter.tokens - old.tokens;
    row.unknownScopes += Number(counter.unknown) - Number(old.unknown);
    row.revision++;
    this.store.transaction(() => {
      this.store.saveUsage(usage);
      this.store.put('spend_counters', key, counter);
      this.store.put('spend_attempts', run.id, row);
    });
  }
  settle(run: Run) {
    const row = this.store.get<StoredAttempt>('spend_attempts', run.id);
    if (!row || row.review) return;
    this.store.put('spend_attempts', run.id, {
      ...row,
      revision: row.revision + 1,
      endedAt: run.endedAt,
      state:
        complete(row) && (run.exitConfirmed || run.settlement?.confirmed) ? 'reported' : 'unknown',
    });
  }
  recover() {
    const rows = this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='spend_attempts' AND json_extract(data,'$.state')='reserved'",
      )
      .all();
    for (const saved of rows) {
      const row = JSON.parse(String(saved.data)) as StoredAttempt;
      const run = this.store.get<Run>('runs', row.runId);
      if (run?.endedAt) this.settle(run);
    }
  }
  reconcile(runId: string, value: unknown, actor: ApprovalActor) {
    const input = spendReconciliationSchema.parse(value);
    const row = this.store.get<StoredAttempt>('spend_attempts', runId);
    const run = this.store.get<Run>('runs', runId);
    assert(row && run, 404, 'This managed spending receipt was not found.');
    assert(
      row.revision === input.expectedRevision,
      409,
      'Native spending changed. Read the latest receipt before reviewing it.',
    );
    assert(
      run.endedAt &&
        (run.exitConfirmed || run.settlement?.confirmed) &&
        !this.store.work(run.workId).activeRunId,
      409,
      'Confirm native settlement before reviewing the spending receipt.',
    );
    assert(!row.review, 409, 'This spending receipt already has a durable human review.');
    return this.store.transaction(() => {
      const updated: StoredAttempt = {
        ...row,
        revision: row.revision + 1,
        state: 'reviewed',
        review: { usd: dollars(micros(input.usd)), note: input.note, at: now(), actor },
      };
      this.store.put('spend_attempts', runId, updated);
      this.store.event(
        run.workId,
        'spending',
        'Native spending reviewed',
        `${updated.review!.usd} USD reported by the operator. ${input.note}`,
      );
      return this.public(updated);
    });
  }
  outcomes() {
    return this.store.all<WorkOutcome>('work_outcomes');
  }
  outcomeCurrent(outcome: WorkOutcome) {
    const work = this.store.get<Work>('work', outcome.workId);
    return Boolean(
      work && work.revision === outcome.workRevision && work.generation === outcome.generation,
    );
  }
  outcome(workId: string, value: unknown, actor: ApprovalActor) {
    const input = outcomeSchema.parse(value),
      work = this.store.work(workId);
    assert(
      work.revision === input.expectedRevision && !work.activeRunId,
      409,
      'Review the current settled work before recording its outcome.',
    );
    const runs = this.store.all<Run>('runs').filter((run) => run.workId === workId);
    assert(
      runs.length > 0 &&
        runs.every((run) => run.endedAt && (run.exitConfirmed || run.settlement?.confirmed)),
      409,
      'An outcome needs at least one settled managed attempt and no unresolved native owner.',
    );
    return this.store.transaction(() => {
      const updated = this.store.updateWork(workId, {});
      const outcome: WorkOutcome = {
        workId,
        workRevision: updated.revision,
        generation: work.generation,
        decision: input.decision,
        note: input.note,
        at: now(),
        actor,
      };
      this.store.put('work_outcomes', workId, outcome);
      this.store.event(
        workId,
        'outcome',
        input.decision === 'accepted' ? 'Work accepted by the operator' : 'Work needs another pass',
        input.note,
      );
      return outcome;
    });
  }
}
