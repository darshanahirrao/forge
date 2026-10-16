import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { request as proxyRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createPhoneGateway } from '../dist/server/phone.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../dist/server/app.js';
import { NativeRpc } from '../dist/server/adapters/rpc.js';
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
const { app } = await createApp({
  phoneBridge,
  filename: join(directory, 'workspace.sqlite'),
  port: 4711,
  codexBinary: process.execPath,
  nativeSourcesOptions: {
    homes: { codex: nativeHome, claude: join(directory, 'missing-claude'), hermes: nativeHome },
  },
  rpcFactory: (options) =>
    new NativeRpc({
      ...options,
      binary: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))],
      env: { PATH: process.env.PATH },
    }),
});
app.get('/api/fixture/memory', async () => ({ path: memoryPath, project: memoryProject }));
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
      process.exit(0);
    }
  });
