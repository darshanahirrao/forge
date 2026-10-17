import type {
  OpenCodeClient,
  PermissionRequest,
  PermissionRule,
  SessionInfo,
} from '@opencode/client';
import type { Usage } from '../../shared/types.js';
import { assert } from '../errors.js';
import { now } from '../store.js';
import { requestDigest } from './sources.js';
import type { DriverContext, DriverSink, NativeDriver } from './driver.js';
import {
  openCodeWorker,
  type OpenCodeConnection,
  type OpenCodeFactory,
} from './opencode-worker.js';

/** Preserve ordered native denials while making native allow rules reviewable for this session. */
export function reviewedOpenCodeRules(rules: readonly PermissionRule[]): PermissionRule[] {
  const reviewed: PermissionRule[] = [
    { action: '*', resource: '*', effect: 'ask' },
    ...rules.map((rule) => ({
      ...rule,
      effect: rule.effect === 'allow' ? ('ask' as const) : rule.effect,
    })),
  ];
  const seen = new Set<string>();
  return reviewed
    .reverse()
    .filter((rule) => {
      const key = JSON.stringify([rule.action, rule.resource, rule.effect]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .reverse();
}
type Pending = { digest: string; request: PermissionRequest };

/** OpenCode owns the model loop, tool stack, descendants, native history and permission queue. */
export class OpenCodeDriver implements NativeDriver {
  readonly harness = 'opencode' as const;
  private worker: OpenCodeConnection | null = null;
  private starting: Promise<OpenCodeConnection> | null = null;
  private stopping: Promise<void> | null = null;
  private abort = new AbortController();
  private closing = false;
  private sessionId: string | null = null;
  private pending = new Map<string, Pending>();
  private owned = new Set<string>();
  private policy: { sessionID: string; reviewed: PermissionRule[] } | null = null;
  get closed() {
    return this.closing || Boolean(this.worker?.transportLost);
  }
  constructor(private factory: OpenCodeFactory = openCodeWorker) {}

  async start(context: DriverContext, sink: DriverSink) {
    assert(
      context.allowMetered,
      409,
      'Allow metered or external-provider billing for this OpenCode launch. Native subscription allowance is not verified by Forge.',
    );
    assert(
      context.account.billingMode !== 'subscription',
      409,
      'Forge cannot verify or require subscription allowance through this OpenCode route. Choose native or API billing.',
    );
    this.starting = this.factory(context.account, context.work.cwd);
    this.worker = await this.starting;
    if (this.closing) {
      await this.worker.stop();
      return;
    }
    if (this.worker.pid) await sink.worker?.(this.worker.pid);
    const c = this.worker.client;
    const location = { directory: context.work.cwd };
    await c.location.get({ location });
    const config = await c.config.get({ location });
    const documents = config.filter((entry) => entry.type === 'document');
    const configuredAgent =
      documents
        .map((entry) => entry.info.default_agent)
        .filter(Boolean)
        .at(-1) || 'build';
    const selectedAgent = await c.agent.get({ agentID: configuredAgent, location });
    assert(
      selectedAgent.data.mode === 'primary' || selectedAgent.data.mode === 'all',
      409,
      'Choose a native primary OpenCode agent.',
    );
    const configuredModel = documents
      .map((entry) => entry.info.model)
      .filter(Boolean)
      .at(-1);
    const selection =
      typeof configuredModel === 'string'
        ? configuredModel.match(/^([^/#]+)\/([^#]+)(?:#([^#]+))?$/)
        : null;
    const model =
      selectedAgent.data.model ??
      (typeof configuredModel === 'object'
        ? {
            providerID: configuredModel.providerID,
            id: configuredModel.model,
            variant: configuredModel.variant,
          }
        : selection
          ? { providerID: selection[1], id: selection[2], variant: selection[3] }
          : undefined);
    assert(
      context.work.nativeSessionId || model,
      409,
      'Choose an explicit default model in this native OpenCode profile before launching.',
    );
    const existing = context.work.nativeSessionId;
    let session = existing
      ? await c.session.get({ sessionID: existing })
      : await c.session.create({
          title: context.work.title,
          agent: configuredAgent,
          model,
          location,
          metadata: { forgeWorkID: context.work.id, forgeAccountID: context.account.id },
        });
    assert(
      session.metadata?.forgeWorkID === context.work.id &&
        session.metadata?.forgeAccountID === context.account.id &&
        !session.parentID &&
        session.location.directory === context.work.cwd,
      409,
      'The OpenCode session did not confirm this work, account and project binding.',
    );
    this.sessionId = session.id;
    this.owned.add(session.id);
    assert(
      session.model,
      409,
      'OpenCode did not confirm the selected native model. No task input was sent.',
    );
    let available = false;
    for (let attempt = 0; attempt < 40 && !this.closing; attempt++) {
      const models = await c.model.list({ location });
      available = models.data.some(
        (m) =>
          m.enabled && m.id === session.model!.id && m.providerID === session.model!.providerID,
      );
      if (available) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(
      available,
      409,
      'The selected OpenCode model is unavailable in this native profile. Connect it through OpenCode first.',
    );
    const active = await c.session.active();
    const inbox = await c.session.inbox.list({ sessionID: session.id });
    assert(
      !active[session.id] && inbox.length === 0,
      409,
      'The native OpenCode session has unfinished input. Reconcile it in the native client first.',
    );
    const agent = await c.agent.get({ agentID: session.agent || 'build', location });
    assert(
      (session.permissions ?? []).length === 0,
      409,
      'This native session has residual permission rules. Reconcile them through OpenCode before resuming; Forge will not reuse an uncertain overlay.',
    );
    const permissions = reviewedOpenCodeRules(agent.data.permissions);
    this.policy = { sessionID: session.id, reviewed: permissions };
    await c.session.update({ sessionID: session.id, permissions });
    session = await c.session.get({ sessionID: session.id });
    assert(
      JSON.stringify(session.permissions) === JSON.stringify(permissions),
      409,
      'OpenCode did not confirm the reviewed native permission rules. No task input was sent.',
    );
    // Prevent the ephemeral server credential from being inherited by ordinary native shell tools.
    await c.session.environment({
      sessionID: session.id,
      variables: { OPENCODE_SERVER_PASSWORD: '' },
    });
    sink.session(session.id);
    sink.turn(context.run.id);
    sink.activity(
      'native',
      'OpenCode connected',
      `Native v2 agent ${session.agent}, model ${session.model!.providerID}/${session.model!.id}. Session allow rules request review; native denials remain in order.`,
    );
    let ready!: () => void;
    let failReady!: (error: unknown) => void;
    const synced = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failReady = reject;
    });
    let connected = false;
    let admitted = false;
    let started = false;
    let ended = false;
    let receipt!: Awaited<ReturnType<OpenCodeClient['session']['prompt']>>;
    let settleAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      settleAdmission = resolve;
    });
    const log = (async () => {
      try {
        for await (const event of c.event.subscribe({ signal: this.abort.signal })) {
          if (event.type === 'server.connected') {
            assert(
              !connected,
              502,
              'OpenCode event transport reconnected. Review native effects before retrying.',
            );
            connected = true;
            ready();
            continue;
          }
          if (
            !admitted ||
            this.closing ||
            !('data' in event) ||
            !('sessionID' in event.data) ||
            event.data.sessionID !== session.id
          )
            continue;
          if (event.type === 'session.execution.started') started = true;
          if (event.type === 'session.text.ended')
            sink.activity('result', 'Native OpenCode result', event.data.text.slice(0, 4000));
          if (event.type === 'session.tool.called')
            sink.activity(
              'tool',
              'OpenCode is using a native tool',
              'Native tool execution remains in the selected profile.',
            );
          if (
            [
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type)
          ) {
            await admission;
            assert(
              started && receipt?.sessionID === session.id,
              502,
              'OpenCode did not confirm execution of this admitted input.',
            );
            await c.session.wait({ sessionID: session.id });
            const input = await c.session.message.get({
              sessionID: session.id,
              messageID: receipt.id,
            });
            const final = await c.session.get({ sessionID: session.id });
            assert(
              input.type === 'user' &&
                final.time.idle &&
                final.time.idle >= receipt.time.created &&
                final.outcome === event.type.slice('session.execution.'.length),
              502,
              'OpenCode did not confirm promotion and final settlement of this input.',
            );
            await this.restorePolicy();
            await this.recordUsage(context, sink);
            ended = true;
            sink.ended(
              event.type === 'session.execution.succeeded'
                ? 'completed'
                : event.type === 'session.execution.failed'
                  ? 'failed'
                  : 'interrupted',
              'Native OpenCode attempt ended',
              'Native input promotion, settlement and outcome were checked. Owned server exit is required before another launch.',
            );
            return;
          }
        }
        if (!this.closing && !ended)
          throw new Error(
            'Native OpenCode events disconnected. Review native effects before retrying.',
          );
      } catch (error) {
        failReady(error);
        if (!this.closing) throw error;
      }
    })();
    // Attach a handler immediately: the stream may fail before its initial synchronization marker.
    void log.catch(() => {});
    try {
      await Promise.race([
        synced,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('OpenCode did not connect its native event stream.')),
            10000,
          );
          timer.unref();
          void synced.finally(() => clearTimeout(timer)).catch(() => {});
        }),
      ]);
      if (this.closing) return;
      admitted = true;
      try {
        receipt = await c.session.prompt({
          sessionID: session.id,
          text: context.prompt,
          resume: true,
        });
      } finally {
        settleAdmission();
      }
      const monitor = (async () => {
        while (!this.closing && !ended && !this.abort.signal.aborted) {
          assert(
            !this.worker?.exited && !this.worker?.transportLost,
            502,
            'The owned OpenCode server or event transport was lost before a final native outcome.',
          );
          await this.reconcile(context, sink);
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.abort.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(done, 250);
            this.abort.signal.addEventListener('abort', done, { once: true });
            if (this.abort.signal.aborted) done();
          });
        }
      })();
      void monitor.catch(() => {});
      await Promise.race([log, monitor]);
    } finally {
      this.abort.abort();
    }
  }

  private async isOwned(c: OpenCodeClient, sessionID: string): Promise<boolean> {
    if (this.owned.has(sessionID)) return true;
    const chain: string[] = [];
    let current: string | undefined = sessionID;
    for (let i = 0; current && i < 16; i++) {
      if (chain.includes(current)) return false;
      if (this.owned.has(current)) {
        for (const id of chain) this.owned.add(id);
        return true;
      }
      chain.push(current);
      current = (await c.session.get({ sessionID: current })).parentID;
    }
    return false;
  }
  private async payload(c: OpenCodeClient, request: PermissionRequest) {
    assert(
      request.source?.type === 'tool',
      409,
      'This OpenCode request has no native tool identity.',
    );
    const message = await c.session.message.get({
      sessionID: request.sessionID,
      messageID: request.source.messageID,
    });
    const tool =
      message.type === 'assistant'
        ? message.content.find((part) => part.type === 'tool' && part.id === request.source!.id)
        : null;
    assert(
      tool?.type === 'tool' && tool.state.status === 'running',
      409,
      'The native tool input is not pending.',
    );
    const params = { request, tool: { id: tool.id, name: tool.name, input: tool.state.input } };
    const command = JSON.stringify(params, null, 2);
    assert(
      command.length <= 180000,
      409,
      'This native tool request exceeds the current review limit.',
    );
    return {
      params,
      command,
      tool,
      digest: requestDigest('opencode/permission', params, 'native', 0),
    };
  }
  private async reconcile(context: DriverContext, sink: DriverSink) {
    const c = this.worker!.client;
    const requests = await c.permission.request.list({ location: { directory: context.work.cwd } });
    const live = new Set<string>();
    for (const request of requests.data) {
      if (!(await this.isOwned(c, request.sessionID))) continue;
      const key = `${request.sessionID}:${request.id}`;
      live.add(key);
      let value: Awaited<ReturnType<OpenCodeDriver['payload']>>;
      try {
        value = await this.payload(c, request);
      } catch (error) {
        try {
          await c.permission.get({ sessionID: request.sessionID, requestID: request.id });
        } catch (lookup) {
          if (
            typeof lookup === 'object' &&
            lookup &&
            '_tag' in lookup &&
            lookup._tag === 'PermissionNotFoundError'
          ) {
            this.pending.delete(key);
            sink.withdrawn(key);
            continue;
          }
          throw lookup;
        }
        throw error;
      }
      const old = this.pending.get(key);
      assert(
        !old || old.digest === value.digest,
        409,
        'A pending OpenCode tool input changed. No replacement grant was sent.',
      );
      if (old || this.closing) continue;
      this.pending.set(key, { request, digest: value.digest });
      sink.approval({
        requestId: key,
        method: `opencode/permission/${request.action}`,
        sessionId: this.sessionId!,
        turnId: context.run.id,
        params: value.params,
        title: `Review OpenCode ${value.tool.name}`,
        detail: `${request.action}: ${request.resources.join(', ')}. Declining dismisses every pending request in this native session.`,
        command: value.command,
        cwd: context.work.cwd,
        respond: async (decision) => {
          assert(
            !this.closing && this.pending.get(key)?.digest === value.digest,
            409,
            'This OpenCode request is no longer pending.',
          );
          const current = await c.permission.get({
            sessionID: request.sessionID,
            requestID: request.id,
          });
          const checked = await this.payload(c, current);
          assert(
            checked.digest === value.digest,
            409,
            'The native tool request changed after review.',
          );
          // This mutation is sent once. An uncertain HTTP reply is never replayed.
          await c.permission.reply({
            sessionID: request.sessionID,
            requestID: request.id,
            decision: decision === 'accept' ? 'once' : 'reject',
          });
          this.pending.delete(key);
          if (decision === 'decline') {
            for (const [other, pending] of this.pending)
              if (pending.request.sessionID === request.sessionID) {
                this.pending.delete(other);
                sink.withdrawn(other);
              }
          }
        },
      });
    }
    for (const key of this.pending.keys())
      if (!live.has(key)) {
        this.pending.delete(key);
        sink.withdrawn(key);
      }
    const forms = await c.form.list({ location: { directory: context.work.cwd } });
    for (const form of forms.data)
      if (await this.isOwned(c, form.sessionID)) {
        throw new Error(
          'OpenCode needs a native interactive form. No answer was invented. Reconcile in the native client before retrying.',
        );
      }
  }
  private async recordUsage(context: DriverContext, sink: DriverSink) {
    for (const sessionID of this.owned) {
      const session = await this.worker!.client.session.get({ sessionID });
      sink.usage(openCodeUsage(context, session));
    }
  }
  private async restorePolicy() {
    if (!this.policy || !this.worker || this.worker.transportLost || this.worker.exited) return;
    const c = this.worker.client;
    const active = await c.session.active();
    for (const id of Object.keys(active))
      assert(
        !(await this.isOwned(c, id)),
        409,
        'Native OpenCode descendant execution is still active. Its permissions were retained; reconcile native activity before continuing.',
      );
    const session = await c.session.get({ sessionID: this.policy.sessionID });
    assert(
      JSON.stringify(session.permissions ?? []) === JSON.stringify(this.policy.reviewed),
      409,
      'Native session permission rules changed outside this attempt. They were not overwritten.',
    );
    await c.session.update({ sessionID: session.id, permissions: [] });
    const checked = await c.session.get({ sessionID: session.id });
    assert(
      (checked.permissions ?? []).length === 0,
      502,
      'OpenCode did not remove the temporary review rules. Reconcile before resuming.',
    );
    this.policy = null;
  }
  async interrupt() {
    if (this.worker && this.sessionId && !this.worker.exited) {
      await this.worker.client.session.interrupt(
        { sessionID: this.sessionId },
        { signal: AbortSignal.timeout(5000) },
      );
      await this.worker.client.session.wait(
        { sessionID: this.sessionId },
        { signal: AbortSignal.timeout(5000) },
      );
    }
  }
  close() {
    this.closing = true;
    this.abort.abort();
    return (this.stopping ??= (async () => {
      const worker = this.worker ?? (await this.starting?.catch(() => null));
      try {
        await this.restorePolicy().catch(() => {});
      } finally {
        await worker?.stop();
      }
    })());
  }
}

export function openCodeUsage(context: DriverContext, session: SessionInfo): Usage {
  const t = session.tokens;
  const values = [t.input, t.output, t.reasoning, t.cache.read, t.cache.write];
  assert(
    values.every((n) => Number.isFinite(n) && n >= 0) &&
      Number.isFinite(session.cost) &&
      session.cost >= 0,
    502,
    'OpenCode returned invalid native usage.',
  );
  return {
    key: `opencode:${context.account.id}:${session.id}`,
    workId: context.work.id,
    accountId: context.account.id,
    harness: 'opencode',
    source: 'opencode/v2',
    scope: `Cumulative native session ${session.id}; provider estimate, not an invoice`,
    inputTokens: t.input,
    outputTokens: t.output,
    cachedTokens: t.cache.read,
    reasoningTokens: t.reasoning,
    cacheWriteTokens: t.cache.write,
    totalTokens: values.reduce((a, b) => a + b, 0),
    estimatedUsd: session.cost,
    observedAt: now(),
  };
}
