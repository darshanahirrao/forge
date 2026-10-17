import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  realpathSync,
  chmodSync,
} from 'node:fs';
import { createHash, sign, verify, createPublicKey } from 'node:crypto';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const fail = () => {
  throw new Error('Native worker exit evidence is unavailable or invalid.');
};
export const scopeHash = (scope) =>
  createHash('sha256').update(JSON.stringify(scope)).digest('hex');
export function privateDirectory(directory) {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))
  )
    fail();
}
function regularFile(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > maxBytes ||
      (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))
    )
      fail();
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
export function readWorkerExit(descriptor) {
  privateDirectory(descriptor.directory);
  const raw = regularFile(join(descriptor.directory, 'exit.json'), 16384);
  const record = JSON.parse(raw);
  const p = record.payload;
  if (
    !p ||
    Object.keys(record).sort().join(',') !== 'payload,signature' ||
    Object.keys(p).sort().join(',') !==
      'closedAt,code,contract,createdAt,guardianPid,id,nativeClosed,nativePid,reason,scopeHash,signal,started,stdioClosed' ||
    p.contract !== 'forge.worker-exit/1' ||
    p.id !== descriptor.id ||
    p.scopeHash !== descriptor.scopeHash ||
    scopeHash(descriptor.scope) !== descriptor.scopeHash ||
    p.guardianPid !== descriptor.guardianPid ||
    !Number.isSafeInteger(p.guardianPid) ||
    p.guardianPid < 2 ||
    p.nativeClosed !== true ||
    p.stdioClosed !== true ||
    typeof p.started !== 'boolean' ||
    (p.started ? !Number.isSafeInteger(p.nativePid) || p.nativePid < 2 : p.nativePid !== null) ||
    !(p.code === null || (Number.isSafeInteger(p.code) && p.code >= 0 && p.code <= 255)) ||
    !(
      p.signal === null ||
      (typeof p.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(p.signal))
    ) ||
    !['normal', 'requested', 'owner-disconnected', 'spawn-error', 'bootstrap-aborted'].includes(
      p.reason,
    ) ||
    typeof p.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(p.createdAt)) ||
    typeof p.closedAt !== 'string' ||
    !Number.isFinite(Date.parse(p.closedAt)) ||
    typeof record.signature !== 'string' ||
    record.signature.length > 128
  )
    fail();
  const key = createPublicKey({
    key: Buffer.from(descriptor.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, Buffer.from(JSON.stringify(p)), key, Buffer.from(record.signature, 'base64'))
  )
    fail();
  return { payload: p, digest: createHash('sha256').update(raw).digest('hex') };
}
export function writeWorkerExit(descriptor, payload, key) {
  privateDirectory(descriptor.directory);
  const record = {
    payload,
    signature: sign(null, Buffer.from(JSON.stringify(payload)), key).toString('base64'),
  };
  const path = join(descriptor.directory, 'exit.json');
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(record) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return readWorkerExit(descriptor);
}
function openProfile(root, create) {
  root = realpathSync(root);
  const rootStat = lstatSync(root);
  if (
    realpathSync(root) !== root ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (process.getuid && (rootStat.uid !== process.getuid() || rootStat.mode & 0o022))
  )
    fail();
  const path = join(root, '.forge-worker-proof.sqlite');
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return null;
  }
  if (
    stat &&
    (!stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077)))
  )
    fail();
  if (!stat) {
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(fd);
  }
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec(
      'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS worker(slot INTEGER PRIMARY KEY CHECK(slot=1), data TEXT NOT NULL CHECK(json_valid(data))); BEGIN EXCLUSIVE',
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function currentProfile(db) {
  const row = db.prepare('SELECT data FROM worker WHERE slot=1').get();
  return row ? JSON.parse(String(row.data)) : null;
}
/** A cooperative profile fence. Only signed native close can retire an armed row. */
export function checkWorkerProfile(root) {
  const db = openProfile(root, false);
  if (!db) return;
  try {
    const current = currentProfile(db);
    if (current && current.state !== 'closed') readWorkerExit(current.descriptor);
  } finally {
    db.close();
  }
}
export function armWorkerProfile(root, descriptor) {
  if (!root) return () => {};
  const db = openProfile(root, true);
  try {
    const old = currentProfile(db);
    if (old && old.state !== 'closed') readWorkerExit(old.descriptor);
    db.prepare(
      'INSERT INTO worker(slot,data) VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET data=excluded.data',
    ).run(JSON.stringify({ state: 'armed', descriptor }));
    // Commit the durable fence before holding a lifetime transaction. A killed
    // guardian rolls back only the lifetime transaction, leaving the armed row.
    db.exec('COMMIT; BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    throw error;
  }
  return () => {
    try {
      readWorkerExit(descriptor);
      db.prepare('UPDATE worker SET data=? WHERE slot=1').run(
        JSON.stringify({ state: 'closed', descriptor }),
      );
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  };
}
