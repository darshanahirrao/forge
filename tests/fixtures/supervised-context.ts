import type { Account, Work } from '../../shared/types.js';
import { Store, now } from '../../server/store.js';

export function supervisedContext(store: Store, directory: string, suffix = '') {
  const account: Account = {
    id: `supervised-account${suffix}`,
    label: 'Owned synthetic account',
    harness: 'codex',
    nativeHome: directory,
    billingMode: 'api',
    credentialEnv: '',
    state: 'configured',
    identity: null,
    identityKey: null,
    plan: null,
    checkedAt: null,
    error: null,
    quotas: [],
    createdAt: now(),
  };
  const work: Work = {
    id: `supervised-work${suffix}`,
    title: 'Owned crash recovery fixture',
    project: 'Recovery',
    cwd: directory,
    goal: 'Verify native closure without replay.',
    acceptance: '',
    context: '',
    harness: 'codex',
    accountId: account.id,
    status: 'ready',
    priority: 'normal',
    generation: 0,
    revision: 0,
    nativeSessionId: null,
    activeRunId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  store.put('accounts', account.id, account);
  store.put('work', work.id, work);
  return { account, work };
}
