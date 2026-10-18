import type { Usage } from '../../shared/types.js';
import { assert } from '../errors.js';
import { now } from '../store.js';
import { nativeEnvironment, readCodexAccount } from './accounts.js';
import { findBinary } from './discovery.js';
import type { DriverContext, DriverSink, NativeDriver } from './driver.js';
import { NativeRpc, type RpcMessage, type RpcOptions } from './rpc.js';
import { readCodexHistory } from './codex-history.js';
import { accountBinding } from './binding.js';

export type RpcFactory = (options: RpcOptions) => NativeRpc;
export class CodexDriver implements NativeDriver {
  readonly harness = 'codex' as const;
  private rpc: NativeRpc | null = null;
  private sessionId: string | null = null;
  private turnId: string | null = null;
  private items = new Map<string, any>();
  private sink: DriverSink | null = null;
  private context: DriverContext | null = null;
  private closing = false;
  private importedUsageBaseline: number[] | null = null;
  get closed() {
    return this.closing || Boolean(this.rpc?.closed);
  }
  constructor(
    private factory: RpcFactory = (options) => new NativeRpc(options),
    private binary = () => findBinary('codex'),
  ) {}
  async start(context: DriverContext, sink: DriverSink) {
    this.context = context;
    this.sink = sink;
    const origin = context.work.nativeOrigin;
    const fork = origin?.state === 'pending' && !context.work.nativeSessionId;
    const retaining = Boolean(
      origin &&
      origin.state !== 'context-only' &&
      (fork || origin.boundSessionId === context.work.nativeSessionId),
    );
    if (retaining && origin)
      assert(
        context.account.id === origin.accountId &&
          accountBinding(context.account) === origin.accountBinding &&
          context.work.cwd === origin.cwd,
        409,
        'This native history belongs to another account or project binding. Prepare a fresh continuation review.',
      );
    const binary = await this.binary();
    assert(binary, 409, 'Codex is not installed on PATH. Complete its native setup first.');
    if (this.closing) return;
    const rpc = this.factory({
      spawnNative: context.spawnNative,
      binary,
      cwd: context.work.cwd,
      env: nativeEnvironment(context.account, context.credentials),
      timeoutMs: 20000,
    });
    this.rpc = rpc;
    rpc.on('message', (message) => this.message(message));
    rpc.on('closed', () => {
      if (!this.closing)
        sink.ended(
          'interrupted',
          'Native connection ended',
          'Inspect native activity and external effects before another attempt. No action was replayed.',
        );
    });
    if (rpc.child.pid) await sink.worker?.(rpc.child.pid);
    await rpc.initialize(Boolean(fork));
    const checked = await readCodexAccount(rpc, context.account);
    this.context = { ...context, account: checked };
    sink.account(checked);
    const native = await rpc.request('account/read', { refreshToken: false });
    const subscription = native.account?.type === 'chatgpt';
    assert(
      checked.ordinaryUsageAllowed !== false || context.allowMetered,
      409,
      'The native backend reports included usage unavailable. Wait for native allowance or explicitly permit metered usage before another launch.',
    );
    assert(
      context.account.billingMode !== 'subscription' || subscription,
      409,
      'This slot requires subscription access, but native Codex selected another billing mode. Check native configuration.',
    );
    assert(
      subscription || context.allowMetered,
      409,
      'The native route may use metered API or external-provider billing. Explicitly allow it for this launch.',
    );
    if (retaining && origin) {
      assert(
        accountBinding(checked) === origin.accountBinding,
        409,
        'Native identity changed after the history review. Review the source and account again.',
      );
      assert(
        origin.modelProvider === 'openai' || context.allowMetered,
        409,
        'This stored chat uses an external native provider. Explicitly allow its metered usage before continuing.',
      );
    }
    if (fork) {
      const current = await readCodexHistory(rpc, origin.threadId);
      assert(
        current.digest === origin.digest &&
          current.lastTurnId === origin.lastTurnId &&
          current.cwd === origin.cwd &&
          current.modelProvider === origin.modelProvider &&
          current.turns === origin.turns &&
          current.items === origin.items,
        409,
        'Native chat history changed after review. No fork or model input was requested. Prepare a fresh continuation review.',
      );
    }
    if (this.closing) return;
    if (retaining && origin && !fork)
      assert(
        (await rpc.request('thread/goal/get', { threadId: context.work.nativeSessionId })).goal ===
          null,
        409,
        'The managed fork has an autonomous native goal. Pause and clear it in the native client before another managed input.',
      );
    const params = {
      cwd: context.work.cwd,
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    };
    const result = fork
      ? await rpc.request('thread/fork', {
          ...params,
          threadId: origin.threadId,
          lastTurnId: origin.lastTurnId,
          excludeTurns: true,
          deferGoalContinuation: true,
          runtimeWorkspaceRoots: [context.work.cwd],
        })
      : context.work.nativeSessionId
        ? await rpc.request('thread/resume', { ...params, threadId: context.work.nativeSessionId })
        : await rpc.request('thread/start', params);
    assert(
      typeof result?.thread?.id === 'string',
      502,
      'Native Codex did not confirm a thread. No turn was requested.',
    );
    if (retaining && origin && !fork)
      assert(
        result.cwd === origin.cwd && result.modelProvider === origin.modelProvider,
        409,
        'The retained native fork changed its project or provider. Review a verified handoff before another input.',
      );
    if (fork) {
      assert(
        result.thread.id !== origin.threadId &&
          result.thread.forkedFromId === origin.threadId &&
          result.cwd === origin.cwd &&
          result.modelProvider === origin.modelProvider &&
          result.approvalsReviewer === 'user' &&
          Array.isArray(result.runtimeWorkspaceRoots) &&
          result.runtimeWorkspaceRoots.length === 1 &&
          result.runtimeWorkspaceRoots[0] === origin.cwd,
        409,
        'Native Codex did not confirm the reviewed fork, provider and project scope. No task input was sent.',
      );
      const copied = await readCodexHistory(rpc, result.thread.id);
      assert(
        copied.digest === origin.digest &&
          copied.lastTurnId === origin.lastTurnId &&
          copied.turns === origin.turns &&
          copied.items === origin.items,
        409,
        'The native fork did not retain the complete reviewed history. No task input was sent. Inspect the native fork before retrying.',
      );
      await rpc.request('thread/goal/clear', { threadId: result.thread.id });
      assert(
        (await rpc.request('thread/goal/get', { threadId: result.thread.id })).goal === null,
        409,
        'The native fork did not confirm its inherited goal was cleared. No task input was sent.',
      );
      sink.activity(
        'continuation',
        'Native chat history retained',
        `${origin.turns} native turns and ${origin.items} items match the reviewed history. The fork has fresh human permissions and no inherited autonomous goal.`,
      );
    }
    assert(
      result.approvalPolicy === 'untrusted' && result.sandbox?.type === 'workspaceWrite',
      409,
      "Native Codex did not confirm Forge's requested permission policy. Continue in the native client or check compatibility.",
    );
    if (this.closing) return;
    this.sessionId = result.thread.id;
    sink.session(this.sessionId!);
    const turn = await rpc.request('turn/start', {
      threadId: this.sessionId,
      input: [{ type: 'text', text: context.prompt, text_elements: [] }],
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
    });
    assert(
      typeof turn?.turn?.id === 'string',
      502,
      'Native Codex did not confirm the turn. Inspect the native session before retrying.',
    );
    if (!this.closing) {
      this.turnId = turn.turn.id;
      sink.turn(this.turnId!);
    }
  }
  private message(message: RpcMessage) {
    if (this.closing || !this.sink || !this.context || !this.rpc) return;
    const sink = this.sink;
    const p = message.params ?? {};
    if (message.id !== undefined && message.method) {
      const method = message.method;
      const correlated =
        p.threadId === this.sessionId && typeof p.turnId === 'string' && p.turnId === this.turnId;
      const command =
        method === 'item/commandExecution/requestApproval' &&
        typeof p.command === 'string' &&
        (!p.kind || p.kind === 'command');
      const changes = this.items.get(p.itemId)?.changes;
      const file =
        method === 'item/fileChange/requestApproval' &&
        !p.grantRoot &&
        Array.isArray(changes) &&
        changes.length > 0;
      if (!correlated || (!command && !file)) {
        this.rpc.refuse(message.id);
        sink.activity(
          'unsupported',
          'Native request needs the native client',
          'This request could not be safely correlated or reviewed in Forge. No permission was granted.',
        );
        return;
      }
      const requestId = message.id;
      sink.approval({
        requestId,
        method,
        sessionId: this.sessionId!,
        turnId: this.turnId!,
        params: p,
        title: command ? 'Review a native command' : 'Review native file changes',
        detail: String(p.reason ?? 'The native harness is requesting your decision.'),
        command: command ? p.command : JSON.stringify(changes, null, 2),
        cwd: String(p.cwd ?? this.context.work.cwd),
        respond: (decision) => this.rpc!.respond(requestId, { decision }),
      });
      return;
    }
    if (p.threadId && p.threadId !== this.sessionId) return;
    if (message.method === 'turn/started' && p.turn?.id) {
      this.turnId = p.turn.id;
      sink.turn(p.turn.id);
    }
    if (message.method === 'serverRequest/resolved') sink.withdrawn(p.requestId);
    if (message.method === 'item/started' && p.item?.id) this.items.set(p.item.id, p.item);
    if (message.method === 'item/completed' && p.item?.id) {
      const item = p.item;
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        sink.activity('assistant', 'Codex response', item.text);
      } else if (item.type === 'commandExecution') {
        sink.activity(
          'command',
          item.exitCode === 0 ? 'Native command finished' : 'Native command returned',
          String(item.command ?? '').slice(0, 20000),
        );
      } else if (item.type === 'fileChange') {
        sink.activity(
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
      this.items.delete(item.id);
    }
    if (
      message.method === 'thread/tokenUsage/updated' &&
      p.threadId === this.sessionId &&
      (!this.context.work.nativeOrigin || p.turnId === this.turnId)
    )
      this.usage(p.tokenUsage?.total, p.tokenUsage?.last);
    if (message.method === 'account/updated' && this.turnId)
      sink.ended(
        'interrupted',
        'Native authentication changed',
        'Review the effective native identity before continuing.',
      );
    if (message.method === 'turn/completed' && p.turn?.id === this.turnId) {
      const status =
        p.turn.status === 'completed'
          ? 'completed'
          : p.turn.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
      sink.ended(
        status,
        status === 'completed' ? 'Native turn completed' : 'Native turn ended',
        status === 'completed'
          ? 'Review the result and artifacts against your acceptance criteria.'
          : 'Inspect native activity and external effects before another attempt.',
      );
    }
    if (message.method === 'error' && p.willRetry === false)
      sink.activity(
        'error',
        'Native error reported',
        'Open the native session for details. Forge has not started a replacement attempt.',
      );
  }
  private usage(total: any, last?: any) {
    if (
      ![
        total?.inputTokens,
        total?.outputTokens,
        total?.cachedInputTokens,
        total?.totalTokens,
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      return;
    const { work, account } = this.context!;
    let values = [
      total.inputTokens,
      total.outputTokens,
      total.cachedInputTokens,
      total.totalTokens,
    ];
    if (work.nativeOrigin) {
      const current = [
        last?.inputTokens,
        last?.outputTokens,
        last?.cachedInputTokens,
        last?.totalTokens,
      ];
      if (!current.every((value) => Number.isSafeInteger(value) && value >= 0)) return;
      if (!this.importedUsageBaseline) {
        const baseline = values.map((value, index) => value - current[index]);
        if (baseline.some((value) => value < 0)) return;
        this.importedUsageBaseline = baseline;
      }
      values = values.map((value, index) => value - this.importedUsageBaseline![index]);
      if (values.some((value) => value < 0)) return;
    }
    const entry: Usage = {
      key: `codex:${account.identityKey ?? account.id}:${work.nativeOrigin ? this.context!.run.id : this.sessionId}`,
      counterScope: work.nativeOrigin ? 'run' : 'session',
      workId: work.id,
      accountId: account.id,
      harness: 'codex',
      source: 'codex/app-server',
      scope: work.nativeOrigin
        ? 'Native run after history continuation; prior usage excluded'
        : 'Cumulative native thread',
      inputTokens: values[0],
      outputTokens: values[1],
      cachedTokens: values[2],
      totalTokens: values[3],
      estimatedUsd: null,
      observedAt: now(),
    };
    this.sink!.usage(entry);
  }
  async interrupt() {
    if (this.sessionId && this.turnId && this.rpc && !this.rpc.closed)
      await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId });
  }
  async close() {
    this.closing = true;
    await this.rpc?.stop();
    this.items.clear();
  }
}
