// Owned protocol fixture. No provider/model/inference loop. Never used by production.
import { agent, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const home = process.env.FIXTURE_AGENT_HOME;
if (!home) throw new Error('An owned fixture home is required.');
const filename = join(home, 'owned-acp-sessions.json');
let sessions = await readFile(filename, 'utf8')
  .then(JSON.parse)
  .catch(() => ({}));
const state = (sessionId) => ({
  sessionId,
  modes: { currentModeId: 'review', availableModes: [{ id: 'review', name: 'Native review' }] },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: sessions[sessionId].model,
      options: [
        { value: 'fixture/default', name: 'Default' },
        { value: 'fixture/proof', name: 'Proof' },
      ],
    },
  ],
});
const native = agent()
  .onRequest('initialize', () => ({
    protocolVersion: 1,
    agentInfo: { name: 'owned-acp-fixture', version: '1.0.0' },
    agentCapabilities: { loadSession: true },
  }))
  .onRequest('session/new', async ({ params }) => {
    const id = randomUUID();
    sessions[id] = { cwd: params.cwd, model: 'fixture/default' };
    await writeFile(filename, JSON.stringify(sessions));
    return state(id);
  })
  .onRequest('session/load', ({ params }) => {
    if (sessions[params.sessionId]?.cwd !== params.cwd)
      throw new Error('The owned session/cwd is unavailable.');
    return state(params.sessionId);
  })
  .onRequest('session/set_config_option', async ({ params }) => {
    if (
      !sessions[params.sessionId] ||
      params.configId !== 'model' ||
      !['fixture/default', 'fixture/proof'].includes(params.value)
    )
      throw new Error('Unsupported owned model selection.');
    sessions[params.sessionId].model = params.value;
    await writeFile(filename, JSON.stringify(sessions));
    return { configOptions: state(params.sessionId).configOptions };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const cwd = sessions[params.sessionId]?.cwd;
    if (!cwd) throw new Error('Unknown owned fixture session.');
    const path = join(cwd, 'owned-connector-proof.json');
    const contents = JSON.stringify(
      { prompt: params.prompt, credentialPresent: Boolean(process.env.FIXTURE_API_KEY), home },
      null,
      2,
    );
    const result = await client.request('session/request_permission', {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: randomUUID(),
        title: 'Write owned connector proof',
        kind: 'edit',
        rawInput: { path, contents },
      },
      options: [
        { kind: 'allow_once', optionId: 'owned-once', name: 'Allow once' },
        { kind: 'reject_once', optionId: 'owned-deny', name: 'Deny once' },
      ],
    });
    if (result.outcome.outcome !== 'selected' || result.outcome.optionId !== 'owned-once')
      return { stopReason: 'cancelled' };
    await writeFile(path, contents);
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Owned proof written after exact one-time review.' },
      },
    });
    return { stopReason: 'end_turn' };
  });
native.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin), {
    maxMessageBytes: 2 * 1024 * 1024,
  }),
);
