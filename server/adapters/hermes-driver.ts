import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hermesPython } from './hermes-install.js';
import type {
  ClientApp,
  ClientRequestContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  NewSessionResponse,
  LoadSessionResponse,
  PromptResponse,
} from '@agentclientprotocol/sdk';
import type { Account, Usage } from '../../shared/types.js';
import { version } from '../../shared/version.js';
import { assert } from '../errors.js';
import { now } from '../store.js';
import { requestDigest } from './sources.js';
import { findBinary } from './discovery.js';
import { acquireProfileLease } from './profile-lease.js';
import {
  spawnAcpWorker,
  boundedAcpRequest,
  type AcpWorker,
  type AcpWorkerFactory,
} from './acp-worker.js';
import type { DriverContext, DriverSink, NativeDriver } from './driver.js';

export function hermesEnvironment(
  account: Pick<Account, 'nativeHome' | 'credentialEnv'>,
): NodeJS.ProcessEnv {
  assert(account.nativeHome, 409, 'Choose an explicit native Hermes home before launching.');
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.HERMES_HOME = account.nativeHome;
  if (account.credentialEnv) {
    assert(
      !/^(PATH|HOME|CODEX_HOME|XDG_|HERMES_|FORGE_DATA_DIR|TMP|TEMP|SystemRoot|COMSPEC)/i.test(
        account.credentialEnv,
      ),
      409,
      'Choose a provider credential variable, not a runtime setting.',
    );
    assert(
      process.env[account.credentialEnv],
      409,
      `Set ${account.credentialEnv} before launching.`,
    );
    env[account.credentialEnv] = process.env[account.credentialEnv];
  }
  return env;
}
export async function startHermesWorker(
  app: ClientApp,
  account: Account,
  cwd: string,
): Promise<AcpWorker> {
  const env = hermesEnvironment(account);
  const binary = await findBinary('hermes');
  assert(binary, 409, 'Install Hermes with its ACP extra through its native setup first.');
  const python = await hermesPython(binary);
  const release = await acquireProfileLease(account.nativeHome);
  try {
    const worker = await spawnAcpWorker(
      app,
      python,
      [fileURLToPath(new URL('./hermes-native.py', import.meta.url))],
      cwd,
      env,
    );
    let stopped: Promise<void> | null = null;
    return {
      pid: worker.pid,
      connection: worker.connection,
      get exited() {
        return worker.exited;
      },
      stop: () => (stopped ??= worker.stop().finally(release)),
    };
  } catch (error) {
    release();
    throw error;
  }
}
export async function initializeHermesWorker(worker: AcpWorker) {
  const { PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk');
  const agent = worker.connection.agent;
  const init = await boundedAcpRequest(
    worker,
    agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'forge', version },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }),
    15000,
  );
  assert(
    init.protocolVersion === 1 &&
      init.agentInfo?.name === 'hermes-agent' &&
      init.agentInfo.version === '0.17.0' &&
      (init._meta?.forge as { hermesNativeResult?: number } | undefined)?.hermesNativeResult === 1,
    409,
    'This Hermes ACP version did not confirm the native ownership and outcome-reporting contract. No input was sent.',
  );
  const methods = (init.authMethods ?? []).filter(
    (method) => (method as { type?: string }).type !== 'terminal',
  );
  assert(
    methods.length === 1,
    409,
    'Configure an active native Hermes provider through Hermes before launching. Forge does not start interactive sign-in.',
  );
  await boundedAcpRequest(
    worker,
    agent.request('authenticate', { methodId: methods[0].id }),
    10000,
  );
  return init;
}
export async function probeHermesAccount(account: Account): Promise<Account> {
  const { client } = await import('@agentclientprotocol/sdk');
  const app = client({ name: 'Forge status probe' }).onRequest(
    'session/request_permission',
    () => ({ outcome: { outcome: 'cancelled' } }),
  );
  const worker = await startHermesWorker(app, account, account.nativeHome);
  try {
    await initializeHermesWorker(worker);
    return {
      ...account,
      state: 'configured',
      identity: null,
      identityKey: null,
      plan: 'Native Hermes ACP; provider identity and allowance unknown',
      quotas: [],
      checkedAt: now(),
      error: null,
    };
  } finally {
    await worker.stop();
  }
}
type Pending = {
  abort: AbortController;
  toolId: string;
  tool: RequestPermissionRequest['toolCall'];
  finish(result: RequestPermissionResponse): void;
};
type SessionState = NewSessionResponse | LoadSessionResponse;

