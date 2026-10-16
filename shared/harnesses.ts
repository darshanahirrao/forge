import type { Account, Harness } from './types.js';

export const managedHarnesses: readonly Harness[] = ['codex', 'claude', 'opencode', 'hermes'];
export function executionName(harness: Harness) {
  return harness === 'claude'
    ? 'Claude'
    : harness === 'codex'
      ? 'Codex'
      : harness === 'opencode'
        ? 'OpenCode'
        : harness === 'hermes'
          ? 'Hermes'
          : harness === 'openclaw'
            ? 'OpenClaw'
            : harness;
}

export function canExecuteAccount(account?: Account): boolean {
  if (!account || !managedHarnesses.includes(account.harness)) return false;
  if (account.harness === 'claude') return account.billingMode === 'api';
  if (account.harness === 'opencode' || account.harness === 'hermes')
    return Boolean(account.nativeHome) && account.billingMode !== 'subscription';
  return true;
}
