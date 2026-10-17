import { useState, type FormEvent } from 'react';
import type { Snapshot } from '../../shared/types';
import type { Mutate } from '../api';
import { FormError } from './primitives';

export function BackendsPanel({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:3773');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('T3 Code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    const pairing = code;
    setCode('');
    await change(async () => {
      await mutate('/backends/t3', 'POST', { endpoint, label, code: pairing });
      setExpanded(false);
    });
  }
  const disabled = busy || data.mode === 'demo';
  return (
    <section className="panel backend-panel" aria-label="Execution backends">
      <div className="section-heading">
        <div>
          <h2>Execution backends</h2>
          <p>Use T3’s native provider instances, accounts and tools in this workspace.</p>
        </div>
        <button
          className="button secondary small"
          disabled={disabled}
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? 'Close setup' : 'Connect T3'}
        </button>
      </div>
      {(data.backends ?? []).map((backend) => (
        <div key={backend.id} className="backend-instance">
          <div className="section-heading">
            <div>
              <h3>{backend.label}</h3>
              <p>
                {backend.endpoint} · {backend.state} · {backend.providerCount} provider instances
              </p>
            </div>
            <div className="connection-actions">
              <button
                className="button secondary small"
                disabled={disabled || backend.state === 'disconnected'}
                onClick={() => void change(() => mutate(`/backends/${backend.id}/refresh`, 'POST'))}
              >
                Refresh
              </button>
              <button
                className="button secondary small"
                disabled={disabled || backend.state === 'disconnected'}
                onClick={() => void change(() => mutate(`/backends/${backend.id}`, 'DELETE'))}
              >
                Disconnect
              </button>
            </div>
          </div>
          {backend.error && <p className="form-error">{backend.error}</p>}
          {data.accounts
            .filter((account) => account.backend?.id === backend.id)
            .map((account) => (
              <label key={account.id}>
                {account.label} · {account.harness}
                <select
                  aria-label={`Model for ${account.label}`}
                  value={account.backend!.model}
                  disabled={disabled || !account.providerReady}
                  onChange={(event) =>
                    void change(() =>
                      mutate(`/accounts/${account.id}/backend`, 'PATCH', {
                        model: event.target.value,
                      }),
                    )
                  }
                >
                  {(account.models ?? []).map((model) => (
                    <option key={model}>{model}</option>
                  ))}
                </select>
              </label>
            ))}
        </div>
      ))}
      {expanded && (
        <form className="form-stack" onSubmit={connect}>
          <p>
            Start your existing T3 server and create a native pairing code with read and operate
            access. Pairing adds its provider instances to Accounts; native sign-in stays in T3.
          </p>
          <details className="native-details">
            <summary>Native CLI setup</summary>
            <pre className="service-commands">
              <code>
                t3 project add /absolute/project/path{'\n'}t3 serve --host 127.0.0.1 --port 3773
                --no-browser{'\n'}t3 auth pairing create --scope orchestration:read --scope
                orchestration:operate
              </code>
            </pre>
            <p className="source-note">
              Add projects before starting the server, or use T3’s project controls. Use the same
              native base directory for each command. Only a protocol 2 loopback server is
              supported.
            </p>
          </details>
          <div className="form-grid">
            <label>
              Native T3 address
              <input
                required
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                disabled={disabled}
              />
            </label>
            <label>
              Connection name
              <input
                required
                maxLength={80}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                disabled={disabled}
              />
            </label>
          </div>
          <label>
            One-time native pairing code
            <input
              required
              type="password"
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={disabled}
            />
          </label>
          <p className="source-note">
            This connects human execution and approval controls. The separate read-only activity
            source keeps its original scope. Re-pairing the same environment preserves existing work
            and account references.
          </p>
          <button className="button primary" disabled={disabled || !code}>
            Connect native backend
          </button>
        </form>
      )}
      <FormError error={error} />
    </section>
  );
}
