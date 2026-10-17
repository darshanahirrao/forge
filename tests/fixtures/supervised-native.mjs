// Owned inert process. Its single append is an external-effect replay detector.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const recordEffect = () => appendFileSync(process.argv[2], 'effect\n', { mode: 0o600 });
if (process.argv[3] === 'inherited-stdio') {
  recordEffect();
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 350)'], {
    stdio: ['ignore', process.stdout, process.stderr],
  });
  process.exit(0);
} else {
  process.stdin.resume();
  process.stdin.once('end', () => {
    if (process.argv[3] !== 'ignore-stop') process.exit(0);
  });
  process.on('SIGTERM', () => {
    if (process.argv[3] !== 'ignore-stop') process.exit(0);
  });
  // The parent's readiness marker must follow native signal-handler registration.
  recordEffect();
  setInterval(() => {}, 1000);
}
