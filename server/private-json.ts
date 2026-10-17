import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { assert, ForgeError } from './errors.js';

/** Small private references stay outside the workspace database and exports. */
export async function readPrivateJson(filename: string, limit = 32768): Promise<unknown> {
  let handle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = await handle.stat();
    assert(
      info.isFile() &&
        info.size <= limit &&
        (process.platform === 'win32' ||
          ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())),
      409,
      'This reference must be a private, owned regular file.',
    );
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    assert(length <= limit, 409, 'This private reference exceeds its size limit.');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch (error) {
    throw error instanceof ForgeError
      ? error
      : new ForgeError(409, 'This private reference is unavailable. Reconnect the native service.');
  } finally {
    await handle?.close();
  }
}

export async function writePrivateJson(filename: string, value: unknown, limit = 32768) {
  const encoded = JSON.stringify(value);
  assert(Buffer.byteLength(encoded) <= limit, 502, 'The private reference exceeds its size limit.');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
