// Opt-in read of existing native metadata. No model turns, account changes or scheduler ticks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeSources } from '../../server/native-sources.js';
import { nativeFile } from '../../server/adapters/inventory.js';
import { Store } from '../../server/store.js';
import type { NativeSource } from '../../shared/types.js';

assert(
  process.argv.includes('--existing'),
  'Explicit --existing is required to inspect native profile metadata.',
);
const store = new Store(':memory:');
const sources = new NativeSources(store);
async function definitions(source: NativeSource) {
  const paths =
    source.kind === 'hermes-schedules'
      ? [join(source.home, 'cron', 'jobs.json')]
      : source.kind === 'codex-schedules'
        ? (await readdir(join(source.home, 'automations'), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(source.home, 'automations', entry.name, 'automation.toml'))
        : [];
  const result = new Map<string, string>();
  for (const filename of paths) {
    const raw = await nativeFile(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw !== null) result.set(filename, createHash('sha256').update(raw).digest('hex'));
  }
  return result;
}
try {
  const found = await sources.discover();
  const observations = [];
  for (const source of found) {
    const before = await definitions(source);
    await sources.refresh(source.id);
    const current = sources.list().find((entry) => entry.id === source.id)!;
    const after = await definitions(source);
    // A scheduler may update concurrently. Report that fact without blaming the observer or retrying writes.
    const unchanged =
      before.size === after.size &&
      [...before].every(([path, digest]) => after.get(path) === digest);
    observations.push({
      kind: source.kind,
      ...current.observation,
      scheduleDefinitionsUnchanged: unchanged,
    });
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      scope: 'Existing native metadata; no model calls or native controls',
      observations,
    }),
  );
} finally {
  store.close();
}
