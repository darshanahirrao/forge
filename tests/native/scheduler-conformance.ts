// Explicit installed-native, isolated-profile read. No native job controls or scheduler tick.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { schedulerEvidence } from '../../shared/scheduler.js';
import type { NativeSource } from '../../shared/types.js';

// Also verify the packaged Python asset resolves from the compiled server.
const { readSchedulerObservation } = (await import(
  new URL('../../dist/server/scheduler-health.js', import.meta.url).href
)) as typeof import('../../server/scheduler-health.js');

const directory = await mkdtemp(join(tmpdir(), 'forge-native-ticker-'));
const source: NativeSource = {
  id: 'owned-native-ticker',
  kind: 'hermes-schedules',
  label: 'Owned native fixture',
  home: directory,
  endpoint: '',
  state: 'configured',
  checkedAt: null,
  error: null,
  capabilities: [],
};
async function hashTree(root: string): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = join(root, entry.name);
    if (entry.isDirectory()) rows.push(...(await hashTree(filename)));
    else
      rows.push(
        `${filename.slice(directory.length)}:${createHash('sha256')
          .update(await readFile(filename))
          .digest('hex')}`,
      );
  }
  return rows.sort();
}
async function inspect(expected: string) {
  const before = await hashTree(directory);
  const observation = await readSchedulerObservation(source);
  assert.equal(
    schedulerEvidence(observation).state,
    expected,
    'Native marker contract was not observed as expected.',
  );
  assert.deepEqual(
    await hashTree(directory),
    before,
    'The native observation changed its isolated profile.',
  );
  return observation;
}
try {
  await mkdir(join(directory, 'cron'));
  await writeFile(join(directory, 'config.yaml'), 'cron:\n  provider: builtin\n');
  await writeFile(
    join(directory, 'cron', 'jobs.json'),
    JSON.stringify({
      jobs: [
        {
          id: 'owned-fixture',
          name: 'Never scheduled by this test',
          enabled: false,
          state: 'paused',
          prompt: 'EXCLUDED-SCHEDULER-INSTRUCTIONS',
        },
      ],
    }),
  );
  await inspect('unknown');
  const epoch = Date.now() / 1000;
  await writeFile(join(directory, 'cron', 'ticker_heartbeat'), String(epoch));
  await writeFile(join(directory, 'cron', 'ticker_last_success'), String(epoch));
  const current = await inspect('recent');
  await writeFile(join(directory, 'cron', 'ticker_last_success'), String(epoch - 600));
  await inspect('success-stale');
  await writeFile(join(directory, 'cron', 'ticker_heartbeat'), String(epoch - 600));
  await inspect('loop-stale');
  await writeFile(join(directory, 'cron', 'ticker_heartbeat'), 'malformed');
  await inspect('unknown');
  for (const invalid of ['nan', 'inf', String(epoch + 3600), '1'.repeat(129)]) {
    await writeFile(join(directory, 'cron', 'ticker_heartbeat'), invalid);
    await inspect('unknown');
  }
  await writeFile(join(directory, 'owned-marker-target'), String(epoch));
  await rm(join(directory, 'cron', 'ticker_heartbeat'));
  await symlink(
    join(directory, 'owned-marker-target'),
    join(directory, 'cron', 'ticker_heartbeat'),
  );
  await inspect('unknown');
  await writeFile(join(directory, 'config.yaml'), 'cron:\n  provider: fixture-external-provider\n');
  await inspect('external');
  assert.equal(JSON.stringify(current).includes('EXCLUDED'), false);
  console.log(
    JSON.stringify({
      status: 'passed',
      contract: current.contract,
      cadenceSeconds: current.cadenceSeconds,
      states: [
        'missing',
        'recent',
        'success-stale',
        'loop-stale',
        'malformed/nonfinite/future/oversized/symlink',
        'external-configured',
      ],
      nativeDefinitionsUnchanged: true,
      ticksStarted: 0,
      modelCalls: 0,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
