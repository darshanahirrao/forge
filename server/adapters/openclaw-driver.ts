import { z } from 'zod';
import type { Usage } from '../../shared/types.js';
import { assert } from '../errors.js';
import { now } from '../store.js';
import { requestDigest } from './sources.js';
import {
  openClawWorker,
  type OpenClawConnection,
  type OpenClawEvent,
  type OpenClawFactory,
} from './openclaw-worker.js';
import type { DriverContext, DriverSink, NativeDriver } from './driver.js';

const nativeId = z.string().min(1).max(256);
const approvalSchema = z.object({
  id: nativeId,
  createdAtMs: z.number().finite(),
  expiresAtMs: z.number().finite(),
  request: z.looseObject({
    command: z.string().min(1).max(128000),
    cwd: z.string().nullable(),
    host: z.literal('gateway'),
    nodeId: z.null().optional(),
    sessionKey: nativeId,
    sessionId: nativeId.nullable().optional(),
    runId: nativeId,
    toolCallId: nativeId,
    agentId: nativeId,
    allowedDecisions: z.array(z.string()),
  }),
});
type ExecApproval = z.infer<typeof approvalSchema>;
type Pending = { record: ExecApproval; digest: string; abort: AbortController };
const historySchema = z.object({
  sessionKey: nativeId,
  sessionId: nativeId,
  pendingInputs: z.object({ total: z.number().int().nonnegative() }),
  inFlightRun: z.object({ runId: nativeId }).nullable().optional(),
  defaults: z.object({ modelProvider: nativeId.optional(), model: nativeId.optional() }).optional(),
  sessionInfo: z.object({
    key: nativeId,
    sessionId: nativeId,
    sessionRoot: z.string(),
    permissionMode: z.literal('guarded'),
    permissionModePending: z.boolean(),
    hasActiveRun: z.boolean(),
    activeRunIds: z.array(nativeId).optional(),
    modelProvider: nativeId.optional(),
    model: nativeId.optional(),
    agentRuntime: z.object({ id: z.literal('openclaw') }),
    placement: z.object({ state: z.literal('local') }).optional(),
  }),
});
const receiptSchema = z.object({
  runId: nativeId,
  sessionId: nativeId,
  turnId: nativeId,
  requested: z.object({ provider: nativeId, model: nativeId }),
  effective: z.object({ provider: nativeId, model: nativeId }),
  successfulToolNames: z.array(z.string()),
  rerouted: z.boolean(),
  terminalDisposition: z.string(),
});
const terminalSchema = z.looseObject({
  phase: z.enum(['end', 'error']),
  executionSettled: z.literal(true),
  aborted: z.boolean().optional(),
  stopReason: z.string().optional(),
  terminalReceipt: receiptSchema.optional(),
});
type Terminal = z.infer<typeof terminalSchema>;
const resultSchema = z.object({
  runId: nativeId,
  status: z.enum(['ok', 'error', 'timeout']),
  summary: z.string(),
  result: z
    .object({
      payloads: z
        .array(z.object({ text: z.string().optional(), isError: z.boolean().optional() }))
        .optional(),
      meta: z.object({
        aborted: z.boolean().optional(),
        stopReason: z.string().optional(),
        error: z.unknown().optional(),
        agentMeta: z.looseObject({
          sessionId: nativeId,
          terminalReceipt: receiptSchema.optional(),
        }),
      }),
    })
    .optional(),
});

/** OpenClaw owns its tools, memory, models and permissions. Forge owns this foreground Gateway. */
export class OpenClawDriver implements NativeDriver {
  readonly harness = 'openclaw' as const;
  private worker: OpenClawConnection | null = null;
  private starting: Promise<OpenClawConnection> | null = null;
  private stopping: Promise<{ clean: boolean }> | null = null;
  private closing = false;
  private sessionId = '';
  private sessionKey = '';
  private agentId = '';
  private accepted = false;
  private terminal: Terminal | null = null;
  private protocolFailure = false;
  private context!: DriverContext;
  private sink!: DriverSink;
  private tools = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private seen = new Map<string, string>();
  private withdrawnIds = new Set<string>();
  private listening: (() => void) | null = null;
  get closed() {
    return this.closing || Boolean(this.worker?.signal.aborted);
  }
  constructor(private factory: OpenClawFactory = openClawWorker) {}

