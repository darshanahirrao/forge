import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, Approval, Run, Usage, Work } from '../../shared/types.js';
import type { NativeContinuationReview } from '../../shared/native-continuations.js';
import { BusyResourceTrace } from './busy-resource-trace.js';
const busyTrace = process.argv.includes('--busy-resource-trace') ? new BusyResourceTrace() : null;
const { createApp } = (await import(
  new URL('../../dist/server/app.js', import.meta.url).href
)) as typeof import('../../server/app.js');
const { NativeRpc } = (await import(
  new URL('../../dist/server/adapters/rpc.js', import.meta.url).href
)) as typeof import('../../server/adapters/rpc.js');
const { readCodexHistory } = (await import(
  new URL('../../dist/server/adapters/codex-history.js', import.meta.url).href
)) as typeof import('../../server/adapters/codex-history.js');
const { unknownPressure } = (await import(
  new URL('../../dist/server/memory-pressure.js', import.meta.url).href
)) as typeof import('../../server/memory-pressure.js');
const { readWorkerExit } = (await import(
  new URL('../../dist/server/worker-proof.mjs', import.meta.url).href
)) as typeof import('../../server/worker-proof.mjs');
const { findBinary } = (await import(
  new URL('../../dist/server/adapters/discovery.js', import.meta.url).href
)) as typeof import('../../server/adapters/discovery.js');
const selectedBinary = process.env.FORGE_CODEX_BINARY ?? (await findBinary('codex'));
assert(
  selectedBinary,
  'Install Codex on PATH or supply FORGE_CODEX_BINARY for this isolated native check.',
);
const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-native-continuation-'))),
  home = join(root, 'native'),
  project = join(root, 'project');
await mkdir(home);
await mkdir(project);
let requests = 0,
  managedRequests = 0,
  sourcePhase = true,
  wrote = false;
