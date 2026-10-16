import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  OpenCodeClient,
  OpenCodeEvent,
  PermissionRequest,
  PermissionRule,
  SessionInfo,
} from '@opencode/client';
import type { DriverContext, DriverSink, NativeApproval } from '../server/adapters/driver.js';
import {
  OpenCodeDriver,
  reviewedOpenCodeRules,
  openCodeUsage,
} from '../server/adapters/opencode-driver.js';
import {
  assertIdleOpenCodeProfile,
  openCodeEnvironment,
} from '../server/adapters/opencode-worker.js';
import type { Account, Work } from '../shared/types.js';

const account = {
  id: 'account',
  harness: 'opencode',
  nativeHome: '/native/profile',
  billingMode: 'api',
} as Account;
const context: DriverContext = {
  account,
  work: { id: 'work', title: 'Fixture', cwd: process.cwd(), nativeSessionId: null } as Work,
  run: {
    id: 'run',
    workId: 'work',
    accountId: account.id,
    generation: 1,
    nativeSessionId: null,
    nativeTurnId: null,
    status: 'starting',
    startedAt: new Date().toISOString(),
    endedAt: null,
  },
  prompt: 'Selected synthetic context.',
  allowMetered: true,
};
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Native fixture did not reach the expected state.');
}
function fixture() {
  let stopping = false;
  let prompts = 0;
  let promoted = true;
  let resolveNext: () => void = () => {};
  const events: OpenCodeEvent[] = [];
  const requests: PermissionRequest[] = [];
  const inputs = new Map<string, Record<string, string>>();
  const approvals: NativeApproval[] = [];
  const withdrawn: (string | number)[] = [];
  const outcomes: string[] = [];
  const replies: { sessionID: string; requestID: string; decision: string }[] = [];
  const session = {
    id: 'root',
    projectID: 'fixture',
    agent: 'build',
    location: { directory: context.work.cwd },
    metadata: { forgeWorkID: 'work', forgeAccountID: 'account' },
    model: { providerID: 'fixture', id: 'model' },
    permissions: [] as PermissionRule[],
    cost: 0.02,
    tokens: { input: 12, output: 4, reasoning: 2, cache: { read: 6, write: 1 } },
    time: { created: Date.now(), updated: Date.now(), idle: Date.now() },
    outcome: 'succeeded' as const,
  };
  const emit = (event: unknown) => {
    events.push(event as OpenCodeEvent);
    resolveNext();
  };
  const client = {
    location: { get: async () => ({}) },
    config: {
      get: async () => [
        { type: 'document', info: { model: { providerID: 'fixture', model: 'model' } } },
      ],
    },
    agent: {
      get: async () => ({
        data: {
          mode: 'primary',
          permissions: [
            { action: '*', resource: '*', effect: 'allow' },
            { action: 'shell', resource: 'git push *', effect: 'deny' },
          ],
        },
      }),
    },
    model: {
      list: async () => ({ data: [{ id: 'model', providerID: 'fixture', enabled: true }] }),
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          yield { type: 'server.connected' };
          const stop = () => resolveNext();
          signal.addEventListener('abort', stop);
          try {
            while (!stopping && !signal.aborted) {
              while (events.length) yield events.shift()!;
              if (stopping || signal.aborted) break;
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });
            }
          } finally {
            signal.removeEventListener('abort', stop);
          }
        })(),
    },
    session: {
      create: async () => session,
      get: async ({ sessionID }: { sessionID: string }) =>
        sessionID === 'root'
          ? session
          : { id: sessionID, parentID: sessionID === 'child' ? 'root' : undefined },
      active: async () => ({}),
      inbox: { list: async () => [] },
      update: async ({
        permissions,
        metadata,
      }: {
        permissions: PermissionRule[];
        metadata?: unknown;
      }) => {
        Object.assign(session, { permissions, ...(metadata ? { metadata } : {}) });
      },
      environment: async () => {},
      prompt: async () => {
        prompts++;
        emit({ type: 'session.execution.started', data: { sessionID: 'root' } });
        return { id: 'input', sessionID: 'root', time: { created: session.time.created } };
      },
      wait: async () => {},
      interrupt: async () => ({ interrupted: true }),
      message: {
        get: async ({ messageID }: { messageID: string }) =>
          messageID === 'input'
            ? { type: promoted ? 'user' : 'assistant' }
            : {
                type: 'assistant',
                content: [
                  {
                    type: 'tool',
                    id: messageID,
                    name: 'write',
                    state: { status: 'running', input: inputs.get(messageID) },
                  },
                ],
              },
      },
    },
    permission: {
      request: { list: async () => ({ data: requests.map((r) => ({ ...r })) }) },
      get: async ({ requestID, sessionID }: { requestID: string; sessionID: string }) => {
        const result = requests.find((r) => r.id === requestID && r.sessionID === sessionID);
        if (!result) throw { _tag: 'PermissionNotFoundError' };
        return result;
      },
      reply: async (reply: { sessionID: string; requestID: string; decision: string }) => {
        replies.push(reply);
        for (let i = requests.length - 1; i >= 0; i--)
          if (
            reply.decision === 'reject'
              ? requests[i].sessionID === reply.sessionID
              : requests[i].id === reply.requestID
          )
            requests.splice(i, 1);
      },
    },
    form: { list: async () => ({ data: [] }) },
  } as unknown as OpenCodeClient;
  const sink: DriverSink = {
    session() {},
    turn() {},
    account() {},
    activity() {},
    usage() {},
    approval: (a) => approvals.push(a),
    withdrawn: (id) => withdrawn.push(id),
    ended: (s) => outcomes.push(s),
  };
  const driver = new OpenCodeDriver(async () => ({
    client,
    get exited() {
      return stopping;
    },
    stop: async () => {
      stopping = true;
      resolveNext();
    },
  }));
  function request(id: string, sessionID = 'root') {
    inputs.set(id, { path: `/fixture/${id}.txt`, content: 'Original input' });
    requests.push({
      id,
      sessionID,
      action: 'edit',
      resources: [`/fixture/${id}.txt`],
      source: { type: 'tool', id, messageID: id },
    });
  }
  return {
    driver,
    sink,
    requests,
    inputs,
    approvals,
    withdrawn,
    outcomes,
    replies,
    emit,
    session,
    request,
    get prompts() {
      return prompts;
    },
    set promoted(value: boolean) {
      promoted = value;
    },
  };
}

