import { version } from '../shared/version.js';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { phoneConfig, createPhoneGateway } from './phone.js';
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
const phone = phoneConfig(process.env, port);
const phoneBridge = phone
  ? { origin: phone.origin, proof: randomBytes(32).toString('hex') }
  : undefined;
const { app } = await createApp({
  phoneBridge,
  filename: join(dataDirectory, 'workspace.sqlite'),
  port,
  development: import.meta.url.endsWith('.ts'),
});
let gateway: Awaited<ReturnType<typeof createPhoneGateway>> | null = null;
app.addHook('onClose', async () => {
  await gateway?.close();
});
try {
  if (phone && phoneBridge)
    gateway = await createPhoneGateway(phone, `http://127.0.0.1:${port}`, phoneBridge);
  await app.listen({ host: '127.0.0.1', port });
  if (phone && gateway) {
    await gateway.listen({ host: '127.0.0.1', port: phone.port });
    console.log(
      `Private phone gateway on 127.0.0.1:${phone.port}. Point Tailscale Serve here, then open ${phone.origin}.`,
    );
  }
} catch {
  console.error(
    `Forge could not start its local listeners. Check FORGE_PORT and the optional phone-gateway port.`,
  );
  await app.close();
  process.exit(1);
}
console.log(`Forge ${version} is ready at http://127.0.0.1:${port}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  });
