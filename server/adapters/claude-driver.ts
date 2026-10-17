import { spawn, type ChildProcess } from 'node:child_process';
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  ModelUsage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Usage } from '../../shared/types.js';
import { assert } from '../errors.js';
import { now } from '../store.js';
import { nativeEnvironment } from './accounts.js';
import type { DriverContext, DriverSink, NativeDriver } from './driver.js';

export type ClaudeQuery = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;
type Pending = { resolve(result: PermissionResult): void; abort(): void };

/** Native Claude Agent SDK transport. Subscription OAuth is deliberately not offered through this SDK. */
export class ClaudeDriver implements NativeDriver {
  readonly harness = 'claude' as const;
  private query: Query | null = null;
  private child: ChildProcess | null = null;
  private childExit: Promise<void> | null = null;
  private stop: Promise<void> | null = null;
  private abortController = new AbortController();
  private pending = new Map<string, Pending>();
  private sessionId: string | null = null;
  private turnId: string | null = null;
  private closing = false;
  private initialized = false;
  private seen = new Set<string>();
  private resultSeen = false;
  private releasePrompt: ((allowed: boolean) => void) | null = null;
  get closed() {
    return this.closing;
  }
  constructor(private queryFactory?: ClaudeQuery) {}
  async start(context: DriverContext, sink: DriverSink) {
    assert(
      context.account.billingMode === 'api',
      409,
      'Claude SDK execution requires an API account slot. Native claude.ai subscription sessions remain in their native client unless upstream approval is established.',
    );
    assert(context.allowMetered, 409, 'Explicitly allow metered usage for this Claude API launch.');
    const env = nativeEnvironment(context.account);
    assert(
      Boolean(env.ANTHROPIC_API_KEY),
      409,
      `Set the ${context.account.credentialEnv || 'ANTHROPIC_API_KEY'} environment variable for this API slot before launching.`,
    );
    const queryFactory =
      this.queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    if (this.closing) return;
    const options: Options = {
      cwd: context.work.cwd,
      env,
      permissionMode: 'default',
      permissionPrompts: 'host',
      settingSources: ['user', 'project', 'local'],
      abortController: this.abortController,
      resume: context.work.nativeSessionId ?? undefined,
      enableFileCheckpointing: true,
      hooks: {
        // Do not override native rules. Block tool execution if startup policy was not confirmed.
        PreToolUse: [
          {
            hooks: [
              async () =>
                this.initialized && !this.closing
                  ? {}
                  : {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason:
                          'Forge has not confirmed the native session policy.',
                      },
                    },
            ],
          },
        ],
      },
      canUseTool: async (toolName, input, permission) => {
        if (['AskUserQuestion', 'ExitPlanMode'].includes(toolName)) {
          sink.activity(
            'unsupported',
            'Native input needs a richer answer',
            'This interactive tool is not a one-time permission decision. Continue through the native client.',
          );
          return {
            behavior: 'deny',
            message:
              'This interactive tool requires a native input surface. Forge did not grant permission or invent an answer.',
          };
        }
        if (
          !this.initialized ||
          this.closing ||
          !this.sessionId ||
          !this.turnId ||
          !permission.requestId ||
          !permission.toolUseID ||
          permission.signal.aborted
        )
          return {
            behavior: 'deny',
            message: 'The native request could not be bound to this attempt.',
          };
        const requestId = permission.requestId;
        if (this.pending.has(requestId))
          return { behavior: 'deny', message: 'Duplicate native permission request.' };
        return new Promise<PermissionResult>((resolve) => {
          const abort = () => {
            if (!this.pending.delete(requestId)) return;
            permission.signal.removeEventListener('abort', abort);
            sink.withdrawn(requestId);
            resolve({ behavior: 'deny', message: 'The native request was withdrawn.' });
          };
          this.pending.set(requestId, { resolve, abort });
          permission.signal.addEventListener('abort', abort, { once: true });
          sink.approval({
            requestId,
            method: `claude/canUseTool/${toolName}`,
            sessionId: this.sessionId!,
            turnId: this.turnId!,
            params: {
              toolName,
              input,
              toolUseID: permission.toolUseID,
              agentID: permission.agentID ?? null,
            },
            title: permission.title || `Review ${toolName}`,
            detail:
              permission.description ||
              permission.decisionReason ||
              'The native harness is requesting a decision for this tool call.',
            command: JSON.stringify({ tool: toolName, input }, null, 2),
            cwd: context.work.cwd,
            signal: permission.signal,
            respond: (decision) => {
              const pending = this.pending.get(requestId);
              assert(
                pending && !permission.signal.aborted && !this.closing,
                409,
                'This native permission request is no longer pending.',
              );
              this.pending.delete(requestId);
              permission.signal.removeEventListener('abort', abort);
              pending.resolve(
                decision === 'accept'
                  ? { behavior: 'allow', updatedInput: input, toolUseID: permission.toolUseID }
                  : {
                      behavior: 'deny',
                      message: 'The user declined this request in Forge.',
                      toolUseID: permission.toolUseID,
                    },
              );
            },
          });
          if (permission.signal.aborted) abort();
        });
      },
      spawnClaudeCodeProcess: (options) => {
        assert(
          !this.child,
          409,
          'The native SDK requested a replacement root worker. Reconcile this attempt before starting another worker.',
        );
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          signal: options.signal,
        });
        this.child = child;
        this.childExit = new Promise((resolve) => {
          child.once('exit', () => resolve());
          child.once('error', () => {
            if (!child.pid) resolve();
          });
        });
        // Native diagnostic output is not persisted or returned: it can contain private data.
        child.stderr?.resume();
        return child;
      },
    };
    // Initialize the same native worker before giving it any model input.
    const admission = new Promise<boolean>((resolve) => {
      this.releasePrompt = resolve;
    });
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      if (await admission)
        yield {
          type: 'user',
          session_id: context.work.nativeSessionId ?? '',
          parent_tool_use_id: null,
          message: { role: 'user', content: context.prompt },
        };
    })();
    this.query = queryFactory({ prompt, options });
    try {
      const account = await this.query.accountInfo();
      assert(
        account.apiKeySource === 'ANTHROPIC_API_KEY' && account.apiProvider === 'firstParty',
        409,
        'The native worker did not confirm the selected API authentication route. No task input was sent.',
      );
      if (this.child?.pid) await sink.worker?.(this.child.pid);
      this.releasePrompt?.(!this.closing);
    } catch (error) {
      this.releasePrompt?.(false);
      throw error;
    }
    for await (const message of this.query) {
      if (this.closing) break;
      this.message(context, sink, message);
    }
    if (!this.closing && !this.resultSeen)
      sink.ended(
        'interrupted',
        'Native Claude stream ended',
        'No final result was confirmed. Inspect the native session before another attempt.',
      );
  }
  private message(context: DriverContext, sink: DriverSink, message: SDKMessage) {
    if (message.type === 'system' && message.subtype === 'init') {
      assert(
        message.permissionMode === 'default' && message.apiKeySource === 'ANTHROPIC_API_KEY',
        409,
        'Native Claude did not confirm API authentication and manual permission mode. Continue through a supported native configuration.',
      );
      assert(
        !context.work.nativeSessionId || context.work.nativeSessionId === message.session_id,
        409,
        'Claude did not resume the selected native session.',
      );
      this.initialized = true;
      this.sessionId = message.session_id;
      this.turnId = context.run.id;
      sink.session(this.sessionId);
      sink.turn(this.turnId);
      sink.account({
        ...context.account,
        state: 'verified',
        plan: 'API (native SDK)',
        identity: 'API credential reference',
        identityKey: null,
        checkedAt: now(),
        error: null,
        quotas: [],
      });
      return;
    }
    if (!this.initialized || message.session_id !== this.sessionId) return;
    if ('uuid' in message && message.uuid && this.seen.has(message.uuid)) return;
    if ('uuid' in message && message.uuid) this.seen.add(message.uuid);
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') sink.activity('assistant', 'Claude response', block.text);
        if (block.type === 'tool_use')
          sink.activity(
            'tool',
            `Native tool: ${block.name}`,
            'The native harness owns execution and permission rules.',
          );
      }
    }
    if (message.type === 'result') {
      this.resultSeen = true;
      const usage = claudeUsage(
        context,
        this.sessionId!,
        message.modelUsage,
        message.total_cost_usd,
      );
      if (usage) sink.usage(usage);
      const success = message.subtype === 'success' && !message.is_error;
      sink.ended(
        success ? 'completed' : 'failed',
        success ? 'Native Claude turn completed' : 'Native Claude turn ended',
        success
          ? 'Review native output and artifacts against your acceptance criteria.'
          : 'Inspect native activity before another attempt. No replacement attempt was started.',
      );
    }
  }
  async interrupt() {
    if (this.initialized) await this.query?.interrupt();
  }
  close(): Promise<void> {
    if (this.stop) return this.stop;
    this.closing = true;
    this.releasePrompt?.(false);
    for (const pending of this.pending.values()) pending.abort();
    this.query?.close();
    this.abortController.abort();
    this.stop = (async () => {
      const child = this.child;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 4000);
        timer.unref();
        await this.childExit;
        clearTimeout(timer);
      }
      this.seen.clear();
    })();
    return this.stop;
  }
}

export function claudeUsage(
  context: DriverContext,
  sessionId: string,
  models: Record<string, ModelUsage> | undefined,
  totalCost: number,
): Usage | null {
  const entries = Object.values(models ?? {});
  if (!entries.length) return null;
  const fields = entries.flatMap((m) => [
    m.inputTokens,
    m.outputTokens,
    m.cacheReadInputTokens,
    m.cacheCreationInputTokens,
  ]);
  if (!fields.every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  const sum = (
    field: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens',
  ) => entries.reduce((total, m) => total + m[field], 0);
  const inputTokens = sum('inputTokens') + sum('cacheCreationInputTokens');
  const cachedTokens = sum('cacheReadInputTokens');
  const outputTokens = sum('outputTokens');
  return {
    key: `claude:${context.account.id}:${sessionId}`,
    workId: context.work.id,
    accountId: context.account.id,
    harness: 'claude',
    source: 'claude/agent-sdk',
    scope: 'Cumulative native session pipeline; excludes native auxiliary calls',
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + cachedTokens + outputTokens,
    estimatedUsd:
      entries.some((m) => m.costBasis === 'unknown') || !Number.isFinite(totalCost) || totalCost < 0
        ? null
        : totalCost,
    observedAt: now(),
  };
}