test('OpenCode review rules preserve ordered denials, remove duplicate rules and never create an allow', () => {
  const rules: PermissionRule[] = [
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'deny' },
    { action: 'shell', resource: 'git status', effect: 'allow' },
    { action: 'edit', resource: '*', effect: 'deny' },
  ];
  const result = reviewedOpenCodeRules(rules);
  assert(!result.some((r) => r.effect === 'allow'));
  assert.deepEqual(
    result.slice(-3).map((r) => r.effect),
    ['deny', 'ask', 'deny'],
  );
  assert.deepEqual(reviewedOpenCodeRules([...rules, ...result]), result);
});

test('OpenCode profile environment excludes ambient credentials and runtime overrides', () => {
  const previous = process.env.FORGE_OPENCODE_UNIT_KEY;
  process.env.FORGE_OPENCODE_UNIT_KEY = 'synthetic';
  try {
    const env = openCodeEnvironment({ ...account, credentialEnv: 'FORGE_OPENCODE_UNIT_KEY' });
    assert.equal(env.FORGE_OPENCODE_UNIT_KEY, 'synthetic');
    assert.equal(env.XDG_CONFIG_HOME, '/native/profile/config');
    assert.equal(env.OPENCODE_DB, '/native/profile/data/opencode/opencode.db');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(env.HOME, undefined);
    assert.throws(
      () => openCodeEnvironment({ ...account, credentialEnv: 'OPENCODE_SIMULATE' }),
      /runtime setting/,
    );
  } finally {
    if (previous === undefined) delete process.env.FORGE_OPENCODE_UNIT_KEY;
    else process.env.FORGE_OPENCODE_UNIT_KEY = previous;
  }
});

test('OpenCode refuses native recovery claims, queued input and background work without rewriting native bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-opencode-recovery-'));
  const path = join(root, 'data', 'opencode', 'opencode.db');
  await mkdir(join(root, 'data', 'opencode'), { recursive: true });
  try {
    await assertIdleOpenCodeProfile(root);
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TABLE session_v2 (time_suspended INTEGER); CREATE TABLE session_pending (id TEXT); CREATE TABLE kv (key TEXT);',
    );
    await assertIdleOpenCodeProfile(root);
    for (const [insert, clear] of [
      ['INSERT INTO session_v2 VALUES (1)', 'DELETE FROM session_v2'],
      ["INSERT INTO session_pending VALUES ('pending')", 'DELETE FROM session_pending'],
      ["INSERT INTO kv VALUES ('job.background/native')", 'DELETE FROM kv'],
    ]) {
      db.exec(insert);
      const before = await readFile(path);
      await assert.rejects(assertIdleOpenCodeProfile(root), /unfinished native recovery or input/);
      assert.deepEqual(await readFile(path), before);
      db.exec(clear);
    }
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenCode rejects unsupported billing before opening a native worker', async () => {
  let opened = false;
  const driver = new OpenCodeDriver(async () => {
    opened = true;
    throw new Error('Not opened');
  });
  const f = fixture();
  await assert.rejects(driver.start({ ...context, allowMetered: false }, f.sink), /Allow metered/);
  await assert.rejects(
    driver.start({ ...context, account: { ...account, billingMode: 'subscription' } }, f.sink),
    /subscription allowance/,
  );
  assert.equal(opened, false);
  await driver.close();
});

