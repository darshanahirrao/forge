import { unknownPressure } from '../dist/server/memory-pressure.js';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { request as proxyRequest, createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createPhoneGateway } from '../dist/server/phone.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../dist/server/app.js';
import { NativeRpc } from '../dist/server/adapters/rpc.js';
import { readCodexAccount } from '../dist/server/adapters/accounts.js';
import { t3Fixture } from './fixtures/t3-mcp.ts';
import { connectorTestExecutable } from './fixtures/connector-executable.ts';
import { serviceContext } from '../dist/server/background-service.js';
import { companionProviderFixture } from './fixtures/companion-provider.mjs';
import { nativeFileSnapshot } from '../dist/server/native-file-snapshot.js';
import { scheduleTransferFixture } from './fixtures/schedule-transfer.ts';
import { loadExtensions } from '../dist/server/extensions.js';
const transferNative = scheduleTransferFixture();
const t3 = await t3Fixture();
// Owned loopback sink only. Browser tests never publish to an external topic.
const delivered = [];
let notificationFailure = false;
let schedulerState = 'success-stale';
let nativeControlMode = 'normal';
let openClawFixtureEnabled = false;
const notificationServer = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  delivered.push({ body, click: request.headers.click, actions: request.headers.actions });
  if (notificationFailure) response.destroy();
  else {
    response.writeHead(200);
    response.end('{"id":"fixture-browser-accepted"}');
  }
});
await new Promise((resolve) => notificationServer.listen(0, '127.0.0.1', resolve));
const notificationOrigin = `http://127.0.0.1:${notificationServer.address().port}`;
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-browser-')));
// Browser-only service simulation. No helper, OS definition or native service is started.
const nativeHome = join(directory, 'native-fixture');
mkdirSync(join(nativeHome, 'automations', 'fixture-schedule'), { recursive: true });
mkdirSync(join(nativeHome, 'cron'));
const memoryPath = join(directory, 'MEMORY.md');
const memoryProject = join(directory, 'project');
mkdirSync(memoryProject);
writeFileSync(join(memoryProject, 'native-migration-proof.txt'), 'Owned migration artifact.\n');
const companionHome = join(directory, 'owned-companion');
mkdirSync(companionHome);
writeFileSync(join(companionHome, 'config.yaml'), 'native-fixture: true\n', { mode: 0o600 });
const extensionHome = join(directory, 'owned-extension');
mkdirSync(extensionHome);
writeFileSync(join(extensionHome, 'config.yaml'), 'owned-extension: true\n', { mode: 0o600 });
const extensionEntry = join(directory, 'runtime-extension.mjs');
writeFileSync(
  extensionEntry,
  `import {companionProviderFixture} from ${JSON.stringify(new URL('./fixtures/companion-provider.mjs', import.meta.url).href)};
export default {format:'forge.extension',version:1,id:'owned.browser-extension',name:'Browser extension',release:'1.0.0',companions:[{...companionProviderFixture,id:'ext.browser.runtime',name:'Browser native runtime'}]};`,
  { mode: 0o600 },
);
const extensions = await loadExtensions([extensionEntry]);
const migrationHome = join(directory, 'owned-migration-source');
mkdirSync(join(migrationHome, 'memories'), { recursive: true });
writeFileSync(join(migrationHome, 'config.yaml'), 'native-fixture: true\n', { mode: 0o600 });
writeFileSync(join(migrationHome, 'memories', 'MEMORY.md'), 'Owned native migration memory.\n', {
  mode: 0o600,
});
const portableMemoryPath = join(directory, 'portable-native-memory.md');
writeFileSync(
  portableMemoryPath,
  '# Shared\nPortable browser selected marker.\n# Private\nPORTABLE-EXCLUDED-PRIVATE\n',
  { mode: 0o600 },
);
const credentialPath = join(directory, 'owned-browser-private.json');
writeFileSync(credentialPath, JSON.stringify({ selected: 'public-owned-browser-synthetic-key' }), {
  mode: 0o600,
});
writeFileSync(
  memoryPath,
  '# Public\nBrowser shared memory marker.\n# Private\nPRIVATE-BROWSER-EXCLUDED\n',
);
writeFileSync(
  join(nativeHome, 'automations', 'fixture-schedule', 'automation.toml'),
  'id = "fixture-schedule"\nname = "Native morning review"\nkind = "heartbeat"\nstatus = "ACTIVE"\nrrule = "FREQ=DAILY;BYHOUR=9"\nprompt = "excluded native instructions"\n',
);
writeFileSync(
  join(nativeHome, 'cron', 'jobs.json'),
  JSON.stringify({
    jobs: [
      {
        id: 'fixture-hermes-job',
        name: 'Native Hermes check',
        state: 'scheduled',
        schedule: { kind: 'interval', display: 'Every 30 minutes', minutes: 30 },
        next_run_at: '2026-10-18T09:00:00+05:30',
        prompt: 'excluded native instructions',
      },
    ],
  }),
);
const phoneOrigin = 'https://127.0.0.1:4713';
const phoneBridge = { origin: phoneOrigin, proof: randomBytes(32).toString('hex') };
const fixtureRpc = (options = {}) =>
  new NativeRpc({
    ...options,
    binary: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))],
    env: { PATH: process.env.PATH, FORGE_FIXTURE_PROJECT: memoryProject },
  });
