import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agent,
  type AgentContext,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import { HermesDriver, hermesEnvironment, hermesUsage } from '../server/adapters/hermes-driver.js';
import { hermesPython } from '../server/adapters/hermes-install.js';
import { acquireProfileLease } from '../server/adapters/profile-lease.js';
import type { AcpWorker } from '../server/adapters/acp-worker.js';
import type { DriverContext, DriverSink, NativeApproval } from '../server/adapters/driver.js';
import type { Account, Work, Usage } from '../shared/types.js';

const context: DriverContext = {
  account: {
    id: 'account',
    harness: 'hermes',
    nativeHome: '/native/home',
    billingMode: 'native',
  } as Account,
  work: { id: 'work', cwd: process.cwd(), nativeSessionId: null } as Work,
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
  prompt: 'Selected context and goal.',
};
const session: NewSessionResponse = {
  sessionId: 'session',
  _meta: { hermes: { sessionProvenance: { acpSessionId: 'session' } } },
  modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
};
const request: RequestPermissionRequest = {
  sessionId: 'session',
  toolCall: {
    toolCallId: 'tool-1',
    title: 'Native file edit',
    kind: 'edit',
    rawInput: { path: '/project/proof.txt', content: 'Exact content.' },
  },
  options: [
    { kind: 'allow_always', optionId: 'permanent', name: 'Always' },
    { kind: 'allow_once', optionId: 'native-once', name: 'Once' },
    { kind: 'reject_once', optionId: 'native-deny', name: 'Reject' },
  ],
};
const response = (flags: Record<string, unknown> = {}): PromptResponse => ({
  stopReason: 'end_turn',
  _meta: {
    forge: {
      hermesTurn: {
        version: 1,
        sessionId: 'session',
        reported: true,
        completed: true,
        failed: false,
        interrupted: false,
        cleanupFailed: false,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        costStatus: 'unknown',
        estimatedUsd: 0,
        ...flags,
      },
    },
  },
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('The ACP fixture did not reach the expected state.');
}
function fixture(
  options: {
    version?: string;
    state?: NewSessionResponse;
    terminalAuth?: boolean;
    delayExit?: Promise<void>;
    delayStart?: Promise<void>;
  } = {},
) {
  let peer!: AgentContext;
  let finish!: (value: PromptResponse) => void;
  let prompts = 0;
  let stopped = false;
  let starting = false;
  let failure: unknown;
  let modeChanges = 0;
  let state = options.state ?? structuredClone(session);
  const approvals: NativeApproval[] = [];
  const withdrawn: (string | number)[] = [];
  const outcomes: string[] = [];
  const usage: Usage[] = [];
  const native = agent()
    .onRequest('initialize', ({ params }) => {
      assert.equal(params.clientCapabilities?.terminal, false);
      assert.deepEqual(params.clientCapabilities?.fs, {
        readTextFile: false,
        writeTextFile: false,
      });
      return {
        protocolVersion: 1,
        agentInfo: { name: 'hermes-agent', version: options.version ?? '0.17.0' },
        agentCapabilities: { loadSession: true },
        authMethods: options.terminalAuth
          ? [{ id: 'login', name: 'Login', type: 'terminal', args: [] }]
          : [{ id: 'native', name: 'Configured native provider' }],
        _meta: { forge: { hermesNativeResult: 1 } },
      };
    })
    .onRequest('authenticate', ({ params }) => {
      assert.equal(params.methodId, 'native');
      return {};
    })
    .onRequest('session/new', () => state)
    .onRequest('session/load', () => state)
    .onRequest('session/set_mode', () => {
      modeChanges++;
      state = { ...state, modes: { ...state.modes!, currentModeId: 'default' } };
      return {};
    })
    .onRequest('session/prompt', ({ params, client }) => {
      assert.equal(params.sessionId, 'session');
      assert.deepEqual(params.prompt, [{ type: 'text', text: context.prompt }]);
      peer = client;
      prompts++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
  const driver = new HermesDriver(async (app) => {
    starting = true;
    await options.delayStart;
    const connection = app.connect(native);
    return {
      connection,
      get exited() {
        return stopped;
      },
      stop: async () => {
        connection.close();
        await options.delayExit;
        stopped = true;
      },
    } satisfies AcpWorker;
  });
  const sink: DriverSink = {
    session() {},
    turn() {},
    account() {},
    activity() {},
    approval(r) {
      approvals.push(r);
    },
    withdrawn(id) {
      withdrawn.push(id);
    },
    ended(status) {
      outcomes.push(status);
    },
    usage(u) {
      usage.push(u);
    },
  };
  const running = driver.start(context, sink).catch((error) => {
    failure = error;
  });
  return {
    driver,
    running,
    approvals,
    withdrawn,
    outcomes,
    usage,
    finish: (value = response()) => finish(value),
    peer: () => peer,
    prompts: () => prompts,
    modeChanges: () => modeChanges,
    failure: () => failure,
    stopped: () => stopped,
    starting: () => starting,
  };
}

test('Hermes uses exact native ACP identities and only one-time native option IDs', async () => {
  const f = fixture();
  try {
    await until(() => f.prompts() === 1);
    const pending = f.peer().request('session/request_permission', request);
    await until(() => f.approvals.length === 1);
    const approval = f.approvals[0];
    assert.equal(typeof approval.requestId, 'number');
    assert.deepEqual(approval.params, request);
    assert.equal(approval.sessionId, 'session');
    assert.equal(approval.turnId, 'run');
    assert(Date.parse(approval.expiresAt!) <= Date.now() + 55000);
    assert(Date.parse(approval.expiresAt!) > Date.now() + 50000);
    await approval.respond('accept');
    assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'native-once' } });
    assert.throws(() => approval.respond('accept'), /no longer pending/);
    const rejection = f.peer().request('session/request_permission', {
      ...request,
      toolCall: { ...request.toolCall, toolCallId: 'tool-2' },
    });
    await until(() => f.approvals.length === 2);
    await f.approvals[1].respond('decline');
    assert.deepEqual(await rejection, {
      outcome: { outcome: 'selected', optionId: 'native-deny' },
    });
    assert.deepEqual(
      await f.peer().request('session/request_permission', { ...request, sessionId: 'foreign' }),
      { outcome: { outcome: 'cancelled' } },
    );
    assert.deepEqual(
      await f.peer().request('session/request_permission', {
        ...request,
        options: [
          ...request.options,
          { kind: 'allow_once', optionId: 'ambiguous', name: 'Another once' },
        ],
      }),
      { outcome: { outcome: 'cancelled' } },
    );
    assert.equal(f.approvals.length, 2);
    f.finish();
    await f.running;
    assert.equal(f.failure(), undefined);
    assert.deepEqual(f.outcomes, ['completed']);
    assert.equal(f.usage[0].estimatedUsd, null);
  } finally {
    await f.driver.close();
  }
});

