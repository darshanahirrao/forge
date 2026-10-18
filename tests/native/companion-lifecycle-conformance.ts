import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { createApp } = (await import(
  new URL('../../dist/server/app.js', import.meta.url).href
)) as typeof import('../../server/app.js');
const { loadExtensions } = (await import(
  new URL('../../dist/server/extensions.js', import.meta.url).href
)) as typeof import('../../server/extensions.js');
import { unknownPressure } from '../../server/memory-pressure.js';
import { Profiles, inspectMemory } from '../../server/memory.js';
import { id, now } from '../../server/store.js';
import type { Account } from '../../shared/types.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-native-companion-lifecycle-')));
const project = join(root, 'project'),
  hermesHome = join(root, 'hermes'),
  openClawHome = join(root, 'openclaw');
for (const home of [project, hermesHome, openClawHome]) await mkdir(home, { mode: 0o700 });
await mkdir(join(hermesHome, 'memories'));
async function nativePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const hermesPort = await nativePort(),
  openClawPort = await nativePort();
await writeFile(
  join(hermesHome, '.env'),
  `API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT=${hermesPort}\nAPI_SERVER_KEY=synthetic-existing-hermes-interface\n`,
  { mode: 0o600 },
);

const memoryFile = join(hermesHome, 'memories', 'MEMORY.md'),
  memoryBytes =
    '# Shared\nnative-runtime-selected-copper\n# Private\nnative-runtime-excluded-violet\n';
