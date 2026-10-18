import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assert } from './errors.js';

export const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Bounded file evidence for native imports. Never interprets or exports file contents. */
export async function nativeFileSnapshot(roots: string[], privateOutput = false) {
  let bytes = 0;
  const files: { path: string; sha256: string | null; bytes: number }[] = [];
  const seen = new Set<string>();
  async function walk(path: string): Promise<void> {
    path = resolve(path);
    if (seen.has(path)) return;
    seen.add(path);
    assert(seen.size <= 6000, 409, 'The native import exceeds its 6,000-entry review bound.');
    const before = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!before) {
      files.push({ path, sha256: null, bytes: 0 });
      return;
    }
    assert(
      !before.isSymbolicLink() &&
        (!process.getuid || before.uid === process.getuid()) &&
        (await realpath(path)) === path,
      409,
      'Native import paths must be owned regular files or directories without symbolic links.',
    );
    if (before.isDirectory()) {
      if (privateOutput) await chmod(path, 0o700);
      const entries = await readdir(path);
      assert(entries.length <= 6000, 409, 'A native import directory exceeds its review bound.');
      files.push({ path: path + '/', sha256: fingerprint(entries.sort()), bytes: 0 });
      for (const name of entries.sort()) await walk(join(path, name));
      const current = await lstat(path);
      assert(
        !current.isSymbolicLink() &&
          current.ino === before.ino &&
          current.dev === before.dev &&
          fingerprint((await readdir(path)).sort()) === fingerprint(entries),
        409,
        'A native import directory changed during verification.',
      );
      return;
    }
    assert(
      before.isFile() && before.nlink === 1 && before.size <= 16 * 1024 * 1024,
      409,
      'Native import files must be regular, unlinked and at most 16 MiB.',
    );
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const content = createHash('sha256'),
        buffer = Buffer.alloc(65536);
      let position = 0;
      for (;;) {
        const read = await handle.read(buffer, 0, buffer.length, position);
        if (!read.bytesRead) break;
        position += read.bytesRead;
        bytes += read.bytesRead;
        assert(
          position <= 16 * 1024 * 1024 && bytes <= 128 * 1024 * 1024,
          409,
          'The native import exceeds its 128 MiB review bound.',
        );
        content.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await handle.stat(),
        current = await lstat(path);
      assert(
        before.dev === after.dev &&
          before.ino === after.ino &&
          current.ino === after.ino &&
          current.dev === after.dev &&
          !current.isSymbolicLink() &&
          before.size === after.size &&
          position === after.size &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs,
        409,
        'A native import file changed during verification. Prepare a fresh import.',
      );
      if (privateOutput) await chmod(path, 0o600);
      files.push({ path, sha256: content.digest('hex'), bytes: position });
    } finally {
      await handle.close();
    }
  }
  for (const path of [...new Set(roots)].sort()) await walk(path);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return {
    digest: fingerprint(files),
    files: files.filter((f) => f.sha256 !== null && !f.path.endsWith('/')).length,
    bytes,
  };
}