test('Hermes withdraws a native cancellation and rejects a changed permission payload', async () => {
  const f = fixture();
  try {
    await until(() => f.prompts() === 1);
    const cancel = new AbortController();
    const first = f
      .peer()
      .request('session/request_permission', request, { cancellationSignal: cancel.signal })
      .catch(() => null);
    await until(() => f.approvals.length === 1);
    cancel.abort();
    await first;
    await until(() => f.withdrawn.length > 0);
    assert.throws(() => f.approvals[0].respond('accept'), /no longer pending/);
    const second = f
      .peer()
      .request('session/request_permission', request)
      .catch(() => null);
    await until(() => f.approvals.length === 2);
    await f
      .peer()
      .notify('session/update', {
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          rawInput: { path: '/changed', content: 'Changed after review.' },
        },
      })
      .catch(() => {});
    await f.running;
    await second;
    assert.equal(f.driver.closed, true);
    assert.throws(() => f.approvals[1].respond('accept'), /no longer pending/);
    assert.equal(f.outcomes.length, 0);
  } finally {
    await f.driver.close();
  }
});

test('Hermes verifies its deployed version, native session provenance, authentication and edit-review mode before input', async (t) => {
  for (const [name, options] of Object.entries({
    version: { version: 'different' },
    provenance: { state: { ...session, _meta: {} } },
    authentication: { terminalAuth: true },
  }))
    await t.test(name, async () => {
      const f = fixture(options);
      try {
        await f.running;
        assert(f.failure() instanceof Error);
        assert.equal(f.prompts(), 0);
      } finally {
        await f.driver.close();
      }
    });
  const f = fixture({
    state: { ...session, modes: { ...session.modes!, currentModeId: 'dont_ask' } },
  });
  try {
    await until(() => f.prompts() === 1);
    assert.equal(f.modeChanges(), 1);
    f.finish();
    await f.running;
    assert.equal(f.failure(), undefined);
  } finally {
    await f.driver.close();
  }
});