  async start(context: DriverContext, sink: DriverSink) {
    assert(
      context.allowMetered && context.account.billingMode !== 'subscription',
      409,
      'OpenClaw requires explicit external/metered consent. Native provider identity and subscription allowance are not verified.',
    );
    this.context = context;
    this.sink = sink;
    if (this.closing) return;
    this.starting = this.factory(context.account, context.work.cwd);
    this.worker = await this.starting;
    if (this.closing) {
      await this.stop();
      return;
    }
    this.listening = this.worker.onEvent((event) => this.event(event));
    this.worker.signal.addEventListener('abort', () => this.withdrawAll(), { once: true });
    const health = await this.worker.request<{ defaultAgentId?: string }>('health', {});
    assert(
      health.defaultAgentId && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(health.defaultAgentId),
      409,
      'OpenClaw did not identify its native default agent. No input was sent.',
    );
    this.agentId = health.defaultAgentId;
    let revision: string | undefined;
    if (context.work.nativeSessionId) {
      assert(
        context.work.nativeSessionKey,
        409,
        'This OpenClaw session has no verified routing key. Prepare an explicit handoff before continuing.',
      );
      this.sessionId = context.work.nativeSessionId;
      this.sessionKey = context.work.nativeSessionKey;
    } else {
      this.sessionKey = `agent:${this.agentId}:forge-${context.work.id}-${context.run.id}`;
      const created = await this.worker.request<{
        key: string;
        sessionId: string;
        runStarted: boolean;
        entry: { lifecycleRevision: string; permissionMode: string; sessionRoot: string };
      }>('sessions.create', {
        key: this.sessionKey,
        idempotencyKey: context.run.id,
        label: `Forge ${context.work.title.slice(0, 70)} ${context.run.id}`,
        agentId: this.agentId,
        permissionMode: 'guarded',
        cwd: context.work.cwd,
      });
      assert(
        created.key === this.sessionKey &&
          nativeId.safeParse(created.sessionId).success &&
          created.runStarted === false &&
          created.entry?.permissionMode === 'guarded' &&
          created.entry.sessionRoot === context.work.cwd &&
          typeof created.entry.lifecycleRevision === 'string',
        502,
        'OpenClaw did not establish the requested idle native session and workspace.',
      );
      this.sessionId = created.sessionId;
      revision = created.entry.lifecycleRevision;
    }
    sink.session(this.sessionId, this.sessionKey);
    const history = await this.history('idle');
    const provider = history.sessionInfo.modelProvider ?? history.defaults?.modelProvider;
    const model = history.sessionInfo.model ?? history.defaults?.model;
    assert(provider && model, 409, 'Select a native OpenClaw model before launching.');
    // Native resolution chooses the model. Pin that selection and obtain a lifecycle CAS token.
    const patched = await this.worker.request<{
      key: string;
      entry: {
        sessionId: string;
        lifecycleRevision: string;
        sessionRoot: string;
        permissionMode: string;
      };
    }>('sessions.patch', {
      key: this.sessionKey,
      expectedSessionId: this.sessionId,
      ...(revision ? { expectedLifecycleRevision: revision } : {}),
      model: `${provider}/${model}`,
    });
    assert(
      patched.key === this.sessionKey &&
        patched.entry?.sessionId === this.sessionId &&
        patched.entry.sessionRoot === context.work.cwd &&
        patched.entry.permissionMode === 'guarded' &&
        typeof patched.entry.lifecycleRevision === 'string',
      502,
      'The native OpenClaw session changed before input.',
    );
    await this.history('idle');
    sink.account({
      ...context.account,
      state: 'configured',
      identity: null,
      identityKey: null,
      plan: 'Native OpenClaw Gateway; provider identity and allowance unknown',
      quotas: [],
      checkedAt: now(),
      error: null,
    });
    sink.activity(
      'native',
      'Native OpenClaw worker ready',
      `Native guarded permissions in ${context.work.cwd}. Workspace file operations follow OpenClaw's native policy. Only supported exact command requests are forwarded.`,
    );
    if (this.closing) return;
    try {
      const raw = await this.worker.request(
        'agent',
        {
          sessionId: this.sessionId,
          agentId: this.agentId,
          message: context.prompt,
          deliver: false,
          idempotencyKey: context.run.id,
        },
        {
          expectFinal: true,
          timeoutMs: 3600000,
          onAccepted: (value) => {
            const ack = z
              .object({ runId: nativeId, sessionKey: nativeId, status: z.literal('accepted') })
              .safeParse(value);
            if (
              !ack.success ||
              ack.data.runId !== context.run.id ||
              ack.data.sessionKey !== this.sessionKey ||
              this.closing
            ) {
              this.protocolFailure = true;
              void this.stop();
              return;
            }
            this.accepted = true;
            sink.turn(ack.data.runId);
          },
        },
      );
      if (this.closing) return;
      const result = resultSchema.parse(raw);
      assert(
        result.runId === context.run.id && this.accepted && !this.protocolFailure,
        502,
        'The native OpenClaw result did not match its accepted run.',
      );
      const final = await this.history('idle');
      assert(
        final.sessionId === this.sessionId && this.terminal,
        502,
        'OpenClaw did not confirm native execution settlement.',
      );
      const meta = result.result?.meta;
      if (meta?.agentMeta) {
        assert(
          meta.agentMeta.sessionId === this.sessionId,
          502,
          'Native result session identity changed.',
        );
        const usage = openClawUsage(context, meta.agentMeta);
        if (usage) sink.usage(usage);
      }
      const receipt = meta?.agentMeta.terminalReceipt ?? this.terminal.terminalReceipt;
      if (receipt) {
        this.verifyReceipt(receipt);
        sink.activity(
          'native',
          'Native model outcome recorded',
          `${receipt.effective.provider}/${receipt.effective.model}; ${receipt.successfulToolNames.length} successful native tool names${receipt.rerouted ? '; native routing changed the requested model' : ''}. Dollar values are native estimates.`,
        );
      }
      const text = (result.result?.payloads ?? [])
        .map((p) => p.text ?? '')
        .filter(Boolean)
        .join('\n\n');
      if (text) sink.activity('agent', 'Native OpenClaw result', text.slice(0, 16000));
      const completed =
        result.status === 'ok' &&
        result.summary === 'completed' &&
        receipt &&
        this.terminal.phase === 'end' &&
        this.terminal.aborted !== true &&
        meta?.aborted !== true &&
        !meta?.error &&
        !(result.result?.payloads ?? []).some((p) => p.isError === true);
      this.withdrawAll();
      const exit = await this.stop();
      if (!this.closing)
        sink.ended(
          exit.clean ? (completed ? 'completed' : 'failed') : 'interrupted',
          exit.clean
            ? completed
              ? 'Native OpenClaw turn completed'
              : 'Native OpenClaw turn failed'
            : 'OpenClaw exit requires reconciliation',
          exit.clean
            ? 'Native execution settled and the owned Gateway exited. Inspect native history for full tool and memory records.'
            : 'The native Gateway did not confirm clean shutdown. Review native work and effects before continuing.',
        );
    } catch (error) {
      if (this.closing) return;
      this.withdrawAll();
      const transportLost = this.worker.signal.aborted;
      const exit = await this.stop();
      if (transportLost || !exit.clean || this.protocolFailure) {
        sink.ended(
          'interrupted',
          'Native OpenClaw outcome requires reconciliation',
          'Transport or native ownership evidence was lost. No input or decision was replayed.',
        );
      } else throw error;
    }
  }
  private verifyReceipt(receipt: z.infer<typeof receiptSchema>) {
    assert(
      receipt.runId === this.context.run.id &&
        receipt.turnId === this.context.run.id &&
        receipt.sessionId === this.sessionId,
      502,
      'OpenClaw terminal receipt did not match the owned native run.',
    );
  }
  private async history(state: 'idle' | 'running') {
    assert(this.worker && !this.closed, 502, 'The owned OpenClaw connection is no longer active.');
    const value = historySchema.parse(
      await this.worker.request('chat.history', {
        sessionKey: this.sessionKey,
        limit: 1,
        maxBytes: 16384,
      }),
    );
    assert(
      value.sessionKey === this.sessionKey &&
        value.sessionId === this.sessionId &&
        value.sessionInfo.key === this.sessionKey &&
        value.sessionInfo.sessionId === this.sessionId &&
        value.sessionInfo.sessionRoot === this.context.work.cwd &&
        !value.sessionInfo.permissionModePending &&
        value.pendingInputs.total === 0,
      409,
      'Native OpenClaw session, workspace, policy or queued input changed.',
    );
    if (state === 'idle') {
      assert(
        value.sessionInfo.hasActiveRun === false &&
          value.sessionInfo.activeRunIds?.length === 0 &&
          !value.inFlightRun,
        409,
        'OpenClaw has active or uncertain native work. No replacement input was sent.',
      );
    } else {
      assert(
        value.sessionInfo.hasActiveRun === true &&
          value.inFlightRun?.runId === this.context.run.id &&
          (!value.sessionInfo.activeRunIds ||
            value.sessionInfo.activeRunIds.every((id) => id === this.context.run.id)),
        409,
        'The native pending action no longer belongs to the exact owned run.',
      );
    }
    return value;
  }
  private event(event: OpenClawEvent) {
    if (this.closed) return;
    if (event.event === 'exec.approval.resolved') {
      const value = z.object({ id: nativeId }).safeParse(event.payload);
      if (value.success) this.withdraw(value.data.id);
      return;
    }
    if (event.event === 'exec.approval.requested') {
      void this.approval(event.payload).catch(() => {
        if (!this.closed)
          this.sink.activity(
            'native',
            'Native command request could not be verified',
            'No replacement grant was sent. Inspect the native request and session.',
          );
      });
      return;
    }
    if (event.event !== 'agent') return;
    const parsed = z
      .object({
        runId: nativeId,
        sessionKey: nativeId,
        sessionId: nativeId.optional(),
        stream: z.string(),
        data: z.record(z.string(), z.unknown()),
      })
      .safeParse(event.payload);
    if (
      !parsed.success ||
      !this.accepted ||
      parsed.data.runId !== this.context.run.id ||
      parsed.data.sessionKey !== this.sessionKey
    )
      return;
    const { data, stream, sessionId } = parsed.data;
    if (sessionId && sessionId !== this.sessionId) {
      this.protocolFailure = true;
      this.withdrawAll();
      void this.stop();
      return;
    }
    if (
      stream === 'tool' &&
      data.phase === 'start' &&
      typeof data.toolCallId === 'string' &&
      typeof data.name === 'string'
    ) {
      this.tools.set(data.toolCallId, data.name);
      this.sink.activity(
        'tool',
        `OpenClaw: ${data.name.slice(0, 120)}`,
        'Native tool started; its implementation and policy remain in OpenClaw.',
      );
    }
    if (stream === 'lifecycle') {
      const terminal = terminalSchema.safeParse(data);
      if (terminal.success) {
        try {
          if (terminal.data.terminalReceipt) this.verifyReceipt(terminal.data.terminalReceipt);
          this.terminal = terminal.data;
        } catch {
          this.protocolFailure = true;
          this.withdrawAll();
          void this.stop();
        }
      }
    }
  }
  private digest(record: ExecApproval) {
    return requestDigest('openclaw/exec', record, this.context.run.id, this.context.run.generation);
  }
  private async approval(raw: unknown) {
    const parsed = approvalSchema.safeParse(raw);
    if (!parsed.success || !this.accepted || this.closed) return;
    const record = parsed.data;
    if (
      record.request.sessionKey !== this.sessionKey ||
      record.request.runId !== this.context.run.id ||
      record.request.agentId !== this.agentId ||
      (record.request.sessionId && record.request.sessionId !== this.sessionId) ||
      this.tools.get(record.request.toolCallId) !== 'exec' ||
      !record.request.allowedDecisions.includes('allow-once') ||
      !record.request.allowedDecisions.includes('deny') ||
      record.expiresAtMs <= Date.now()
    )
      return;
    const digest = this.digest(record);
    if (this.seen.has(record.id)) {
      if (this.seen.get(record.id) !== digest) this.withdraw(record.id);
      return;
    }
    this.seen.set(record.id, digest);
    await this.verifyPending(record, digest);
    if (this.closed || this.withdrawnIds.has(record.id)) return;
    const pending: Pending = { record, digest, abort: new AbortController() };
    this.pending.set(record.id, pending);
    this.sink.approval({
      requestId: record.id,
      method: 'openclaw/gateway/exec',
      sessionId: this.sessionId,
      turnId: this.context.run.id,
      params: record,
      title: 'OpenClaw command approval',
      detail:
        'Allow this exact native command once. OpenClaw retains command binding, hard denials and policy checks.',
      command: record.request.command,
      cwd: record.request.cwd ?? this.context.work.cwd,
      signal: pending.abort.signal,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      respond: async (decision) => {
        assert(
          !pending.abort.signal.aborted && this.pending.get(record.id) === pending && !this.closed,
          409,
          'This native OpenClaw request is no longer pending.',
        );
        await this.verifyPending(record, digest);
        assert(
          this.pending.get(record.id) === pending && !pending.abort.signal.aborted && !this.closed,
          409,
          'The native OpenClaw request changed during review.',
        );
        this.pending.delete(record.id);
        await this.worker!.request('exec.approval.resolve', {
          id: record.id,
          decision: decision === 'accept' ? 'allow-once' : 'deny',
        });
      },
    });
  }
  private async verifyPending(record: ExecApproval, digest: string) {
    await this.history('running');
    const list = await this.worker!.request<unknown[]>('exec.approval.list', {});
    assert(
      Array.isArray(list) && list.length <= 1000,
      502,
      'Unsupported native OpenClaw approval queue.',
    );
    const current = list
      .map((item) => approvalSchema.safeParse(item))
      .find((item) => item.success && item.data.id === record.id);
    assert(
      current?.success &&
        this.digest(current.data) === digest &&
        current.data.expiresAtMs > Date.now(),
      409,
      'Native OpenClaw approval expired, changed or was withdrawn.',
    );
  }
  private withdraw(id: string) {
    this.withdrawnIds.add(id);
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.abort.abort();
    this.sink?.withdrawn(id);
  }
  private withdrawAll() {
    for (const id of [...this.pending.keys()]) this.withdraw(id);
  }
  private stop() {
    return (this.stopping ??= (async () => {
      const worker = this.worker ?? (await this.starting?.catch(() => null));
      this.withdrawAll();
      this.listening?.();
      this.listening = null;
      if (this.accepted && !this.terminal && worker && !worker.signal.aborted) {
        await worker
          .request('chat.abort', { sessionKey: this.sessionKey, runId: this.context.run.id })
          .catch(() => {});
      }
      return worker ? worker.stop() : { clean: true };
    })());
  }
  async interrupt() {
    this.closing = true;
    this.withdrawAll();
    await this.stop();
  }
  async close() {
    this.closing = true;
    await this.stop();
  }
}

