import test from 'node:test';
import assert from 'node:assert/strict';
import type { Account, Work, Usage } from '../shared/types.js';
import type { DriverContext, DriverSink, NativeApproval } from '../server/adapters/driver.js';
import { OpenClawDriver, openClawUsage } from '../server/adapters/openclaw-driver.js';
import {
  openClawEnvironment,
  newOpenClawIdentity,
  type OpenClawConnection,
  type OpenClawEvent,
} from '../server/adapters/openclaw-worker.js';
import { createHash, createPublicKey } from 'node:crypto';

const context: DriverContext = {
  work: { id: 'work', title: 'Native fixture', cwd: '/project', nativeSessionId: null } as Work,
  account: {
    id: 'account',
    harness: 'openclaw',
    nativeHome: '/native/profile',
    billingMode: 'native',
  } as Account,
  run: {
    id: 'run',
    workId: 'work',
    accountId: 'account',
    generation: 1,
    nativeSessionId: null,
    nativeTurnId: null,
    status: 'starting',
    startedAt: new Date().toISOString(),
    endedAt: null,
  },
  allowMetered: true,
  prompt: 'Reviewed context.',
};
async function until(check: () => boolean) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  assert.fail('Native Gateway fixture did not reach the expected state.');
}
function fixture(
  options: {
    resume?: boolean;
    changedId?: boolean;
    delayExit?: Promise<void>;
    failStart?: boolean;
  } = {},
) {
  const copy = structuredClone(context);
  const sessionId = 'native-uuid';
  const sessionKey = options.resume ? 'agent:main:saved-route' : 'agent:main:forge-work-run';
  if (options.resume) {
    copy.work.nativeSessionId = sessionId;
    copy.work.nativeSessionKey = sessionKey;
  }
  let active = false;
  let exited = false;
  let stopping = false;
  let prompts = 0;
  let activeSession = options.changedId ? 'replacement-uuid' : sessionId;
  let sessionRoot = '/project';
  let listener: ((event: OpenClawEvent) => void) | null = null;
  let finish!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  let failure: unknown;
  const lost = new AbortController();
  let pending: Record<string, unknown>[] = [];
  const decisions: unknown[] = [];
  const approvals: NativeApproval[] = [];
  const outcomes: string[] = [];
  const usage: Usage[] = [];
  const bindings: [string, string | undefined][] = [];
  const event = (name: string, payload: unknown) =>
    listener?.({ type: 'event', event: name, payload });
  const agentEvent = (stream: string, data: unknown) =>
    event('agent', { runId: 'run', sessionKey, sessionId, stream, data });
  const receipt = {
    runId: 'run',
    sessionId,
    turnId: 'run',
    requested: { provider: 'native', model: 'model' },
    effective: { provider: 'native', model: 'model' },
    successfulToolNames: ['exec'],
    rerouted: false,
    terminalDisposition: 'visible',
  };
  const worker: OpenClawConnection = {
    get exited() {
      return exited;
    },
    signal: lost.signal,
    hello: {} as OpenClawConnection['hello'],
    request: (async (method: string, params: any, opts: any) => {
      if (method === 'health') return { defaultAgentId: 'main' };
      if (method === 'sessions.create')
        return {
          key: sessionKey,
          sessionId,
          runStarted: false,
          entry: { lifecycleRevision: 'epoch', permissionMode: 'guarded', sessionRoot },
        };
      if (method === 'sessions.patch')
        return {
          key: sessionKey,
          entry: { sessionId, lifecycleRevision: 'epoch', sessionRoot, permissionMode: 'guarded' },
        };
      if (method === 'chat.history')
        return {
          sessionKey,
          sessionId: activeSession,
          pendingInputs: { total: 0 },
          ...(active ? { inFlightRun: { runId: 'run' } } : {}),
          sessionInfo: {
            key: sessionKey,
            sessionId: activeSession,
            sessionRoot,
            permissionMode: 'guarded',
            permissionModePending: false,
            hasActiveRun: active,
            activeRunIds: active ? ['run'] : [],
            modelProvider: 'native',
            model: 'model',
            agentRuntime: { id: 'openclaw' },
          },
        };
      if (method === 'agent') {
        assert.equal(params.message, copy.prompt);
        assert.equal(params.sessionId, sessionId);
        assert.equal(params.agentId, 'main');
        assert.equal(params.sessionKey, undefined);
        assert.equal(params.cwd, undefined);
        prompts++;
        active = true;
        opts.onAccepted({ runId: 'run', sessionKey, status: 'accepted' });
        return new Promise<unknown>((yes, no) => {
          finish = yes;
          reject = no;
        });
      }
      if (method === 'exec.approval.list') return structuredClone(pending);
      if (method === 'exec.approval.resolve') {
        decisions.push(params);
        return { ok: true };
      }
      if (method === 'chat.abort') {
        active = false;
        reject(new Error('Native cancellation.'));
        return { ok: true };
      }
      throw new Error(`Unsupported fixture method ${method}`);
    }) as OpenClawConnection['request'],
    onEvent: (callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    stop: async () => {
      stopping = true;
      lost.abort();
      reject?.(new Error('Native stopped.'));
      await options.delayExit;
      exited = true;
      return { clean: true };
    },
  };
  const driver = new OpenClawDriver(async () => {
    if (options.failStart) throw new Error('Native startup failed before ownership.');
    return worker;
  });
  const sink: DriverSink = {
    session: (id, key) => {
      bindings.push([id, key]);
    },
    turn() {},
    account() {},
    activity() {},
    approval: (approval) => {
      approvals.push(approval);
    },
    withdrawn() {},
    ended: (status) => {
      outcomes.push(status);
    },
    usage: (value) => {
      usage.push(value);
    },
  };
  const running = driver.start(copy, sink).catch((error) => {
    failure = error;
  });
  function request(overrides: Record<string, unknown> = {}, expiresAtMs = Date.now() + 30000) {
    agentEvent('tool', { phase: 'start', name: 'exec', toolCallId: 'tool' });
    const record = {
      id: 'approval',
      createdAtMs: Date.now(),
      expiresAtMs,
      request: {
        command: 'native-command',
        cwd: '/project',
        host: 'gateway',
        nodeId: null,
        sessionKey,
        sessionId: null,
        runId: 'run',
        toolCallId: 'tool',
        agentId: 'main',
        allowedDecisions: ['allow-once', 'deny'],
        ...overrides,
      },
    };
    pending = [record];
    event('exec.approval.requested', structuredClone(record));
    return record;
  }
  function complete(status: 'ok' | 'error' = 'ok') {
    active = false;
    agentEvent('lifecycle', {
      phase: status === 'ok' ? 'end' : 'error',
      executionSettled: true,
      aborted: false,
      terminalReceipt: receipt,
    });
    finish({
      runId: 'run',
      status,
      summary: status === 'ok' ? 'completed' : 'failed',
      result: {
        payloads: [{ text: 'Native report.' }],
        meta: {
          agentMeta: {
            sessionId,
            terminalReceipt: receipt,
            usage: { input: 100, output: 20, total: 120 },
          },
        },
      },
    });
  }
  return {
    driver,
    running,
    request,
    complete,
    event,
    bindings,
    approvals,
    outcomes,
    decisions,
    usage,
    prompts: () => prompts,
    failure: () => failure,
    stopping: () => stopping,
    changePending: () => {
      (pending[0].request as Record<string, unknown>).command = 'changed-command';
    },
    changeRoot: () => {
      sessionRoot = '/other-project';
    },
    changeSession: () => {
      activeSession = 'replacement-uuid';
    },
    lose: () => {
      lost.abort();
      reject(new Error('Native transport lost.'));
    },
  };
}

test('OpenClaw resume requires the stable UUID and routing key, and rejects a native reset before input', async () => {
  const good = fixture({ resume: true });
  await until(() => good.prompts() === 1);
  assert.deepEqual(good.bindings, [['native-uuid', 'agent:main:saved-route']]);
  good.complete();
  await good.running;
  assert.deepEqual(good.outcomes, ['completed']);
  await good.driver.close();
  const changed = fixture({ resume: true, changedId: true });
  await changed.running;
  assert.equal(changed.prompts(), 0);
  assert.match(String(changed.failure()), /session, workspace/);
  await changed.driver.close();
});
test('OpenClaw only answers exact owned once-only command requests, after native revalidation', async () => {
  const f = fixture();
  await until(() => f.prompts() === 1);
  f.request();
  await until(() => f.approvals.length === 1);
  const request = f.approvals[0];
  assert.equal(request.sessionId, 'native-uuid');
  assert.equal(request.turnId, 'run');
  await request.respond('accept');
  assert.deepEqual(f.decisions, [{ id: 'approval', decision: 'allow-once' }]);
  await assert.rejects(async () => request.respond('accept'), /no longer pending/);
  f.complete();
  await f.running;
  assert.deepEqual(f.outcomes, ['completed']);
  await f.driver.close();
});
test('changed native command, workspace or session cannot receive an earlier OpenClaw approval', async () => {
  for (const mutate of ['changePending', 'changeRoot', 'changeSession'] as const) {
    const f = fixture();
    await until(() => f.prompts() === 1);
    f.request();
    await until(() => f.approvals.length === 1);
    f[mutate]();
    await assert.rejects(async () => f.approvals[0].respond('accept'));
    assert.deepEqual(f.decisions, []);
    await f.driver.interrupt();
    await f.running;
  }
});
test('foreign, expired, replaced and natively resolved OpenClaw requests never gain authority', async () => {
  const expired = fixture();
  await until(() => expired.prompts() === 1);
  expired.request({}, Date.now() - 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(expired.approvals, []);
  await expired.driver.interrupt();
  await expired.running;
  for (const changed of [
    { sessionKey: 'foreign' },
    { sessionId: 'foreign' },
    { runId: 'foreign' },
    { agentId: 'foreign' },
  ]) {
    const f = fixture();
    await until(() => f.prompts() === 1);
    f.request(changed);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(f.approvals, []);
    assert.deepEqual(f.decisions, []);
    await f.driver.interrupt();
    await f.running;
  }
  for (const resolved of [false, true]) {
    const f = fixture();
    await until(() => f.prompts() === 1);
    const record = f.request();
    await until(() => f.approvals.length === 1);
    if (resolved) f.event('exec.approval.resolved', { id: record.id });
    else {
      record.request.command = 'replacement';
      f.event('exec.approval.requested', record);
    }
    assert(f.approvals[0].signal?.aborted);
    await assert.rejects(async () => f.approvals[0].respond('accept'));
    assert.deepEqual(f.decisions, []);
    await f.driver.interrupt();
    await f.running;
  }
});
test('OpenClaw transport loss withdraws controls, never replays input and waits for the owned process exit', async () => {
  let release!: () => void;
  const f = fixture({
    delayExit: new Promise((resolve) => {
      release = resolve;
    }),
  });
  await until(() => f.prompts() === 1);
  f.request();
  await until(() => f.approvals.length === 1);
  f.lose();
  await until(f.stopping);
  assert(f.approvals[0].signal?.aborted);
  assert.deepEqual(f.outcomes, []);
  assert.equal(f.prompts(), 1);
  release();
  await f.running;
  assert.deepEqual(f.outcomes, ['interrupted']);
  await f.driver.close();
});
test('native OpenClaw failure remains failed and a pre-ownership startup failure can close', async () => {
  const f = fixture();
  await until(() => f.prompts() === 1);
  f.complete('error');
  await f.running;
  assert.deepEqual(f.outcomes, ['failed']);
  await f.driver.close();
  const failed = fixture({ failStart: true });
  await failed.running;
  assert.match(String(failed.failure()), /startup failed/);
  await failed.driver.close();
  assert.equal(failed.prompts(), 0);
});
test('OpenClaw usage preserves native per-run counters, null cost and separate context pressure', () => {
  const u = openClawUsage(context, {
    usage: { input: 100, output: 20, total: 140, cacheRead: 10, cacheWrite: 10 },
    lastCallUsage: { total: 99999 },
    contextBudgetStatus: { estimatedPromptTokens: 99999 },
  });
  assert(u);
  assert.equal(u.totalTokens, 140);
  assert.equal(u.estimatedUsd, null);
  assert.equal(u.key, 'openclaw-gateway:run');
  assert.equal(openClawUsage(context, { usage: { input: -1, output: 20, total: 19 } }), null);
  assert.equal(
    openClawUsage(context, { usage: { input: 100, output: 20, total: 120, cost: { total: 0 } } })
      ?.estimatedUsd,
    0,
  );
});
test('OpenClaw device identity uses native challenge-signing keys and excludes ambient runtime credentials', () => {
  const identity = newOpenClawIdentity();
  const raw = createPublicKey(identity.device.publicKeyPem).export({ format: 'jwk' }).x!;
  assert.equal(
    identity.device.deviceId,
    createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex'),
  );
  const env = openClawEnvironment(context.account);
  assert.equal(env.OPENCLAW_STATE_DIR, '/native/profile');
  assert.equal(env.OPENCLAW_SKIP_CHANNELS, '1');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HOME, undefined);
  assert.throws(
    () => openClawEnvironment({ ...context.account, credentialEnv: 'OPENCLAW_GATEWAY_TOKEN' }),
    /provider credential/,
  );
});
