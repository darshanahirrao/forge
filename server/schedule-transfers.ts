import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import type { ApprovalActor, NativeSource } from '../shared/types.js';
import type { ScheduleAction } from '../shared/native-controls.js';
import type {
  PortableSchedule,
  ScheduleEvidence,
  ScheduleTransfer,
  ScheduleTransferPlan,
  ScheduleTransferReview,
} from '../shared/schedule-transfers.js';
import type { NativeControlBridge } from './native-controls.js';
import type { NativeScheduleDraft, ScheduleTransferBridge } from './adapters/schedule-transfer.js';
import { portableSchedule } from './schedule-portability.js';
import { NativeSources } from './native-sources.js';
import { ExecutionController } from './execution.js';
import { Store, id, now } from './store.js';
import { assert } from './errors.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const schedulerIdentity = (source: NativeSource) => {
  if (source.kind === 'hermes-schedules') return realpathSync(source.home);
  assert(
    source.kind === 'openclaw-schedules',
    409,
    'This source has no evaluated scheduler identity.',
  );
  const endpoint = new URL(source.endpoint);
  // Loopback host aliases may reach the same listener. Conservatively share its
  // hold across IPv4/IPv6/localhost and require distinct ports for distinct owners.
  return `openclaw-loopback:${endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80')}`;
};
const binding = (s: NativeSource) =>
  hash([
    s.id,
    s.kind,
    s.home,
    s.endpoint,
    s.tokenEnv,
    Boolean(s.scheduleControls),
    s.revision ?? 0,
  ]);
const prepareSchema = z
  .object({
    sourceId: z.string().uuid(),
    jobId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    targetSourceId: z.string().uuid(),
  })
  .strict();
export const transferDecisionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    reviewed: z.literal(true),
    sourceActivitySettled: z.literal(true),
  })
  .strict();
interface Stored extends ScheduleTransfer {
  intentDigest: string;
  portable: PortableSchedule;
  changes: string[];
  originalDefinition: string;
  sourceBinding: string;
  targetBinding: string;
  sourceHome: string;
  targetHome: string;
  draft: NativeScheduleDraft;
  source: ScheduleEvidence;
  target: ScheduleEvidence | null;
  reconciliation?: { actor: ApprovalActor; note: string; at: string };
}
interface Plan extends ScheduleTransferPlan {
  sourceBinding: string;
  targetBinding: string;
  sourceHome: string;
  targetHome: string;
  draft: NativeScheduleDraft;
}

