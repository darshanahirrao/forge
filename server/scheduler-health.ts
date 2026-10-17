import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { NativeSource } from '../shared/types.js';
import type { SchedulerObservation } from '../shared/scheduler.js';
import { now } from './store.js';
import { findBinary } from './adapters/discovery.js';
import { hermesPython } from './adapters/hermes-install.js';
import { hermesEnvironment } from './adapters/hermes-driver.js';

const exec = promisify(execFile);
const age = z.number().finite().nonnegative().max(1e10).nullable();
const schema = z
  .object({
    contract: z.literal(1),
    provider: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
      .nullable(),
    loopAgeSeconds: age,
    successAgeSeconds: age,
    cadenceSeconds: z.number().finite().min(1).max(86400).nullable(),
    sampledAt: z.number().finite(),
  })
  .strict();
const unknown = (): SchedulerObservation => ({
  contract: 'hermes-native-ticker/1',
  provider: null,
  loopAgeSeconds: null,
  successAgeSeconds: null,
  cadenceSeconds: null,
  observedAt: now(),
});

export function parseSchedulerObservation(value: unknown): SchedulerObservation {
  const input = schema.parse(value);
  const sampledAt = input.sampledAt * 1000;
  if (Math.abs(sampledAt - Date.now()) > 10000) return unknown();
  return {
    contract: 'hermes-native-ticker/1',
    provider: input.provider,
    loopAgeSeconds: input.loopAgeSeconds,
    successAgeSeconds: input.successAgeSeconds,
    cadenceSeconds: input.cadenceSeconds,
    observedAt: new Date(sampledAt).toISOString(),
  };
}

export async function readSchedulerObservation(
  source: NativeSource,
): Promise<SchedulerObservation> {
  if (source.kind !== 'hermes-schedules') return unknown();
  try {
    const home = await realpath(source.home);
    if (!(await stat(home)).isDirectory()) return unknown();
    const binary = await findBinary('hermes');
    if (!binary) return unknown();
    const python = await hermesPython(binary);
    const result = await exec(
      python,
      [fileURLToPath(new URL('./adapters/hermes-scheduler.py', import.meta.url))],
      {
        cwd: home,
        timeout: 5000,
        maxBuffer: 16384,
        env: {
          ...hermesEnvironment({ nativeHome: home }),
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUNBUFFERED: '1',
        },
      },
    );
    // A moved source must not attribute a different profile's markers to the saved source.
    if ((await realpath(source.home)) !== home) return unknown();
    return parseSchedulerObservation(JSON.parse(result.stdout));
  } catch {
    return unknown();
  }
}
