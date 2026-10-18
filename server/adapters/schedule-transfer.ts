import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { NativeSource } from '../../shared/types.js';
import type { PortableSchedule } from '../../shared/schedule-transfers.js';
import { findBinary } from './discovery.js';
import { hermesPython } from './hermes-install.js';
import { hermesEnvironment } from './hermes-driver.js';
import { assert } from '../errors.js';

export interface NativeScheduleDraft {
  definition: string;
  jobsDigest: string;
  configDigest: string;
  jobId?: string;
}
export interface ScheduleTransferBridge {
  draft(
    target: NativeSource,
    portable: PortableSchedule,
    marker: string,
  ): Promise<NativeScheduleDraft>;
  publish(target: NativeSource, draft: NativeScheduleDraft, deadline: number): Promise<string>;
  locate(target: NativeSource, marker: string): Promise<string | null>;
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);
async function call(home: string, input: unknown): Promise<unknown> {
  const binary = await findBinary('hermes');
  assert(binary, 409, 'Install the evaluated native Hermes runtime before moving schedules.');
  const python = await hermesPython(binary);
  const canonical = await realpath(home);
  const raw = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      python,
      [fileURLToPath(new URL('./hermes-schedule-transfer.py', import.meta.url))],
      {
        cwd: canonical,
        env: { ...hermesEnvironment({ nativeHome: canonical }), PYTHONDONTWRITEBYTECODE: '1' },
        timeout: 8000,
        maxBuffer: 262144,
      },
      (error, stdout) =>
        error ? reject(new Error('Native schedule acknowledgement unavailable.')) : resolve(stdout),
    );
    child.stdin?.end(JSON.stringify(input));
  });
  assert(
    (await realpath(home)) === canonical,
    409,
    'The native profile changed during schedule review.',
  );
  const result = JSON.parse(raw);
  assert(
    !result.error,
    409,
    'The native schedule operation was not acknowledged. Read the native state before continuing.',
  );
  return result;
}
export const hermesScheduleTransfer: ScheduleTransferBridge = {
  async draft(target, portable) {
    const evidence = z
      .object({ jobsDigest: sha, configDigest: sha, timezone: z.string().max(120) })
      .parse(await call(target.home, { mode: 'inspect' }));
    assert(
      portable.schedule.kind !== 'cron' || portable.schedule.tz === evidence.timezone,
      409,
      'Set the destination Hermes profile to the reviewed cron timezone through native setup before transfer.',
    );
    const stage = await realpath(await mkdtemp(join(tmpdir(), 'forge-schedule-draft-')));
    try {
      await writeFile(
        join(stage, 'config.yaml'),
        JSON.stringify({ cron: { provider: 'builtin' }, timezone: evidence.timezone }),
        { mode: 0o600 },
      );
      const { definition } = z
        .object({ definition: z.string().max(65536) })
        .parse(await call(stage, { mode: 'construct', portable }));
      return {
        ...evidence,
        definition,
        jobId: z
          .string()
          .regex(/^[a-f0-9]{12}$/)
          .parse(JSON.parse(definition).id),
      };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  },
  async publish(target, draft, deadline) {
    return z
      .object({ jobId: z.literal(draft.jobId!) })
      .parse(await call(target.home, { mode: 'publish', ...draft, deadline })).jobId;
  },
  async locate() {
    return null;
  },
};
