import { useState, type FormEvent } from 'react';
import {
  CalendarClock,
  ChevronRight,
  FolderSearch,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Unplug,
} from 'lucide-react';
import type { NativeSession, NativeSource, NativeSourceKind, Snapshot } from '../../shared/types';
import type { Mutate } from '../api';
import { Dialog, Empty, FormError, IconButton } from '../components/primitives';
import { age, names } from '../lib/format';

const sourceNames: Record<NativeSourceKind, string> = {
  codex: 'Codex chats',
  claude: 'Claude Code chats',
  'codex-schedules': 'Codex schedules',
  'hermes-schedules': 'Hermes schedules',
  hermes: 'Hermes API',
  openclaw: 'OpenClaw gateway',
};
const nativeDate = (value: string | null) =>
  value ? new Date(value).toLocaleString() : 'Not reported';
const quantity = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`;

export function ActivityPage({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [tab, setTab] = useState<'chats' | 'schedules'>('chats');
  const [query, setQuery] = useState('');
  const [sourceId, setSourceId] = useState('all');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<NativeSession | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const managedActive = data.work.some((work) => work.activeRunId);
  const local = data.mode === 'local';
  const sources = new Map(data.nativeSources.map((source) => [source.id, source]));
  const label = (id?: string) => (id ? sources.get(id)?.label : undefined) ?? 'Agent Deck';
  const matches = (id: string | undefined, value: string) =>
    (sourceId === 'all' || id === sourceId) && value.toLowerCase().includes(query.toLowerCase());
  const sessions = data.nativeSessions
    .filter((session) =>
      matches(
        session.sourceId,
        `${session.title} ${session.project} ${session.harness} ${label(session.sourceId)}`,
      ),
    )
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const schedules = data.nativeSchedules.filter((schedule) =>
    matches(
      schedule.sourceId,
      `${schedule.title} ${schedule.owner} ${schedule.state} ${label(schedule.sourceId)}`,
    ),
  );
  async function perform(key: string, operation: () => Promise<unknown>, message: string) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await operation();
      setNotice(message);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-heading activity-heading">
          <div>
            <h2>Native sources</h2>
            <p>Refresh on demand. A saved chat does not establish that a worker is running.</p>
          </div>
          <div className="activity-actions">
            <button
              className="button secondary small"
              disabled={!local || !!busy}
              onClick={() =>
                void perform(
                  'discover',
                  () => mutate('/native/discover', 'POST'),
                  'Existing local profile references registered. Choose a source to read its metadata.',
                )
              }
            >
              {busy === 'discover' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <FolderSearch size={15} />
              )}{' '}
              Discover profiles
            </button>
            <button
              className="button secondary small"
              disabled={!local || !!busy}
              onClick={() => setAdding(true)}
            >
              <Plus size={15} /> Add source
            </button>
          </div>
        </div>
        <div className="native-sources">
          {data.nativeSources.length ? (
            data.nativeSources.map((source) => (
              <article className="native-source" key={source.id}>
                <div className="native-source-title">
                  <h3>{source.label}</h3>
                  <span
                    className={`native-connection-state ${source.state === 'error' ? 'text-error' : ''}`}
                  >
                    {source.state === 'connected'
                      ? 'Observed'
                      : source.state === 'error'
                        ? 'Refresh failed'
                        : 'Ready to read'}
                  </span>
                </div>
                <p>
                  {sourceNames[source.kind]}
                  <span> · </span>
                  {source.checkedAt
                    ? `Read ${age(source.checkedAt).toLowerCase()}`
                    : 'No metadata read yet'}
                </p>
                {source.observation && (
                  <p>
                    {quantity(source.observation.sessions, 'chat')} ·{' '}
                    {quantity(source.observation.schedules, 'schedule')}
                    {source.observation.moreAvailable
                      ? ' · More available in the native client'
                      : ''}
                  </p>
                )}
                {source.error && (
                  <p className="text-error">
                    {source.error}
                    {source.checkedAt ? ' The previous observation is retained.' : ''}
                  </p>
                )}
                <details className="native-details">
                  <summary>Source and coverage</summary>
                  <p className="native-location mono">{source.home || source.endpoint}</p>
                  <p>
                    {source.kind === 'codex'
                      ? 'Up to 100 recent interactive chats from the native state database. Archived chats and rollout repair are excluded.'
                      : source.kind === 'claude'
                        ? 'Up to 100 recent native SDK sessions, including programmatic sessions.'
                        : source.kind.endsWith('schedules')
                          ? 'Native definitions only. The native scheduler owns execution; its liveness is not inferred.'
                          : 'Up to 100 native session records. The gateway retains execution, permissions and tool policy.'}
                  </p>
                  {source.checkedAt && <p>Observed {nativeDate(source.checkedAt)}</p>}
                  <p>
                    {source.capabilities.join(' · ') ||
                      'Capabilities appear after the first successful read.'}
                  </p>
                </details>
                <div className="native-source-actions">
                  <button
                    className="button secondary small"
                    disabled={!!busy || managedActive}
                    onClick={() =>
                      void perform(
                        source.id,
                        () => mutate(`/native/sources/${source.id}/refresh`, 'POST'),
                        `${source.label} metadata refreshed.`,
                      )
                    }
                  >
                    {busy === source.id ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}{' '}
                    Read {source.label}
                  </button>
                  <IconButton
                    label={`Forget ${source.label}`}
                    disabled={!!busy}
                    onClick={() =>
                      void perform(
                        `remove-${source.id}`,
                        async () => {
                          await mutate(`/native/sources/${source.id}`, 'DELETE');
                          if (sourceId === source.id) setSourceId('all');
                        },
                        'Source reference and its cached observation removed. Native data is unchanged.',
                      )
                    }
                  >
                    <Unplug size={16} />
                  </IconButton>
                </div>
              </article>
            ))
          ) : (
            <div className="native-source-intro">
              <FolderSearch size={22} />
              <p>
                {local
                  ? 'Discover your existing profiles, or add a separate account home or runtime API. Registration saves a reference; reading is a separate action.'
                  : 'Native discovery stays in your local workspace. The demo never reads your profiles.'}
              </p>
            </div>
          )}
        </div>
        {managedActive && (
          <p className="panel-footnote">
            A managed worker is active. Inventory refreshes will be available after it exits.
          </p>
        )}
        {notice && (
          <p className="panel-footnote" role="status">
            {notice}
          </p>
        )}
        {error && (
          <div className="panel-footnote">
            <FormError error={error} />
          </div>
        )}
      </section>
      <section className="panel">
        <div className="filter-row native-filter">
          <div className="segmented" role="group" aria-label="Activity type">
            <button aria-pressed={tab === 'chats'} onClick={() => setTab('chats')}>
              Chats <span>{data.nativeSessions.length}</span>
            </button>
            <button aria-pressed={tab === 'schedules'} onClick={() => setTab('schedules')}>
              Schedules <span>{data.nativeSchedules.length}</span>
            </button>
          </div>
          <div className="activity-actions">
            <label>
              <span className="sr-only">Filter native source</span>
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="all">All sources</option>
                {data.nativeSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-search">
              <Search size={16} />
              <span className="sr-only">Search native activity</span>
              <input
                placeholder="Find native activity"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
        </div>
        {tab === 'chats' ? (
          sessions.length ? (
            <div className="native-entry-list">
              {sessions.map((session) => (
                <button
                  className="native-entry native-session"
                  key={`${session.sourceId ?? session.source}:${session.id}`}
                  onClick={() => setSelected(session)}
                >
                  <MessageSquare size={19} className="native-entry-icon" />
                  <span className="native-entry-copy">
                    <strong>{session.title || 'Untitled native session'}</strong>
                    <span>
                      {session.project} · {label(session.sourceId)}
                    </span>
                    <small>{session.status}</small>
                  </span>
                  <span className="native-entry-meta">
                    {session.updatedAt ? age(session.updatedAt) : 'Time unknown'}
                    <ChevronRight size={16} />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon={MessageSquare}
              title={
                query || sourceId !== 'all'
                  ? 'No chats match this view.'
                  : 'Your native chats belong here.'
              }
            >
              {query || sourceId !== 'all'
                ? 'Try another source or search term.'
                : 'Read a configured source to see its saved sessions. Forge will keep each native owner visible.'}
            </Empty>
          )
        ) : schedules.length ? (
          <div className="native-entry-list">
            {schedules.map((schedule) => (
              <article
                className="native-entry native-schedule"
                key={`${schedule.sourceId}:${schedule.id}`}
              >
                <CalendarClock size={19} className="native-entry-icon" />
                <div className="native-entry-copy">
                  <h3>{schedule.title}</h3>
                  <p>
                    {names[schedule.owner]} · {label(schedule.sourceId)} · {schedule.state}
                  </p>
                  <code className="native-rule">{schedule.rule}</code>
                  <details className="native-details">
                    <summary>Native schedule record</summary>
                    <p>Type: {schedule.kind}</p>
                    <p>Next run: {nativeDate(schedule.nextRunAt)}</p>
                    <p>Last run: {nativeDate(schedule.lastRunAt)}</p>
                    <p>Last result: {schedule.lastOutcome ?? 'Not reported'}</p>
                    <p>Observed: {nativeDate(schedule.observedAt)}</p>
                    <p className="mono">ID: {schedule.id}</p>
                  </details>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={CalendarClock}
            title={
              query || sourceId !== 'all'
                ? 'No schedules match this view.'
                : 'A clear view of recurring work.'
            }
          >
            {query || sourceId !== 'all'
              ? 'Try another source or search term.'
              : 'Read Codex or Hermes schedule metadata. Jobs continue to run through their native scheduler.'}
          </Empty>
        )}
        {(sessions.length > 0 || schedules.length > 0) && (
          <p className="panel-footnote">
            Saved observations, refreshed on demand. Foreign sessions and schedules retain their
            native controls.
          </p>
        )}
      </section>
      {adding && (
        <SourceForm
          mutate={mutate}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setNotice('Source registered. Read it when you are ready.');
          }}
        />
      )}
      {selected && (
        <Dialog
          title={selected.title || 'Native session'}
          subtitle="NATIVE OBSERVATION"
          onClose={() => setSelected(null)}
        >
          <div className="dialog-body form-stack">
            <dl className="native-facts">
              <div>
                <dt>Owner</dt>
                <dd>{label(selected.sourceId)}</dd>
              </div>
              <div>
                <dt>Native state</dt>
                <dd>{selected.status}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{nativeDate(selected.updatedAt ?? null)}</dd>
              </div>
              <div>
                <dt>Observed</dt>
                <dd>{nativeDate(selected.observedAt ?? null)}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd className="mono">{selected.cwd || selected.project}</dd>
              </div>
              <div>
                <dt>Native session</dt>
                <dd className="mono">{selected.id}</dd>
              </div>
            </dl>
            <p className="source-note">
              This is a metadata reference. Continue and inspect approvals in the native client. A
              saved session does not establish current process ownership.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function SourceForm({
  mutate,
  onClose,
  onSaved,
}: {
  mutate: Mutate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<NativeSourceKind>('codex');
  const [label, setLabel] = useState(sourceNames.codex);
  const [home, setHome] = useState('');
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:8642');
  const [tokenEnv, setTokenEnv] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const runtime = kind === 'hermes' || kind === 'openclaw';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await mutate<NativeSource>('/native/sources', 'POST', {
        kind,
        label,
        ...(runtime ? { endpoint, ...(tokenEnv ? { tokenEnv } : {}) } : { home }),
      });
      onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title="Connect existing activity." subtitle="NATIVE SOURCE" onClose={onClose}>
      <form className="dialog-body form-stack" onSubmit={submit}>
        <label>
          Source type
          <select
            value={kind}
            onChange={(event) => {
              const next = event.target.value as NativeSourceKind;
              setKind(next);
              setLabel(sourceNames[next]);
              setEndpoint(next === 'openclaw' ? 'http://127.0.0.1:18789' : 'http://127.0.0.1:8642');
            }}
          >
            {Object.entries(sourceNames).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source label
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={100}
            required
          />
        </label>
        {runtime ? (
          <>
            <label>
              Local API address
              <input
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                maxLength={300}
                required
              />
              <small>
                Use an existing loopback API. Its native authentication and tool policy apply.
              </small>
            </label>
            <label>
              Token environment variable <span className="optional">Optional</span>
              <input
                value={tokenEnv}
                onChange={(event) => setTokenEnv(event.target.value)}
                pattern="FORGE_[A-Z0-9_]+"
                maxLength={128}
                placeholder="FORGE_RUNTIME_TOKEN"
              />
              <small>
                Save the environment variable name. Keep its secret value outside Forge.
              </small>
            </label>
          </>
        ) : (
          <label>
            Native home directory
            <input
              value={home}
              onChange={(event) => setHome(event.target.value)}
              placeholder="/absolute/path/to/native/home"
              maxLength={2000}
              required
            />
            <small>
              {kind.endsWith('schedules')
                ? 'Choose the profile home containing automations/ or cron/jobs.json.'
                : 'Choose the existing native configuration home for this account.'}
            </small>
          </label>
        )}
        <p className="source-note">
          Only the source reference is saved now. A separate read collects native titles and
          summaries. Full transcripts and schedule instructions stay native.
        </p>
        <FormError error={error} />
        <footer className="form-footer handoff-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving}>
            {saving && <LoaderCircle size={16} className="spin" />}Save source reference
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