test('changed OpenCode tool input cannot receive the reviewed one-time grant', async () => {
  const f = fixture();
  f.request('request');
  const running = f.driver.start(context, f.sink);
  void running.catch(() => {});
  try {
    await until(() => f.approvals.length === 1);
    f.inputs.set('request', { path: '/changed.txt', content: 'Changed input' });
    await assert.rejects(Promise.resolve(f.approvals[0].respond('accept')), /changed after review/);
    assert.equal(f.replies.length, 0);
  } finally {
    await f.driver.close();
    await running.catch(() => {});
  }
});

test('OpenCode rejection withdraws sibling requests only in the exact native session', async () => {
  const f = fixture();
  f.request('one');
  f.request('two');
  f.request('three', 'child');
  f.request('foreign', 'foreign');
  const running = f.driver.start(context, f.sink);
  void running.catch(() => {});
  try {
    await until(() => f.approvals.length === 3);
    const one = f.approvals.find((a) => a.requestId === 'root:one')!;
    await one.respond('decline');
    assert.deepEqual(f.replies, [{ sessionID: 'root', requestID: 'one', decision: 'reject' }]);
    assert.deepEqual(f.withdrawn, ['root:two']);
    const child = f.approvals.find((a) => a.requestId === 'child:three')!;
    assert(child.command.includes('child'));
    assert.equal(child.sessionId, 'root');
    await child.respond('accept');
    assert.deepEqual(f.replies[1], { sessionID: 'child', requestID: 'three', decision: 'once' });
    assert(f.requests.some((r) => r.id === 'foreign'));
  } finally {
    await f.driver.close();
    await running.catch(() => {});
  }
});

test('OpenCode event reconnect fails the attempt and never replays task input', async () => {
  const f = fixture();
  const running = f.driver.start(context, f.sink);
  void running.catch(() => {});
  try {
    await until(() => f.prompts === 1);
    f.emit({ type: 'server.connected' });
    await assert.rejects(running, /transport reconnected/);
    assert.equal(f.prompts, 1);
    assert.equal(f.outcomes.length, 0);
  } finally {
    await f.driver.close();
  }
});

test('OpenCode completion requires native input promotion and matching settled outcome', async () => {
  const f = fixture();
  f.promoted = false;
  const running = f.driver.start(context, f.sink);
  void running.catch(() => {});
  try {
    await until(() => f.prompts === 1);
    f.emit({ type: 'session.execution.succeeded', data: { sessionID: 'root' } });
    await assert.rejects(running, /promotion and final settlement/);
    assert.equal(f.outcomes.length, 0);
  } finally {
    await f.driver.close();
  }
});

test('OpenCode cumulative usage keeps native token facets and a stable account/session scope', () => {
  const f = fixture();
  const usage = openCodeUsage(context, f.session as SessionInfo);
  assert.equal(usage.totalTokens, 25);
  assert.equal(usage.key, 'opencode:account:root');
  assert.equal(usage.estimatedUsd, 0.02);
  assert.equal(openCodeUsage(context, { ...f.session, cost: 0.04 } as SessionInfo).key, usage.key);
  assert.throws(
    () => openCodeUsage(context, { ...f.session, cost: NaN } as SessionInfo),
    /invalid native usage/,
  );
});

test('OpenCode removes its temporary review overlay only after native settlement', async () => {
  const f = fixture();
  const running = f.driver.start(context, f.sink);
  void running.catch(() => {});
  try {
    await until(() => f.prompts === 1);
    assert(f.session.permissions.length > 0);
    f.emit({ type: 'session.execution.succeeded', data: { sessionID: 'root' } });
    await running;
    assert.deepEqual(f.outcomes, ['completed']);
    assert.deepEqual(f.session.permissions, []);
  } finally {
    await f.driver.close();
  }
});

test('a residual native review overlay cannot silently override a new native project policy', async () => {
  const f = fixture();
  f.session.permissions.push({ action: '*', resource: '*', effect: 'ask' });
  try {
    await assert.rejects(f.driver.start(context, f.sink), /residual permission rules/);
    assert.equal(f.prompts, 0);
    assert.equal(f.session.permissions.length, 1);
  } finally {
    await f.driver.close();
  }
});
