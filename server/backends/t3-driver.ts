import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Run, Usage } from '../../shared/types.js';
import type { DriverContext, DriverSink, NativeDriver } from '../adapters/driver.js';
import { assert, ForgeError } from '../errors.js';
import { now } from '../store.js';
import { T3Backends, driverHarness } from './t3-backend.js';
import { t3Projection, terminalRunStates, type T3Projection } from './t3-contract.js';
import { T3Rpc } from './t3-rpc.js';

/** T3 owns native providers and tools. Forge owns this explicit work/run mapping, never the server PID. */
export class T3Driver implements NativeDriver {
  readonly ownership = 'delegated-run' as const;
  readonly harness: string;
  readonly settlement: NonNullable<Run['settlement']>;
  closed = false;
  private rpc?: T3Rpc;
  private context?: DriverContext;
  private sink?: DriverSink;
  private subscription?: { close(): void; ended: Promise<void> };
  private reading?: Promise<void>;
  private dirty = false;
  private ending = false;
  private dispatched = false;
  private approvals = new Map<string, { abort: AbortController; payload: string }>();
  private results = new Set<string>();
  private sourceNativeThreadId?: string;
  private continuityReported?: string;
  constructor(
    private backends: T3Backends,
    context: DriverContext,
  ) {
    assert(context.account.backend, 409, 'This account has no native backend binding.');
    this.harness = context.account.harness;
    const resume =
      context.work.nativeSessionId && context.work.nativeSessionKey === context.account.backend.id;
    this.settlement = {
      kind: 'delegated-run',
      backendId: context.account.backend.id,
      threadId: resume ? context.work.nativeSessionId! : `forge-${randomUUID()}`,
      messageId: `forge-${context.run.id}`,
      runId: null,
      state: 'prepared',
      confirmed: false,
      observedAt: now(),
    };
  }
  private receipt(state: string, confirmed = false) {
    Object.assign(this.settlement, { state, confirmed, observedAt: now() });
    this.sink?.delegated?.({ ...this.settlement });
  }
  async start(context: DriverContext, sink: DriverSink) {
    this.context = context;
    this.sink = sink;
    assert(
      context.allowMetered,
      409,
      'Confirm native provider billing before dispatch through T3. Forge cannot infer included allowance from a provider name.',
    );
    const binding = context.account.backend!;
    this.rpc = await this.backends.rpc(binding.id);
    if (this.closed) this.rpc.close();
    assert(!this.closed, 409, 'This attempt ended before the native connection opened.');
    await this.rpc.request('server.refreshProviders', { instanceId: binding.instanceId });
    const config = await this.backends.inspect(
      this.rpc,
      this.backends.list().find((backend) => backend.id === binding.id)?.environmentId,
    );
    const native = config.providers.find((provider) => provider.instanceId === binding.instanceId);
    assert(
      native &&
        native.enabled &&
        native.installed &&
        ['ready', 'warning'].includes(native.status) &&
        native.auth?.status !== 'unauthenticated' &&
        driverHarness(native.driver) === context.account.harness &&
        native.models.some((model) => model.id === binding.model),
      409,
      'This native provider or model is unavailable. Refresh its catalogue in Connections.',
    );
    const projects = await this.backends.projects(this.rpc);
    const candidates = projects.filter(
      (project) =>
        resolve(project.workspaceRoot) === resolve(context.work.cwd) &&
        (!binding.projectId || project.id === binding.projectId),
    );
    assert(
      candidates.length === 1,
      409,
      'Add this exact workspace as a native T3 project, then choose its project if more than one matches.',
    );
    const project = candidates[0]!;
    const modelSelection = { instanceId: binding.instanceId, model: binding.model };
    const resume = Boolean(
      context.work.nativeSessionId && context.work.nativeSessionKey === binding.id,
    );
    if (resume) {
      const prior = await this.projection();
      this.sourceNativeThreadId = prior.providerThreads.find(
        (thread) => thread.id === prior.thread.activeProviderThreadId,
      )?.nativeThreadRef?.nativeId;
      assert(
        prior.thread.projectId === project.id &&
          !prior.thread.worktreePath &&
          prior.thread.runtimeMode === 'approval-required',
        409,
        'Native workspace or permission mode changed. Review the T3 thread before continuing.',
      );
      assert(
        prior.runs.every((run) => terminalRunStates.has(run.status)) &&
          !prior.providerThreads.some((thread) => thread.pendingBackgroundTasks?.length),
        409,
        'The native thread still owns active or background work. Settle it in T3 first.',
      );
      // T3 chooses native continuation against its current provider context and this message's selection.
    } else {
      this.receipt('creating-thread');
      await this.command({
        type: 'thread.create',
        createdBy: 'user',
        creationSource: 'web',
        commandId: `forge-thread-${context.run.id}`,
        threadId: this.settlement.threadId,
        projectId: project.id,
        title: context.work.title,
        modelSelection,
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
      });
    }
    assert(!this.closed, 409, 'This native attempt ended before dispatch.');
    sink.session(this.settlement.threadId, binding.id);
    this.receipt('dispatching');
    this.dispatched = true; // Persist the uncertain boundary before native write, never retry it implicitly.
    await this.command({
      type: 'message.dispatch',
      createdBy: 'user',
      creationSource: 'web',
      commandId: `forge-message-${context.run.id}`,
      threadId: this.settlement.threadId,
      messageId: this.settlement.messageId,
      text: context.prompt,
      attachments: [],
      modelSelection,
      dispatchMode: { type: 'start_immediately' },
    });
    this.subscription = await this.rpc.subscribe(
      'orchestration.subscribeThread',
      { threadId: this.settlement.threadId },
      () => this.refresh(),
    );
    void this.subscription.ended.then(
      () => {
        if (!this.ending && !this.closed) this.fail();
      },
      () => this.fail(),
    );
    await this.read();
  }
  private async command(payload: unknown) {
    assert(this.rpc && !this.closed, 409, 'The native connection is no longer live.');
    return this.rpc.request('orchestration.dispatchCommand', payload);
  }
  private async projection() {
    assert(this.rpc && !this.closed, 409, 'The native connection is no longer live.');
    const parsed = t3Projection.safeParse(
      await this.rpc.request('orchestration.getThreadProjection', {
        threadId: this.settlement.threadId,
      }),
    );
    assert(
      parsed.success && parsed.data.thread.id === this.settlement.threadId,
      502,
      'The native thread projection is unsupported. Inspect T3; nothing was replayed.',
    );
    return parsed.data;
  }
  private refresh() {
    if (this.closed || this.ending) return;
    this.dirty = true;
    if (!this.reading) void this.read().catch(() => this.fail());
  }
  private read(): Promise<void> {
    if (this.reading) {
      this.dirty = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.dirty = false;
        this.observe(await this.projection());
      } while (this.dirty && !this.closed && !this.ending);
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }
  private observe(projection: T3Projection) {
    if (this.ending || this.closed || !this.context || !this.sink) return;
    const native = projection.runs.find((run) => run.userMessageId === this.settlement.messageId);
    if (!native) return;
    assert(
      native.providerInstanceId === this.context.account.backend!.instanceId,
      409,
      'The native provider changed outside this Forge binding. Review its outcome.',
    );
    this.settlement.runId = native.id;
    const nativeThread = projection.providerThreads.find(
      (thread) => thread.id === native.providerThreadId,
    )?.nativeThreadRef;
    const nativeStarted = projection.providerTurns.some(
      (turn) =>
        projection.nodes.some((node) => node.id === turn.nodeId && node.runId === native.id) &&
        ['running', 'completed', 'failed', 'interrupted'].includes(turn.status),
    );
    if (nativeThread?.strength === 'strong' && nativeStarted) {
      const handoff = projection.contextHandoffs.find(
        (handoff) => handoff.targetRunId === native.id && handoff.status === 'ready',
      );
      const mode = handoff
        ? 'portable-handoff'
        : !this.sourceNativeThreadId
          ? 'fresh'
          : nativeThread.nativeId === this.sourceNativeThreadId
            ? 'native-resume'
            : 'unverified';
      this.settlement.continuity = {
        mode,
        nativeThreadId: nativeThread.nativeId,
        ...(this.sourceNativeThreadId ? { sourceNativeThreadId: this.sourceNativeThreadId } : {}),
        ...(handoff ? { strategy: handoff.strategy } : {}),
      };
      if (
        this.continuityReported !== mode &&
        (native.status === 'running' || terminalRunStates.has(native.status))
      ) {
        this.continuityReported = mode;
        this.sink.activity(
          'continuity',
          mode === 'native-resume'
            ? 'Native conversation resumed'
            : mode === 'portable-handoff'
              ? 'T3 continued with a context summary'
              : mode === 'fresh'
                ? 'Fresh native conversation'
                : 'Native context coverage needs review',
          mode === 'portable-handoff'
            ? `Native strategy: ${handoff!.strategy}. Full hidden provider state is not proven portable. Forge work, reviewed memory and selected artifacts stay linked.`
            : `Native context mode: ${mode}. The native conversation reference is retained in this run receipt.`,
        );
      }
    }
    this.receipt(native.status);
    this.sink.turn(native.id);
    const nodes = new Set(
      projection.nodes.filter((node) => node.runId === native.id).map((node) => node.id),
    );
    const pending = projection.runtimeRequests.filter(
      (request) => nodes.has(request.nodeId) && request.status === 'pending',
    );
    for (const [id, control] of this.approvals)
      if (!pending.some((request) => request.id === id)) {
        control.abort.abort();
        this.approvals.delete(id);
      }
    for (const request of pending) {
      const item = projection.turnItems.find(
        (item) =>
          item.type === 'approval_request' &&
          item.runId === native.id &&
          item.requestId === request.id &&
          item.providerTurnId === request.providerTurnId,
      );
      if (
        !item?.prompt ||
        request.nativeRequestRef?.strength !== 'strong' ||
        request.responseCapability.type !== 'live' ||
        !['command', 'file-read', 'file-write', 'file-change', 'network', 'tool'].includes(
          request.kind,
        )
      )
        continue;
      if (
        item.options &&
        (!item.options.some((option) => option.decision === 'accept') ||
          !item.options.some((option) => option.decision === 'decline'))
      )
        continue;
      const payload = JSON.stringify({ request, item });
      const old = this.approvals.get(request.id);
      assert(
        !old || old.payload === payload,
        409,
        'The native approval changed under the same identity. No replacement grant was sent.',
      );
      if (old) continue;
      const abort = new AbortController();
      this.approvals.set(request.id, { abort, payload });
      this.sink.approval({
        requestId: request.id,
        method: 't3/runtime-request.respond',
        sessionId: this.settlement.threadId,
        turnId: native.id,
        params: { nativeRequest: request, item },
        title: 'Review native T3 request',
        detail:
          item.options
            ?.map(
              (option) =>
                `${option.label ?? option.decision}${option.warning ? `: ${option.warning}` : ''}`,
            )
            .join('\n') || `Native ${request.kind} request`,
        command: item.prompt,
        cwd: this.context.work.cwd,
        signal: abort.signal,
        respond: async (decision) => {
          // Re-read before a grant so a stale stream cannot authorize a changed native request.
          const current = await this.projection();
          const currentRequest = current.runtimeRequests.find((value) => value.id === request.id);
          const currentItem = current.turnItems.find((value) => value.id === item.id);
          assert(
            !abort.signal.aborted &&
              JSON.stringify({ request: currentRequest, item: currentItem }) === payload,
            409,
            'This exact native approval is no longer pending. Refresh native activity.',
          );
          await this.command({
            type: 'runtime-request.respond',
            commandId: `forge-decision-${this.context!.run.id}-${request.id}`,
            threadId: this.settlement.threadId,
            requestId: request.id,
            decision,
          });
          this.refresh();
        },
      });
    }
    for (const item of projection.turnItems.filter(
      (item) => item.runId === native.id && item.type === 'assistant_message' && item.text,
    )) {
      if (terminalRunStates.has(native.status) && !this.results.has(item.id)) {
        this.results.add(item.id);
        this.sink.activity('assistant', 'Native T3 result', item.text);
      }
    }
    for (const turn of projection.providerTurns.filter((turn) => nodes.has(turn.nodeId))) {
      const tokens = turn.turnTokenUsage;
      if (!tokens || tokens.usageStatus === 'unavailable' || tokens.usageScope !== 'main_agent')
        continue;
      const inputTokens = tokens.inputTokens ?? 0,
        outputTokens = tokens.outputTokens ?? 0;
      const usage: Usage = {
        key: `t3:${this.settlement.backendId}:${turn.id}`,
        counterScope: 'run',
        workId: this.context.work.id,
        accountId: this.context.account.id,
        harness: this.harness,
        source: 't3/native',
        scope: `T3 main agent / ${tokens.usageStatus}; dollars unavailable`,
        inputTokens,
        outputTokens,
        cachedTokens: tokens.cachedInputTokens ?? 0,
        reasoningTokens: tokens.reasoningTokens ?? 0,
        cacheWriteTokens: tokens.cacheCreationTokens ?? 0,
        totalTokens: inputTokens + outputTokens,
        estimatedUsd: null,
        observedAt: now(),
      };
      this.sink.usage(usage);
    }
    if (
      terminalRunStates.has(native.status) &&
      projection.runs.every((run) => terminalRunStates.has(run.status)) &&
      !projection.providerThreads.some((thread) => thread.pendingBackgroundTasks?.length)
    ) {
      this.receipt(native.status, true);
      this.ending = true;
      this.sink.ended(
        native.status === 'completed'
          ? 'completed'
          : native.status === 'failed'
            ? 'failed'
            : 'interrupted',
        'Native T3 run settled',
        'T3 confirmed the exact run outcome. Its server and other threads remain owned by T3.',
      );
    }
  }
  private fail() {
    if (this.ending || this.closed) return;
    this.ending = true;
    this.sink?.ended(
      'interrupted',
      'Native outcome needs reconciliation',
      'The T3 connection ended. Forge did not replay input or grant permission.',
    );
  }
  async interrupt() {
    if (this.settlement.confirmed) return;
    const projection = await this.projection();
    const run = projection.runs.find((value) => value.userMessageId === this.settlement.messageId);
    assert(
      run && run.id === this.settlement.runId,
      409,
      'The exact native run could not be confirmed for cancellation.',
    );
    if (!terminalRunStates.has(run.status))
      await this.command({
        type: 'run.interrupt',
        commandId: `forge-interrupt-${this.context!.run.id}`,
        threadId: this.settlement.threadId,
        runId: run.id,
        holdQueue: true,
        reason: 'Forge user requested stop',
      });
    // Native acknowledgement is not completion; wait for a terminal projection, bounded and read-only.
    const deadline = Date.now() + 12000;
    do {
      const current = await this.projection();
      const exact = current.runs.find(
        (value) => value.id === run.id && value.userMessageId === this.settlement.messageId,
      );
      if (
        exact &&
        terminalRunStates.has(exact.status) &&
        current.runs.every((run) => terminalRunStates.has(run.status)) &&
        !current.providerThreads.some((thread) => thread.pendingBackgroundTasks?.length)
      ) {
        this.receipt(exact.status, true);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new ForgeError(
      409,
      'Native cancellation is still settling. Reconcile this run before another attempt.',
    );
  }
  async close() {
    if (!this.settlement.confirmed && !this.dispatched) this.receipt('not-dispatched', true);
    if (!this.settlement.confirmed && !this.ending && !this.rpc?.closed)
      await this.interrupt().catch(() => {});
    this.closed = true;
    this.subscription?.close();
    this.rpc?.close();
    for (const control of this.approvals.values()) control.abort.abort();
    this.approvals.clear();
    assert(
      this.settlement.confirmed,
      409,
      'The delegated native run is not confirmed settled. Its lease remains reserved.',
    );
  }
}
