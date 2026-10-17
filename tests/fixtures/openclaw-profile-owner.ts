import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ownedNativeSpawner } from '../../server/owned-native.js';
import {
  armOpenClawIdentity,
  createOpenClawIdentity,
  newOpenClawIdentity,
} from '../../server/adapters/openclaw-identity.js';

const root = process.argv[2],
  home = join(root, 'profile'),
  proofs = join(root, 'proofs');
await mkdir(home, { mode: 0o700 });
await mkdir(proofs, { mode: 0o700 });
const identity = newOpenClawIdentity();
await createOpenClawIdentity(home, identity);
identity.cleanExit = false;
identity.attemptId = randomUUID();
const spawn = ownedNativeSpawner({
  directory: proofs,
  nativeHome: home,
  scope: { harness: 'openclaw', runId: randomUUID() },
  mayPrepare: () => true,
  mayCommit: () => true,
  prepared: () => {},
  phaseChanged: () => {},
});
const child = spawn(
  process.execPath,
  [
    '-e',
    "process.on('SIGTERM',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000);",
  ],
  { cwd: home },
  {
    input: 'ignore',
    graceMs: 500,
    onArmed: (record) => armOpenClawIdentity(home, identity, record),
  },
);
child.stdout.once('data', () => process.send?.({ type: 'ready' }));
child.stdout.resume();
child.stderr.resume();
