import { copyFile } from 'node:fs/promises';

await copyFile(
  new URL('../server/adapters/hermes-schedule-transfer.py', import.meta.url),
  new URL('../dist/server/adapters/hermes-schedule-transfer.py', import.meta.url),
);

for (const filename of ['native-worker.mjs', 'worker-proof.mjs', 'worker-proof.d.mts'])
  await copyFile(
    new URL(`../server/${filename}`, import.meta.url),
    new URL(`../dist/server/${filename}`, import.meta.url),
  );

await copyFile(
  new URL('../server/adapters/hermes-native.py', import.meta.url),
  new URL('../dist/server/adapters/hermes-native.py', import.meta.url),
);
await copyFile(
  new URL('../server/adapters/hermes-scheduler.py', import.meta.url),
  new URL('../dist/server/adapters/hermes-scheduler.py', import.meta.url),
);
await copyFile(
  new URL('../server/adapters/hermes-control.py', import.meta.url),
  new URL('../dist/server/adapters/hermes-control.py', import.meta.url),
);
await copyFile(
  new URL('../server/adapters/hermes-gateway.py', import.meta.url),
  new URL('../dist/server/adapters/hermes-gateway.py', import.meta.url),
);
