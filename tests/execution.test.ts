import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Options,
  Query,
  SDKMessage,
  ModelUsage,
  NonNullableUsage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Account, Approval, Harness, Usage, Work } from '../shared/types.js';
import type {
  DriverContext,
  DriverSink,
  NativeApproval,
  NativeDriver,
} from '../server/adapters/driver.js';
import { ExecutionController } from '../server/execution.js';
import { ClaudeDriver, claudeUsage } from '../server/adapters/claude-driver.js';
import { Store, now } from '../server/store.js';
import { fileURLToPath } from 'node:url';
import { usageSummary } from '../shared/usage.js';

function prepared(store: Store, harness: Harness, suffix = '') {
  const account: Account = {
    id: `account-${harness}${suffix}`,
    label: `Fixture ${harness}`,
    harness,
    nativeHome: '',
    billingMode: 'api',
    credentialEnv: 'FORGE_FIXTURE_CLAUDE_KEY',
    state: 'configured',
    identity: null,
    identityKey: null,
    plan: null,
    checkedAt: null,
    error: null,
    quotas: [],
    createdAt: now(),
  };
  const work: Work = {
    id: `work-${harness}${suffix}`,
    title: 'A persistent work fixture',
    project: 'Fixture',
    cwd: process.cwd(),
    goal: 'Keep the goal with its work.',
    acceptance: 'A verified artifact.',
    context: 'Durable context.',
    harness,
    accountId: account.id,
    status: 'ready',
    priority: 'normal',
    generation: 0,
    revision: 0,
    nativeSessionId: null,
    activeRunId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  store.put('accounts', account.id, account);
  store.put('work', work.id, work);
  return { work, account };
}
async function waitFor(fn: () => boolean, label: string) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${label}`);
}
class FixtureDriver implements NativeDriver {
  closed = false;
  sink!: DriverSink;
  context!: DriverContext;
  decisions: string[] = [];
  exit: Promise<void> = Promise.resolve();
  constructor(readonly harness: Harness) {}
  async start(context: DriverContext, sink: DriverSink) {
    this.context = context;
    this.sink = sink;
    sink.session(`session-${context.work.id}`);
    sink.turn('turn-1');
  }
  request(signal?: AbortSignal, expiresAt?: string) {
    const request: NativeApproval = {
      requestId: 'request-1',
      method: 'fixture/permission',
      sessionId: `session-${this.context.work.id}`,
      turnId: 'turn-1',
      params: { action: 'fixture' },
      title: 'Review fixture',
      detail: 'No command will be executed.',
      command: 'fixture input',
      cwd: process.cwd(),
      signal,
      expiresAt,
      respond: (decision) => {
        this.decisions.push(decision);
      },
    };
    this.sink.approval(request);
    return request;
  }
  async interrupt() {}
  async close() {
    this.closed = true;
    await this.exit;
  }
}

test('one execution owner serializes different harnesses until the native worker exits', async () => {
  const store = new Store(':memory:');
  const first = prepared(store, 'codex');
  const second = prepared(store, 'claude');
  const drivers: FixtureDriver[] = [];
  const controller = new ExecutionController(store, (context) => {
    const driver = new FixtureDriver(context.work.harness);
    drivers.push(driver);
    return driver;
  });
  let exited!: () => void;
  try {
    await controller.launch(first.work.id, false, false);
    drivers[0].exit = new Promise((resolve) => {
      exited = resolve;
    });
    drivers[0].sink.ended('completed', 'Fixture completed', 'Worker is still closing.');
    await assert.rejects(controller.launch(second.work.id, true, false), /slots are occupied/);
    assert.ok(store.work(first.work.id).activeRunId);
    assert.equal(controller.activeCount, 1);
    exited();
    await waitFor(() => !store.work(first.work.id).activeRunId, 'native exit releases lease');
    await controller.launch(second.work.id, true, false);
    assert.equal(drivers[1].harness, 'claude');
    assert.match(drivers[1].context.prompt, /Keep the goal with its work/);
    assert.match(drivers[1].context.prompt, /Durable context/);
  } finally {
    exited?.();
    await controller.close();
    store.close();
  }
});

test('changed native payloads and withdrawn requests cannot receive a grant', async () => {
  const store = new Store(':memory:');
  const { work } = prepared(store, 'claude');
  const driver = new FixtureDriver('claude');
  const controller = new ExecutionController(store, () => driver);
  try {
    await controller.launch(work.id, true, false);
    const cancellation = new AbortController();
    const request = driver.request(cancellation.signal);
    const approval = store.all<Approval>('approvals')[0];
    request.params = { action: 'changed after display' };
    await assert.rejects(controller.decide(approval.id, approval.digest, 'accept'), /stale/);
    assert.deepEqual(driver.decisions, []);
    cancellation.abort();
    assert.equal(store.get<Approval>('approvals', approval.id)?.status, 'invalidated');
    await assert.rejects(
      controller.decide(approval.id, approval.digest, 'accept'),
      /no longer pending/,
    );
    assert.deepEqual(driver.decisions, []);
  } finally {
    await controller.close();
    store.close();
  }
});

test('a decision is recorded before delivery and an uncertain delivery is never replayed', async () => {
  const store = new Store(':memory:');
  const { work } = prepared(store, 'claude');
  const driver = new FixtureDriver('claude');
  const controller = new ExecutionController(store, () => driver);
  let deliveries = 0;
  try {
    await controller.launch(work.id, true, false);
    const request = driver.request();
    const approval = store.all<Approval>('approvals')[0];
    request.respond = () => {
      deliveries++;
      assert.equal(store.get<Approval>('approvals', approval.id)?.status, 'accepted');
      throw new Error('fixture disconnected after send');
    };
    await assert.rejects(controller.decide(approval.id, approval.digest, 'accept'), /disconnected/);
    assert.equal(store.get<Approval>('approvals', approval.id)?.status, 'uncertain');
    await assert.rejects(
      controller.decide(approval.id, approval.digest, 'accept'),
      /no longer pending/,
    );
    assert.equal(deliveries, 1);
  } finally {
    await controller.close();
    store.close();
  }
});

const model = (overrides: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 10,
  outputTokens: 4,
  cacheReadInputTokens: 6,
  cacheCreationInputTokens: 3,
  webSearchRequests: 0,
  costUSD: 0.02,
  contextWindow: 100000,
  maxOutputTokens: 2000,
  costBasis: 'list',
  ...overrides,
});

test('Claude native permission callback resolves exactly once without creating persistent rules', async () => {
  const store = new Store(':memory:');
  const { work } = prepared(store, 'claude');
  const original = process.env.FORGE_FIXTURE_CLAUDE_KEY;
  process.env.FORGE_FIXTURE_CLAUDE_KEY = 'synthetic-test-value';
  let received: Options | undefined;
  let nativeDecision: unknown;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const driver = new ClaudeDriver((params) => {
    received = params.options;
    const stream = (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'fixture-claude-session',
        permissionMode: 'default',
        apiKeySource: 'ANTHROPIC_API_KEY',
      } as SDKMessage;
      nativeDecision = await params.options.canUseTool!(
        'Bash',
        { command: 'synthetic only' },
        {
          signal: new AbortController().signal,
          requestId: 'claude-request-1',
          toolUseID: 'tool-call-1',
        },
      );
      const result = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'fixture-claude-session',
        uuid: '1-1-1-1-1',
        total_cost_usd: 0.02,
        modelUsage: { fixture: model() },
        duration_ms: 1,
        duration_api_ms: 0,
        num_turns: 1,
        result: 'Synthetic callback result.',
        stop_reason: 'end_turn',
        permission_denials: [],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 3,
        } as NonNullableUsage,
      } as SDKMessage;
      yield result;
      yield result;
      await stopped;
    })();
    return Object.assign(stream, {
      close: stop,
      interrupt: async () => {},
      accountInfo: async () => ({ apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }),
    }) as unknown as Query;
  });
  const controller = new ExecutionController(store, () => driver);
  try {
    await controller.launch(work.id, true, false);
    await waitFor(() => store.all<Approval>('approvals').length === 1, 'Claude native callback');
    const approval = store.all<Approval>('approvals')[0];
    assert.equal(approval.nativeRequestId, 'claude-request-1');
    assert.match(approval.command, /synthetic only/);
    assert.equal(received?.permissionMode, 'default');
    assert.equal(received?.env?.ANTHROPIC_API_KEY, 'synthetic-test-value');
    assert.equal(received?.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(received?.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
    assert.deepEqual(received?.settingSources, ['user', 'project', 'local']);
    await controller.decide(approval.id, approval.digest, 'accept');
    await waitFor(() => store.work(work.id).status === 'completed', 'Claude terminal result');
    assert.deepEqual(nativeDecision, {
      behavior: 'allow',
      updatedInput: { command: 'synthetic only' },
      toolUseID: 'tool-call-1',
    });
    assert.equal(store.all<Usage>('usage').length, 1);
    assert.equal(store.all<Usage>('usage')[0].totalTokens, 23);
    assert.equal(store.all<Usage>('usage')[0].estimatedUsd, 0.02);
    assert.equal(store.work(work.id).nativeSessionId, 'fixture-claude-session');
    assert.equal(JSON.stringify(store.all('accounts')).includes('synthetic-test-value'), false);
    await assert.rejects(
      controller.decide(approval.id, approval.digest, 'accept'),
      /no longer pending/,
    );
  } finally {
    stop?.();
    await controller.close();
    store.close();
    if (original === undefined) delete process.env.FORGE_FIXTURE_CLAUDE_KEY;
    else process.env.FORGE_FIXTURE_CLAUDE_KEY = original;
  }
});

test('Claude SDK never starts subscription authentication or an unapproved metered launch', async () => {
  const store = new Store(':memory:');
  const { work, account } = prepared(store, 'claude');
  let starts = 0;
  const driver = () =>
    new ClaudeDriver(() => {
      starts++;
      throw new Error('must not start');
    });
  const controller = new ExecutionController(store, driver);
  try {
    store.put('accounts', account.id, { ...account, billingMode: 'subscription' });
    await controller.launch(work.id, true, false);
    await waitFor(() => store.work(work.id).status === 'failed', 'subscription gate');
    store.put('accounts', account.id, account);
    await controller.launch(work.id, false, true);
    await waitFor(() => store.work(work.id).status === 'failed', 'metered gate');
    assert.equal(starts, 0);
    assert.equal(store.all('approvals').length, 0);
    assert.equal(store.all('usage').length, 0);
  } finally {
    await controller.close();
    store.close();
  }
});

test('Claude accounting replaces resumed cumulative snapshots and preserves unknown pricing', () => {
  const store = new Store(':memory:');
  const { work, account } = prepared(store, 'claude');
  const context = { work, account } as DriverContext;
  try {
    const first = claudeUsage(context, 'native-session', { first: model() }, 0.02)!;
    const resumed = claudeUsage(
      context,
      'native-session',
      { first: model({ inputTokens: 20 }) },
      0.03,
    )!;
    store.saveUsage(first);
    store.saveUsage(resumed);
    assert.equal(store.all<Usage>('usage').length, 1);
    assert.equal(store.all<Usage>('usage')[0].estimatedUsd, 0.03);
    assert.equal(
      claudeUsage(context, 'native-session', { first: model({ costBasis: 'unknown' }) }, 0.02)
        ?.estimatedUsd,
      null,
    );
    assert.equal(claudeUsage(context, 'native-session', undefined, 0), null);
    assert.equal(
      claudeUsage(context, 'native-session', { first: model({ inputTokens: NaN }) }, 0.02),
      null,
    );
  } finally {
    store.close();
  }
});

test('the installed Claude SDK carries native request IDs and waits for its owned child to exit', async () => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const store = new Store(':memory:');
  const { work } = prepared(store, 'claude');
  const original = process.env.FORGE_FIXTURE_CLAUDE_KEY;
  process.env.FORGE_FIXTURE_CLAUDE_KEY = 'synthetic-transport-value';
  const driver = new ClaudeDriver((params) =>
    query({
      ...params,
      options: {
        ...params.options,
        pathToClaudeCodeExecutable: fileURLToPath(
          new URL('./fixtures/claude-native.cjs', import.meta.url),
        ),
        executable: 'node',
      },
    }),
  );
  const controller = new ExecutionController(store, () => driver);
  try {
    await controller.launch(work.id, true, false);
    await waitFor(() => {
      if (store.work(work.id).status === 'failed')
        throw new Error(JSON.stringify(store.recentEvents(work.id)));
      return store.all<Approval>('approvals').some((a) => a.status === 'pending');
    }, 'real SDK native transport');
    const approval = store.all<Approval>('approvals')[0];
    assert.equal(approval.nativeRequestId, 'native-sdk-request');
    await controller.decide(approval.id, approval.digest, 'accept');
    await waitFor(
      () => store.work(work.id).status === 'completed',
      'SDK child exit and completion',
    );
    assert.equal(controller.activeCount, 0);
    assert.equal(store.work(work.id).activeRunId, null);
    assert.equal(store.all<Usage>('usage')[0].totalTokens, 10);
  } finally {
    await controller.close();
    store.close();
    if (original === undefined) delete process.env.FORGE_FIXTURE_CLAUDE_KEY;
    else process.env.FORGE_FIXTURE_CLAUDE_KEY = original;
  }
});

test('overview accounting does not add overlapping daily imports to native session evidence', () => {
  const entry: Usage = {
    key: 'native',
    workId: 'work',
    accountId: 'account',
    harness: 'claude',
    source: 'claude/agent-sdk',
    scope: 'Cumulative session',
    inputTokens: 7,
    outputTokens: 3,
    cachedTokens: 0,
    totalTokens: 10,
    estimatedUsd: 0.01,
    observedAt: now(),
  };
  const daily: Usage = {
    ...entry,
    key: 'daily',
    workId: null,
    accountId: null,
    source: 'ccusage',
    scope: 'Daily aggregate',
    totalTokens: 50,
    estimatedUsd: 0.05,
  };
  const codex: Usage = {
    ...entry,
    key: 'codex',
    harness: 'codex',
    source: 'codex/app-server',
    estimatedUsd: null,
  };
  const overlapping = usageSummary([entry, daily, codex]);
  assert.equal(overlapping.estimatedUsd, 0.01);
  assert.equal(overlapping.totalTokens, 20);
  assert.deepEqual(overlapping.excludedAggregates, [daily]);
  assert.equal(overlapping.incomplete, true);
  assert.equal(usageSummary([daily, codex]).totalTokens, 60);
  assert.equal(usageSummary([daily, codex]).estimatedUsd, 0.05);
});

test('an unexpected native auth route receives no task input before failure', async () => {
  const store = new Store(':memory:');
  const { work } = prepared(store, 'claude');
  const original = process.env.FORGE_FIXTURE_CLAUDE_KEY;
  process.env.FORGE_FIXTURE_CLAUDE_KEY = 'synthetic-preflight-value';
  let sent = 0;
  let consumed = Promise.resolve();
  const driver = new ClaudeDriver((params) => {
    consumed = (async () => {
      for await (const _input of params.prompt as AsyncIterable<unknown>) sent++;
    })();
    const stream = (async function* () {
      await consumed;
    })();
    return Object.assign(stream, {
      close() {},
      interrupt: async () => {},
      accountInfo: async () => ({ apiProvider: 'vertex', apiKeySource: 'none' }),
    }) as unknown as Query;
  });
  const controller = new ExecutionController(store, () => driver);
  try {
    await controller.launch(work.id, true, false);
    await waitFor(() => store.work(work.id).status === 'failed', 'native auth preflight rejection');
    await consumed;
    assert.equal(sent, 0);
    assert.equal(store.work(work.id).nativeSessionId, null);
    assert.equal(store.all('approvals').length, 0);
    assert.equal(store.all('usage').length, 0);
  } finally {
    await controller.close();
    store.close();
    if (original === undefined) delete process.env.FORGE_FIXTURE_CLAUDE_KEY;
    else process.env.FORGE_FIXTURE_CLAUDE_KEY = original;
  }
});

test('the approval inbox honors a shorter native deadline and refuses invalid deadlines', async () => {
  const store = new Store(':memory:');
  const { work } = prepared(store, 'hermes');
  const driver = new FixtureDriver('hermes');
  const controller = new ExecutionController(store, () => driver);
  try {
    await controller.launch(work.id, true, false);
    const expiresAt = new Date(Date.now() + 100).toISOString();
    driver.request(undefined, expiresAt);
    const approval = store.all<Approval>('approvals')[0];
    assert.equal(approval.expiresAt, expiresAt);
    await waitFor(
      () => store.get<Approval>('approvals', approval.id)?.status === 'expired',
      'native approval deadline',
    );
    assert.deepEqual(driver.decisions, ['decline']);
    await assert.rejects(
      controller.decide(approval.id, approval.digest, 'accept'),
      /no longer pending/,
    );
    driver.request(undefined, 'invalid');
    driver.request(undefined, new Date(Date.now() - 1000).toISOString());
    await waitFor(() => driver.decisions.length === 3, 'invalid deadlines rejected');
    assert.equal(store.all<Approval>('approvals').length, 1);
    assert.deepEqual(driver.decisions, ['decline', 'decline', 'decline']);
  } finally {
    await controller.close();
    store.close();
  }
});