await writeFile(memoryFile, memoryBytes, { mode: 0o600 });
let modelRequests = 0;
const provider = createServer((_request, response) => {
  modelRequests++;
  response.writeHead(503);
  response.end('No inference is authorized by this lifecycle fixture.');
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
await writeFile(
  join(hermesHome, 'config.yaml'),
  `model:\n  default: forge-no-inference\n  provider: custom\n  base_url: ${providerOrigin}/v1\n  api_mode: chat_completions\n  api_key: synthetic-hermes-lifecycle\n`,
  { mode: 0o600 },
);
await writeFile(
  join(openClawHome, 'openclaw.json'),
  JSON.stringify({
    gateway: {
      mode: 'local',
      reload: { mode: 'off' },
      port: openClawPort,
      bind: 'loopback',
      auth: { mode: 'token', token: 'synthetic-existing-openclaw-interface' },
    },
    agents: {
      defaults: {
        workspace: project,
        heartbeat: { every: '0m' },
        model: { primary: 'forge/proof' },
      },
    },
    cron: { enabled: true },
    models: {
      providers: {
        forge: {
          baseUrl: providerOrigin + '/v1',
          apiKey: 'synthetic-openclaw-lifecycle',
          api: 'openai-completions',
          models: [
            {
              id: 'proof',
              name: 'Lifecycle fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 32768,
              maxTokens: 2048,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  }),
  { mode: 0o600 },
);
const configBefore = await Promise.all([
  readFile(join(hermesHome, 'config.yaml'), 'utf8'),
  readFile(join(openClawHome, 'openclaw.json'), 'utf8'),
]);
const extensionRuntime = process.argv.includes('--extension-runtime');
const extensions = extensionRuntime
  ? await loadExtensions([
      new URL('../../examples/hermes-runtime-extension.mjs', import.meta.url).pathname,
    ])
  : undefined;
const app = await createApp({
  extensions,
  filename: join(root, 'state.sqlite'),
  port: 0,
  test: true,
  memoryPressureReader: unknownPressure,
});
const nativeResourcePolicy = process.argv.includes('--native-resource-policy');

const profiles = new Profiles(app.local),
  profile = profiles.profile(),
  selection = await inspectMemory(memoryFile, ['Shared']);
const source = await profiles.addSource(
  {
    label: 'Native shared memory',
    owner: 'hermes',
    path: memoryFile,
    section: ['Shared'],
    scope: { kind: 'global' },
  },
  selection.sha256,
  selection.selectionSha256,
);
profiles.update(profile.id, profile.revision, { ...profile, memorySourceIds: [source.id] });
const nativeAccount = (harness: string, nativeHome: string): Account => ({
  id: id(),
  harness,
  nativeHome,
  label: `Actual ${harness} companion`,
  billingMode: 'native',
  state: 'configured',
  identity: null,
  identityKey: null,
  plan: null,
  checkedAt: null,
  error: null,
  quotas: [],
  createdAt: now(),
});
const accounts = [nativeAccount('hermes', hermesHome), nativeAccount('openclaw', openClawHome)];
if (extensionRuntime) {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { host: '127.0.0.1:0', 'x-forge-csrf': app.csrf },
    payload: {
      label: 'Actual external Hermes runtime',
      harness: extensions!.runtimes[0].id,
      nativeHome: hermesHome,
      billingMode: 'native',
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  accounts[0] = response.json<Account>();
  assert.equal(accounts[0].nativeProvider?.digest, extensions!.runtimes[0].digest);
}
for (const account of accounts) app.local.put('accounts', account.id, account);
const original = await app.companions.create({
  label: 'Actual Hermes gateway',
  profileId: profile.id,
  root: project,
  scopes: ['work:read', 'context:read', 'work:write'],
});
const work = await app.companions.createWork(original.grant.id, {
  requestId: 'native-runtime-work',
  title: 'Persistent runtime work',
  goal: 'Retain work and selected context across native gateway ownership changes.',
});
const sourceRuntime = app.companionRuntimes.register({
  label: 'Actual Hermes lifecycle',
  accountId: accounts[0].id,
  grantId: original.grant.id,
});
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Native lifecycle timeout: ${label}`);
}
async function start(runtimeId: string) {
  const review = await app.companionRuntimes.prepare(runtimeId);
  const launch = await app.companionRuntimes.start(
    {
      id: review.id,
      digest: review.digest,
      nativeActivityReviewed: true,
      nativeSpendingAccepted: true,
    },
    { kind: 'local' },
  );
  await waitFor(
    () =>
      app.companionRuntimes.snapshot().launches.find((row) => row.id === launch.id)?.state !==
      'starting',
    'native readiness',
  );
  const current = app.companionRuntimes.snapshot().launches.find((row) => row.id === launch.id)!;
  assert.equal(current.state, 'running', current.detail);
  if (nativeResourcePolicy) {
    assert.equal(current.nativeResources?.rootMemoryMiB, 2048);
    assert.equal(current.nativeResources?.digest, app.resourceGovernance.review()?.digest);
  }
  await waitFor(
    () =>
      Boolean(
        app.companionRuntimes.snapshot().launches.find((row) => row.id === launch.id)?.nativeWorker,
      ),
    'owned native resource identity',
  );
  return app.companionRuntimes.snapshot().launches.find((row) => row.id === launch.id)!;
}
async function stop(runtimeId: string, launchId: string) {
  const launch = app.companionRuntimes.snapshot().launches.find((row) => row.id === launchId)!;
  app.companionRuntimes.stop(runtimeId, { launchId, revision: launch.revision }, { kind: 'local' });
  await waitFor(
    () =>
      Boolean(
        app.companionRuntimes.snapshot().launches.find((row) => row.id === launchId)?.exitConfirmed,
      ),
    'signed native closure',
  );
  const ended = app.companionRuntimes.snapshot().launches.find((row) => row.id === launchId)!;
  assert.equal(ended.exit?.method, 'signed-native-close');
  assert.equal(ended.exit.native?.code, 0);
  assert.equal(ended.state, 'closed');
  return ended;
}
try {
  if (nativeResourcePolicy) {
    assert(
      app.resourceGovernance.snapshot().supported,
      'The explicit native policy check requires the evaluated Darwin 27 host.',
    );
    await app.resourceGovernance.configure(
      { expectedRevision: 0, lowPriority: true, rootMemoryMiB: 2048, effectsReviewed: true },
      { kind: 'local' },
    );
  }
  const first = await start(sourceRuntime.id);
  assert.equal(first.nativeVersion, '0.17.0');
  const originalApi = await fetch(`http://127.0.0.1:${hermesPort}/v1/models`, {
    headers: { Authorization: 'Bearer synthetic-existing-hermes-interface' },
  });
  assert.equal(
    originalApi.status,
    200,
    'The native configured API address and key must remain usable.',
  );
  await assert.rejects(
    app.companionHandoffs.prepare({ grantId: original.grant.id, label: 'Held replacement' }),
    /Stop and reconcile/,
  );
  await stop(sourceRuntime.id, first.id);
  const review = await app.companionHandoffs.prepare({
    grantId: original.grant.id,
    label: 'Actual OpenClaw gateway',
  });
  const staged = await app.companionHandoffs.stage(review.id, review.digest, { kind: 'local' });
  const targetRuntime = app.companionRuntimes.register({
    label: 'Actual OpenClaw lifecycle',
    accountId: accounts[1].id,
    grantId: staged.grant.id,
  });
  const second = await start(targetRuntime.id);
  assert.equal(second.nativeVersion, '2026.10.4');
  const context = await app.companions.context(staged.grant.id, work.id);
  assert(
    context.memories.some((memory) => memory.content.includes('native-runtime-selected-copper')),
  );
  assert(!JSON.stringify(context).includes('native-runtime-excluded-violet'));
  // This checks lifecycle ownership with the existing authenticated readiness API;
  // native MCP-client interoperability is covered by test:native:companion.
  await app.companionHandoffs.ready(staged.grant.id, review.id, review.digest);
  const receipt = app.companionHandoffs.list()[0];
  await app.companionHandoffs.activate(receipt.id, receipt.digest, receipt.revision);
  assert.throws(() => app.companions.workspace(original.grant.id), /revoked/);
  assert.equal(app.companions.work(staged.grant.id, work.id).work.profileId, profile.id);
  await stop(targetRuntime.id, second.id);
  assert.equal(await readFile(memoryFile, 'utf8'), memoryBytes);
  const configAfter = await Promise.all([
    readFile(join(hermesHome, 'config.yaml'), 'utf8'),
    readFile(join(openClawHome, 'openclaw.json'), 'utf8'),
  ]);
  assert.deepEqual(configAfter, configBefore);
  assert.equal(modelRequests, 0);
  assert.equal(app.local.all('runs').length, 0);
  console.log(
    JSON.stringify({
      status: 'passed',
      nativeGateways: ['Hermes 0.17.0', 'OpenClaw 2026.10.4'],
      nativeStarts: 2,
      signedCloses: 2,
      nativeResourcePolicyGateways: nativeResourcePolicy ? 2 : 0,
      nativeSchedulerConfigurationRetained: true,
      configuredNativeInterfacesPreserved: true,
      scheduleDefinitionsTransferred: false,
      sameWorkAndProfile: true,
      externalRuntimeExtension: extensionRuntime,
      selectedMemory: true,
      nativeConfigAndMemoryUnchanged: true,
      sourceMustStopBeforeHandoff: true,
      paidModelCalls: 0,
      modelRequests,
      serviceControlRequested: false,
      personalProfileChanged: false,
    }),
  );
} finally {
  await app.app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
