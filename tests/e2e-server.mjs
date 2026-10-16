import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../dist/server/app.js';
import { NativeRpc } from '../dist/server/adapters/rpc.js';
const directory = mkdtempSync(join(tmpdir(), 'forge-browser-'));
const { app } = await createApp({
  filename: join(directory, 'workspace.sqlite'),
  port: 4711,
  codexBinary: process.execPath,
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
