import test from 'node:test';
import assert from 'node:assert/strict';
import { agent, type AgentContext, type NewSessionResponse } from '@agentclientprotocol/sdk';
import { AcpDriver } from '../server/adapters/acp-driver.js';
import type { DriverContext, NativeApproval } from '../server/adapters/driver.js';

const mode = (value: string) => ({
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select' as const,
  currentValue: value,
  options: [
    { value: 'review', name: 'Review' },
    { value: 'unattended', name: 'Unattended' },
  ],
});
const context = {
  work: { id: 'owned-work', cwd: process.cwd(), nativeSessionId: null },
  account: { id: 'owned-account', harness: 'ext.owned.v1', billingMode: 'native' },
  run: { id: 'owned-run' },
  allowMetered: true,
  prompt: 'Owned protocol fixture only.',
} as DriverContext;

function fixture(state: NewSessionResponse) {
  let peer!: AgentContext,
    prompts = 0;
  const approvals: NativeApproval[] = [],
    withdrawn: (string | number)[] = [];
  const native = agent()
    .onRequest('initialize', () => ({
      protocolVersion: 1,
      agentInfo: { name: 'owned', version: '1' },
    }))
    .onRequest('session/new', () => state)
    .onRequest('session/prompt', async ({ client }) => {
      peer = client;
      prompts++;
      const permission = await client.request('session/request_permission', {
        sessionId: 'owned-session',
        toolCall: {
          toolCallId: 'owned-tool',
          kind: 'edit',
          title: 'Owned edit',
          rawInput: { path: '/owned/proof', contents: 'Owned.' },
        },
        options: [
          { kind: 'allow_once', optionId: 'once', name: 'Once' },
          { kind: 'reject_once', optionId: 'deny', name: 'Deny' },
        ],
      });
      assert.notEqual(
        permission.outcome.outcome === 'selected' && permission.outcome.optionId,
        'once',
      );
      return { stopReason: 'cancelled' };
    });
  const driver = new AcpDriver({
    harness: 'ext.owned.v1',
    name: 'Owned agent',
    mode: 'review',
    configModes: true,
    coverage: 'Owned test',
    start: async (app) => {
      const connection = app.connect(native);
      let exited = false;
      return {
        connection,
        get exited() {
          return exited;
        },
        stop: async () => {
          exited = true;
          connection.close();
        },
      };
    },
    initialize: (worker) => worker.connection.agent.request('initialize', { protocolVersion: 1 }),
    report: () => ({ status: 'interrupted', detail: 'Owned fixture ended.' }),
  });
  const sink = {
    session() {},
    turn() {},
    account() {},
    activity() {},
    usage() {},
    ended() {},
    approval: (value: NativeApproval) => approvals.push(value),
    withdrawn: (id: string | number) => withdrawn.push(id),
  };
  return {
    driver,
    sink,
    approvals,
    withdrawn,
    prompts: () => prompts,
    update: (value: string) =>
      peer.notify('session/update', {
        sessionId: 'owned-session',
        update: { sessionUpdate: 'config_option_update', configOptions: [mode(value)] },
      }),
  };
}

test('conflicting legacy and configuration permission modes refuse native input', async (t) => {
  const f = fixture({
    sessionId: 'owned-session',
    modes: { currentModeId: 'review', availableModes: [{ id: 'review', name: 'Review' }] },
    configOptions: [mode('unattended')],
  });
  t.after(() => f.driver.close());
  await assert.rejects(f.driver.start(context, f.sink), /configured permission mode/);
  assert.equal(f.prompts(), 0);
  assert.equal(f.approvals.length, 0);
});

test('a native config-option mode change withdraws a pending exact permission without sending a replacement grant', async (t) => {
  const f = fixture({ sessionId: 'owned-session', configOptions: [mode('review')] });
  t.after(() => f.driver.close());
  const running = f.driver.start(context, f.sink);
  const result = running.catch(() => {});
  for (let i = 0; i < 100 && !f.approvals.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.approvals.length, 1);
  await f.update('unattended');
  await result;
  assert.equal(f.approvals[0].signal?.aborted, true);
  assert.ok(f.withdrawn.includes(f.approvals[0].requestId));
  assert.throws(() => f.approvals[0].respond('accept'), /no longer pending/);
});
