import { join } from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './app.js';

const port = Number(process.env.FORGE_PORT ?? 4710);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('FORGE_PORT must be an integer between 1024 and 65535.');
const dataDirectory =
  process.env.FORGE_DATA_DIR ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Forge')
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? homedir(), 'Forge')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'forge'));
const { app } = await createApp({
  filename: join(dataDirectory, 'workspace.sqlite'),
  port,
  development: import.meta.url.endsWith('.ts'),
});
try {
  await app.listen({ host: '127.0.0.1', port });
} catch {
  console.error(`Forge could not bind to port ${port}. Set FORGE_PORT to an available local port.`);
  await app.close();
  process.exit(1);
}
console.log(`Forge 0.5.0 is ready at http://127.0.0.1:${port}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  });
