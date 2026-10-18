import { type Snapshot, type Account } from '../../shared/types';
import { UsersRound, Gauge, LoaderCircle, RefreshCw, Plus } from 'lucide-react';
import { HarnessMark, Status, Empty } from '../components/primitives';
import { harnessName, age } from '../lib/format';
import { SpendingPanel } from '../components/SpendingPanel';
import { CredentialReference } from '../components/CredentialReference';
import { NativeMigrations } from '../components/NativeMigrations';
import type { Mutate } from '../api';
import { managedHarnesses } from '../../shared/harnesses';

export function AccountsPage({
  data,
  onNew,
  onProbe,
  busy,
  mutate,
  onWork,
  onNativeHandoff,
}: {
  data: Snapshot;
  onNew: () => void;
  onProbe: (account: Account) => void;
  busy: string;
  mutate: Mutate;
  onWork: (id: string) => void;
  onNativeHandoff: (workId: string, accountId: string) => void;
}) {
  const duplicates = new Set(
    data.accounts
      .filter(
        (a, i) =>
          a.identityKey && data.accounts.some((b, j) => i !== j && b.identityKey === a.identityKey),
      )
      .map((a) => a.id),
  );
  return (
    <div className="page-stack">
      <SpendingPanel data={data} mutate={mutate} onWork={onWork} />
      <div className="notice">
        <UsersRound size={19} />
        <p>
          Each slot points to native sign-in. Limits retain their own windows and scopes; several
          slots can share one allowance.
        </p>
      </div>
      {data.accounts.length ? (
        <div className="account-grid">
          {data.accounts.map((a) => (
            <section className="panel account-panel" key={a.id}>
              <div className="account-heading">
                <HarnessMark harness={a.harness} />
                <div>
                  <h2>{a.label}</h2>
                  <p>
                    {data.runtimeProviders?.find((provider) => provider.id === a.harness)?.name ??
                      harnessName(a.harness)}
                  </p>
                </div>
                <Status
                  value={a.state}
                  label={
                    a.state === 'verified'
                      ? 'Native checked'
                      : a.state === 'configured'
                        ? 'Configured'
                        : 'Check needed'
                  }
                />
              </div>
              <dl className="account-facts">
                {a.nativeProvider && (
                  <div>
                    <dt>Native runtime extension</dt>
                    <dd>
                      {a.nativeProvider.extensionId} · {a.nativeProvider.extensionVersion}
                    </dd>
                  </div>
                )}
                {a.openClawProjectRoot && (
                  <div>
                    <dt>Reviewed native project</dt>
                    <dd>{a.openClawProjectRoot}</dd>
                  </div>
                )}
                {a.harness === 'claude' && a.billingMode === 'api' && (
                  <div>
                    <dt>Credential reference</dt>
                    <dd>{a.credentialEnv || 'ANTHROPIC_API_KEY'}</dd>
                  </div>
                )}
                <div>
                  <dt>Identity</dt>
                  <dd>{a.identity ?? 'Not checked'}</dd>
                </div>
                <div>
                  <dt>Access</dt>
                  <dd>
                    {a.plan ??
                      (a.billingMode === 'native'
                        ? 'Native default'
                        : a.billingMode === 'api'
                          ? 'API billing'
                          : 'Subscription')}
                  </dd>
                </div>
                <div>
                  <dt>Last checked</dt>
                  <dd>{age(a.checkedAt)}</dd>
                </div>
              </dl>
              {a.quotas.length ? (
                <div className="quota-list">
                  {a.quotas.map((q) => (
                    <div key={q.scope}>
                      <div className="quota-heading">
                        <span>{q.label}</span>
                        <strong>{q.usedPercent}% used</strong>
                      </div>
                      <progress
                        className={`meter ${q.usedPercent > 75 ? 'meter-warning' : ''}`}
                        max={100}
                        value={q.usedPercent}
                        aria-label={`${a.label} ${q.label} usage`}
                      />
                      <p>
                        {q.source === 'example'
                          ? 'Fictional example'
                          : `Native report · ${age(q.observedAt)}`}
                        {q.resetsAt
                          ? ` · Resets ${new Date(q.resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
                          : ' · Reset unknown'}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="quota-unknown">
                  <Gauge size={16} />
                  <span>
                    Allowance not reported
                    <small>Unknown is preserved; no balance is inferred.</small>
                  </span>
                </div>
              )}
              {duplicates.has(a.id) && (
                <p className="inline-note">
                  This identity also appears in another slot. It does not add independent capacity.
                </p>
              )}
              {a.ordinaryUsageAllowed === false && (
                <p className="inline-note">
                  The native backend reports included usage unavailable. Reset percentages do not
                  imply restored access.
                </p>
              )}
              {a.error && <p className="form-error">{a.error}</p>}
              <CredentialReference
                account={a}
                mutate={mutate}
                disabled={
                  Boolean(busy) ||
                  data.mode === 'demo' ||
                  data.access?.kind === 'tailscale' ||
                  data.work.some((work) => work.activeRunId)
                }
              />
              <div className="account-footer">
                <span className="source-note">
                  {a.backend
                    ? `T3 · ${a.backend.instanceId}`
                    : a.nativeHome
                      ? 'Separate native configuration'
                      : 'Native default configuration'}
                </span>
                <button
                  className="button secondary small"
                  disabled={
                    busy === a.id ||
                    data.mode === 'demo' ||
                    !(
                      a.backend ||
                      a.connector ||
                      a.nativeProvider ||
                      managedHarnesses.includes(a.harness)
                    )
                  }
                  onClick={() => onProbe(a)}
                  title={
                    data.mode === 'demo'
                      ? 'Demo accounts never contact native tools'
                      : a.nativeProvider
                        ? 'Check the loaded runtime extension binding; identity and allowance remain native'
                        : !(a.backend || a.connector || managedHarnesses.includes(a.harness))
                          ? 'No supported native status adapter'
                          : 'Read native authentication status'
                  }
                >
                  {busy === a.id ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  {a.nativeProvider ? 'Check runtime binding' : 'Check native account'}
                </button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon={UsersRound}
            title="Bring the accounts you already use."
            action={
              <button className="button primary" onClick={onNew}>
                <Plus size={16} />
                Add a native account slot
              </button>
            }
          >
            Add several accounts for the same harness. Keep tasks and context together while native
            authentication stays in its existing home.
          </Empty>
        </section>
      )}
      <NativeMigrations data={data} mutate={mutate} onHandoff={onNativeHandoff} />
    </div>
  );
}
