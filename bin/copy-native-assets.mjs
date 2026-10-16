import { copyFile } from 'node:fs/promises';

await copyFile(
  new URL('../server/adapters/hermes-native.py', import.meta.url),
  new URL('../dist/server/adapters/hermes-native.py', import.meta.url),
);
