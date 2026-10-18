#!/usr/bin/env node
import manifest from '../package.json' with { type: 'json' };
import { resolve } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    `Forge ${manifest.version}\n\nUsage: forge [start] [--port PORT] [--data-dir DIRECTORY]\n       [--phone-origin HTTPS_ORIGIN --phone-user LOGIN] [--phone-port PORT]\n       [--extension /absolute/path/to/extension.mjs]\n       forge service install [--data-dir DIRECTORY] [--port PORT] [phone options] [--extension FILE]\n       forge service status|start|stop|restart|uninstall [--data-dir DIRECTORY]\n\nA local workspace for native agents. Open the printed URL to begin.\nThe opt-in macOS user service starts at login and runs outside Codex. Installation does not start it immediately. Native shutdown can remain pending; configuration is retained. Provider keys and shell profiles are not copied.\nPhone access reuses Tailscale Serve and explicit approved identities. Repeat --phone-user for another approved owner.\nRepeat --extension to load another explicitly trusted local Node module. Native accounts connect explicitly. Read existing chats and schedules from Activity.`,
  );
} else if (args.includes('--version')) {
  console.log(manifest.version);
} else if (args[0] === 'service') {
  try {
    const { runServiceCommand } = await import('../dist/server/background-service.js');
    await runServiceCommand(args.slice(1));
  } catch (error) {
    console.error(
      error.code === 'ERR_MODULE_NOT_FOUND'
        ? 'Build Forge before using service commands: npm run build.'
        : error.message,
    );
    process.exitCode = 1;
  }
} else {
  const phoneUsers = [];
  const extensions = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'start' && i === 0) continue;
    if (args[i] === '--port' && args[i + 1]) process.env.FORGE_PORT = args[++i];
    else if (args[i] === '--data-dir' && args[i + 1]) process.env.FORGE_DATA_DIR = args[++i];
    else if (args[i] === '--phone-origin' && args[i + 1])
      process.env.FORGE_PHONE_ORIGIN = args[++i];
    else if (args[i] === '--phone-user' && args[i + 1]) phoneUsers.push(args[++i]);
    else if (args[i] === '--phone-port' && args[i + 1]) process.env.FORGE_PHONE_PORT = args[++i];
    else if (args[i] === '--extension' && args[i + 1]) extensions.push(resolve(args[++i]));
    else {
      console.error('Unknown option. Run forge --help for supported options.');
      process.exit(1);
    }
  }
  if (phoneUsers.length) process.env.FORGE_PHONE_USERS = phoneUsers.join(',');
  if (extensions.length) process.env.FORGE_EXTENSION_MODULES = JSON.stringify(extensions);
  await import('../dist/server/index.js');
}
