// Compiled, isolated native Gateway with no model turn. Parent owns this helper's handle.
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../../dist/server/store.js';
import { ownedNativeSpawner } from '../../dist/server/owned-native.js';
import { openClawWorker } from '../../dist/server/adapters/openclaw-worker.js';

const root = process.argv[2];
const account = JSON.parse(await readFile(join(root, 'account.json'), 'utf8'));
if (account.nativeHome !== join(root, 'profile'))
  throw new Error('Use only the owned fixture profile.');
const directory = join(root, 'proofs');
await mkdir(directory, { recursive: true, mode: 0o700 });
const store = new Store(join(root, 'state.sqlite'));
const save = (record) => store.put('worker_supervisions', record.id, record);
const spawn = ownedNativeSpawner({
  directory,
  nativeHome: account.nativeHome,
  scope: { kind: 'openclaw-cold-recovery-conformance', attemptId: randomUUID() },
  mayPrepare: () => true,
  mayCommit: () => true,
  prepared: save,
  phaseChanged: save,
});
let connection, closing;
const close = () =>
  (closing ??= (async () => {
    await connection?.stop();
    store.close();
    if (process.connected) process.disconnect();
  })());
process.once('SIGTERM', () => {
  void close();
});
process.on('message', (message) => {
  if (message === 'stop') void close();
});
try {
  connection = await openClawWorker(account, join(root, 'project'), undefined, spawn);
  process.send?.({ type: 'ready' });
} catch {
  process.send?.({ type: 'failed' });
  await close();
  process.exitCode = 1;
}