/** Hermes owns its model loop, memory, skills and native tools. Forge is its ACP host. */
export class HermesDriver implements NativeDriver {
  readonly harness = 'hermes' as const;
  private worker: AcpWorker | null = null;
  private starting: Promise<AcpWorker> | null = null;
  private stopping: Promise<void> | null = null;
  private closing = false;
  private sessionId: string | null = null;
  private executing = false;
  private text = '';
  private pending = new Map<string | number, Pending>();
  private context!: DriverContext;
  private sink!: DriverSink;
  get closed() {
    return this.closing || Boolean(this.worker?.connection.signal.aborted);
  }
  constructor(private factory?: AcpWorkerFactory) {}

  async start(context: DriverContext, sink: DriverSink) {
    assert(
      context.allowMetered && context.account.billingMode !== 'subscription',
      409,
      'Hermes requires explicit external/metered consent. Forge cannot verify or require a native subscription allowance.',
    );
    this.context = context;
    this.sink = sink;
    const { client } = await import('@agentclientprotocol/sdk');
    const app = client({ name: 'Forge' })
      .onRequest('session/request_permission', (request) => this.permission(request))
      .onNotification('session/update', ({ params }) => this.update(params));
    if (this.closing) return;
    this.starting = this.factory
      ? this.factory(app)
      : startHermesWorker(app, context.account, context.work.cwd);
    this.worker = await this.starting;
    if (this.closing) {
      await this.worker.stop();
      return;
    }
    if (this.worker.pid) await sink.worker?.(this.worker.pid);
    const init = await initializeHermesWorker(this.worker);
    const agent = this.worker.connection.agent;
    let state: SessionState;
    if (context.work.nativeSessionId) {
      assert(
        init.agentCapabilities?.loadSession,
        409,
        'Hermes did not advertise native session loading.',
      );
      this.sessionId = context.work.nativeSessionId;
      state = await this.bounded(
        agent.request('session/load', {
          sessionId: this.sessionId,
          cwd: context.work.cwd,
          mcpServers: [],
        }),
        20000,
      );
    } else {
      state = await this.bounded(
        agent.request('session/new', { cwd: context.work.cwd, mcpServers: [] }),
        20000,
      );
      this.sessionId = (state as NewSessionResponse).sessionId;
    }
    assert(
      typeof this.sessionId === 'string' &&
        this.sessionId.length > 0 &&
        this.sessionId.length <= 256,
      502,
      'Hermes did not return a supported native session identity.',
    );
    this.verifySession(state);
    sink.session(this.sessionId);
    assert(
      state.modes && state.modes.availableModes.some((mode) => mode.id === 'default'),
      409,
      'Hermes did not advertise its native default edit-review mode.',
    );
    if (state.modes.currentModeId !== 'default') {
      await this.bounded(
        agent.request('session/set_mode', { sessionId: this.sessionId, modeId: 'default' }),
        10000,
      );
      state = await this.bounded(
        agent.request('session/load', {
          sessionId: this.sessionId,
          cwd: context.work.cwd,
          mcpServers: [],
        }),
        20000,
      );
      this.verifySession(state);
    }
    assert(
      state.modes?.currentModeId === 'default',
      409,
      'Hermes did not confirm native default edit review. No task input was sent.',
    );
    sink.turn(context.run.id);
    sink.activity(
      'native',
      'Hermes connected over ACP',
      'Native tools, memory, skills and provider configuration remain in the selected Hermes home. Native command rules and default edit review apply.',
    );
    if (this.closed) return;
    this.executing = true;
    try {
      const result = await agent.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: context.prompt }],
      });
      this.executing = false;
      this.withdrawAll();
      if (this.closing) return;
      if (this.text) sink.activity('result', 'Native Hermes result', this.text.slice(-16000));
      const report = hermesReport(result, this.sessionId);
      if (report.usage) sink.usage(hermesUsage(context, report));
      const status =
        report.interrupted || result.stopReason === 'cancelled'
          ? 'interrupted'
          : report.failed || report.cleanupFailed
            ? 'failed'
            : report.reported && report.completed && result.stopReason === 'end_turn'
              ? 'completed'
              : 'interrupted';
      sink.ended(
        status,
        'Native Hermes turn ended',
        `ACP stop reason: ${result.stopReason}. Native outcome ${report.reported ? 'reported' : 'unavailable'}; the task's acceptance criteria remain separate.`,
      );
    } finally {
      this.executing = false;
      this.withdrawAll();
    }
  }
  private bounded<T>(request: Promise<T>, milliseconds: number): Promise<T> {
    return boundedAcpRequest(this.worker!, request, milliseconds);
  }
  private verifySession(state: SessionState) {
    const hermes = state._meta?.hermes as
      { sessionProvenance?: { acpSessionId?: string } } | undefined;
    assert(
      hermes?.sessionProvenance?.acpSessionId === this.sessionId,
      409,
      'Hermes did not confirm the selected native session. A missing session cannot silently become a fresh conversation.',
    );
  }
  private update(notification: SessionNotification) {
    if (!this.executing || this.closing || notification.sessionId !== this.sessionId) return;
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
      this.text = (this.text + update.content.text).slice(-16000);
    if (update.sessionUpdate === 'tool_call')
      this.sink.activity('tool', 'Hermes is using a native tool', update.title.slice(0, 300));
    if (update.sessionUpdate === 'current_mode_update' && update.currentModeId !== 'default')
      this.worker?.connection.close(
        new Error('The native Hermes permission mode changed during this attempt.'),
      );
    if (update.sessionUpdate === 'tool_call_update') {
      for (const [id, pending] of this.pending) {
        if (pending.toolId !== update.toolCallId) continue;
        const changed = (['rawInput', 'content', 'title', 'kind', 'locations'] as const).some(
          (key) =>
            update[key] !== undefined &&
            update[key] !== null &&
            requestDigest('acp/value', update[key], 'native', 0) !==
              requestDigest('acp/value', pending.tool[key], 'native', 0),
        );
        if (changed || update.status === 'completed' || update.status === 'failed') {
          pending.abort.abort();
          this.sink.withdrawn(id);
        }
        if (changed)
          this.worker?.connection.close(
            new Error(
              'A pending native ACP permission payload changed. No replacement grant was sent.',
            ),
          );
      }
    }
    // usage_update is native context-window pressure, not billable token usage.
  }
  private permission(
    request: ClientRequestContext<RequestPermissionRequest>,
  ): Promise<RequestPermissionResponse> | RequestPermissionResponse {
    const { params, requestId, signal } = request;
    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (requestId === null) return cancelled;
    const allow = params.options.filter((option) => option.kind === 'allow_once');
    const deny = params.options.filter((option) => option.kind === 'reject_once');
    const command = JSON.stringify(params, null, 2);
    if (this.pending.has(requestId)) {
      this.pending.get(requestId)!.abort.abort();
      this.worker?.connection.close(
        new Error('A native ACP request identity was reused before settlement.'),
      );
      return cancelled;
    }
    if (
      this.closed ||
      !this.executing ||
      params.sessionId !== this.sessionId ||
      signal.aborted ||
      !params.toolCall.toolCallId ||
      command.length > 180000 ||
      allow.length !== 1 ||
      deny.length !== 1 ||
      new Set(params.options.map((option) => option.optionId)).size !== params.options.length ||
      (params.toolCall.rawInput == null && !params.toolCall.content?.length)
    )
      return cancelled;
    return new Promise<RequestPermissionResponse>((resolve) => {
      const abort = new AbortController();
      const finish = (result: RequestPermissionResponse) => {
        if (!this.pending.delete(requestId)) return;
        signal.removeEventListener('abort', cancel);
        abort.signal.removeEventListener('abort', cancel);
        resolve(result);
      };
      const cancel = () => {
        finish(cancelled);
        this.sink.withdrawn(requestId);
      };
      this.pending.set(requestId, {
        abort,
        toolId: params.toolCall.toolCallId,
        tool: params.toolCall,
        finish,
      });
      signal.addEventListener('abort', cancel, { once: true });
      abort.signal.addEventListener('abort', cancel, { once: true });
      this.sink.approval({
        requestId,
        method: 'hermes/acp/request_permission',
        sessionId: params.sessionId,
        turnId: this.context.run.id,
        params,
        command,
        cwd: this.context.work.cwd,
        title: params.toolCall.title?.slice(0, 200) || 'Review native Hermes action',
        detail:
          'Review this exact native request. The selected response is one-time and creates no session or permanent grant.',
        expiresAt: new Date(Date.now() + 55000).toISOString(),
        signal: abort.signal,
        respond: (decision) => {
          assert(
            !this.closed && !signal.aborted && this.pending.has(requestId),
            409,
            'This native ACP request is no longer pending.',
          );
          finish({
            outcome: {
              outcome: 'selected',
              optionId: decision === 'accept' ? allow[0].optionId : deny[0].optionId,
            },
          });
        },
      });
      if (signal.aborted) cancel();
    });
  }
  private withdrawAll() {
    for (const pending of this.pending.values()) pending.abort.abort();
  }
  async interrupt() {
    this.withdrawAll();
    if (this.worker && this.sessionId && !this.worker.connection.signal.aborted)
      await this.worker.connection.agent.notify('session/cancel', { sessionId: this.sessionId });
  }
  close() {
    this.closing = true;
    this.withdrawAll();
    return (this.stopping ??= (async () => {
      const worker = this.worker ?? (await this.starting?.catch(() => null));
      await worker?.stop();
    })());
  }
}

