import type { MemoryPressure } from './types.js';

/** Forge's admission thresholds, not kernel-defined Linux health states. */
export const linuxPressureThresholds = Object.freeze({
  warningSomeAvg10: 10,
  warningFullAvg10: 1,
  criticalFullAvg10: 10,
});

export function memoryPressureDescription(pressure?: MemoryPressure): string {
  if (pressure?.source === 'macos-sysctl' && pressure.state !== 'unknown')
    return `macOS reports ${pressure.state} memory pressure.`;
  if (pressure?.source === 'linux-psi') {
    if (pressure.state === 'unknown')
      return 'Linux memory pressure coverage is incomplete. The available stall measurements remain visible.';
    return pressure.state === 'normal'
      ? 'Linux memory stalls are below Forge admission thresholds.'
      : `Linux memory stalls meet Forge's ${pressure.state} admission threshold.`;
  }
  return 'Automatic memory pressure detection is unavailable here.';
}
