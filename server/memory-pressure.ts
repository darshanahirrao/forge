import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MemoryPressure, Settings } from '../shared/types.js';
import { assert } from './errors.js';
import { readLinuxMemoryPressure } from './linux-memory-pressure.js';
import { memoryPressureDescription } from '../shared/memory-pressure.js';
const exec = promisify(execFile);

export const unknownPressure = (): MemoryPressure => ({
  state: 'unknown',
  source: 'unavailable',
  nativeValue: null,
  checkedAt: new Date().toISOString(),
});
/** macOS exposes Dispatch flags here, not XNU's internal 0/1/2/3 pressure enum. */
export function parseMemoryPressure(output: string): MemoryPressure {
  const value = /^\s*[124]\s*$/.test(output) ? Number(output.trim()) : null;
  return value === null
    ? unknownPressure()
    : {
        state: value === 1 ? 'normal' : value === 2 ? 'warning' : 'critical',
        source: 'macos-sysctl',
        nativeValue: value,
        checkedAt: new Date().toISOString(),
      };
}
export async function readMemoryPressure(): Promise<MemoryPressure> {
  if (process.platform === 'linux') return readLinuxMemoryPressure();
  if (process.platform !== 'darwin') return unknownPressure();
  try {
    const result = await exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
      timeout: 1000,
      maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C' },
    });
    return parseMemoryPressure(result.stdout);
  } catch {
    return unknownPressure();
  }
}
export function checkMemoryAdmission(settings: Settings, pressure: MemoryPressure) {
  assert(
    settings.memoryPressurePolicy === 'observe' ||
      !['warning', 'critical'].includes(pressure.state),
    409,
    `${memoryPressureDescription(pressure)} No native attempt was created. Wait for pressure to ease, or review memory protection in Resources before launching again.`,
  );
}
