import { useState } from 'react';
import type { Snapshot, Approval, NativeSession, WorkSummary, Harness } from '../../shared/types';
import { usageSummary } from '../../shared/usage';
import {
  ArrowRight,
  ChevronRight,
  Search,
  ShieldCheck,
  Pause,
  Cpu,
  MessageSquare,
  FileText,
} from 'lucide-react';
import { currency, compact, age, gb, names } from '../lib/format';
import { Status } from '../components/primitives';

type Entry =
  | { key: string; kind: 'managed'; value: WorkSummary }
  | { key: string; kind: 'native'; value: NativeSession };

export function Overview({
  data,
  onWork,
  onNative,
  onApproval,
  onAccounts,
  onLinkAccount,
  onResources,
  onActivity,
  onSchedules,
  onQuiet,
  busy,
}: {
  data: Snapshot;
  onWork: (id: string) => void;
  onNative: (session: NativeSession) => void;
  onApproval: (approval: Approval) => void;
  onAccounts: () => void;
  onLinkAccount: () => void;
  onResources: () => void;
  onActivity: () => void;
  onSchedules: () => void;
  onQuiet: () => void;
  busy: string;
}) {
  const [filter, setFilter] = useState<'all' | 'managed' | 'native'>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const pending = data.approvals.filter((approval) => approval.status === 'pending');
  const active = data.work.filter((work) => work.activeRunId).length;
  const sourceErrors = data.nativeSources.filter((source) => source.state === 'error').length;
  const sources = new Map(data.nativeSources.map((source) => [source.id, source.label]));
  const usage = usageSummary(data.usage);
  const entries: Entry[] = [
    ...data.work.map((value) => ({ key: `work:${value.id}`, kind: 'managed' as const, value })),
    ...data.nativeSessions.map((value) => ({
      key: `native:${value.sourceId ?? value.source}:${value.id}`,
      kind: 'native' as const,
      value,
    })),
  ];
  const matches = entries
    .filter((entry) => {
      const value = entry.value;
      const account =
        entry.kind === 'managed'
          ? (data.accounts.find((item) => item.id === entry.value.accountId)?.label ?? '')
          : (sources.get(entry.value.sourceId ?? '') ?? '');
      return (
        (filter === 'all' || filter === entry.kind) &&
        `${value.title} ${value.project} ${value.cwd ?? ''} ${value.harness} ${account}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      );
    })
    .sort((a, b) => {
      const running = (entry: Entry) =>
        entry.kind === 'managed' && entry.value.activeRunId ? 1 : 0;
      return (
        running(b) - running(a) ||
        (Date.parse(b.value.updatedAt ?? '') || 0) - (Date.parse(a.value.updatedAt ?? '') || 0)
      );
    });
  const pressure = data.machine.memoryPressure?.state ?? 'unknown';
  return (
    <div className="workspace-content">
      <section className="workspace-status" aria-label="Workspace status">
        <button onClick={onResources} title="Inspect owned native workers and machine usage">
          <Cpu size={15} />
          <span>
            <strong>{active}</strong> active {active === 1 ? 'attempt' : 'attempts'}
          </span>
          <span className="muted">
            CPU{' '}
            {data.machine.cpuPercent === null
              ? 'sampling'
              : `${Math.round(data.machine.cpuPercent)}%`}
          </span>
        </button>
        <button
          onClick={onResources}
          title="OS memory includes reclaimable cache. Pressure is reported separately."
        >
          <span>
            {gb(data.machine.totalMemory - data.machine.freeMemory)} /{' '}
            {gb(data.machine.totalMemory)} OS memory
          </span>
          <span className={`pressure-text pressure-${pressure}`}>Pressure {pressure}</span>
        </button>
        <button
          onClick={onAccounts}
          title="Saved usage reports, with unknown costs excluded. Estimates are not invoices."
        >
          <span>
            {usage.estimatedUsd === null
              ? 'Cost not reported'
              : `${currency(usage.estimatedUsd)} estimated`}
          </span>
          <span className="muted">
            {compact(usage.totalTokens)} reported tokens{usage.incomplete ? ' · partial' : ''}
          </span>
        </button>
        <button
          className={`workspace-quiet ${data.settings.quietMode ? 'is-paused' : ''}`}
          role="switch"
          aria-checked={data.settings.quietMode}
          aria-label="Quiet mode"
          disabled={busy === 'quiet'}
          onClick={onQuiet}
          title="Pause admission of new managed work. Existing workers continue."
        >
          <Pause size={14} />
          {data.settings.quietMode ? 'New work paused' : 'Pause new work'}
        </button>
      </section>
      {pending.length > 0 && (
        <section className="workspace-attention" aria-label="Needs your attention">
          <h2>
            <ShieldCheck size={16} />
            Needs your attention <span>{pending.length}</span>
          </h2>
          {pending.map((approval) => (
            <button
              key={approval.id}
              className="attention-row"
              onClick={() => onApproval(approval)}
            >
              <span>
                <strong>{approval.title}</strong>
                <small>
                  {data.work.find((work) => work.id === approval.workId)?.title ??
                    'Native permission request'}
                </small>
              </span>
              <span>
                Review request <ChevronRight size={15} />
              </span>
            </button>
          ))}
        </section>
      )}
      {data.mode === 'local' && data.accounts.length === 0 && (
        <div className="setup-inline">
          <p>
            <strong>
              {data.connections.filter((connection) => connection.installed).length} tools detected.
            </strong>{' '}
            Link an existing account to run work from Forge.
          </p>
          <button className="text-button" onClick={onLinkAccount}>
            Link account <ArrowRight size={14} />
          </button>
        </div>
      )}
      <section className="workspace-list" aria-label="Recent work">
        <div className="workspace-list-heading">
          <h2>
            Recent work <span>{entries.length}</span>
          </h2>
          <button className="text-button" onClick={onSchedules}>
            {data.nativeSchedules.length} schedules <ArrowRight size={14} />
          </button>
        </div>
        <div className="workspace-filter">
          <div className="segmented" role="group" aria-label="Workspace work type">
            {(['all', 'managed', 'native'] as const).map((kind) => (
              <button
                key={kind}
                aria-pressed={filter === kind}
                onClick={() => {
                  setFilter(kind);
                  setLimit(20);
                }}
              >
                {kind === 'all' ? 'All' : kind === 'managed' ? 'Managed' : 'Native'}
              </button>
            ))}
          </div>
          <label className="inline-search">
            <Search size={15} />
            <span className="sr-only">Filter workspace work</span>
            <input
              placeholder="Filter work..."
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(20);
              }}
            />
          </label>
        </div>
        {matches.length > 0 ? (
          <ul className="workspace-entries" role="list">
            {matches.slice(0, limit).map((entry) => {
              const value = entry.value;
              const harness = names[value.harness as Harness] ?? value.harness;
              const account =
                entry.kind === 'managed'
                  ? (data.accounts.find((item) => item.id === entry.value.accountId)?.label ??
                    'No account')
                  : (sources.get(entry.value.sourceId ?? '') ?? entry.value.source);
              return (
                <li key={entry.key}>
                  <button
                    className="workspace-entry"
                    aria-label={value.title || 'Untitled native session'}
                    onClick={() =>
                      entry.kind === 'managed' ? onWork(entry.value.id) : onNative(entry.value)
                    }
                  >
                    {entry.kind === 'managed' ? (
                      <FileText size={17} />
                    ) : (
                      <MessageSquare size={17} />
                    )}
                    <span className="workspace-entry-main">
                      <strong>{value.title || 'Untitled native session'}</strong>
                      <small>
                        {value.project || value.cwd || 'No project'} · {harness} · {account}
                      </small>
                    </span>
                    <span className="workspace-entry-state">
                      {entry.kind === 'managed' ? (
                        <Status value={entry.value.status} />
                      ) : (
                        <span>Native observation</span>
                      )}
                    </span>
                    <time className="workspace-entry-time" dateTime={value.updatedAt ?? undefined}>
                      {value.updatedAt ? age(value.updatedAt) : 'Time unknown'}
                    </time>
                    <ChevronRight size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="workspace-empty">
            <h3>{query || filter !== 'all' ? 'No matching work' : 'No work yet'}</h3>
            <p>
              {query || filter !== 'all'
                ? 'Change the filter or search another title, project or harness.'
                : 'Create a work record, or connect your existing native chats.'}
            </p>
            {!entries.length && (
              <button className="text-button" onClick={onActivity}>
                Connect existing activity <ArrowRight size={14} />
              </button>
            )}
          </div>
        )}
        <div className="workspace-list-footer">
          <span>
            {matches.length
              ? `${Math.min(limit, matches.length)} of ${matches.length}`
              : '0 results'}
          </span>
          {matches.length > limit && (
            <button className="text-button" onClick={() => setLimit(limit + 30)}>
              Show more work
            </button>
          )}
          {sourceErrors > 0 && (
            <button className="text-button source-error-link" onClick={onActivity}>
              {sourceErrors} source {sourceErrors === 1 ? 'connection needs' : 'connections need'}{' '}
              attention
            </button>
          )}
        </div>
      </section>
      <p className="workspace-coverage">
        Native entries are saved metadata, refreshed on demand. Their execution and approvals stay
        in the native client. Active attempts above are managed by Forge.
      </p>
    </div>
  );
}
