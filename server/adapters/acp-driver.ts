import type {
  ClientApp,
  ClientRequestContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  NewSessionResponse,
  LoadSessionResponse,
  PromptResponse,
  InitializeResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import type { Usage } from '../../shared/types.js';
import { assert } from '../errors.js';
import { requestDigest } from './sources.js';
import { boundedAcpRequest, type AcpWorker, type AcpWorkerFactory } from './acp-worker.js';
import type { DriverContext, DriverSink, NativeDriver } from './driver.js';

export interface AcpDialect {
  harness: string;
  name: string;
  mode: string;
  configModes?: boolean;
  coverage: string;
  start(app: ClientApp, context: DriverContext): Promise<AcpWorker>;
  initialize(worker: AcpWorker): Promise<InitializeResponse>;
  configureSession?(
    worker: AcpWorker,
    state: NewSessionResponse | LoadSessionResponse,
    sessionId: string,
  ): Promise<NewSessionResponse | LoadSessionResponse>;
  verifySession?(state: NewSessionResponse | LoadSessionResponse, sessionId: string): void;
  report(
    result: PromptResponse,
    context: DriverContext,
    sessionId: string,
  ): { status: 'completed' | 'failed' | 'interrupted'; detail: string; usage?: Usage };
}

type Pending = {
  abort: AbortController;
  toolId: string;
  tool: RequestPermissionRequest['toolCall'];
  finish(result: RequestPermissionResponse): void;
};
type SessionState = NewSessionResponse | LoadSessionResponse;
export function acpMode(
  state: { modes?: SessionState['modes']; configOptions?: SessionConfigOption[] | null },
  configModes = false,
) {
  const legacy = state.modes
    ? {
        current: state.modes.currentModeId,
        available: state.modes.availableModes.map((mode) => mode.id),
        configId: null,
      }
    : null;
  if (!configModes) return legacy;
  const candidates = configModes
    ? (state.configOptions ?? []).filter((option) => option.category === 'mode')
    : [];
  if (candidates.length === 0) return legacy;
  if (candidates.length !== 1 || candidates[0].type !== 'select') return null;
  const config = candidates[0];
  const options = config.options.flatMap((option) =>
    'options' in option ? option.options : [option],
  );
  if (legacy && legacy.current !== config.currentValue) return null;
  return {
    current: config.currentValue,
    available: options
      .map((option) => option.value)
      .filter((value) => !legacy || legacy.available.includes(value)),
    configId: config.id,
  };
}

/** The official SDK handles ACP; the selected agent owns its tools, policy and model loop. */
export class AcpDriver implements NativeDriver {
  get harness() {
    return this.dialect.harness;
  }
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
  constructor(
    private dialect: AcpDialect,
    private factory?: AcpWorkerFactory,
  ) {}

  async start(context: DriverContext, sink: DriverSink) {
    assert(
      context.allowMetered && context.account.billingMode !== 'subscription',
      409,
      `${this.dialect.name} requires explicit external/metered consent. Native provider identity and allowance require separate evidence.`,
    );
    this.context = context;
    this.sink = sink;
    const { client } = await import('@agentclientprotocol/sdk');
    const app = client({ name: 'Forge' })
      .onRequest('session/request_permission', (request) => this.permission(request))
      .onNotification('session/update', ({ params }) => this.update(params));
    if (this.closing) return;
    this.starting = this.factory ? this.factory(app) : this.dialect.start(app, context);
    this.worker = await this.starting;
    if (this.closing) {
      await this.worker.stop();
      return;
    }
    if (this.worker.pid) await sink.worker?.(this.worker.pid);
    const init = await this.dialect.initialize(this.worker);
    const agent = this.worker.connection.agent;
    let state: SessionState;
    if (context.work.nativeSessionId) {
      assert(
        init.agentCapabilities?.loadSession,
        409,
        'The selected native agent did not advertise session loading. No history fallback was used.',
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
      'The native agent did not return a supported session identity.',
    );
    if (this.dialect.configureSession)
      state = await this.dialect.configureSession(this.worker, state, this.sessionId);
    this.verifySession(state);
    sink.session(this.sessionId);
    let mode = acpMode(state, this.dialect.configModes);
    assert(
      mode && mode.available.includes(this.dialect.mode),
      409,
      'The native agent did not advertise the configured permission mode.',
    );
    if (mode.current !== this.dialect.mode && mode.configId) {
      const changed = await this.bounded(
        agent.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: mode.configId,
          value: this.dialect.mode,
        }),
        10000,
      );
      mode = acpMode(changed, true);
    } else if (mode.current !== this.dialect.mode) {
      assert(
        init.agentCapabilities?.loadSession,
        409,
        'The native agent must start in the configured permission mode or advertise session loading to confirm a mode change.',
      );
      await this.bounded(
        agent.request('session/set_mode', { sessionId: this.sessionId, modeId: this.dialect.mode }),
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
      mode = acpMode(state, this.dialect.configModes);
    }
    assert(
      mode?.current === this.dialect.mode,
      409,
      'The native agent did not confirm the configured permission mode. No task input was sent.',
    );
    sink.turn(context.run.id);
    sink.activity('native', `${this.dialect.name} connected over ACP`, this.dialect.coverage);
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
      if (this.text)
        sink.activity('result', `Native ${this.dialect.name} result`, this.text.slice(-16000));
      const report = this.dialect.report(result, context, this.sessionId);
      if (report.usage) sink.usage(report.usage);
      sink.ended(report.status, `Native ${this.dialect.name} turn ended`, report.detail);
    } finally {
      this.executing = false;
      this.withdrawAll();
    }
  }
  private bounded<T>(request: Promise<T>, milliseconds: number): Promise<T> {
    return boundedAcpRequest(this.worker!, request, milliseconds);
  }
  private verifySession(state: SessionState) {
    this.dialect.verifySession?.(state, this.sessionId!);
  }
  private update(notification: SessionNotification) {
    if (!this.executing || this.closing || notification.sessionId !== this.sessionId) return;
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
      this.text = (this.text + update.content.text).slice(-16000);
    if (update.sessionUpdate === 'tool_call')
      this.sink.activity(
        'tool',
        `${this.dialect.name} is using a native tool`,
        update.title.slice(0, 300),
      );
    if (
      update.sessionUpdate === 'current_mode_update' &&
      update.currentModeId !== this.dialect.mode
    )
      this.worker?.connection.close(
        new Error(`The native ${this.dialect.name} permission mode changed during this attempt.`),
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
    if (update.sessionUpdate === 'config_option_update' && this.dialect.configModes) {
      try {
        assert(
          acpMode(update, true)?.current === this.dialect.mode,
          409,
          'The native ACP permission mode changed or became unavailable.',
        );
        this.verifySession(update);
      } catch {
        this.worker?.connection.close(new Error('The native ACP mode or model binding changed.'));
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
        if (!abort.signal.aborted) abort.abort();
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
        method: `${this.harness}/acp/request_permission`,
        sessionId: params.sessionId,
        turnId: this.context.run.id,
        params,
        command,
        cwd: this.context.work.cwd,
        title: params.toolCall.title?.slice(0, 200) || `Review native ${this.dialect.name} action`,
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
