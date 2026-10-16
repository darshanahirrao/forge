// Opt-in native CLI conformance. The only model endpoint is a local deterministic fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Account, Approval, Usage, Work } from '../../shared/types.js';
import { createApp } from '../../server/app.js';
import { ClaudeDriver } from '../../server/adapters/claude-driver.js';

const directory = await mkdtemp(join(tmpdir(), 'forge-native-claude-'));
const project = join(directory, 'project');
const nativeHome = join(directory, 'native');
await mkdir(project);
await mkdir(nativeHome);
await mkdir(join(project, '.claude'));
// Contradictory native settings must not replace the explicitly selected host route or credential.
await writeFile(
  join(project, '.claude', 'settings.json'),
  JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_API_KEY: 'incorrect-synthetic-key',
      CLAUDE_CODE_USE_VERTEX: '1',
    },
  }),
);
const artifact = join(project, 'proof.txt');
const proof = 'Forge native tool conformance.\n';
let requests = 0;
let writeRequested = false;
let selectedCredential = true;
const provider = createServer(async (request, reply) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (request.url?.includes('/count_tokens')) {
    reply.setHeader('content-type', 'application/json');
    reply.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  if (!request.url?.startsWith('/v1/messages')) {
    reply.setHeader('content-type', 'application/json');
    reply.end('{}');
    return;
  }
  requests++;
  if (request.headers['x-api-key'] !== 'synthetic-local-provider-key') {
    selectedCredential = false;
    reply.statusCode = 401;
    reply.setHeader('content-type', 'application/json');
    reply.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Synthetic credential mismatch.' },
      }),
    );
    return;
  }
  const toolReturned = JSON.stringify(body.messages ?? []).includes('forge-native-write');
  const canWrite =
    Array.isArray(body.tools) && body.tools.some((tool: { name: string }) => tool.name === 'Write');
  const write = canWrite && !toolReturned && !writeRequested;
  if (write) writeRequested = true;
  const model = body.model;
  const content = write
    ? {
        type: 'tool_use',
        id: 'forge-native-write',
        name: 'Write',
        input: { file_path: artifact, content: proof },
      }
    : { type: 'text', text: 'The local conformance fixture completed.' };
  const message = {
    id: `msg-forge-${requests}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [content],
    stop_reason: write ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 8 },
  };
  if (!body.stream) {
    reply.setHeader('content-type', 'application/json');
    reply.end(JSON.stringify(message));
    return;
  }
  reply.setHeader('content-type', 'text/event-stream');
  const emit = (value: { type: string; [key: string]: unknown }) =>
    reply.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  emit({
    type: 'message_start',
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  emit({
    type: 'content_block_start',
    index: 0,
    content_block: write ? { ...content, input: {} } : { type: 'text', text: '' },
  });
  emit({
    type: 'content_block_delta',
    index: 0,
    delta: write
      ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
      : { type: 'text_delta', text: content.text },
  });
  emit({ type: 'content_block_stop', index: 0 });
  emit({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  emit({ type: 'message_stop' });
  reply.end();
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
assert(address && typeof address === 'object');
const endpoint = `http://127.0.0.1:${address.port}`;
const previous = process.env.FORGE_NATIVE_CONFORMANCE_KEY;
process.env.FORGE_NATIVE_CONFORMANCE_KEY = 'synthetic-local-provider-key';
const state = await createApp({
  filename: ':memory:',
  csrf: 'native-conformance',
  test: true,
  driverFactory: () =>
    new ClaudeDriver((params) =>
      query({
        ...params,
        options: {
          ...params.options,
          model: 'claude-sonnet-4-5-20250929',
          maxTurns: 3,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            TMPDIR: directory,
            CLAUDE_CONFIG_DIR: nativeHome,
            ANTHROPIC_API_KEY: params.options.env?.ANTHROPIC_API_KEY,
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:
              params.options.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
            ANTHROPIC_BASE_URL: endpoint,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
            API_TIMEOUT_MS: '8000',
          },
        },
      }),
    ),
});
const call = (url: string, payload: Record<string, unknown>) =>
  state.app.inject({
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:4710',
      'x-forge-csrf': 'native-conformance',
      'content-type': 'application/json',
    },
    payload,
  });
try {
  const account = (
    await call('/api/accounts', {
      label: 'Native conformance',
      harness: 'claude',
      nativeHome,
      billingMode: 'api',
      credentialEnv: 'FORGE_NATIVE_CONFORMANCE_KEY',
    })
  ).json<Account>();
  const work = (
    await call('/api/work', {
      title: 'Native artifact proof',
      project: 'Synthetic',
      cwd: project,
      goal: 'Produce the single conformance artifact requested by the local provider.',
      acceptance: 'The proof.txt content must match exactly.',
      harness: 'claude',
      accountId: account.id,
    })
  ).json<Work>();
  const launch = await call(`/api/work/${work.id}/launch`, {
    expectedRevision: work.revision,
    allowMetered: true,
  });
  assert.equal(launch.statusCode, 202, launch.body);
  const deadline = Date.now() + 45000;
  let decisionCount = 0;
  while (Date.now() < deadline) {
    for (const approval of state.local
      .all<Approval>('approvals')
      .filter((a) => a.status === 'pending')) {
      assert.equal(approval.method, 'claude/canUseTool/Write');
      assert.ok(approval.command.includes(artifact));
      const result = await call(`/api/approvals/${approval.id}/decision`, {
        digest: approval.digest,
        decision: 'accept',
      });
      assert.equal(result.statusCode, 200, result.body);
      decisionCount++;
    }
    const current = state.local.work(work.id);
    if (['completed', 'failed', 'interrupted'].includes(current.status)) {
      assert.equal(current.status, 'completed', JSON.stringify(state.local.recentEvents(work.id)));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    state.local.work(work.id).status,
    'completed',
    JSON.stringify(state.local.recentEvents(work.id)),
  );
  assert.equal(await readFile(artifact, 'utf8'), proof);
  assert.equal(decisionCount, 1);
  assert.equal(selectedCredential, true);
  assert.equal(state.controller.activeCount, 0);
  const usage = state.local.all<Usage>('usage');
  assert.equal(usage.length, 1);
  assert.ok(usage[0].totalTokens > 0);
  console.log(
    JSON.stringify({
      status: 'passed',
      harness: 'claude',
      sdk: '0.3.301',
      provider: 'synthetic loopback only',
      artifactVerified: true,
      nativeApprovals: decisionCount,
      requestCount: requests,
      nativeUsageObserved: true,
      settingsOverrideRejected: true,
      paidModelCalls: 0,
    }),
  );
} finally {
  await state.app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (previous === undefined) delete process.env.FORGE_NATIVE_CONFORMANCE_KEY;
  else process.env.FORGE_NATIVE_CONFORMANCE_KEY = previous;
  await rm(directory, { recursive: true, force: true });
}
