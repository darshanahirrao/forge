import { useState, type FormEvent } from 'react';
import type { CompanionGrant, CompanionScope, Snapshot } from '../../shared/types';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';

type Credential = { grant: CompanionGrant; token: string; endpoint: string };
export function CompanionsPanel({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [adding, setAdding] = useState(false);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [label, setLabel] = useState('Hermes');
  const [root, setRoot] = useState('');
  const [profileId, setProfileId] = useState(data.defaultProfileId);
  const [access, setAccess] = useState('coordinate');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [maxRuns, setMaxRuns] = useState('10');
  const [allowMetered, setAllowMetered] = useState(false);
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [format, setFormat] = useState('json');
  const disabled = busy || data.mode === 'demo';
  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const scopes: CompanionScope[] =
      access === 'read' ? ['work:read'] : ['work:read', 'context:read', 'work:write'];
    if (access === 'dispatch') scopes.push('work:dispatch');
    try {
      setCredential(
        await mutate<Credential>('/companions', 'POST', {
          label,
          root,
          profileId,
          scopes,
          accountIds: access === 'read' ? [] : accountIds,
          expiresInDays: Number(days),
          dispatch: access === 'dispatch' ? { maxRuns: Number(maxRuns), allowMetered } : null,
        }),
      );
      setAdding(false);
      setFormat('json');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError('');
    try {
      await mutate(`/companions/${id}`, 'DELETE');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const configuration = credential
    ? format === 'hermes'
      ? `mcp_servers:\n  forge:\n    url: ${JSON.stringify(credential.endpoint)}\n    headers:\n      Authorization: ${JSON.stringify(`Bearer ${credential.token}`)}\n    sampling:\n      enabled: false\n`
      : format === 'openclaw'
        ? JSON.stringify(
            {
              mcp: {
                servers: {
                  forge: {
                    url: credential.endpoint,
                    transport: 'streamable-http',
                    headers: { Authorization: `Bearer ${credential.token}` },
                  },
                },
              },
            },
            null,
            2,
          )
        : JSON.stringify(
            {
              mcpServers: {
                forge: {
                  url: credential.endpoint,
                  headers: { Authorization: `Bearer ${credential.token}` },
                },
              },
            },
            null,
            2,
          )
    : '';
  return (
    <section className="panel backend-panel companion-panel" aria-label="Companion access">
      <div className="section-heading">
        <div>
          <h2>Companion access</h2>
          <p>Connect Hermes, OpenClaw or another MCP client to the same profile and project.</p>
        </div>
        <button
          className="button secondary small"
          disabled={disabled || data.access?.kind === 'tailscale'}
          onClick={() => {
            setError('');
            setAdding(true);
          }}
        >
          Connect companion
        </button>
      </div>
      {(data.companionGrants ?? []).map((grant) => {
        const inactive = Boolean(grant.revokedAt) || grant.expiresAt <= data.now;
        return (
          <div className="backend-instance" key={grant.id}>
            <div className="section-heading">
              <div>
                <h3>{grant.label}</h3>
                <p>
                  {data.profiles.find((profile) => profile.id === grant.profileId)?.name ??
                    'Saved profile'}{' '}
                  ·{' '}
                  {inactive
                    ? grant.revokedAt
                      ? 'Revoked'
                      : 'Expired'
                    : `Expires ${new Date(grant.expiresAt).toLocaleDateString()}`}
                </p>
              </div>
              <button
                className="button secondary small"
                disabled={disabled || inactive}
                onClick={() => void revoke(grant.id)}
                aria-label={`Revoke ${grant.label}`}
              >
                Revoke
              </button>
            </div>
            <p className="companion-root">{grant.root}</p>
            <p className="source-note">
              {grant.dispatch
                ? `${grant.runsStarted} of ${grant.dispatch.maxRuns} native runs · ${grant.dispatch.allowMetered ? 'Metered usage allowed' : 'Verified allowance required'}`
                : grant.scopes.includes('work:write')
                  ? 'Read selected memory and save work'
                  : 'Read work only'}
            </p>
          </div>
        );
      })}
      {!data.companionGrants?.length && (
        <p className="source-note companion-empty">
          Native tools, channels and schedules stay in your companion. Its connection can change
          while Forge keeps the work and memory references.
        </p>
      )}
      {!adding && <FormError error={error} />}
      {adding && (
        <Dialog
          title="Connect companion"
          onClose={() => {
            setAdding(false);
            setError('');
          }}
        >
          <form className="dialog-body form-stack" onSubmit={create}>
            <div className="form-grid">
              <label>
                Companion name
                <input
                  autoFocus
                  data-autofocus=""
                  required
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label>
                Persistent profile
                <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                  {data.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Project directory
              <input
                required
                value={root}
                placeholder="/absolute/project/path"
                onChange={(event) => setRoot(event.target.value)}
              />
              <small>
                Access covers this directory, its subdirectories and the selected profile.
              </small>
            </label>
            <div className="form-grid">
              <label>
                Access
                <select value={access} onChange={(event) => setAccess(event.target.value)}>
                  <option value="read">Read work only</option>
                  <option value="coordinate">Read selected memory and save work</option>
                  <option value="dispatch">Also start native work</option>
                </select>
              </label>
              <label>
                Expires in days
                <input
                  type="number"
                  min={1}
                  max={90}
                  required
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                />
              </label>
            </div>
            {access !== 'read' && (
              <fieldset>
                <legend>Available native accounts</legend>
                {data.accounts.length ? (
                  data.accounts.map((account) => (
                    <label className="checkbox-label" key={account.id}>
                      <input
                        type="checkbox"
                        checked={accountIds.includes(account.id)}
                        onChange={(event) =>
                          setAccountIds(
                            event.target.checked
                              ? [...accountIds, account.id]
                              : accountIds.filter((id) => id !== account.id),
                          )
                        }
                      />
                      <span>
                        {account.label} · {account.harness}
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="source-note">
                    Connect native accounts to make them available. Work can still be saved without
                    an account.
                  </p>
                )}
              </fieldset>
            )}
            {access === 'dispatch' && (
              <>
                <label>
                  Maximum native runs
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    required
                    value={maxRuns}
                    onChange={(event) => setMaxRuns(event.target.value)}
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={allowMetered}
                    onChange={(event) => setAllowMetered(event.target.checked)}
                  />
                  <span>
                    Allow metered or unverified provider usage through the selected accounts.
                  </span>
                </label>
                <p className="source-note">
                  Native approvals, quiet mode and memory protection still apply. This is a run
                  limit; dollar budgets are not enforced. Changed account bindings require new
                  access.
                </p>
              </>
            )}
            <FormError error={error} />
            <div className="form-footer">
              <button type="button" className="button secondary" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || (access === 'dispatch' && !accountIds.length)}
              >
                {busy ? 'Connecting…' : 'Create access'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {credential && (
        <Dialog title="Add Forge to your native client" onClose={() => setCredential(null)}>
          <div className="dialog-body form-stack">
            <p>
              This credential is shown once. Store it in your native client’s private configuration.
            </p>
            <label>
              Configuration format
              <select value={format} onChange={(event) => setFormat(event.target.value)}>
                <option value="json">MCP client JSON</option>
                <option value="hermes">Hermes YAML</option>
                <option value="openclaw">OpenClaw JSON</option>
              </select>
            </label>
            <label>
              MCP connection configuration
              <textarea
                className="companion-configuration"
                readOnly
                value={configuration}
                rows={12}
                spellCheck={false}
                onFocus={(event) => event.target.select()}
              />
            </label>
            <p className="source-note">
              Merge this entry with your existing configuration. Switching clients keeps the
              profile, selected memory and work. Revoke access here to stop future calls; existing
              native runs retain their owner.
            </p>
            <div className="form-footer">
              <button className="button primary" onClick={() => setCredential(null)}>
                Done
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
