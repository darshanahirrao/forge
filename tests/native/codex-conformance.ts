// Opt-in actual app-server/tool conformance against a deterministic loopback Responses fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPhoneGateway } from '../../server/phone.js';
import { createApp } from '../../server/app.js';
import { NativeRpc } from '../../server/adapters/rpc.js';
import type { Account, Approval, Usage, Work } from '../../shared/types.js';

const directory = await mkdtemp(join(tmpdir(), 'forge-native-codex-'));
const project = join(directory, 'project');
const nativeHome = join(directory, 'native');
await mkdir(project);
await mkdir(nativeHome);
const artifact = join(project, 'proof.txt');
const proof = 'Forge native Codex conformance.\n';
let requests = 0;
let sentCommand = false;
const provider = createServer(async (request, reply) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (!request.url?.includes('/responses')) {
    reply.setHeader('content-type', 'application/json');
    reply.end('{}');
    return;
  }
  requests++;
  const available = Array.isArray(body.tools) ? body.tools : [];
  const tool = available.find((entry: { name?: string }) => entry.name === 'exec_command');
  const call = !sentCommand && Boolean(tool);
  if (call) sentCommand = true;
  const output = call
    ? {
        id: 'fc-forge-proof',
        type: 'function_call',
        call_id: 'forge-proof-call',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: "printf 'Forge native Codex conformance.\\n' > proof.txt",
          workdir: project,
          max_output_tokens: 1000,
        }),
      }
    : {
        id: 'msg-forge-proof',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'The local native conformance fixture completed.',
            annotations: [],
          },
        ],
        status: 'completed',
      };
  const response = {
    id: `resp-forge-${requests}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: body.model,
    output: [output],
    usage: {
      input_tokens: 10,
      output_tokens: 8,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
  reply.setHeader('content-type', 'text/event-stream');
  const emit = (value: { type: string; [key: string]: unknown }) =>
    reply.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  emit({ type: 'response.created', response: { ...response, output: [], status: 'in_progress' } });
  emit({ type: 'response.output_item.added', output_index: 0, item: output });
  emit({ type: 'response.output_item.done', output_index: 0, item: output });
  emit({ type: 'response.completed', response });
  reply.end();
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
assert(address && typeof address === 'object');
await writeFile(
  join(nativeHome, 'config.toml'),
  `model = "forge-conformance"\nmodel_provider = "fixture"\ncli_auth_credentials_store = "file"\n[model_providers.fixture]\nname = "Local conformance fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
);
const phoneOrigin = 'https://forge.conformance.ts.net';
const phoneIdentity = 'reviewer@example.com';
const bridge = { origin: phoneOrigin, proof: randomBytes(32).toString('hex') };
const state = await createApp({
  port: 0,
  phoneBridge: bridge,
  filename: ':memory:',
  csrf: 'native-conformance',
  test: true,
  rpcFactory: (options) =>
    new NativeRpc({
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        CODEX_HOME: nativeHome,
        LANG: 'en_US.UTF-8',
      },
    }),
});
const upstream = await state.app.listen({ host: '127.0.0.1', port: 0 });
const gateway = await createPhoneGateway(
  { origin: phoneOrigin, users: [phoneIdentity], port: 0 },
  upstream,
  bridge,
);
const phoneAddress = await gateway.listen({ host: '127.0.0.1', port: 0 });
const call = (url: string, payload: Record<string, unknown>) =>
  state.app.inject({
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:0',
      'x-forge-csrf': 'native-conformance',
      'content-type': 'application/json',
    },
    payload,
  });
try {
  const account = (
    await call('/api/accounts', {
      label: 'Native conformance',
      harness: 'codex',
      nativeHome,
      billingMode: 'native',
    })
  ).json<Account>();
  const work = (
    await call('/api/work', {
      title: 'Native Codex artifact proof',
      project: 'Synthetic',
      cwd: project,
      goal: 'Produce the single conformance artifact requested by the local fixture provider.',
      acceptance: 'The proof.txt content must match exactly.',
      harness: 'codex',
      accountId: account.id,
    })
  ).json<Work>();
  const launch = await call(`/api/work/${work.id}/launch`, {
    expectedRevision: work.revision,
    allowMetered: true,
  });
  assert.equal(launch.statusCode, 202, launch.body);
  const deadline = Date.now() + 45000;
  let decisions = 0;
  while (Date.now() < deadline) {
    for (const approval of state.local
      .all<Approval>('approvals')
      .filter((a) => a.status === 'pending')) {
      assert.equal(approval.method, 'item/commandExecution/requestApproval');
      assert.ok(approval.command.includes('proof.txt'));
      const path = `/api/approvals/${approval.id}/decision`;
      assert.equal(
        (
          await fetch(phoneAddress + path, {
            method: 'POST',
            headers: {
              origin: phoneOrigin,
              'content-type': 'application/json',
              'x-forge-csrf': 'native-conformance',
            },
            body: JSON.stringify({ digest: approval.digest, decision: 'accept' }),
          })
        ).status,
        401,
      );
      await assert.rejects(readFile(artifact), { code: 'ENOENT' });
      const result = await fetch(phoneAddress + path, {
        method: 'POST',
        headers: {
          origin: phoneOrigin,
          'tailscale-user-login': phoneIdentity,
          'content-type': 'application/json',
          'x-forge-csrf': 'native-conformance',
        },
        body: JSON.stringify({ digest: approval.digest, decision: 'accept' }),
      });
      assert.equal(result.status, 200, await result.text());
      assert.deepEqual(state.local.get<Approval>('approvals', approval.id)?.decidedBy, {
        kind: 'tailscale',
        identity: phoneIdentity,
      });
      decisions++;
    }
    if (['completed', 'failed', 'interrupted'].includes(state.local.work(work.id).status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    state.local.work(work.id).status,
    'completed',
    JSON.stringify(state.local.recentEvents(work.id)),
  );
  assert.equal(await readFile(artifact, 'utf8'), proof);
  assert.equal(state.controller.activeCount, 0);
  const usage = state.local.all<Usage>('usage');
  assert.equal(usage.length, 1);
  assert.ok(usage[0].totalTokens > 0);
  console.log(
    JSON.stringify({
      status: 'passed',
      harness: 'codex',
      provider: 'synthetic loopback only',
      artifactVerified: true,
      nativeApprovals: decisions,
      requestCount: requests,
      nativeUsageObserved: true,
      paidModelCalls: 0,
      phoneGatewayNativeDecision: true,
      authenticatedIdentityRecorded: true,
      phoneTransport: 'loopback native-Serve-header fixture; actual tailnet not configured',
    }),
  );
} finally {
  await gateway.close();
  await state.app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
