import { chmod, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Pin an owned test launcher without chmodding shared caches or relocating native runtime libraries. */
export async function connectorTestExecutable(
  root: string,
  source = process.execPath,
  forcePrivate = false,
) {
  const info = await stat(source);
  if (process.platform === 'win32' || (!forcePrivate && (info.mode & 0o022) === 0)) return source;
  const target = join(root, 'owned-connector-node');
  const quoted = "'" + source.replaceAll("'", "'\\''") + "'";
  await writeFile(target, `#!/bin/sh\nexec ${quoted} "$@"\n`, { flag: 'wx', mode: 0o700 });
  await chmod(target, 0o700);
  return target;
}
