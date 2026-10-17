import { useState } from 'react';
import type { Account } from '../../shared/types';
import type { Mutate } from '../api';
import { FormError } from './primitives';

export function CredentialReference({
  account,
  mutate,
  disabled,
}: {
  account: Account;
  mutate: Mutate;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [checked, setChecked] = useState(false);
  const reference = account.credentialReference;
  if (!reference) return null;
  async function check() {
    setBusy(true);
    setError('');
    setChecked(false);
    try {
      await mutate(`/accounts/${account.id}/credential/check`, 'POST');
      setChecked(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="native-details credential-reference">
      <summary>Private credential reference</summary>
      <p>
        {reference.kind === 'private-json' ? 'Private JSON file' : 'macOS Keychain item'}. Values
        stay outside Forge records and exports.
      </p>
      <p className="companion-root">
        {reference.kind === 'private-json'
          ? `${reference.path} · ${reference.key}`
          : `${reference.service} · ${reference.account}`}
      </p>
      <button
        className="button secondary small"
        disabled={disabled || busy}
        onClick={() => void check()}
      >
        {busy ? 'Checking reference…' : 'Check private reference'}
      </button>
      {checked && (
        <p role="status">
          Private reference available. Native identity and allowance require their own check.
        </p>
      )}
      {disabled && (
        <p>Check private references from the local Forge host while native operations are idle.</p>
      )}
      <FormError error={error} />
    </details>
  );
}
