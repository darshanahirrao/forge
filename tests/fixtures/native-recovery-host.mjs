// Compiled application, isolated native home and owned IPC. No personal account.
import { dirname, join } from 'node:path';
import { createApp } from '../../dist/server/app.js';
import { NativeRpc } from '../../dist/server/adapters/rpc.js';
import { unknownPressure } from '../../dist/server/memory-pressure.js';
const root = dirname(process.argv[2]);
const { app } = await createApp({
  filename: process.argv[2],
  port: 0,
  memoryPressureReader: unknownPressure,
  csrf: 'owned-native-recovery',
  rpcFactory: (options) =>
    new NativeRpc({
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CODEX_HOME: join(root, 'codex'),
        TMPDIR: root,
        LANG: 'en_US.UTF-8',
      },
    }),
});
const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ endpoint });
process.once('SIGTERM', async () => {
  await app.close();
  if (process.connected) process.disconnect();
});
