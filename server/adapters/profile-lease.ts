import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { assert } from '../errors.js';
import { checkWorkerProfile } from '../worker-proof.mjs';

/** Cooperative ownership between Forge processes, retained until the native worker exits. */
export async function acquireProfileLease(root: string): Promise<() => void> {
  checkWorkerProfile(root);
  const path = join(root, '.forge-native-owner.sqlite');
  const existing = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert(
    !existing || (existing.isFile() && !existing.isSymbolicLink()),
    409,
    'The native profile ownership file must be a regular file.',
  );
  const db = new DatabaseSync(path);
  try {
    await chmod(path, 0o600);
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  } catch {
    db.close();
    throw new Error('Another Forge worker owns this native profile. Wait for its confirmed exit.');
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      db.close();
    }
  };
}
