import type { Account, Approval, Run, Usage, Work } from '../shared/types.js';
import { assert, safeMessage } from './errors.js';
import { Store, id, now } from './store.js';
import { NativeRpc, type RpcMessage, type RpcOptions } from './adapters/rpc.js';
import { findBinary } from './adapters/discovery.js';
import { nativeEnvironment, readCodexAccount } from './adapters/accounts.js';
import { requestDigest } from './adapters/sources.js';

interface Active {
  rpc: NativeRpc;
  run: Run;
  settled: boolean;
  threadId: string | null;
  turnId: string | null;
  items: Map<string, any>;
  timers: Map<string, NodeJS.Timeout>;
}
export type RpcFactory = (options: RpcOptions) => NativeRpc;
export class CodexController {
  private active = new Map<string, Active>();
  constructor(
    private store: Store,
    private factory: RpcFactory = (options) => new NativeRpc(options),
    private binary = () => findBinary('codex'),
  ) {}
  get activeCount() {
    return this.active.size;
  }
  async launch(workId: string, allowMetered: boolean, reconciled: boolean): Promise<Run> {
    const work = this.store.work(workId);
    assert(
      work.harness === 'codex',
      409,
      'Managed execution is available for Codex in this release. Other harnesses keep their native execution.',
    );
    assert(work.accountId, 409, 'Choose a native Codex account before starting.');
    assert(
      !this.store.settings().quietMode,
      409,
      'Quiet mode pauses new managed work. Turn it off to start this task.',
    );
    assert(
      !this.active.has(workId) && !work.activeRunId,
      409,
      'This task already has a managed attempt. Open its current activity.',
    );
    assert(
      this.active.size < this.store.settings().maxConcurrent,
      409,
      'All managed execution slots are occupied. Wait for an attempt to finish.',
    );
    assert(
      (work.status !== 'interrupted' && work.status !== 'failed') || reconciled,
      409,
      'Review native activity and external effects, then confirm reconciliation before retrying.',
    );
    // First release serializes all managed writers. Avoid pretending directory checks fence detached native effects.
    assert(
      this.active.size === 0,
      409,
      'The first release allows one managed native attempt at a time. Wait for the current attempt to finish.',
    );
    const account = this.store.account(work.accountId);
    const binary = await this.binary();
    assert(binary, 409, 'Codex is not installed on PATH. Complete its native setup first.');
    // Recheck after discovery yields, so simultaneous HTTP launches cannot both reserve the single slot.
    assert(
      this.active.size === 0 &&
        !this.store.work(workId).activeRunId &&
        !this.store.settings().quietMode,
      409,
      'Managed capacity changed. Refresh before starting.',
    );
    assert(
      this.store.work(workId).revision === work.revision &&
        this.store.account(account.id).nativeHome === account.nativeHome,
      409,
      'The task or account changed while preparing the attempt. Review the latest binding before starting.',
    );
    const run: Run = {
      id: id(),
      workId,
      accountId: account.id,
      generation: work.generation + 1,
      nativeSessionId: work.nativeSessionId,
      nativeTurnId: null,
      status: 'starting',
      startedAt: now(),
      endedAt: null,
    };
    const rpc = this.factory({
      binary,
      cwd: work.cwd,
      env: nativeEnvironment(account),
      timeoutMs: 20000,
    });
    const active: Active = {
      rpc,
      run,
      settled: false,
      threadId: null,
      turnId: null,
      items: new Map(),
      timers: new Map(),
    };
    this.active.set(workId, active);
    this.store.transaction(() => {
      this.store.put('runs', run.id, run);
      this.store.updateWork(workId, {
        generation: run.generation,
        activeRunId: run.id,
        status: 'running',
      });
      this.store.event(
        workId,
        'attempt',
        'Starting a native Codex attempt',
        `Account: ${account.label}. Native permissions remain active.`,
      );
    });
    rpc.on('message', (message) => this.message(active, message));
    rpc.on('closed', () => {
      if (!active.settled)
        this.settle(
          active,
          'interrupted',
          'Native connection ended',
          'Inspect native activity and external effects before another attempt. No action was replayed.',
        );
    });
    void this.start(active, work, account, allowMetered).catch((error) => {
      if (!active.settled)
        this.settle(active, 'failed', 'Native attempt could not complete', safeMessage(error));
    });
    return run;
  }
  private async start(active: Active, work: Work, account: Account, allowMetered: boolean) {
    const { rpc } = active;
    await rpc.initialize();
    const checked = await readCodexAccount(rpc, account);
    this.store.put('accounts', account.id, checked);
    const native = await rpc.request('account/read', { refreshToken: false });
    const subscription = native.account?.type === 'chatgpt';
    assert(
      checked.ordinaryUsageAllowed !== false || allowMetered,
      409,
      'The native backend reports included usage unavailable. Wait for native allowance or explicitly permit metered usage before another launch.',
    );
    assert(
      account.billingMode !== 'subscription' || subscription,
      409,
      'This slot requires subscription access, but native Codex selected another billing mode. Check native configuration.',
    );
    assert(
      subscription || allowMetered,
      409,
      'The native route may use metered API or external-provider billing. Explicitly allow it for this launch.',
    );
    const params = {
      cwd: work.cwd,
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    };
    const thread = work.nativeSessionId
      ? await rpc.request('thread/resume', { ...params, threadId: work.nativeSessionId })
      : await rpc.request('thread/start', params);
    assert(
      typeof thread?.thread?.id === 'string',
      502,
      'Native Codex did not confirm a thread. No turn was requested.',
    );
    // Fail closed if the installed server or managed policy selected different permissions.
    assert(
      thread.approvalPolicy === 'untrusted' && thread.sandbox?.type === 'workspaceWrite',
      409,
      "Native Codex did not confirm Forge's requested permission policy. Continue in the native client or check compatibility.",
    );
    active.threadId = thread.thread.id;
    active.run.nativeSessionId = active.threadId;
    this.store.transaction(() => {
      this.store.put('runs', active.run.id, active.run);
      this.store.updateWork(work.id, { nativeSessionId: active.threadId });
      this.store.event(
        work.id,
        'binding',
        'Native session bound to this work',
        'The same native account and session are retained for subsequent turns.',
      );
    });
    const input = this.continuation(work, Boolean(work.nativeSessionId));
    const result = await rpc.request('turn/start', {
      threadId: active.threadId,
      input: [{ type: 'text', text: input, text_elements: [] }],
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
    });
    assert(
      typeof result?.turn?.id === 'string',
      502,
      'Native Codex did not confirm the turn. Inspect the native session before retrying.',
    );
    if (active.settled) return;
    active.turnId = result.turn.id;
    active.run.nativeTurnId = active.turnId;
    active.run.status = 'running';
    this.store.put('runs', active.run.id, active.run);
  }
  private continuation(work: Work, resumed: boolean) {
    const text = [
      `Forge work: ${work.title}`,
      `Goal: ${work.goal}`,
      `Acceptance criteria: ${work.acceptance || 'Report the result and validation.'}`,
      `Project context: ${work.context || "Use the project's native instructions and sources."}`,
      `User checkpoints: ${
        this.store
          .checkpoints(work.id)
          .map((event) => `${event.createdAt}: ${event.detail}`)
          .join('\n') || 'None recorded.'
      }`,
      resumed
        ? 'Continue this existing native session. Reconcile current artifacts before acting.'
        : 'This is the initial native attempt for this work record.',
    ].join('\n\n');
    assert(
      text.length <= 100000,
      409,
      "The continuation context exceeds this release's limit. Select the necessary context before launching.",
    );
    return text;
  }
  private message(active: Active, message: RpcMessage) {
    if (active.settled) return;
    const p = message.params ?? {};
    if (message.id !== undefined && message.method) {
      this.approval(active, message);
      return;
    }
    if (p.threadId && p.threadId !== active.threadId) return;
    if (message.method === 'turn/started' && p.turn?.id) {
      active.turnId = p.turn.id;
      active.run.nativeTurnId = p.turn.id;
    }
    if (message.method === 'serverRequest/resolved') {
      const approval = this.store
        .all<Approval>('approvals')
        .find(
          (a) =>
            a.runId === active.run.id &&
            a.nativeRequestId === p.requestId &&
            a.status === 'pending',
        );
      if (approval) {
        this.store.transaction(() => {
          this.store.put('approvals', approval.id, {
            ...approval,
            status: 'invalidated',
            resolvedAt: now(),
          });
          this.store.event(
            approval.workId,
            'approval',
            'Native request is no longer pending',
            'The harness resolved or withdrew this request. No Forge decision can be sent.',
          );
          const more = this.store
            .all<Approval>('approvals')
            .some((a) => a.runId === active.run.id && a.status === 'pending');
          this.store.updateWork(approval.workId, { status: more ? 'waiting' : 'running' });
        });
        clearTimeout(active.timers.get(approval.id));
        active.timers.delete(approval.id);
      }
    }
    if (message.method === 'item/started' && p.item?.id) active.items.set(p.item.id, p.item);
    if (message.method === 'item/completed' && p.item?.id) {
      const item = p.item;
      active.items.set(item.id, item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        const clipped = item.text.length > 200000;
        this.store.event(
          active.run.workId,
          'assistant',
          'Codex response',
          item.text.slice(0, 200000) +
            (clipped
              ? '\n[Excerpt limit reached. The native session retains the complete message.]'
              : ''),
        );
      } else if (item.type === 'commandExecution') {
        this.store.event(
          active.run.workId,
          'command',
          item.exitCode === 0 ? 'Native command finished' : 'Native command returned',
          String(item.command ?? '').slice(0, 20000),
        );
      } else if (item.type === 'fileChange') {
        this.store.event(
          active.run.workId,
          'artifact',
          'Native file changes reported',
          Array.isArray(item.changes)
            ? item.changes
                .map((c: any) => c.path)
                .join('\n')
                .slice(0, 20000)
            : 'Inspect the native session for details.',
        );
      }
      // Only pending file changes need an in-memory review payload.
      active.items.delete(item.id);
    }
    if (message.method === 'thread/tokenUsage/updated' && p.threadId === active.threadId)
      this.usage(active, p.tokenUsage?.total);
    if (message.method === 'account/updated' && active.turnId) {
      this.settle(
        active,
        'interrupted',
        'Native authentication changed',
        'Review the effective native identity before continuing.',
      );
    }
    if (message.method === 'turn/completed' && p.turn?.id === active.turnId) {
      const status =
        p.turn.status === 'completed'
          ? 'completed'
          : p.turn.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
      this.settle(
        active,
        status,
        status === 'completed' ? 'Native turn completed' : 'Native turn ended',
        status === 'completed'
          ? 'Review the result and artifacts against your acceptance criteria.'
          : 'Inspect native activity and external effects before another attempt.',
      );
    }
    if (message.method === 'error' && p.willRetry === false) {
      this.store.event(
        active.run.workId,
        'error',
        'Native error reported',
        'Open the native session for details. Forge has not started a replacement attempt.',
      );
    }
  }
  private usage(active: Active, total: any) {
    const values = [
      total?.inputTokens,
      total?.outputTokens,
      total?.cachedInputTokens,
      total?.totalTokens,
    ];
    if (!values.every((n) => Number.isSafeInteger(n) && n >= 0)) return;
    const account = this.store.account(active.run.accountId);
    const entry: Usage = {
      key: `codex:${account.identityKey ?? account.id}:${active.threadId}`,
      workId: active.run.workId,
      accountId: account.id,
      harness: 'codex',
      source: 'codex/app-server',
      scope: 'Cumulative native thread',
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      cachedTokens: total.cachedInputTokens,
      totalTokens: total.totalTokens,
      estimatedUsd: null,
      observedAt: now(),
    };
    this.store.saveUsage(entry);
  }
  private approval(active: Active, message: RpcMessage) {
    const p = message.params ?? {};
    const method = message.method!;
    const supported = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ].includes(method);
    const correlated =
      p.threadId === active.threadId && typeof p.turnId === 'string' && p.turnId === active.turnId;
    const command =
      method.includes('commandExecution') &&
      typeof p.command === 'string' &&
      (!p.kind || p.kind === 'command');
    const changes = active.items.get(p.itemId)?.changes;
    const file =
      method.includes('fileChange') && !p.grantRoot && Array.isArray(changes) && changes.length > 0;
    if (!supported || !correlated || (!command && !file)) {
      active.rpc.refuse(message.id!);
      this.store.event(
        active.run.workId,
        'unsupported',
        'Native request needs the native client',
        'This request could not be safely correlated or reviewed in Forge. No permission was granted.',
      );
      return;
    }
    const approval: Approval = {
      id: id(),
      workId: active.run.workId,
      runId: active.run.id,
      generation: active.run.generation,
      nativeRequestId: message.id!,
      method,
      digest: requestDigest(method, p, active.run.id, active.run.generation),
      title: command ? 'Review a native command' : 'Review native file changes',
      detail: String(p.reason ?? 'The native harness is requesting your decision.'),
      command: command ? p.command : JSON.stringify(changes, null, 2),
      cwd: String(p.cwd ?? this.store.work(active.run.workId).cwd),
      status: 'pending',
      createdAt: now(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      resolvedAt: null,
    };
    this.store.transaction(() => {
      this.store.put('approvals', approval.id, approval);
      this.store.updateWork(approval.workId, { status: 'waiting' });
      this.store.event(
        approval.workId,
        'approval',
        'A native decision is waiting',
        approval.detail,
      );
    });
    const timer = setTimeout(
      () => {
        const current = this.store.get<Approval>('approvals', approval.id);
        if (!active.settled && current?.status === 'pending') {
          this.store.put('approvals', approval.id, {
            ...current,
            status: 'expired',
            resolvedAt: now(),
          });
          try {
            active.rpc.respond(approval.nativeRequestId, { decision: 'decline' });
          } catch {
            /* No replay. */
          }
          this.store.event(
            approval.workId,
            'approval',
            'Approval expired',
            'The native request was declined after ten minutes.',
          );
          const more = this.store
            .all<Approval>('approvals')
            .some((a) => a.runId === active.run.id && a.status === 'pending');
          this.store.updateWork(approval.workId, { status: more ? 'waiting' : 'running' });
        }
        active.timers.delete(approval.id);
      },
      10 * 60 * 1000,
    );
    timer.unref();
    active.timers.set(approval.id, timer);
  }
  decide(approvalId: string, digest: string, decision: 'accept' | 'decline') {
    const approval = this.store.get<Approval>('approvals', approvalId);
    assert(
      approval && approval.status === 'pending',
      409,
      'This decision is no longer pending. Refresh the inbox.',
    );
    const active = this.active.get(approval.workId);
    const work = this.store.work(approval.workId);
    assert(
      active &&
        !active.settled &&
        !active.rpc.closed &&
        active.run.id === approval.runId &&
        work.activeRunId === approval.runId &&
        work.generation === approval.generation &&
        approval.digest === digest &&
        Date.parse(approval.expiresAt) > Date.now(),
      409,
      'This approval is stale or belongs to another attempt. No decision was sent.',
    );
    this.store.transaction(() => {
      this.store.put('approvals', approval.id, {
        ...approval,
        status: decision === 'accept' ? 'accepted' : 'declined',
        resolvedAt: now(),
      });
      this.store.event(
        approval.workId,
        'decision',
        decision === 'accept' ? 'Allowed this request once' : 'Declined this request',
        'Decision recorded for the exact native request. No persistent permission rule was created.',
      );
    });
    try {
      active.rpc.respond(approval.nativeRequestId, { decision });
    } catch (error) {
      this.store.put('approvals', approval.id, {
        ...approval,
        status: 'uncertain',
        resolvedAt: now(),
      });
      throw error;
    }
    clearTimeout(active.timers.get(approval.id));
    active.timers.delete(approval.id);
    const pending = this.store
      .all<Approval>('approvals')
      .some((a) => a.runId === active.run.id && a.status === 'pending');
    this.store.updateWork(approval.workId, { status: pending ? 'waiting' : 'running' });
  }
  private settle(
    active: Active,
    status: 'completed' | 'failed' | 'interrupted',
    title: string,
    detail: string,
  ) {
    if (active.settled) return;
    active.settled = true;
    for (const timer of active.timers.values()) clearTimeout(timer);
    active.run.status = status;
    active.run.endedAt = now();
    this.store.transaction(() => {
      this.store.put('runs', active.run.id, active.run);
      this.store.invalidateApprovals(active.run.id);
      this.store.updateWork(active.run.workId, { status, activeRunId: null });
      this.store.event(active.run.workId, status, title, detail);
    });
    // Keep capacity reserved until the process exits. Never kill an unrelated observed PID.
    void active.rpc.stop().finally(() => this.active.delete(active.run.workId));
  }
  async interrupt(workId: string) {
    const active = this.active.get(workId);
    assert(active && !active.settled, 409, 'This task has no live Forge-owned native attempt.');
    if (active.threadId && active.turnId) {
      try {
        await active.rpc.request('turn/interrupt', {
          threadId: active.threadId,
          turnId: active.turnId,
        });
      } catch {
        /* Mark uncertainty; the process is still closed below. */
      }
    }
    this.settle(
      active,
      'interrupted',
      'Managed connection stopped',
      'Review native activity and any detached tools or external effects before continuing.',
    );
  }
  async close() {
    for (const active of this.active.values())
      this.settle(
        active,
        'interrupted',
        'Forge shut down',
        'Native outcome requires reconciliation before another attempt.',
      );
    await Promise.all([...this.active.values()].map((a) => a.rpc.stop()));
  }
}
