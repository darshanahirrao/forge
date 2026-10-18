import { type Snapshot } from '../../shared/types';
import { type Mutate } from '../api';
import { useState, type FormEvent } from 'react';
import { Status, FormError } from '../components/primitives';
import {
  LoaderCircle,
  Plug,
  Network,
  Activity,
  Terminal,
  RefreshCw,
  Plus,
  ExternalLink,
} from 'lucide-react';
import { compact, currency } from '../lib/format';
import { BackendsPanel } from '../components/BackendsPanel';
import { CompanionsPanel } from '../components/CompanionsPanel';
import { BlueprintsPanel } from '../components/BlueprintsPanel';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { ConnectorsPanel } from '../components/ConnectorsPanel';
import { AvailabilityPanel } from '../components/AvailabilityPanel';

export function ConnectionsPage({
  data,
  mutate,
  onNewAccount,
  onDownload,
  busy,
  act,
  runtimeFocus,
}: {
  data: Snapshot;
  mutate: Mutate;
  onNewAccount: (harness?: string) => void;
  onDownload: () => void;
  busy: string;
  act: (key: string, fn: () => Promise<unknown>, message?: string) => Promise<void>;
  runtimeFocus?: string;
}) {
  const [endpoint, setEndpoint] = useState(
    data.hermes.endpoint.startsWith('http') ? data.hermes.endpoint : 'http://127.0.0.1:8642',
  );
  const [tokenEnv, setTokenEnv] = useState('');
  const [hermesError, setHermesError] = useState('');
  const [connecting, setConnecting] = useState(false);
  async function connectHermes(e: FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setHermesError('');
    try {
      await mutate('/connections/hermes', 'POST', { endpoint, ...(tokenEnv ? { tokenEnv } : {}) });
    } catch (error) {
      setHermesError((error as Error).message);
    } finally {
      setConnecting(false);
    }
  }
  return (
    <div className="page-stack">
      <BackendsPanel data={data} mutate={mutate} />
      <ConnectorsPanel data={data} mutate={mutate} />
      {data.mode === 'local' && Boolean(data.nativeHarnesses?.length) && (
        <section className="panel" aria-label="Native harness extensions">
          <div className="section-heading">
            <div>
              <h2>Native harness extensions</h2>
              <p>Link a native profile, then select it for managed work.</p>
            </div>
          </div>
          <div className="native-entry-list">
            {data.nativeHarnesses!.map((provider) => (
              <article className="native-entry" key={provider.id}>
                <div className="native-entry-copy">
                  <h3>{provider.name}</h3>
                  <p>
                    {provider.extensionName} · {provider.extensionVersion} · Native{' '}
                    {provider.nativeVersion}
                  </p>
                  <details className="native-details">
                    <summary>Provider binding</summary>
                    <p className="mono">{provider.id}</p>
                    <p className="native-rule">{provider.digest}</p>
                    <p>
                      The native adapter keeps its tools, permissions and conversation. Forge
                      retains the same work, selected context, approvals, usage and original-child
                      recovery. Loading a provider starts no worker.
                    </p>
                  </details>
                </div>
                <button
                  className="button secondary small"
                  onClick={() => onNewAccount(provider.id)}
                >
                  Link an account
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      {data.mode === 'local' && Boolean(data.runtimeProviders?.length) && (
        <section className="panel" aria-label="Native runtime extensions">
          <div className="section-heading">
            <div>
              <h2>Native runtime extensions</h2>
              <p>Link a native profile, then review its start in Companion access.</p>
            </div>
          </div>
          <div className="native-entry-list">
            {data.runtimeProviders!.map((provider) => (
              <article className="native-entry" key={provider.id}>
                <div className="native-entry-copy">
                  <h3>{provider.name}</h3>
                  <p>
                    {provider.extensionName} · {provider.extensionVersion} · Native{' '}
                    {provider.nativeVersion}
                  </p>
                  <details className="native-details">
                    <summary>Provider binding</summary>
                    <p className="mono">{provider.id}</p>
                    <p className="native-rule">{provider.digest}</p>
                    <p>
                      Native models, tools, memory, permissions and schedules keep their existing
                      owner. Loading a provider does not start a native runtime.
                    </p>
                  </details>
                </div>
                <button
                  className="button secondary small"
                  onClick={() => onNewAccount(provider.id)}
                >
                  Link an account
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      <CompanionsPanel data={data} mutate={mutate} runtimeFocus={runtimeFocus} />
      <NotificationsPanel data={data} mutate={mutate} />
      <AvailabilityPanel data={data} mutate={mutate} />
      <section className="panel runtime-panel">
        <div className="runtime-copy">
          <h2>Hermes API health</h2>
          <p>
            Connect an existing local Hermes API server for native health and capability discovery.
            Its tools, memory, and execution stay native. The runtime remains replaceable.
          </p>
          <div className="runtime-state">
            <Status
              value={data.hermes.status === 'connected' ? 'verified' : 'configured'}
              label={data.hermes.status === 'connected' ? 'API connected' : 'Not connected'}
            />
            {data.hermes.version && <span className="source-note">{data.hermes.version}</span>}
          </div>
          {data.hermes.capabilities.length > 0 && (
            <details className="native-details">
              <summary>{data.hermes.capabilities.length} advertised native capabilities</summary>
              <ul>
                {data.hermes.capabilities.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
              <p className="source-note">
                Discovery does not enable controls that Forge has not implemented.
              </p>
            </details>
          )}
        </div>
        <form className="runtime-form" onSubmit={connectHermes}>
          <label>
            Local API address
            <input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              required
              disabled={data.mode === 'demo'}
            />
          </label>
          <label>
            Token environment variable <span className="optional">Optional</span>
            <input
              value={tokenEnv}
              onChange={(e) => setTokenEnv(e.target.value)}
              placeholder="FORGE_HERMES_TOKEN"
              pattern="FORGE_[A-Z0-9_]+"
              disabled={data.mode === 'demo'}
            />
            <small>Reference an environment variable. Keep the native token outside Forge.</small>
          </label>
          <FormError error={hermesError} />
          <button className="button primary" disabled={connecting || data.mode === 'demo'}>
            {connecting ? <LoaderCircle className="spin" size={16} /> : <Plug size={16} />}Check
            Hermes API
          </button>
          {data.mode === 'demo' && (
            <small>Switch to your local workspace to connect a native service.</small>
          )}
        </form>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Native tools &amp; sources</h2>
            <p>Detected on PATH. Installation does not imply account access.</p>
          </div>
          <span className="count-label">
            {data.connections.filter((c) => c.installed).length} detected
          </span>
        </div>
        <div className="connection-list">
          {data.connections.map((c) => (
            <div className="connection-row" key={c.id}>
              <span className="connection-icon">
                {c.kind === 'runtime' ? (
                  <Network size={21} />
                ) : c.kind === 'source' ? (
                  <Activity size={21} />
                ) : (
                  <Terminal size={21} />
                )}
              </span>
              <div className="connection-info">
                <h3>
                  {c.name}
                  <span>{c.installed ? 'Installed' : 'Not detected'}</span>
                </h3>
                <p>{c.description}</p>
                <small>{c.capabilities.join(' · ')}</small>
              </div>
              <div className="connection-actions">
                {c.id === 'agent-deck' || c.id === 'ccusage' ? (
                  <button
                    className="button secondary small"
                    disabled={!c.installed || data.mode === 'demo' || busy === c.id}
                    onClick={() =>
                      void act(
                        c.id,
                        () => mutate(`/connections/${c.id}/refresh`, 'POST'),
                        `${c.name} source refreshed.`,
                      )
                    }
                  >
                    {busy === c.id ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {c.id === 'agent-deck' ? 'Read sessions' : 'Read usage'}
                  </button>
                ) : c.id === 'codex' || c.id === 'claude' ? (
                  <button className="button secondary small" onClick={() => onNewAccount()}>
                    <Plus size={14} />
                    Add account
                  </button>
                ) : null}
                <a
                  href={c.documentation}
                  target="_blank"
                  rel="noreferrer"
                  className="external-link"
                  aria-label={`${c.name} native documentation`}
                >
                  <ExternalLink size={16} />
                </a>
              </div>
            </div>
          ))}
        </div>
      </section>
      {data.nativeSessions.some((s) => s.source === 'agent-deck') && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Existing Agent Deck sessions</h2>
              <p>Read-only native inventory. Ownership remains in Agent Deck.</p>
            </div>
          </div>
          <div
            className="table-scroll"
            role="region"
            aria-label="Existing Agent Deck sessions"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Harness</th>
                  <th scope="col">Native state</th>
                  <th scope="col">Project</th>
                </tr>
              </thead>
              <tbody>
                {data.nativeSessions
                  .filter((s) => s.source === 'agent-deck')
                  .map((s) => (
                    <tr key={s.id}>
                      <td>{s.title}</td>
                      <td>{s.harness}</td>
                      <td>{s.status}</td>
                      <td>{s.project}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {data.usage.length > 0 && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Usage evidence</h2>
              <p>Native cumulative snapshots and ccusage daily estimates retain separate scopes.</p>
            </div>
          </div>
          <div
            className="table-scroll"
            role="region"
            aria-label="Native usage evidence"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Scope</th>
                  <th scope="col" className="align-right">
                    Tokens
                  </th>
                  <th scope="col" className="align-right">
                    Estimated USD
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.usage.map((u) => (
                  <tr key={u.key}>
                    <td>{u.source}</td>
                    <td>{u.scope}</td>
                    <td className="mono align-right">{compact(u.totalTokens)}</td>
                    <td className="mono align-right">
                      {u.estimatedUsd === null ? 'Not reported' : currency(u.estimatedUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <BlueprintsPanel data={data} mutate={mutate} onDownload={onDownload} />
    </div>
  );
}
