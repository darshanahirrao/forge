// An actual installed OpenCode ACP worker through a registered generic connector.
// Owned loopback provider, isolated HOME/XDG roots and synthetic credential only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixtureProvider } from './provider.js';
import { unknownPressure } from '../../server/memory-pressure.js';
import { findBinary } from '../../server/adapters/discovery.js';
import type { Approval, Run, Work } from '../../shared/types.js';

const { createApp } = (await import(
  new URL('../../dist/server/app.js', import.meta.url).href
)) as typeof import('../../server/app.js');
const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-native-connector-')));
const home = join(root, 'native'),
  project = join(root, 'project'),
  artifact = join(project, 'connector-proof.txt');
const marker = 'Actual native generic ACP connector proof.\n';
let memorySeen = false,
  observedModel = '';
const provider = await fixtureProvider(
  'chat',
  (body) => {
    if (!body.tools?.length) return { text: 'Owned native connector fixture title.' };
    observedModel = body.model;
    memorySeen ||= JSON.stringify(body.messages).includes(
      'Selected generic connector continuity marker',
    );
    const written = body.messages?.some(
      (message: { role: string; tool_call_id: string }) =>
        message.role === 'tool' && message.tool_call_id === 'owned-connector-write',
    );
    if (written) return { text: 'The native connector proof is ready.' };
    assert.ok(
      body.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'write'),
    );
    return {
      tool: 'write',
      id: 'owned-connector-write',
      input: { path: artifact, content: marker },
    };
  },
  'owned-synthetic-connector-key',
);
let state: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  for (const path of [
    project,
    join(home, 'config', 'opencode'),
    join(home, 'data'),
    join(home, 'state'),
    join(home, 'cache'),
  ])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(home, 'config', 'opencode', 'opencode.json'),
    JSON.stringify({
      model: 'forge/proof',
      update: 'disable',
      share: 'disabled',
      snapshots: false,
      permissions: [{ action: 'edit', resource: '*', effect: 'ask' }],
      providers: {
        forge: {
          env: ['FIXTURE_API_KEY'],
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: provider.endpoint + '/v1', timeout: 10000 },
          models: {
            proof: {
              name: 'Owned synthetic provider',
              cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
              limit: { context: 32768, output: 2048 },
              capabilities: { tools: true, input: ['text'], output: ['text'] },
            },
          },
        },
      },
    }),
  );
  // The ACP child resolves session configuration from its cwd. Pin the model
  // and provide the owned native project config rather than assuming XDG inheritance.
  await writeFile(
    join(project, 'opencode.json'),
    await readFile(join(home, 'config', 'opencode', 'opencode.json')),
  );
  const secret = join(root, 'private.json');
  await writeFile(secret, '{"selected":"owned-synthetic-connector-key"}', { mode: 0o600 });
  const executable =
    process.env.FORGE_CONNECTOR_CONFORMANCE_BINARY || (await findBinary('opencode'));
  assert.ok(executable, 'Install native OpenCode before running this explicit conformance check.');
  const nativeVersionOutput = (
    await promisify(execFile)(executable, ['--version'], { timeout: 5000 })
  ).stdout.trim();
  const nativeVersion = /^(?:opencode v)?(2\.0\.\d+)$/.exec(nativeVersionOutput)?.[1];
  assert.ok(nativeVersion, 'The native version output is unsupported.');
  state = await createApp({
    filename: ':memory:',
    test: true,
    memoryPressureReader: unknownPressure,
  });
  const plan = await state.connectors.prepare({
    format: 'forge.native-connector',
    version: 1,
    id: 'ext.opencode-acp.v1',
    name: 'Native OpenCode ACP',
    protocol: 'acp/1',
    executable,
    args: ['acp'],
    agent: { name: 'OpenCode', version: nativeVersion },
    mode: 'build',
    model: 'forge/proof',
    homeVariables: {
      XDG_CONFIG_HOME: 'config',
      XDG_DATA_HOME: 'data',
      XDG_STATE_HOME: 'state',
      XDG_CACHE_HOME: 'cache',
    },
  });
  const connector = await state.connectors.install(plan.id, plan.connector.digest);
  const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': state.csrf };
  const accountResponse = await state.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: {
      label: 'Owned native ACP slot',
      harness: connector.id,
      connectorId: connector.id,
      nativeHome: home,
      billingMode: 'api',
      credentialEnv: 'FIXTURE_API_KEY',
      credentialReference: { kind: 'private-json', path: secret, key: 'selected' },
    },
  });
  assert.equal(accountResponse.statusCode, 201, accountResponse.body);
  const account = accountResponse.json();
  const workResponse = await state.app.inject({
    method: 'POST',
    url: '/api/work',
    headers,
    payload: {
      title: 'Native generic ACP proof',
      project: 'Owned native fixture',
      cwd: project,
      goal: 'Write connector-proof.txt using the native write tool.',
      context: 'Selected generic connector continuity marker',
      harness: connector.id,
      accountId: account.id,
    },
  });
  assert.equal(workResponse.statusCode, 201, workResponse.body);
  const work = workResponse.json() as Work;
  await state.controller.launch(work.id, true, false, work.revision);
  const deadline = Date.now() + 45000;
  let approvals = 0;
  while (Date.now() < deadline && state.local.work(work.id).activeRunId) {
    for (const approval of state.local
      .all<Approval>('approvals')
      .filter((row) => row.workId === work.id && row.status === 'pending')) {
      assert.equal(approval.method, `${connector.id}/acp/request_permission`);
      await state.controller.decide(approval.id, approval.digest, 'accept', { kind: 'local' });
      approvals++;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = state.local.all<Run>('runs')[0];
  if (process.argv.includes('--expect-model-hold')) {
    assert.equal(run.status, 'failed');
    assert.ok(
      state.local
        .recentEvents(work.id)
        .some((event) =>
          /reviewed model is not offered|connector model binding/.test(event.detail),
        ),
    );
    assert.equal(provider.requests(), 0);
    assert.equal(approvals, 0);
    await assert.rejects(readFile(artifact), { code: 'ENOENT' });
    console.log(
      JSON.stringify({
        status: 'passed',
        native: `OpenCode ACP ${nativeVersion}`,
        expectedModelHold: true,
        taskInputSent: false,
        providerRequests: 0,
        approvals: 0,
        paidModelCalls: 0,
      }),
    );
  } else {
    assert.equal(run.status, 'completed', JSON.stringify(state.local.recentEvents(work.id)));
    assert.equal(run.exitConfirmed, true);
    assert.equal(await readFile(artifact, 'utf8'), marker);
    assert.ok(approvals > 0, 'The actual native approval boundary was not observed.');
    assert.equal(memorySeen, true);
    assert.equal(observedModel, 'proof');
    assert.equal(
      state.local.all('usage').length,
      0,
      'Unverified billable counters were fabricated.',
    );
    assert.equal(
      JSON.stringify(state.local.all('accounts')).includes('owned-synthetic-connector-key'),
      false,
    );
    assert.equal(provider.failure(), null);
    console.log(
      JSON.stringify({
        status: 'passed',
        native: `OpenCode ACP ${nativeVersion}`,
        manifestContract: connector.manifest.protocol,
        nativeConfigMode: 'build',
        pinnedModel: 'forge/proof',
        approvals,
        artifactVerified: true,
        selectedContextSeen: true,
        privateReferenceUsed: true,
        billableUsageUnverified: true,
        requests: provider.requests(),
        paidModelCalls: 0,
      }),
    );
  }
} finally {
  await state?.app.close();
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