const marker = 'native-history-marker-1',
  artifact = join(project, 'continued.txt'),
  busyStarted = join(project, 'busy.started');
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const controlledTool = `const {writeFileSync}=require('node:fs'); const retained=Buffer.alloc(32*1024*1024,1);writeFileSync('busy.started','controlled load started'); const end=Date.now()+16000; (async()=>{while(Date.now()<end){const until=performance.now()+4;while(performance.now()<until){Math.sqrt(retained[0]+performance.now());}await new Promise(r=>setTimeout(r,96));}writeFileSync('continued.txt',${JSON.stringify(marker + '\n')});})();`;
let historyObserved = false;
const provider = createServer(async (request, response) => {
  let raw = '';
  for await (const part of request) raw += part;
  if (!request.url?.includes('/responses')) {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
    return;
  }
  requests++;
  const body = JSON.parse(raw);
  const tool = (body.tools ?? []).find((entry: { name: string }) => entry.name === 'exec_command');
  if (!sourcePhase) {
    managedRequests++;
    historyObserved ||= JSON.stringify(body.input).includes(marker);
  }
  const call = !sourcePhase && !wrote && Boolean(tool);
  if (call) wrote = true;
  const output = call
    ? {
        id: 'fc-native-continuation',
        type: 'function_call',
        call_id: 'native-continuation-call',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: busyTrace
            ? `${quote(process.execPath)} -e ${quote(controlledTool)}`
            : "printf 'native-history-marker-1\\n' > continued.txt",
          workdir: project,
          max_output_tokens: 1000,
          ...(busyTrace ? { yield_time_ms: 30000 } : {}),
        }),
      }
    : {
        id: 'msg-native-' + requests,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: sourcePhase ? marker : 'The native continuation completed.',
            annotations: [],
          },
        ],
      };
  const result = {
    id: 'resp-native-' + requests,
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
  response.setHeader('content-type', 'text/event-stream');
  for (const event of [
    { type: 'response.created', response: { ...result, output: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: output },
    { type: 'response.output_item.done', output_index: 0, item: output },
    { type: 'response.completed', response: result },
  ])
    response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
  response.end();
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const config =
  'model="forge-native-continuation"\nmodel_provider="fixture"\ncli_auth_credentials_store="file"\n[model_providers.fixture]\nname="Local continuation conformance"\nbase_url="http://127.0.0.1:' +
  (provider.address() as { port: number }).port +
  '/v1"\nwire_api="responses"\nrequires_openai_auth=false\n';
await writeFile(join(home, 'config.toml'), config, { mode: 0o600 });
const rpcFactory: import('../../server/adapters/codex-driver.js').RpcFactory = (options) =>
  new NativeRpc({
    ...options,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      CODEX_HOME: home,
      LANG: 'en_US.UTF-8',
    },
  });
const native = rpcFactory({
  binary: selectedBinary,
  cwd: project,
});
const turns = new Set<string>();
native.on('message', (message) => {
  if (message.id !== undefined) native.refuse(message.id);
  if (message.method === 'turn/completed') turns.add(message.params.turn.id);
});
let state: Awaited<ReturnType<typeof createApp>> | undefined;
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 45000;
  while (!check()) {
    assert(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
try {
  await native.initialize(true);
  const started = await native.request('thread/start', {
      cwd: project,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    }),
    sourceId = started.thread.id;
  const sourceTurn = await native.request('turn/start', {
    threadId: sourceId,
    input: [{ type: 'text', text: 'Retain the source fact in native history.', text_elements: [] }],
  });
  await until(() => turns.has(sourceTurn.turn.id), 'Source native turn did not complete.');
  await native.request('thread/goal/set', {
    threadId: sourceId,
    objective: 'Retain a paused source goal',
    status: 'paused',
  });
  const original = await readCodexHistory(native, sourceId),
    sourceGoal = await native.request('thread/goal/get', { threadId: sourceId });
  await native.stop();
  sourcePhase = false;
  const appOptions = {
    filename: join(root, 'workspace.sqlite'),
    port: 0,
    test: true,
    memoryPressureReader: unknownPressure,
    rpcFactory,
    codexBinary: selectedBinary,
  };
  state = await createApp(appOptions);
  let host = state;
  const post = async (url: string, payload: Record<string, unknown>) => {
    const response = await host.app.inject({
      method: 'POST',
      url,
      headers: { host: '127.0.0.1:0', 'x-forge-csrf': host.csrf },
      payload,
    });
    assert(response.statusCode < 300, response.body);
    return response;
  };
  const account = (
    await post('/api/accounts', {
      label: 'Native existing chat',
      harness: 'codex',
      nativeHome: home,
      billingMode: 'native',
    })
  ).json<Account>();
  const source = (
    await post('/api/native/sources', { kind: 'codex', label: 'Owned existing chat source', home })
  ).json<{ id: string }>();
  await post(`/api/native/sources/${source.id}/refresh`, {});
  const profile = host.local.all<{ id: string }>('profiles')[0];
  const before = requests;
  const review = (
    await post('/api/native/continuations/prepare', {
      sourceId: source.id,
      sessionId: sourceId,
      accountId: account.id,
      profileId: profile.id,
      title: 'Actual existing native continuation',
      goal: 'Continue the existing native conversation and write continued.txt with its retained source fact.',
    })
  ).json<NativeContinuationReview>();
  assert.equal(review.source.digest, original.digest);
  assert.equal(requests, before);
  await busyTrace?.start(host);
  let work = (
    await post('/api/native/continuations', {
      id: review.id,
      digest: review.digest,
      nativeActivityReviewed: true,
    })
  ).json<Work>();
  assert.equal(host.local.all('runs').length, 0);
  assert.equal(requests, before);
  let approvals = 0,
    resourceRootObserved = false;
  const run = async () => {
    await post(`/api/work/${work.id}/launch`, {
      expectedRevision: work.revision,
      reconciled: true,
      allowMetered: true,
    });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const approval = host.local
        .all<Approval>('approvals')
        .find((row) => row.workId === work.id && row.status === 'pending');
      if (approval) {
        const current = host.local.all<Run>('runs').find((row) => row.id === approval.runId);
        resourceRootObserved ||= Boolean(current?.nativeWorker);
        await assert.rejects(readFile(artifact), { code: 'ENOENT' });
        await post(`/api/approvals/${approval.id}/decision`, {
          digest: approval.digest,
          decision: 'accept',
        });
        approvals++;
      }
      if (
        busyTrace &&
        approvals === 1 &&
        (await readFile(busyStarted)
          .then(() => true)
          .catch(() => false)) &&
        !(await readFile(artifact)
          .then(() => true)
          .catch(() => false))
      )
        await busyTrace.activeSample(host);
      if (host.local.work(work.id).status === 'completed' && host.controller.activeCount === 0)
        break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    work = host.local.work(work.id);
    assert.equal(work.status, 'completed', JSON.stringify(host.local.recentEvents(work.id)));
  };
  await run();
  const nativeId = work.nativeSessionId;
  assert(nativeId && nativeId !== sourceId);
  assert.equal(work.nativeOrigin?.state, 'bound');
  assert.equal(await readFile(artifact, 'utf8'), marker + '\n');
  assert(historyObserved);
  assert.equal(approvals, 1);
  await busyTrace?.sample(host, 'settled-ui');
  const busyResources = busyTrace?.report();
  await busyTrace?.close();
  await host.app.close();
  state = await createApp(appOptions);
  host = state;
  work = host.local.work(work.id);
  await run();
  assert.equal(work.nativeSessionId, nativeId);
  const usage = host.local.all<Usage>('usage');
  assert.equal(usage.length, 2);
  assert(usage.every((row) => row.counterScope === 'run' && row.estimatedUsd === null));
  assert.equal(
    usage.reduce((sum, row) => sum + row.totalTokens, 0),
    managedRequests * 18,
  );
  assert.equal(managedRequests, 3);
  const runs = host.local.all<Run>('runs');
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(run.exitConfirmed, true);
    assert(run.supervisionId);
    const proof = host.local.get<import('../../shared/recovery.js').WorkerProofDescriptor>(
      'worker_supervisions',
      run.supervisionId,
    )!;
    assert.equal(readWorkerExit(proof).payload.nativeClosed, true);
  }
  const inspect = rpcFactory({
    binary: selectedBinary,
    cwd: project,
  });
  inspect.on('message', (message) => {
    if (message.id !== undefined) inspect.refuse(message.id);
  });
  try {
    await inspect.initialize(true);
    assert.equal((await readCodexHistory(inspect, sourceId)).digest, original.digest);
    assert.deepEqual(await inspect.request('thread/goal/get', { threadId: sourceId }), sourceGoal);
    assert.equal((await inspect.request('thread/goal/get', { threadId: nativeId })).goal, null);
  } finally {
    await inspect.stop();
  }
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config);
  assert.equal(requests, 4);
  assert.equal(host.local.all('work').length, 1);
  console.log(
    JSON.stringify({
      passed: true,
      actualNative: 'Codex ' + original.nativeVersion,
      compiledFramework: true,
      sameWorkProfileAndForkAcrossResume: true,
      compiledHostRestartBetweenTurns: true,
      sourceHistoryAndGoalUnchanged: true,
      exactNativeHistoryFingerprint: true,
      forkGoalCleared: true,
      noModelCallDuringReviewOrLink: true,
      nativeApprovals: approvals,
      realArtifact: true,
      resourceRootObserved,
      signedNativeCloses: 2,
      managedRequests,
      sourceRequests: 1,
      managedTokens: 54,
      sourceTokensExcluded: 18,
      paidModelCalls: 0,
      personalProfileChanged: false,
      ...(busyResources ? { busyResources } : {}),
    }),
  );
} finally {
  await busyTrace?.close();
  await native.stop();
  await state?.app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