test('Hermes result evidence overrides end_turn and context pressure is excluded from billable usage', async () => {
  for (const [flags, status] of [
    [{ failed: true }, 'failed'],
    [{ cleanupFailed: true }, 'failed'],
    [{ reported: false, completed: false }, 'interrupted'],
    [{ interrupted: true }, 'interrupted'],
    [{}, 'completed'],
  ] as const) {
    const f = fixture();
    try {
      await until(() => f.prompts() === 1);
      await f.peer().notify('session/update', {
        sessionId: 'session',
        update: { sessionUpdate: 'usage_update', used: 9999, size: 32768 },
      });
      assert.equal(f.usage.length, 0);
      f.finish(response(flags));
      await f.running;
      assert.equal(f.failure(), undefined);
      assert.deepEqual(f.outcomes, [status]);
      assert.equal(f.usage[0].totalTokens, 120);
      assert.equal(f.usage[0].key, 'hermes-acp:run');
    } finally {
      await f.driver.close();
    }
  }
});

test('Hermes stops if native permission mode changes and holds close through startup and worker exit', async () => {
  const f = fixture();
  try {
    await until(() => f.prompts() === 1);
    await f
      .peer()
      .notify('session/update', {
        sessionId: 'session',
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'dont_ask' },
      })
      .catch(() => {});
    await f.running;
    assert.equal(f.driver.closed, true);
  } finally {
    await f.driver.close();
  }
  let start!: () => void;
  let exit!: () => void;
  const delayed = fixture({
    delayStart: new Promise((resolve) => {
      start = resolve;
    }),
    delayExit: new Promise((resolve) => {
      exit = resolve;
    }),
  });
  await until(() => delayed.starting());
  let closed = false;
  const closing = delayed.driver.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  assert.equal(delayed.prompts(), 0);
  exit();
  await closing;
  await delayed.running;
  assert.equal(delayed.stopped(), true);
});

test('native Hermes homes have cooperative ownership and preserve the native venv interpreter path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-hermes-install-'));
  let release: (() => void) | undefined;
  const saved = process.env.FORGE_HERMES_PYTHON;
  delete process.env.FORGE_HERMES_PYTHON;
  try {
    release = await acquireProfileLease(root);
    await assert.rejects(acquireProfileLease(root), /Another Forge worker/);
    assert.equal((await stat(join(root, '.forge-native-owner.sqlite'))).mode & 0o777, 0o600);
    release();
    release = await acquireProfileLease(root);
    release();
    release = undefined;
    const venv = join(root, 'venv', 'bin');
    await mkdir(venv, { recursive: true });
    const interpreter = join(venv, 'python3');
    await symlink(process.execPath, interpreter);
    const native = join(venv, 'hermes');
    await writeFile(native, `#!${interpreter}\n`, { mode: 0o700 });
    const wrapper = join(root, 'hermes');
    await writeFile(wrapper, `#!/bin/sh\nexec "${native}" "$@"\n`, { mode: 0o700 });
    assert.equal(await hermesPython(wrapper), interpreter);
    await writeFile(wrapper, '#!/bin/sh\nexec "$(untrusted)/hermes" "$@"\n');
    await assert.rejects(hermesPython(wrapper), /FORGE_HERMES_PYTHON/);
    await rm(join(root, '.forge-native-owner.sqlite'));
    await symlink(native, join(root, '.forge-native-owner.sqlite'));
    await assert.rejects(acquireProfileLease(root), /regular file/);
    const env = hermesEnvironment({ ...context.account, credentialEnv: undefined });
    assert.equal(env.HERMES_HOME, context.account.nativeHome);
    assert.equal(env.HOME, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.throws(
      () => hermesEnvironment({ ...context.account, nativeHome: '' }),
      /explicit native Hermes home/,
    );
    assert.throws(
      () => hermesEnvironment({ ...context.account, credentialEnv: 'HERMES_HOME' }),
      /runtime setting/,
    );
    const reported = {
      version: 1 as const,
      sessionId: 'session',
      reported: true,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      estimatedUsd: 0.1,
      costStatus: 'estimated',
    };
    assert.equal(hermesUsage(context, reported).estimatedUsd, 0.1);
    assert.notEqual(
      hermesUsage(context, reported).key,
      hermesUsage({ ...context, run: { ...context.run, id: 'next-run' } }, reported).key,
    );
  } finally {
    release?.();
    if (saved === undefined) delete process.env.FORGE_HERMES_PYTHON;
    else process.env.FORGE_HERMES_PYTHON = saved;
    await rm(root, { recursive: true, force: true });
  }
});