/** Native per-agent-run counters, not session context pressure or accumulated session history. */
export function openClawUsage(
  context: DriverContext,
  agentMeta: Record<string, unknown>,
): Usage | null {
  const counters = z
    .object({
      input: z.number().finite().nonnegative(),
      output: z.number().finite().nonnegative(),
      total: z.number().finite().nonnegative(),
      cacheRead: z.number().finite().nonnegative().optional(),
      cacheWrite: z.number().finite().nonnegative().optional(),
      cost: z.object({ total: z.number().finite().nonnegative() }).optional(),
    })
    .safeParse(agentMeta.usage);
  if (!counters.success) return null;
  const u = counters.data;
  const cost = z.number().finite().nonnegative().safeParse(agentMeta.costUsd);
  return {
    key: `openclaw-gateway:${context.run.id}`,
    workId: context.work.id,
    accountId: context.account.id,
    harness: 'openclaw',
    source: 'openclaw/gateway',
    scope:
      'Native root agent-run counters; session context pressure and descendant/utility coverage excluded; native cost estimate',
    inputTokens: u.input,
    outputTokens: u.output,
    cachedTokens: u.cacheRead ?? 0,
    cacheWriteTokens: u.cacheWrite ?? 0,
    totalTokens: u.total,
    estimatedUsd: cost.success ? cost.data : (u.cost?.total ?? null),
    observedAt: now(),
  };
}
