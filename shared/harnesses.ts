import type { Harness } from './types.js';

export const managedHarnesses: readonly Harness[] = ['codex', 'claude', 'opencode'];
export function executionName(harness: Harness) {
  return harness === 'claude'
    ? 'Claude'
    : harness === 'codex'
      ? 'Codex'
      : harness === 'opencode'
        ? 'OpenCode'
        : harness;
}
