import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ApprovalActor, NativeSource } from '../shared/types.js';
import type {
  ScheduleAction,
  ScheduleReview,
  NativeControlReceipt,
  NativeControlSnapshot,
} from '../shared/native-controls.js';
import { Store, id, now } from './store.js';
import { NativeSources } from './native-sources.js';
import { assert } from './errors.js';
import { findBinary } from './adapters/discovery.js';
import { hermesPython } from './adapters/hermes-install.js';
import { hermesEnvironment } from './adapters/hermes-driver.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const observed = z
  .object({
    state: z.string().max(80),
    enabled: z.boolean(),
    nextRunAt: z.string().max(120).nullable(),
    jobsDigest: sha,
  })
  .strict();
const resultSchema = z.union([
  z
    .object({
      state: z.literal('absent'),
      contract: z.literal('hermes-builtin-native-flock/1'),
      jobsDigest: sha,
      configDigest: sha.nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal('preview'),
      contract: z.literal('hermes-builtin-native-flock/1'),
      jobsDigest: sha,
      configDigest: sha.nullable(),
      job: z
        .object({
          id: z.string().max(80),
          title: z.string().max(160),
          prompt: z.string().max(20000),
          script: z.string().max(2000).nullable(),
          rule: z.string().max(2000),
          definition: z.string().max(65536),
          noAgent: z.boolean(),
          state: z.string().max(80),
          enabled: z.boolean(),
          nextRunAt: z.string().max(120).nullable(),
        })
        .strict(),
    })
    .strict(),
  z.object({ state: z.literal('applied'), observed }).strict(),
  z
    .object({
      state: z.enum(['rejected', 'uncertain']),
      code: z.enum(['changed', 'unsupported', 'unavailable']),
    })
    .strict(),
]);
type NativeResult = z.infer<typeof resultSchema>;
type Request = {
  mode: 'preview' | 'apply';
  jobId: string;
  action: ScheduleAction;
  jobsDigest?: string;
  configDigest?: string | null;
  deadline?: number;
};
export type NativeControlBridge = (source: NativeSource, request: Request) => Promise<NativeResult>;
export const schedulePrepareSchema = z
  .object({
    sourceId: z.string().uuid(),
    jobId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    action: z.enum(['pause', 'resume']),
  })
  .strict();
const binding = (source: NativeSource) =>
  createHash('sha256')
    .update(JSON.stringify([source.id, source.kind, source.home]))
    .digest('hex');

export const nativeControlBridge: NativeControlBridge = async (source, request) => {
  const home = await realpath(source.home),
    binary = await findBinary('hermes');
  assert(
    binary,
    409,
    'Install the supported native Hermes runtime before using native scheduler controls.',
  );
  const python = await hermesPython(binary);
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      python,
      [fileURLToPath(new URL('./adapters/hermes-control.py', import.meta.url))],
      {
        cwd: home,
        timeout: 8000,
        maxBuffer: 262144,
        env: { ...hermesEnvironment({ nativeHome: home }), PYTHONDONTWRITEBYTECODE: '1' },
      },
      (error, stdout) =>
        error ? reject(new Error('Native control acknowledgement unavailable.')) : resolve(stdout),
    );
    child.stdin?.end(JSON.stringify(request));
  });
  assert(
    (await realpath(source.home)) === home,
    409,
    'The native profile target changed during the operation.',
  );
  return resultSchema.parse(JSON.parse(result));
};