const count = z.number().finite().nonnegative().nullable().optional();
export const hermesReportSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  reported: z.boolean(),
  completed: z.boolean().optional(),
  failed: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  cleanupFailed: z.boolean().optional(),
  usage: z
    .object({
      inputTokens: count,
      outputTokens: count,
      totalTokens: count,
      thoughtTokens: count,
      cachedReadTokens: count,
      cachedWriteTokens: count,
    })
    .optional(),
  estimatedUsd: count,
  costStatus: z.string().max(80).optional(),
});
export type HermesReport = z.infer<typeof hermesReportSchema>;
export function hermesReport(result: PromptResponse, sessionId: string): HermesReport {
  const data = hermesReportSchema.parse(
    (result._meta?.forge as { hermesTurn?: unknown } | undefined)?.hermesTurn,
  );
  assert(
    data.sessionId === sessionId,
    502,
    'The native Hermes turn evidence changed session scope.',
  );
  return data;
}
export function hermesUsage(context: DriverContext, result: HermesReport): Usage {
  const u = result.usage!;
  assert(
    [u.inputTokens, u.outputTokens, u.totalTokens].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
    ),
    502,
    'Hermes did not report complete native usage counters.',
  );
  // Native counters reset on construction. One owned worker receives one prompt, including native queued continuations.
  return {
    key: `hermes-acp:${context.run.id}`,
    counterScope: 'run',
    workId: context.work.id,
    accountId: context.account.id,
    harness: 'hermes',
    source: 'hermes/acp',
    scope: `Native root worker counters; context pressure excluded; native cost status ${result.costStatus || 'unknown'}`,
    inputTokens: u.inputTokens!,
    outputTokens: u.outputTokens!,
    cachedTokens: u.cachedReadTokens ?? 0,
    reasoningTokens: u.thoughtTokens ?? 0,
    cacheWriteTokens: u.cachedWriteTokens ?? 0,
    totalTokens: u.totalTokens!,
    estimatedUsd: ['actual', 'estimated', 'included'].includes(result.costStatus || '')
      ? (result.estimatedUsd ?? null)
      : null,
    observedAt: now(),
  };
}
