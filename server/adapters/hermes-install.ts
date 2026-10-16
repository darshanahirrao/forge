import { open, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assert } from '../errors.js';

/** Resolve native Python metadata without evaluating a launcher or scraping a terminal. */
export async function hermesPython(binary: string): Promise<string> {
  const configured = process.env.FORGE_HERMES_PYTHON;
  if (configured) {
    assert(
      isAbsolute(configured),
      409,
      'FORGE_HERMES_PYTHON must reference an absolute native interpreter path.',
    );
    await access(configured, constants.X_OK);
    return configured;
  }
  let current = await realpath(binary);
  for (let depth = 0; depth < 4; depth++) {
    const file = await open(current, 'r');
    const data = Buffer.alloc(4096);
    let count: number;
    try {
      count = (await file.read(data, 0, data.length, 0)).bytesRead;
    } finally {
      await file.close();
    }
    const source = data.subarray(0, count).toString('utf8');
    const python = source.match(/^#!(\/[^\r\n]*\/(?:python|python3|python3\.\d+))\s*\r?\n/);
    if (python) {
      await access(python[1], constants.X_OK);
      return python[1];
    }
    const wrapper = source.match(/^exec "(\/[^"\r\n]+\/hermes)" "\$@"\s*$/m);
    assert(
      wrapper,
      409,
      'Set FORGE_HERMES_PYTHON to the native Hermes interpreter for this installation.',
    );
    current = await realpath(wrapper[1]);
  }
  throw new Error('The native Hermes launcher chain exceeds the supported discovery limit.');
}
