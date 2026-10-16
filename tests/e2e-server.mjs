import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../dist/server/app.js';
import { NativeRpc } from '../dist/server/adapters/rpc.js';
const directory = mkdtempSync(join(tmpdir(), 'forge-browser-'));
const nativeHome = join(directory, 'native-fixture');
mkdirSync(join(nativeHome, 'automations', 'fixture-schedule'), { recursive: true });
mkdirSync(join(nativeHome, 'cron'));
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
const { app } = await createApp({
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
await app.listen({ host: '127.0.0.1', port: 4711 });
console.log('Forge browser fixture is ready on 4711. Native execution uses a synthetic worker.');
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      process.exit(0);
    }
  });
