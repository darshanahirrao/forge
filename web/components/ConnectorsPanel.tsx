import { useState } from 'react';
import type { Snapshot } from '../../shared/types';
import type { ConnectorPlan } from '../../shared/connectors';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';

export function ConnectorsPanel({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [open, setOpen] = useState(false),
    [plan, setPlan] = useState<ConnectorPlan | null>(null),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const disabled =
    data.mode !== 'local' ||
    data.access?.kind === 'tailscale' ||
    data.work.some((work) => work.activeRunId) ||
    !!busy;
  return (
    <section className="panel" aria-label="Native harness connectors">
      <div className="section-heading">
        <div>
          <h2>Native harness connectors</h2>
          <p>Register an installed ACP v1 agent. Native execution stays in its own process.</p>
        </div>
        <button
          className="button secondary small"
          disabled={disabled}
          onClick={() => {
            setOpen(true);
            setReviewed(false);
            setError('');
          }}
        >
          Register connector
        </button>
      </div>
      {(data.connectors ?? []).map((connector) => (
        <div className="native-entry" key={connector.id}>
          <div className="native-entry-copy">
            <h3>{connector.manifest.name}</h3>
            <p>
              {connector.id} · ACP v1 · {connector.enabled ? 'Enabled' : 'Retired'}
            </p>
            <details className="native-details">
              <summary>Native contract</summary>
              <pre className="native-rule">{JSON.stringify(connector.manifest, null, 2)}</pre>
              <p>
                Executable SHA-256:{' '}
                <code className="native-rule">{connector.executableDigest}</code>
              </p>
              <p>
                Native sign-in, model, tools and permission policy remain upstream. Turn completion
                does not verify task acceptance, provider identity or billing.
              </p>
            </details>
            <div className="activity-actions">
              {(['toggle', 'remove'] as const).map((action) => (
                <button
                  key={action}
                  className="button secondary small"
                  disabled={disabled}
                  onClick={async () => {
                    setBusy(connector.id);
                    setError('');
                    try {
                      await mutate(
                        `/connectors/${connector.id}`,
                        action === 'toggle' ? 'PATCH' : 'DELETE',
                        action === 'toggle' ? { enabled: !connector.enabled } : {},
                      );
                    } catch (cause) {
                      setError((cause as Error).message);
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  {action === 'remove'
                    ? 'Remove unused connector'
                    : connector.enabled
                      ? 'Retire connector'
                      : 'Enable connector'}
                </button>
              ))}
            </div>
          </div>
        </div>
      ))}
      {!data.connectors?.length && (
        <p className="panel-footnote">
          No additional connector installed. Built-in harness adapters remain available.
          Registration starts no process and installs no package.
        </p>
      )}
      {!open && <FormError error={error} />}
      {open && (
        <Dialog
          title={plan ? 'Review native connector' : 'Register native connector'}
          onClose={() => {
            if (!busy) {
              setOpen(false);
              setPlan(null);
            }
          }}
        >
          <form
            className="dialog-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setBusy('register');
              setError('');
              try {
                if (!plan)
                  setPlan(
                    await mutate<ConnectorPlan>(
                      '/connectors/prepare',
                      'POST',
                      JSON.parse(String(form.get('manifest'))),
                    ),
                  );
                else {
                  await mutate('/connectors/install', 'POST', {
                    planId: plan.id,
                    digest: plan.connector.digest,
                    reviewed: true,
                  });
                  setPlan(null);
                  setOpen(false);
                }
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                setBusy('');
              }
            }}
          >
            <div className="dialog-body form-stack">
              {plan ? (
                <>
                  <p>{plan.coverage}</p>
                  <p>
                    Review expires in two minutes. The executable must remain unchanged before
                    registration and every launch. This pins the main executable; its dependencies
                    and native configuration still need your trust.
                  </p>
                  <pre className="native-rule">
                    {JSON.stringify(plan.connector.manifest, null, 2)}
                  </pre>
                  <p>
                    Resolved executable:{' '}
                    <code className="native-rule">{plan.connector.executable}</code>
                  </p>
                  <p>
                    SHA-256: <code className="native-rule">{plan.connector.executableDigest}</code>
                  </p>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(event) => setReviewed(event.target.checked)}
                      required
                    />
                    I trust this native executable and reviewed its arguments, profile variables and
                    permission mode.
                  </label>
                </>
              ) : (
                <>
                  <p>
                    Paste a version 1 connector manifest for an agent you already installed and
                    configured. Use an immutable ID beginning with ext. No shell commands, package
                    downloads or model calls run during registration.
                  </p>
                  <label>
                    Native connector manifest
                    <textarea
                      name="manifest"
                      rows={16}
                      required
                      spellCheck={false}
                      placeholder={
                        '{\n  "format": "forge.native-connector",\n  "version": 1,\n  "id": "ext.my-agent.v1",\n  "name": "My agent",\n  "protocol": "acp/1",\n  "executable": "/absolute/path/to/agent",\n  "args": ["acp"],\n  "agent": { "name": "native-agent", "version": "1.0.0" },\n  "mode": "default",\n  "homeVariables": { "AGENT_HOME": "." }\n}'
                      }
                    />
                  </label>
                </>
              )}
              <FormError error={error} />
            </div>
            <footer className="form-footer">
              <button
                type="button"
                className="button secondary"
                disabled={!!busy}
                onClick={() => {
                  setOpen(false);
                  setPlan(null);
                }}
              >
                Cancel
              </button>
              <button className="button" disabled={!!busy || (Boolean(plan) && !reviewed)}>
                {busy ? 'Checking…' : plan ? 'Register reviewed connector' : 'Prepare review'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </section>
  );
}
