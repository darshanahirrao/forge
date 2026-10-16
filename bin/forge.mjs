#!/usr/bin/env node
import manifest from '../package.json' with { type: 'json' };
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    `Forge ${manifest.version}\n\nUsage: forge [start] [--port PORT] [--data-dir DIRECTORY]\n       [--phone-origin HTTPS_ORIGIN --phone-user LOGIN] [--phone-port PORT]\n\nA local workspace for native agents. Open the printed URL to begin.\nPhone access reuses Tailscale Serve and explicit approved identities. Repeat --phone-user for another approved owner.\nNative accounts connect explicitly. Read existing chats and schedules from Activity.`,
  );
} else if (args.includes('--version')) {
  console.log(manifest.version);
} else {
  const phoneUsers = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'start' && i === 0) continue;
    if (args[i] === '--port' && args[i + 1]) process.env.FORGE_PORT = args[++i];
    else if (args[i] === '--data-dir' && args[i + 1]) process.env.FORGE_DATA_DIR = args[++i];
    else if (args[i] === '--phone-origin' && args[i + 1])
      process.env.FORGE_PHONE_ORIGIN = args[++i];
    else if (args[i] === '--phone-user' && args[i + 1]) phoneUsers.push(args[++i]);
    else if (args[i] === '--phone-port' && args[i + 1]) process.env.FORGE_PHONE_PORT = args[++i];
    else {
      console.error('Unknown option. Run forge --help for supported options.');
      process.exit(1);
    }
  }
  if (phoneUsers.length) process.env.FORGE_PHONE_USERS = phoneUsers.join(',');
  await import('../dist/server/index.js');
}
