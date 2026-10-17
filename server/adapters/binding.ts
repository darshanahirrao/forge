import { createHash } from 'node:crypto';
import type { Account } from '../../shared/types.js';

/** Native account authority excludes mutable quota samples and display labels. */
export const accountBinding = (account: Account) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        harness: account.harness,
        home: account.nativeHome,
        credential: account.credentialEnv,
        ...(account.credentialReference
          ? { credentialReference: account.credentialReference }
          : {}),
        billing: account.billingMode,
        backend: account.backend,
        identity: account.identityKey,
      }),
    )
    .digest('hex');
