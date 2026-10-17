// Protocol fixture only. It performs no shell commands, model calls, or project writes.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let initialized = false;
let threadId = randomUUID();
const turnId = 'fixture-turn';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initialized = true;
    send({ id: message.id, result: { userAgent: 'fixture' } });
    return;
  }
  if (!initialized) return;
  if (message.method === 'initialized') return;
  if (message.method === 'thread/list') {
    if (message.params?.useStateDbOnly !== true || message.params?.limit !== 100)
      send({
        id: message.id,
        error: { code: -32602, message: 'Fixture requires a bounded state-only catalog.' },
      });
    else
      send({
        id: message.id,
        result: {
          data: [
            {
              id: 'fixture-observed-thread',
              name: 'Existing native fixture chat',
              cwd: '/fixture/project',
              updatedAt: 1792170000,
              status: { type: 'notLoaded' },
            },
          ],
          nextCursor: 'more-native-chats',
        },
      });
    return;
  }
  if (message.method === 'account/read')
    send({
      id: message.id,
      result: {
        account: process.env.FORGE_FIXTURE_METERED
          ? { type: 'apiKey' }
          : { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' },
        requiresOpenaiAuth: true,
      },
    });
  else if (message.method === 'account/rateLimits/read')
    send({
      id: message.id,
      result: {
        accountId: 'fixture-identity',
        ordinaryUsageAllowed: true,
        rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 } },
      },
    });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.method === 'thread/resume') threadId = message.params.threadId;
    send({
      id: message.id,
      result: {
        thread: { id: threadId },
        approvalPolicy: process.env.FORGE_FIXTURE_BAD_POLICY ? 'never' : 'untrusted',
        sandbox: { type: 'workspaceWrite' },
      },
    });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
    send({
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item: { id: 'fixture-command', type: 'commandExecution', command: 'echo protocol-fixture' },
      },
    });
    send({
      id: 'native-request-71',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: 'fixture-command',
        kind: 'command',
        command: 'echo protocol-fixture',
        cwd: '/fixture',
        reason: 'A synthetic permission request',
      },
    });
    if (process.env.FORGE_FIXTURE_WITHDRAW)
      send({
        method: 'serverRequest/resolved',
        params: { threadId, requestId: 'native-request-71' },
      });
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'interrupted' } },
    });
  } else if (message.id === 'native-request-71' && message.result) {
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          id: 'fixture-command',
          type: 'commandExecution',
          command: 'echo protocol-fixture',
          exitCode: message.result.decision === 'accept' ? 0 : 1,
        },
      },
    });
    const usage = {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: { inputTokens: 80, outputTokens: 20, cachedInputTokens: 30, totalTokens: 100 },
          last: {},
        },
      },
    };
    send(usage);
    send(usage);
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          id: 'fixture-response',
          type: 'agentMessage',
          text: 'The protocol fixture completed without executing a command.',
        },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } },
    });
  } else if (message.id !== undefined && message.method)
    send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } });
});