/** Reviewed native scheduling saga. No timer, model loop, job execution or automatic retry. */
export class ScheduleTransfers {
  private plans = new Map<string, Plan>();
  private busy = false;
  constructor(
    private store: Store,
    private sources: NativeSources,
    private execution: ExecutionController,
    private control: NativeControlBridge,
    private provider: (source: NativeSource) => ScheduleTransferBridge,
    private admit: () => Promise<void> | void = () => {},
  ) {
    for (const item of store.db
      .prepare(
        "SELECT data FROM records WHERE collection='schedule_transfers' AND json_extract(data,'$.state') IN ('preparing','activating','cancelling')",
      )
      .all()) {
      const row = JSON.parse(String(item.data)) as Stored;
      this.save({
        ...row,
        state: 'uncertain',
        detail:
          'The native acknowledgement was interrupted. No schedule operation was replayed. Read both native owners and reconcile the outcome.',
      });
    }
  }
  get isBusy() {
    return this.busy;
  }
  list(): ScheduleTransfer[] {
    return this.store.db
      .prepare(
        "SELECT json_remove(data,'$.intentDigest','$.portable','$.changes','$.originalDefinition','$.sourceBinding','$.targetBinding','$.sourceHome','$.targetHome','$.draft','$.source','$.target','$.reconciliation') AS data FROM records WHERE collection='schedule_transfers' ORDER BY CASE WHEN json_extract(data,'$.state') IN ('uncertain','staged') THEN 0 ELSE 1 END, rowid DESC LIMIT 50",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  assertControl(sourceId: string, jobId: string, action: ScheduleAction) {
    if (action !== 'resume') return;
    const source = this.store.get<NativeSource>('native_sources', sourceId);
    if (!source || !['hermes-schedules', 'openclaw-schedules'].includes(source.kind)) return;
    const identity = schedulerIdentity(source);
    assert(
      !this.store.db
        .prepare(
          "SELECT 1 FROM records WHERE collection='schedule_transfers' AND json_extract(data,'$.state')!='cancelled' AND ((json_extract(data,'$.sourceHome')=? AND json_extract(data,'$.sourceJobId')=?) OR (json_extract(data,'$.targetHome')=? AND (json_extract(data,'$.targetJobId')=? OR json_type(data,'$.targetJobId') IS NULL) AND json_extract(data,'$.state')!='active')) LIMIT 1",
        )
        .get(identity, jobId, identity, jobId),
      409,
      'This schedule has a transfer hold. Activate or cancel its reviewed transfer before resuming it.',
    );
  }
  private assertFree(sourceId: string, jobId: string) {
    const source = this.store.get<NativeSource>('native_sources', sourceId)!;
    const identity = schedulerIdentity(source);
    assert(
      !this.unsettledControl(sourceId, jobId),
      409,
      'Reconcile the prior uncertain native control before moving this schedule.',
    );
    assert(
      !this.store.db
        .prepare(
          "SELECT 1 FROM records WHERE collection='schedule_transfers' AND json_extract(data,'$.state')!='cancelled' AND ((json_extract(data,'$.sourceHome')=? AND json_extract(data,'$.sourceJobId')=?) OR (json_extract(data,'$.targetHome')=? AND (json_extract(data,'$.targetJobId')=? OR json_type(data,'$.targetJobId') IS NULL) AND json_extract(data,'$.state')!='active')) LIMIT 1",
        )
        .get(identity, jobId, identity, jobId),
      409,
      'Resolve this schedule’s existing transfer before preparing another move.',
    );
  }
  private unsettledControl(sourceId: string, jobId: string) {
    const identity = schedulerIdentity(this.store.get<NativeSource>('native_sources', sourceId)!);
    for (const item of this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='native_controls' AND json_extract(data,'$.jobId')=? AND json_extract(data,'$.state') IN ('submitted','uncertain') AND json_type(data,'$.review') IS NULL",
      )
      .iterate(jobId)) {
      const receipt = JSON.parse(String(item.data));
      const owner = this.store.get<NativeSource>('native_sources', receipt.sourceId);
      if (owner && schedulerIdentity(owner) === identity) return true;
    }
    return false;
  }
  private row(identifier: string) {
    const row = this.store.get<Stored>('schedule_transfers', identifier);
    assert(row, 404, 'This schedule transfer was not found.');
    return row;
  }
  private public(row: Stored): ScheduleTransfer {
    const {
      intentDigest: _i,
      portable: _p,
      changes: _c,
      originalDefinition: _o,
      sourceBinding: _s,
      targetBinding: _t,
      sourceHome: _sh,
      targetHome: _th,
      draft: _d,
      source: _se,
      target: _te,
      reconciliation: _r,
      ...result
    } = row;
    return result;
  }
  private save(row: Stored) {
    return this.store.put('schedule_transfers', row.id, {
      ...row,
      revision: row.revision + 1,
      updatedAt: now(),
    });
  }
  private async checkpoint<T>(ids: string[], body: (sources: NativeSource[]) => Promise<T>) {
    assert(!this.busy, 409, 'Wait for the current schedule transfer operation.');
    return this.execution.atWorkspaceCheckpoint('schedule-transfer', async () => {
      await this.admit();
      this.busy = true;
      try {
        return await this.sources.atSources(ids, body);
      } finally {
        this.busy = false;
      }
    });
  }
  private async home(source: NativeSource) {
    assert(
      ['hermes-schedules', 'openclaw-schedules'].includes(source.kind),
      409,
      'Choose an evaluated Hermes or OpenClaw scheduler.',
    );
    assert(
      source.kind !== 'openclaw-schedules' || source.scheduleControls,
      409,
      'Enable reviewed native administrator schedule access on both OpenClaw connections first.',
    );
    if (source.kind === 'hermes-schedules') await realpath(source.home);
    return schedulerIdentity(source);
  }
  private async evidence(source: NativeSource, jobId: string): Promise<ScheduleEvidence | null> {
    const result = await this.control(source, { mode: 'preview', jobId, action: 'pause' });
    if (result.state === 'absent' || result.state === 'not-visible') return null;
    assert(
      result.state === 'preview' && result.job.id === jobId,
      409,
      'Read the current native schedule through its owner before continuing.',
    );
    return {
      ...result.job,
      sourceId: source.id,
      jobId,
      jobsDigest: result.jobsDigest,
      configDigest: result.configDigest,
      contract: result.contract,
    };
  }
  private async requireEvidence(source: NativeSource, jobId: string) {
    const row = await this.evidence(source, jobId);
    assert(row, 409, 'The native schedule is absent or hidden. Review its native owner.');
    return row;
  }
  private samePortable(source: NativeSource, row: ScheduleEvidence, expected: PortableSchedule) {
    try {
      return hash(portableSchedule(source, row)) === hash(expected);
    } catch {
      return false;
    }
  }
  private paused(row: ScheduleEvidence | null) {
    return row && !row.enabled && !/running/i.test(row.state);
  }
  private async current(row: Stored, source: NativeSource, target: NativeSource) {
    assert(
      (await this.home(source)) === row.sourceHome && (await this.home(target)) === row.targetHome,
      409,
      'A native scheduler endpoint or profile changed. Restore its original binding before reconciling this transfer.',
    );
    const from = await this.requireEvidence(source, row.sourceJobId);
    let targetJobId = row.targetJobId;
    if (!targetJobId)
      targetJobId =
        (await this.provider(target).locate(target, `forge.transfer.${row.id}`)) ?? undefined;
    const to = targetJobId ? await this.evidence(target, targetJobId) : null;
    return {
      ...row,
      sourceBinding: binding(source),
      targetBinding: binding(target),
      source: from,
      target: to,
      ...(targetJobId ? { targetJobId } : {}),
    };
  }
  private reviewed(
    row: Stored,
    source: NativeSource,
    target: NativeSource,
  ): ScheduleTransferReview {
    const sourceMatches = this.samePortable(source, row.source, row.portable);
    const controlsSettled =
      !this.unsettledControl(source.id, row.sourceJobId) &&
      (!row.targetJobId || !this.unsettledControl(target.id, row.targetJobId));
    return {
      ...this.public(row),
      portable: row.portable,
      changes: row.changes,
      originalDefinition: row.originalDefinition,
      targetDefinition: row.draft.definition,
      source: row.source,
      target: row.target,
      canActivate:
        row.state === 'staged' &&
        controlsSettled &&
        Boolean(
          this.paused(row.source) &&
          this.paused(row.target) &&
          sourceMatches &&
          this.samePortable(target, row.target!, row.portable),
        ),
      canCancel:
        ['staged', 'active'].includes(row.state) &&
        controlsSettled &&
        Boolean(this.paused(row.source) && row.target && !/running/i.test(row.target.state)),
    };
  }
  private seal(row: Stored) {
    return {
      ...row,
      digest: hash([
        row.id,
        row.revision + 1,
        row.state,
        row.sourceBinding,
        row.targetBinding,
        row.source,
        row.target,
        row.draft,
        row.portable,
      ]),
    };
  }
  async prepare(value: unknown): Promise<ScheduleTransferPlan> {
    const input = prepareSchema.parse(value);
    assert(
      input.sourceId !== input.targetSourceId,
      409,
      'Choose a different native scheduler connection.',
    );
    return this.checkpoint([input.sourceId, input.targetSourceId], async ([source, target]) => {
      this.assertFree(source.id, input.jobId);
      const sourceHome = await this.home(source),
        targetHome = await this.home(target);
      assert(
        sourceHome !== targetHome,
        409,
        'These connections point to the same native scheduler.',
      );
      const evidence = await this.requireEvidence(source, input.jobId);
      assert(
        !/running/i.test(evidence.state),
        409,
        'Let the native job finish before moving its schedule.',
      );
      const portable = portableSchedule(source, evidence),
        identifier = id();
      const draft = await this.provider(target).draft(
        target,
        portable,
        `forge.transfer.${identifier}`,
      );
      assert(
        Buffer.byteLength(draft.definition) <= 65536,
        409,
        'The native destination definition exceeds the review limit.',
      );
      const changes = [
        'Native execution, model, tools and memory use the destination profile defaults. Delivery remains local.',
        'Missed runs and daylight-saving transitions follow the destination native scheduler policy.',
        'The destination starts with fresh native run history. The original definition and transfer receipt remain in Forge.',
        ...(portable.schedule.kind === 'every'
          ? [
              'The interval starts a new cadence when enabled; the original interval phase is not preserved.',
            ]
          : []),
        ...(target.kind === 'openclaw-schedules'
          ? ['The destination uses the native main agent in an isolated automation session.']
          : []),
      ];
      for (const [key, p] of this.plans) if (p.expiresAt <= now()) this.plans.delete(key);
      assert(
        this.plans.size < 32,
        409,
        'Finish existing schedule reviews or let them expire first.',
      );
      const plan = {
        id: identifier,
        ...input,
        source: evidence,
        portable,
        targetDefinition: draft.definition,
        changes,
        sourceHome,
        targetHome,
        sourceBinding: binding(source),
        targetBinding: binding(target),
        draft,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      };
      const digest = hash(plan);
      this.plans.set(identifier, { ...plan, digest });
      const {
        sourceHome: _sh,
        targetHome: _th,
        sourceBinding: _sb,
        targetBinding: _tb,
        draft: _d,
        ...result
      } = plan;
      return { ...result, digest };
    });
  }
  async stage(identifier: string, digest: string, actor: ApprovalActor) {
    const previous = this.store.get<Stored>('schedule_transfers', identifier);
    if (previous) {
      assert(previous.intentDigest === digest, 409, 'This transfer intent changed.');
      return this.public(previous);
    }
    const plan = this.plans.get(identifier);
    assert(
      plan && plan.digest === digest && plan.expiresAt > now(),
      409,
      'This schedule review expired or changed. Read both native owners again.',
    );
    return this.checkpoint([plan.sourceId, plan.targetSourceId], async ([source, target]) => {
      assert(
        this.plans.get(identifier) === plan &&
          binding(source) === plan.sourceBinding &&
          binding(target) === plan.targetBinding &&
          (await this.home(source)) === plan.sourceHome &&
          (await this.home(target)) === plan.targetHome,
        409,
        'A native scheduler binding changed during review.',
      );
      this.assertFree(source.id, plan.source.jobId);
      const before = await this.requireEvidence(source, plan.source.jobId);
      assert(
        hash(before) === hash(plan.source) && plan.expiresAt > now(),
        409,
        'The native source changed or its review expired. Prepare another review.',
      );
      this.plans.delete(identifier);
      let row: Stored = this.save({
        id: plan.id,
        digest: plan.digest,
        intentDigest: plan.digest,
        revision: -1,
        state: 'preparing',
        sourceId: source.id,
        targetSourceId: target.id,
        sourceJobId: before.jobId,
        targetJobId: plan.draft.jobId,
        title: plan.portable.title,
        portable: plan.portable,
        changes: plan.changes,
        draft: plan.draft,
        source: before,
        target: null,
        sourceHome: plan.sourceHome,
        targetHome: plan.targetHome,
        sourceBinding: plan.sourceBinding,
        targetBinding: plan.targetBinding,
        originalDefinition: before.definition,
        actor,
        createdAt: now(),
        updatedAt: now(),
        detail:
          'Pausing the source and staging one disabled native destination. No activation is automatic.',
      });
      try {
        if (before.enabled) {
          const result = await this.control(source, {
            mode: 'apply',
            jobId: before.jobId,
            action: 'pause',
            jobsDigest: before.jobsDigest,
            configDigest: before.configDigest,
            deadline: Date.parse(plan.expiresAt),
          });
          if (result.state === 'rejected')
            return this.public(
              this.save({
                ...row,
                state: 'cancelled',
                detail: 'The native source rejected this stale pause. No destination was created.',
              }),
            );
          assert(result.state === 'applied', 409, 'The source pause was not acknowledged.');
        }
        const paused = await this.requireEvidence(source, before.jobId);
        assert(
          this.paused(paused) && this.samePortable(source, paused, row.portable),
          409,
          'The source is running, enabled or changed.',
        );
        row = this.save({ ...row, source: paused });
        const targetJobId = await this.provider(target).publish(
          target,
          row.draft,
          Date.parse(plan.expiresAt),
        );
        row = this.save({ ...row, targetJobId });
        const staged = await this.requireEvidence(target, targetJobId);
        assert(
          this.paused(staged) && this.samePortable(target, staged, row.portable),
          409,
          'The destination did not confirm the reviewed disabled definition.',
        );
        row = this.save(
          this.seal({
            ...row,
            source: paused,
            target: staged,
            state: 'staged',
            detail:
              'Both schedules are paused. Review source runs and deliveries before enabling the destination. Native run history was not replayed.',
          }),
        );
      } catch {
        row = this.save({
          ...row,
          state: 'uncertain',
          detail:
            'A native operation was not acknowledged. Source scheduling remains held in Forge. Read both native owners and reconcile; no operation will be replayed.',
        });
      }
      return this.public(row);
    });
  }
  async review(identifier: string) {
    const row = this.row(identifier);
    return this.checkpoint([row.sourceId, row.targetSourceId], async ([source, target]) => {
      const current = await this.current(row, source, target);
      const saved = this.save(this.seal(current));
      return this.reviewed(saved, source, target);
    });
  }
  async decide(
    identifier: string,
    input: z.infer<typeof transferDecisionSchema>,
    actor: ApprovalActor,
    action: 'activate' | 'cancel',
  ) {
    const row = this.row(identifier);
    assert(
      row.digest === input.digest && row.revision === input.revision,
      409,
      'The transfer changed. Read both native owners for a current review.',
    );
    return this.checkpoint([row.sourceId, row.targetSourceId], async ([source, target]) => {
      const current = await this.current(row, source, target);
      assert(
        binding(source) === row.sourceBinding &&
          binding(target) === row.targetBinding &&
          hash(current.source) === hash(row.source) &&
          hash(current.target) === hash(row.target),
        409,
        'A native job or authority changed after review. Read both owners again.',
      );
      const review = this.reviewed(row, source, target);
      assert(
        action === 'activate' ? review.canActivate : review.canCancel,
        409,
        'Reconcile both native schedules before changing this transfer.',
      );
      if (action === 'cancel')
        assert(
          !this.store.db
            .prepare(
              "SELECT 1 FROM records WHERE collection='schedule_transfers' AND id!=? AND json_extract(data,'$.sourceHome')=? AND json_extract(data,'$.sourceJobId')=? AND json_extract(data,'$.state')!='cancelled' LIMIT 1",
            )
            .get(row.id, row.targetHome, row.targetJobId!),
          409,
          'Cancel the destination’s later transfer first, then release this original source.',
        );
      let saved = this.save({
        ...row,
        reviewedBy: actor,
        state: action === 'activate' ? 'activating' : 'cancelling',
        detail: 'Waiting for one native scheduling acknowledgement.',
      });
      try {
        const result = await this.control(target, {
          mode: 'apply',
          jobId: row.targetJobId!,
          action: action === 'activate' ? 'resume' : 'pause',
          jobsDigest: row.target!.jobsDigest,
          configDigest: row.target!.configDigest,
          deadline: Date.now() + 15000,
        });
        if (result.state === 'rejected')
          return this.public(
            this.save({
              ...saved,
              state: row.state,
              detail:
                'The native destination rejected the stale change. Read both owners before another action.',
            }),
          );
        assert(result.state === 'applied', 409, 'The native scheduling acknowledgement was lost.');
        saved = this.save({
          ...saved,
          state: action === 'activate' ? 'active' : 'cancelled',
          detail:
            action === 'activate'
              ? 'Destination scheduling is enabled. The original remains paused with a durable Forge resume hold. Native billing, permissions and execution remain authoritative.'
              : 'Destination scheduling is paused. The source remains paused and its Forge resume hold is released; resume it only after a separate native review.',
        });
      } catch {
        saved = this.save({
          ...saved,
          state: 'uncertain',
          detail:
            'The native acknowledgement is uncertain. No enable or pause will be replayed. Read both owners and reconcile this outcome.',
        });
      }
      return this.public(saved);
    });
  }
  async reconcile(
    identifier: string,
    input: z.infer<typeof transferDecisionSchema> & {
      note: string;
      targetAbsenceReviewed?: boolean;
    },
    actor: ApprovalActor,
  ) {
    const row = this.row(identifier);
    assert(
      row.state === 'uncertain' && row.digest === input.digest && row.revision === input.revision,
      409,
      'Read the current uncertain transfer before recording its outcome.',
    );
    assert(
      input.note.trim().length >= 8 && input.note.length <= 2000,
      400,
      'Record what you checked in native run history and pending operations.',
    );
    return this.checkpoint([row.sourceId, row.targetSourceId], async ([source, target]) => {
      const current = await this.current(row, source, target);
      assert(
        binding(source) === row.sourceBinding &&
          binding(target) === row.targetBinding &&
          hash(current.source) === hash(row.source) &&
          hash(current.target) === hash(row.target),
        409,
        'A native job or authority changed after outcome review. Read both owners again.',
      );
      assert(
        !this.unsettledControl(source.id, row.sourceJobId) &&
          (!current.targetJobId || !this.unsettledControl(target.id, current.targetJobId)),
        409,
        'Reconcile the prior uncertain native control before recording this transfer outcome.',
      );
      assert(
        this.paused(current.source),
        409,
        'Pause and settle the original through its native owner before reconciliation.',
      );
      assert(
        current.target || input.targetAbsenceReviewed,
        409,
        'The target is absent or hidden. Check its pending operations and native store before explicitly recording absence.',
      );
      return this.public(
        this.save(
          this.seal({
            ...current,
            state: !current.target ? 'cancelled' : current.target.enabled ? 'active' : 'staged',
            reviewedBy: actor,
            reconciliation: { actor, at: now(), note: input.note.trim() },
            detail:
              'A human reviewed both native owners, pending operations and source activity. Current scheduling state is recorded; no create, pause, enable or job run was replayed.',
          }),
        ),
      );
    });
  }
}