export class NativeControls {
  private plans = new Map<string, ScheduleReview & { binding: string; home: string }>();
  constructor(
    private store: Store,
    private sources: NativeSources,
    private bridge: NativeControlBridge = nativeControlBridge,
    private admitResume?: () => Promise<void>,
  ) {
    const rows = store.db
      .prepare(
        "SELECT data FROM records WHERE collection='native_controls' AND json_extract(data,'$.state')='submitted'",
      )
      .all();
    for (const row of rows) {
      const receipt = JSON.parse(String(row.data)) as NativeControlReceipt;
      this.save({
        ...receipt,
        state: 'uncertain',
        detail: 'The native acknowledgement was lost. No control was replayed.',
      });
    }
  }
  private save(row: NativeControlReceipt) {
    return this.store.put('native_controls', row.id, { ...row, updatedAt: now() });
  }
  snapshot(): NativeControlSnapshot {
    const receipts = this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='native_controls' ORDER BY (json_extract(data,'$.state')='uncertain' AND json_type(data,'$.review') IS NULL) DESC,rowid DESC LIMIT 50",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as NativeControlReceipt);
    const needsReview = Number(
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS total FROM records WHERE collection='native_controls' AND json_extract(data,'$.state')='uncertain' AND json_type(data,'$.review') IS NULL",
        )
        .get()!.total,
    );
    return { receipts, needsReview };
  }
  async prepare(value: unknown): Promise<ScheduleReview> {
    const input = schedulePrepareSchema.parse(value);
    return this.sources.atSource(input.sourceId, async (source) => {
      assert(
        source.kind === 'hermes-schedules',
        409,
        'This source has no supported reviewed native scheduler control contract.',
      );
      const result = await this.bridge(source, {
        mode: 'preview',
        jobId: input.jobId,
        action: input.action,
      });
      assert(
        result.state === 'preview' && result.job.id === input.jobId,
        409,
        'The native job, builtin provider or cross-process lock contract is unavailable. Review it in the native runtime.',
      );
      for (const [key, plan] of this.plans) if (plan.expiresAt < now()) this.plans.delete(key);
      while (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
      const plan = {
        ...input,
        ...result.job,
        jobId: input.jobId,
        id: id(),
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        jobsDigest: result.jobsDigest,
        configDigest: result.configDigest,
        contract: result.contract,
      };
      this.plans.set(plan.id, {
        ...plan,
        binding: binding(source),
        home: await realpath(source.home),
      });
      return plan;
    });
  }
  async apply(planId: string, actor: ApprovalActor) {
    const existing = this.store.get<NativeControlReceipt>('native_controls', planId);
    if (existing) return existing;
    const plan = this.plans.get(planId);
    assert(
      plan && plan.expiresAt > now(),
      409,
      'This native control review expired. Read the current job again.',
    );
    return this.sources.atSource(plan.sourceId, async (source) => {
      assert(
        this.plans.get(planId) === plan &&
          binding(source) === plan.binding &&
          (await realpath(source.home)) === plan.home,
        409,
        'The native source changed. Prepare a new review.',
      );
      const uncertain = this.store.db
        .prepare(
          "SELECT 1 FROM records WHERE collection='native_controls' AND json_extract(data,'$.sourceId')=? AND json_extract(data,'$.jobId')=? AND json_extract(data,'$.state') IN ('submitted','uncertain') AND json_type(data,'$.review') IS NULL LIMIT 1",
        )
        .get(source.id, plan.jobId);
      assert(
        !uncertain,
        409,
        'Review the prior uncertain native control before submitting another one for this job.',
      );
      if (plan.action === 'resume') await this.admitResume?.();
      assert(
        plan.expiresAt > now(),
        409,
        'This review expired during admission. Read the native job again.',
      );
      this.plans.delete(planId);
      const receipt: NativeControlReceipt = {
        id: plan.id,
        sourceId: source.id,
        jobId: plan.jobId,
        action: plan.action,
        title: plan.title,
        actor,
        state: 'submitted',
        createdAt: now(),
        updatedAt: now(),
        detail: 'Waiting for the native control acknowledgement.',
      };
      this.save(receipt);
      try {
        const result = await this.bridge(source, {
          mode: 'apply',
          jobId: plan.jobId,
          action: plan.action,
          jobsDigest: plan.jobsDigest,
          configDigest: plan.configDigest,
          deadline: Date.parse(plan.expiresAt),
        });
        if (result.state === 'applied')
          return this.save({
            ...receipt,
            state: 'applied',
            observed: result.observed,
            detail:
              'Native scheduling state confirmed. Running work and delivery retain their native owner.',
          });
        if (result.state === 'rejected')
          return this.save({
            ...receipt,
            state: 'rejected',
            detail:
              'The native definition, review or supported lock contract changed. No control was applied.',
          });
      } catch {
        /* A lost acknowledgement is never authority to retry. */
      }
      return this.save({
        ...receipt,
        state: 'uncertain',
        detail:
          'Native outcome is uncertain. Read the current job and review its effects before another control.',
      });
    });
  }
  async review(receiptId: string, actor: ApprovalActor, note: string) {
    const receipt = this.store.get<NativeControlReceipt>('native_controls', receiptId);
    assert(
      receipt?.state === 'uncertain',
      409,
      'Only an uncertain native control needs outcome review.',
    );
    if (receipt.review) return receipt;
    assert(
      note.trim().length >= 8 && note.length <= 2000,
      400,
      'Record what you checked in the native runtime.',
    );
    return this.sources.atSource(receipt.sourceId, async (source) => {
      const result = await this.bridge(source, {
        mode: 'preview',
        jobId: receipt.jobId,
        action: receipt.action,
      });
      assert(
        result.state === 'preview' || result.state === 'absent',
        409,
        'Current native state is unavailable. Reconcile through its native owner first.',
      );
      return this.save({
        ...receipt,
        review: {
          actor,
          note: note.trim(),
          observedAt: now(),
          observed:
            result.state === 'absent'
              ? {
                  state: 'not-found',
                  enabled: false,
                  nextRunAt: null,
                  jobsDigest: result.jobsDigest,
                }
              : {
                  state: result.job.state,
                  enabled: result.job.enabled,
                  nextRunAt: result.job.nextRunAt,
                  jobsDigest: result.jobsDigest,
                },
        },
      });
    });
  }
}
