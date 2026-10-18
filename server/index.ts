import { version } from '../shared/version.js';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { phoneConfig, createPhoneGateway } from './phone.js';
import { createApp } from './app.js';
import { backgroundRuntime, defaultDataDirectory, serviceContext } from './background-service.js';
import { loadExtensions } from './extensions.js';
import { extensionPaths } from './extension-config.js';
import { Store } from './store.js';

const port = Number(process.env.FORGE_PORT ?? 4710);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('FORGE_PORT must be an integer between 1024 and 65535.');
const dataDirectory = defaultDataDirectory();
const store = new Store(join(dataDirectory, 'workspace.sqlite'));
let extensions: Awaited<ReturnType<typeof loadExtensions>>;
try {
  extensions = await loadExtensions(extensionPaths(process.env.FORGE_EXTENSION_MODULES));
} catch (error) {
  store.close();
  throw error;
}
const phone = phoneConfig(process.env, port);
const phoneBridge = phone
  ? { origin: phone.origin, proof: randomBytes(32).toString('hex') }
  : undefined;
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    process.exit(0);
  } catch {
    console.error(
      'Forge could not confirm graceful shutdown. Review native workers and service status before another start.',
    );
    process.exitCode = 1;
  }
};
const { app } = await createApp({
  store,
  extensions,
  phoneBridge,
  background: backgroundRuntime(),
  filename: join(dataDirectory, 'workspace.sqlite'),
  port,
  development: import.meta.url.endsWith('.ts'),
  availability: {
    dataDirectory,
    port,
    phone,
    context: serviceContext({
      ...(backgroundRuntime().definitionDirectory
        ? { agentDirectory: backgroundRuntime().definitionDirectory }
        : {}),
    }),
    requestShutdown: shutdown,
  },
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
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void shutdown();
  });
