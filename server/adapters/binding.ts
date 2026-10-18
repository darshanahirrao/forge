import { createHash } from 'node:crypto';
import type { Account } from '../../shared/types.js';

/** Native account authority excludes mutable quota samples and display labels. */
export const accountBinding = (account: Account) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        harness: account.harness,
        ...(account.nativeProvider ? { nativeProvider: account.nativeProvider } : {}),
        ...(account.nativeExecutor ? { nativeExecutor: account.nativeExecutor } : {}),
        ...(account.connector ? { connector: account.connector } : {}),
        home: account.nativeHome,
        ...(account.openClawProjectRoot
          ? { openClawProjectRoot: account.openClawProjectRoot }
          : {}),
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
