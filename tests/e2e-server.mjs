import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'forge-browser-'));
const child = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, FORGE_PORT: '4711', FORGE_DATA_DIR: directory },
  stdio: 'inherit',
});
child.once('exit', (code) => {
  rmSync(directory, { recursive: true, force: true });
  process.exit(code ?? 0);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
