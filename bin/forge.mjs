#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Forge 0.4.1\n\nUsage: forge [start] [--port PORT] [--data-dir DIRECTORY]\n\nA local workspace for native agents. Open the printed URL to begin.\nNative accounts connect explicitly. Read existing chats and schedules from Activity.',
  );
} else if (args.includes('--version')) {
  console.log('0.4.1');
} else {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'start' && i === 0) continue;
    if (args[i] === '--port' && args[i + 1]) process.env.FORGE_PORT = args[++i];
    else if (args[i] === '--data-dir' && args[i + 1]) process.env.FORGE_DATA_DIR = args[++i];
    else {
      console.error('Unknown option. Run forge --help for supported options.');
      process.exit(1);
    }
  }
  await import('../dist/server/index.js');
}