const { app, nativeSources } = await createApp({
  extensions,
  scheduleTransferBridge: transferNative.transfer,
  nativeMigrationBridge: async (request) => {
    if (request.source !== migrationHome)
      throw Error('Only the owned migration fixture may be imported.');
    const memory = join(migrationHome, 'memories', 'MEMORY.md');
    const target = join(request.target, 'MEMORY.md');
    writeFileSync(target, readFileSync(memory), { mode: 0o600 });
    writeFileSync(join(request.operationRoot, 'native-report.json'), '{"owned":true}', {
      mode: 0o600,
    });
    return {
      nativeVersion: 'Owned browser native importer fixture',
      sourceRoots: [memory],
      sourceDigest: (await nativeFileSnapshot([memory])).digest,
      items: [
        {
          kind: 'memory',
          status: 'migrated',
          source: memory,
          target,
          note: 'Native memory imported.',
          overflowedEntries: 1,
        },
        {
          kind: 'cron',
          status: 'archived',
          source: null,
          target: null,
          note: 'Scheduled definitions are archived and inactive.',
          overflowedEntries: 0,
        },
        {
          kind: 'credentials',
          status: 'skipped',
          source: null,
          target: null,
          note: 'Credentials excluded.',
          overflowedEntries: 0,
        },
      ],
    };
  },
  companionProviders: { hermes: companionProviderFixture, openclaw: companionProviderFixture },
  availability: {
    dataDirectory: directory,
    port: 4711,
    phone: null,
    context: serviceContext({
      platform: 'darwin',
      root: fileURLToPath(new URL('../', import.meta.url)),
      agentDirectory: join(directory, 'Owned simulated definitions'),
      control: async () => null,
    }),
    environment: { PATH: '/usr/bin:/bin', LANG: 'C' },
    launch: async () => 'aborted',
    requestShutdown: () => {
      throw new Error('The browser fixture never commits native background activation.');
    },
  },
  memoryPressureReader: unknownPressure,
  nativeControlBridge: async (_source, request) => {
    if (transferNative.rows.has(_source.id)) return transferNative.control(_source, request);
    if (_source.kind === 'openclaw-schedules') {
      const digest = createHash('sha256').update(String(openClawFixtureEnabled)).digest('hex');
      const job = {
        id: 'fixture-openclaw-job',
        title: 'Native OpenClaw check',
        prompt: 'Native OpenClaw instructions.',
        script: null,
        noAgent: false,
        rule: '{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}',
        definition: '{"native":"OpenClaw","reviewed":"complete definition"}',
        enabled: openClawFixtureEnabled,
        state: openClawFixtureEnabled ? 'enabled' : 'paused',
        nextRunAt: null,
      };
      if (request.mode === 'preview')
        return {
          state: 'preview',
          contract: 'openclaw-native-revision/1',
          jobsDigest: digest,
          configDigest: null,
          job,
        };
      if (request.jobsDigest !== digest) return { state: 'rejected', code: 'changed' };
      openClawFixtureEnabled = request.action === 'resume';
      return {
        state: 'applied',
        observed: {
          enabled: openClawFixtureEnabled,
          state: openClawFixtureEnabled ? 'enabled' : 'paused',
          nextRunAt: null,
          jobsDigest: createHash('sha256').update(String(openClawFixtureEnabled)).digest('hex'),
        },
      };
    }
    const filename = join(nativeHome, 'cron', 'jobs.json');
    const raw = readFileSync(filename, 'utf8');
    const jobs = JSON.parse(raw);
    const job = jobs.jobs.find((item) => item.id === request.jobId);
    const digest = createHash('sha256').update(raw).digest('hex');
    if (request.mode === 'preview')
      return {
        state: 'preview',
        contract: 'hermes-builtin-native-flock/1',
        jobsDigest: digest,
        configDigest: null,
        job: {
          id: job.id,
          title: job.name,
          prompt: job.prompt,
          script: null,
          rule: JSON.stringify(job.schedule),
          definition: JSON.stringify(job, null, 2),
          noAgent: false,
          state: job.state,
          enabled: job.enabled ?? true,
          nextRunAt: job.next_run_at,
        },
      };
    if (nativeControlMode === 'changed' || request.jobsDigest !== digest)
      return { state: 'rejected', code: 'changed' };
    job.enabled = request.action === 'resume';
    job.state = job.enabled ? 'scheduled' : 'paused';
    writeFileSync(filename, JSON.stringify(jobs));
    if (nativeControlMode === 'lost') throw new Error('Owned fixture lost its acknowledgement.');
    return {
      state: 'applied',
      observed: {
        state: job.state,
        enabled: job.enabled,
        nextRunAt: job.next_run_at,
        jobsDigest: createHash('sha256').update(JSON.stringify(jobs)).digest('hex'),
      },
    };
  },
  phoneBridge,
  filename: join(directory, 'workspace.sqlite'),
  port: 4711,
  codexBinary: process.execPath,
  accountProbe: async (account) => {
    if (account.harness !== 'codex')
      return {
        ...account,
        state: 'configured',
        checkedAt: new Date().toISOString(),
        identity: null,
        identityKey: null,
        quotas: [],
        error: null,
      };
    const rpc = fixtureRpc();
    try {
      await rpc.initialize();
      return await readCodexAccount(rpc, account);
    } finally {
      await rpc.stop();
    }
  },
  nativeSourcesOptions: {
    openClawSchedulesReader: async (source) => ({
      inventory: {
        sessions: [],
        schedules: [
          {
            id: 'fixture-openclaw-job',
            sourceId: source.id,
            title: 'Native OpenClaw check',
            owner: 'openclaw',
            kind: 'OpenClaw native automation',
            state: openClawFixtureEnabled ? 'enabled' : 'paused',
            rule: '0 9 * * * UTC',
            nextRunAt: null,
            lastRunAt: null,
            lastOutcome: null,
            observedAt: new Date().toISOString(),
          },
        ],
        moreAvailable: false,
        checkedAt: new Date().toISOString(),
      },
      capabilities: ['Owned browser fixture; native authentication is evaluated separately'],
    }),
    schedulerProbe: async () => ({
      contract: 'hermes-native-ticker/1',
      provider:
        schedulerState === 'unavailable'
          ? null
          : schedulerState === 'external'
            ? 'fixture-managed'
            : 'builtin',
      loopAgeSeconds: schedulerState === 'loop-stale' ? 600 : 5,
      successAgeSeconds: schedulerState === 'recent' ? 10 : 600,
      cadenceSeconds: 60,
      observedAt: new Date().toISOString(),
    }),
    homes: { codex: nativeHome, claude: join(directory, 'missing-claude'), hermes: nativeHome },
  },
  rpcFactory: fixtureRpc,
});
app.get('/api/fixture/memory', async () => ({
  nativeHome,
  path: memoryPath,
  project: memoryProject,
  companionHome,
}));
app.get('/api/fixture/memory-packs', async () => ({
  path: portableMemoryPath,
  project: memoryProject,
}));
app.get('/api/fixture/native-migrations', async () => ({
  nativeHome: migrationHome,
  project: memoryProject,
  credentialPath,
}));
app.get('/api/fixture/credentials', async () => ({
  path: credentialPath,
  key: 'selected',
  project: memoryProject,
  nativeHome,
}));
const connectorHome = join(directory, 'connector-home');
mkdirSync(connectorHome);
const connectorExecutable = await connectorTestExecutable(directory);
app.get('/api/fixture/connectors', async () => ({
  nativeHome: connectorHome,
  manifest: {
    format: 'forge.native-connector',
    version: 1,
    id: 'ext.browser-agent.v1',
    name: 'Owned browser agent',
    protocol: 'acp/1',
    executable: connectorExecutable,
    args: [fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))],
    agent: { name: 'owned-acp-fixture', version: '1.0.0' },
    mode: 'review',
    homeVariables: { FIXTURE_AGENT_HOME: '.' },
  },
}));
app.get('/api/fixture/extensions', async () => ({
  nativeHome: extensionHome,
  project: memoryProject,
  provider: extensions.runtimes[0],
}));
app.post('/api/fixture/native-controls', async (request) => {
  nativeControlMode = request.body.mode;
  return { ok: true };
});
app.post('/api/fixture/schedule-transfers', async (request) => {
  const label = request.body.label;
  const homes = ['source', 'destination'].map((kind) => join(directory, `${label}-${kind}`));
  for (const home of homes) mkdirSync(join(home, 'cron'), { recursive: true });
  const [source, target] = homes.map((home, index) =>
    nativeSources.add({
      kind: 'hermes-schedules',
      label: `${label} ${index ? 'destination' : 'source'}`,
      home,
      endpoint: '',
    }),
  );
  const job = transferNative.definition(
    {
      title: `${label} recurring task`,
      prompt: 'Reviewed local recurring instructions.',
      schedule: { kind: 'every', minutes: 30 },
    },
    'owned-source',
    true,
  );
  transferNative.jobs(source).set(job.id, job);
  transferNative.jobs(target);
  writeFileSync(join(homes[0], 'cron', 'jobs.json'), JSON.stringify({ jobs: [job] }));
  writeFileSync(join(homes[1], 'cron', 'jobs.json'), JSON.stringify({ jobs: [] }));
  await nativeSources.refresh(source.id);
  transferNative.stats.lostCreate = request.body.lost === true;
  return { sourceId: source.id, targetSourceId: target.id };
});
app.get('/api/fixture/notifications', async () => ({ origin: notificationOrigin, delivered }));
app.post('/api/fixture/notifications', async (request) => {
  notificationFailure = request.body.fail === true;
  return { ok: true };
});
app.post('/api/fixture/scheduler', async (request) => {
  schedulerState = request.body.state;
  return { ok: true };
});
app.get('/api/test/t3', () => ({ endpoint: t3.origin }));
app.post('/api/test/t3/revoke', () => {
  t3.settings.revoked = true;
  return { ok: true };
});
await app.listen({ host: '127.0.0.1', port: 4711 });
const gateway = await createPhoneGateway(
  { origin: phoneOrigin, users: ['alice@example.com'], port: 4712 },
  'http://127.0.0.1:4711',
  phoneBridge,
);
await gateway.listen({ host: '127.0.0.1', port: 4712 });
const certConfig = join(directory, 'tls.cnf');
const certPath = join(directory, 'tls.crt');
const keyPath = join(directory, 'tls.key');
writeFileSync(
  certConfig,
  '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n',
);
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    certConfig,
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ],
  { stdio: 'ignore' },
);
// Test-only TLS/identity boundary. Production reuses native Tailscale Serve.
const phoneProxy = createHttpsServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    const headers = { ...req.headers, host: '127.0.0.1:4712' };
    for (const key of Object.keys(headers))
      if (key.startsWith('tailscale-') || key.startsWith('x-forge-bridge-')) delete headers[key];
    headers['tailscale-user-login'] = 'alice@example.com';
    const upstream = proxyRequest(
      { hostname: '127.0.0.1', port: 4712, path: req.url, method: req.method, headers },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('Synthetic proxy upstream unavailable.');
    });
    req.pipe(upstream);
  },
);
await new Promise((resolve) => phoneProxy.listen(4713, '127.0.0.1', resolve));
console.log(
  'Forge browser fixture is ready on 4711 with test-only TLS/identity ingress on 4713. Native execution uses a synthetic worker.',
);
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try {
      phoneProxy.closeAllConnections();
      await new Promise((resolve) => phoneProxy.close(resolve));
      await gateway.close();
      await app.close();
      await t3.close();
      notificationServer.closeAllConnections();
      await new Promise((resolve) => notificationServer.close(resolve));
    } finally {
      rmSync(directory, { recursive: true, force: true });
      process.exit(0);
    }
  });
