import { unknownPressure } from '../dist/server/memory-pressure.js';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
const t3 = await t3Fixture();
// Owned loopback sink only. Browser tests never publish to an external topic.
const delivered = [];
let notificationFailure = false;
let schedulerState = 'success-stale';
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
const directory = mkdtempSync(join(tmpdir(), 'forge-browser-'));
const nativeHome = join(directory, 'native-fixture');
mkdirSync(join(nativeHome, 'automations', 'fixture-schedule'), { recursive: true });
mkdirSync(join(nativeHome, 'cron'));
const memoryPath = join(directory, 'MEMORY.md');
const memoryProject = join(directory, 'project');
mkdirSync(memoryProject);
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
    env: { PATH: process.env.PATH },
  });
const { app } = await createApp({
  memoryPressureReader: unknownPressure,
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
app.get('/api/fixture/memory', async () => ({ path: memoryPath, project: memoryProject }));
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
