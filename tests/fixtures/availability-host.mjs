// Owned fault-injection host. The real helper commits, but this test keeps SQLite open.
import { createApp } from '../../dist/server/app.js';
import { serviceContext } from '../../dist/server/background-service.js';
import { join } from 'node:path';
const [directory, portValue, definitions] = process.argv.slice(2);
const port = Number(portValue);
if (!process.connected || !directory || !definitions || !Number.isInteger(port)) process.exit(1);
const { app } = await createApp({
  filename: join(directory, 'workspace.sqlite'),
  port,
  availability: {
    dataDirectory: directory,
    port,
    phone: null,
    context: serviceContext({ agentDirectory: definitions }),
    requestShutdown: () => {
      process.send?.({ type: 'committed-with-owned-workspace-retained' });
    },
  },
});
await app.listen({ host: '127.0.0.1', port });
process.send?.({ type: 'ready' });
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
