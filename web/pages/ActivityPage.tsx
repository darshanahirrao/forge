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
import { NativeSessionDialog } from '../components/NativeSessionDialog';
import { schedulerEvidence } from '../../shared/scheduler';

const sourceNames: Record<NativeSourceKind, string> = {
  codex: 'Codex chats',
  claude: 'Claude Code chats',
  'codex-schedules': 'Codex schedules',
  'hermes-schedules': 'Hermes schedules',
  hermes: 'Hermes API',
  openclaw: 'OpenClaw gateway',
  't3-code': 'T3 Code workspace',
};
const nativeDate = (value: string | null) =>
  value ? new Date(value).toLocaleString() : 'Not reported';
const quantity = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`;

export function ActivityPage({
  data,
  mutate,
  tab,
  setTab,
}: {
  data: Snapshot;
  mutate: Mutate;
  tab: 'chats' | 'schedules';
  setTab: (tab: 'chats' | 'schedules') => void;
}) {
  const [query, setQuery] = useState('');
  const [sourceId, setSourceId] = useState('all');
  const [adding, setAdding] = useState<NativeSource | true | null>(null);
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
        `${session.title} ${session.project} ${session.harness} ${session.providerInstanceId ?? ''} ${label(session.sourceId)}`,
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
                    {source.observation.projects !== undefined && (
                      <>{quantity(source.observation.projects, 'project')} · </>
                    )}
                    {quantity(
                      source.observation.sessions,
                      source.kind === 't3-code' ? 'thread' : 'chat',
                    )}{' '}
                    ·{' '}
                    {source.kind === 't3-code'
                      ? 'Schedules not read'
                      : quantity(source.observation.schedules, 'schedule')}
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
                {source.kind === 'hermes-schedules' && (
                  <p
                    className={
                      source.scheduler &&
                      schedulerEvidence(source.scheduler).state.endsWith('stale')
                        ? 'text-warning'
                        : ''
                    }
                  >
                    {source.schedulerCheck?.available === false
                      ? 'Latest scheduler check unavailable'
                      : schedulerEvidence(source.scheduler).label}
                    {source.schedulerCheck
                      ? ` · Checked ${age(source.schedulerCheck.observedAt).toLowerCase()}`
                      : ''}
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
                          : source.kind === 't3-code'
                            ? 'Up to 20 projects and 100 threads through read-only MCP. Threads stay in T3 Code; transcripts, schedules and approval controls are not imported.'
                            : 'Up to 100 native session records. The gateway retains execution, permissions and tool policy.'}
                  </p>
                  {source.kind === 't3-code' && (
                    <p>
                      <a href={source.endpoint} target="_blank" rel="noreferrer">
                        Open T3 Code
                      </a>
                      {' · '}Disconnect removes Forge's local sign-in. Revoke the native grant in T3
                      Code Connections.
                    </p>
                  )}
                  {source.checkedAt && <p>Observed {nativeDate(source.checkedAt)}</p>}
                  {source.kind === 'hermes-schedules' && (
                    <>
                      <p>
                        A check reads native provider and ticker markers. It starts no tick or job.
                        Saved evidence does not confirm current gateway availability or individual
                        job delivery.
                      </p>
                      {source.scheduler && (
                        <p>
                          Saved evidence from {nativeDate(source.scheduler.observedAt)}. Configured
                          provider: {source.scheduler.provider ?? 'Unknown'}. Native loop age at
                          check:{' '}
                          {source.scheduler.loopAgeSeconds === null
                            ? 'Unknown'
                            : `${Math.round(source.scheduler.loopAgeSeconds)} seconds`}
                          . Successful tick age at check:{' '}
                          {source.scheduler.successAgeSeconds === null
                            ? 'Unknown'
                            : `${Math.round(source.scheduler.successAgeSeconds)} seconds`}
                          .
                        </p>
                      )}
                    </>
                  )}
                  <p>
                    {source.capabilities.join(' · ') ||
                      'Capabilities appear after the first successful read.'}
                  </p>
                </details>
                <div className="native-source-actions">
                  {source.kind === 'hermes-schedules' && (
                    <button
                      className="button secondary small"
                      disabled={!local || !!busy || managedActive}
                      onClick={() =>
                        void perform(
                          `scheduler-${source.id}`,
                          () => mutate(`/native/sources/${source.id}/scheduler`, 'POST'),
                          'Native scheduler evidence checked. No job or tick was started.',
                        )
                      }
                    >
                      Check native scheduler
                    </button>
                  )}
                  {source.kind === 't3-code' && (
                    <button
                      className="button secondary small"
                      disabled={!!busy}
                      onClick={() => setAdding(source)}
                    >
                      Reconnect
                    </button>
                  )}
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
          initial={adding === true ? undefined : adding}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            setNotice('Source registered. Read it when you are ready.');
          }}
        />
      )}
      {selected && (
        <NativeSessionDialog
          session={selected}
          sources={data.nativeSources}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function SourceForm({
  mutate,
  initial,
  onClose,
  onSaved,
}: {
  mutate: Mutate;
  initial?: NativeSource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<NativeSourceKind>(initial?.kind ?? 'codex');
  const [label, setLabel] = useState(initial?.label ?? sourceNames.codex);
  const [home, setHome] = useState('');
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? 'http://127.0.0.1:8642');
  const [tokenEnv, setTokenEnv] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const runtime = kind === 'hermes' || kind === 'openclaw' || kind === 't3-code';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (kind === 't3-code') {
        const result = await mutate<{ authorizationUrl: string }>('/native/t3/authorize', 'POST', {
          endpoint,
          label,
        });
        window.location.assign(result.authorizationUrl);
        return;
      }
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
              setEndpoint(
                next === 'openclaw'
                  ? 'http://127.0.0.1:18789'
                  : next === 't3-code'
                    ? 'http://127.0.0.1:3773'
                    : 'http://127.0.0.1:8642',
              );
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
              {kind === 't3-code' ? 'T3 Code address' : 'Local API address'}
              <input
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                maxLength={300}
                required
              />
              <small>
                {kind === 't3-code'
                  ? 'Paste the local T3 Code address or its copied MCP URL. Sign in on this computer and choose Read only.'
                  : 'Use an existing loopback API. Its native authentication and tool policy apply.'}
              </small>
            </label>
            {kind === 't3-code' ? (
              <p className="source-note">
                T3 Code keeps its threads, tools and approvals. Forge reads project and thread
                summaries on demand. Its native grant covers all projects.
              </p>
            ) : (
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
            )}
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
          {kind === 't3-code'
            ? 'Forge remembers this read-only connection on this computer. Read its activity after connecting.'
            : 'Only the source reference is saved now. A separate read collects native titles and summaries. Full transcripts and schedule instructions stay native.'}
        </p>
        <FormError error={error} />
        <footer className="form-footer handoff-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving}>
            {saving && <LoaderCircle size={16} className="spin" />}
            {kind === 't3-code' ? 'Sign in to T3 Code' : 'Save source reference'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
