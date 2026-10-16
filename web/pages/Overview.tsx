import { type Snapshot, type Approval } from '../../shared/types';
import { usageSummary } from '../../shared/usage';
import {
  Layers3,
  ShieldCheck,
  Gauge,
  ArrowRight,
  Plus,
  Activity,
  Check,
  Cpu,
  HardDrive,
  Pause,
  MoreHorizontal,
  UsersRound,
  Network,
} from 'lucide-react';
import { currency, compact, age, gb } from '../lib/format';
import { WorkTable } from '../components/WorkTable';
import { Empty, IconButton, HarnessMark } from '../components/primitives';

export function Overview({
  data,
  onWork,
  onApproval,
  onNewWork,
  onAccounts,
  onResources,
  onConnections,
  onDemo,
  onQuiet,
  busy,
}: {
  data: Snapshot;
  onWork: (id: string) => void;
  onApproval: (a: Approval) => void;
  onNewWork: () => void;
  onAccounts: () => void;
  onResources: () => void;
  onConnections: () => void;
  onDemo: () => void;
  onQuiet: () => void;
  busy: string;
}) {
  const pending = data.approvals.filter((a) => a.status === 'pending');
  const ongoing = data.work.filter((w) => !['completed'].includes(w.status));
  const usage = usageSummary(data.usage);
  return (
    <>
      <div className="metrics-row">
        <div className="metric">
          <span>
            Work in progress <Layers3 size={16} />
          </span>
          <strong>{ongoing.length.toString().padStart(2, '0')}</strong>
          <small>
            {data.work.length
              ? `${data.work.length} work records in this workspace`
              : 'A durable place for your next task'}
          </small>
        </div>
        <div className="metric">
          <span>
            Needs your attention <ShieldCheck size={16} />
          </span>
          <strong>{pending.length.toString().padStart(2, '0')}</strong>
          <small>
            {pending.length
              ? 'Native decisions waiting for review'
              : 'No permission requests waiting'}
          </small>
        </div>
        <div className="metric">
          <span>
            Reported cost estimate <Gauge size={16} />
          </span>
          <strong>
            {usage.estimatedUsd !== null ? (
              currency(usage.estimatedUsd)
            ) : (
              <span className="metric-unknown">Not reported</span>
            )}
          </strong>
          <small>
            {data.usage.length
              ? `${compact(usage.totalTokens)} reported tokens${usage.incomplete ? ' · Cost coverage incomplete' : ' · Estimates, not invoices'}`
              : 'Usage appears after native reporting'}
          </small>
        </div>
      </div>
      {usage.excludedAggregates.length > 0 && (
        <div className="notice">
          <Gauge size={18} />
          <p>
            Imported daily reports can overlap native session reports. This total uses session
            reports for that harness; daily imports are retained separately.
          </p>
        </div>
      )}
      <div className="overview-grid">
        <div className="overview-main">
          {pending.length > 0 && (
            <section className="attention-strip">
              <div className="attention-icon">
                <ShieldCheck size={21} />
              </div>
              <div>
                <h2>
                  {pending.length === 1
                    ? 'One decision is waiting for you.'
                    : `${pending.length} decisions are waiting for you.`}
                </h2>
                <p>
                  {data.work.find((w) => w.id === pending[0].workId)?.title ??
                    'A native attempt needs review.'}
                </p>
              </div>
              <button className="button secondary" onClick={() => onApproval(pending[0])}>
                Review request <ArrowRight size={16} />
              </button>
            </section>
          )}
          <section className="panel work-panel">
            <div className="section-heading">
              <div>
                <h2>Work in motion</h2>
                <p>Context stays with the task.</p>
              </div>
              <span className="count-label">{data.work.length} records</span>
            </div>
            {data.work.length ? (
              <WorkTable
                work={data.work.slice(0, 6)}
                accounts={data.accounts}
                usage={data.usage}
                onWork={onWork}
              />
            ) : (
              <Empty
                title="Give your next task a place to live."
                action={
                  <div className="empty-actions">
                    <button className="button primary" onClick={onNewWork}>
                      <Plus size={16} />
                      Create your first work record
                    </button>
                    <button className="text-button" onClick={onDemo}>
                      Explore a demo <ArrowRight size={14} />
                    </button>
                  </div>
                }
              >
                Save the goal and context once. Connect an account when you are ready to use the
                native harness.
              </Empty>
            )}
          </section>
          <section className="panel activity-panel">
            <div className="section-heading">
              <div>
                <h2>Recent activity</h2>
                <p>A factual record of what changed.</p>
              </div>
              <Activity size={18} />
            </div>
            {data.events.length ? (
              <ol className="activity-list" role="list">
                {data.events.slice(0, 4).map((event) => (
                  <li key={event.id}>
                    <span className={`event-mark event-${event.kind}`} aria-hidden="true">
                      {event.kind === 'checkpoint' ? <Check size={13} /> : <span />}
                    </span>
                    <div>
                      <button onClick={() => onWork(event.workId)}>{event.title}</button>
                      <p>{data.work.find((w) => w.id === event.workId)?.title}</p>
                    </div>
                    <time dateTime={event.createdAt}>{age(event.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="quiet-empty">
                <Activity size={18} />
                <p>Work, checkpoints, and native decisions will appear here.</p>
              </div>
            )}
          </section>
        </div>
        <aside className="overview-rail" aria-label="Capacity and connections">
          <section className="panel capacity-panel">
            <div className="section-heading">
              <h2>Machine headroom</h2>
              <span className="live-label">
                <span className="status-dot" />
                Live
              </span>
            </div>
            <div className="capacity-value">
              <Cpu size={19} />
              <span>CPU in use</span>
              <strong>
                {data.machine.cpuPercent === null
                  ? 'Sampling'
                  : `${Math.round(data.machine.cpuPercent)}%`}
              </strong>
            </div>
            <progress
              className="meter"
              max={100}
              value={data.machine.cpuPercent ?? 0}
              aria-label="CPU in use"
            />
            <div className="capacity-value">
              <HardDrive size={19} />
              <span>OS memory in use</span>
              <strong>{gb(data.machine.totalMemory - data.machine.freeMemory)}</strong>
            </div>
            <progress
              className="meter"
              max={data.machine.totalMemory}
              value={data.machine.totalMemory - data.machine.freeMemory}
              aria-label="OS memory in use, including reclaimable cache"
            />
            <p className="source-note">
              Of {gb(data.machine.totalMemory)}. Includes reclaimable cache; this is not a
              memory-pressure score.
            </p>
            <button className="text-button" onClick={onResources}>
              Inspect resources <ArrowRight size={14} />
            </button>
            <div className="quiet-mode">
              <div>
                <Pause size={16} />
                <span>
                  Quiet mode
                  <small>
                    {data.settings.quietMode
                      ? 'New managed work is paused'
                      : 'Keep new work under your control'}
                  </small>
                </span>
              </div>
              <button
                className={`switch ${data.settings.quietMode ? 'switch-on' : ''}`}
                role="switch"
                aria-checked={data.settings.quietMode}
                aria-label="Quiet mode"
                disabled={busy === 'quiet'}
                onClick={onQuiet}
              >
                <span />
              </button>
            </div>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>Account capacity</h2>
              <IconButton label="Open accounts" onClick={onAccounts}>
                <MoreHorizontal size={18} />
              </IconButton>
            </div>
            {data.accounts.length ? (
              <div className="mini-account-list">
                {data.accounts.slice(0, 3).map((account) => (
                  <div className="mini-account" key={account.id}>
                    <div>
                      <HarnessMark harness={account.harness} />
                      <span>
                        <strong>{account.label}</strong>
                        <small>
                          {account.quotas[0]
                            ? `${account.quotas[0].usedPercent}% used · ${account.quotas[0].source === 'example' ? 'Example' : 'Native report'}`
                            : 'Allowance not reported'}
                        </small>
                      </span>
                    </div>
                    {account.quotas[0] && (
                      <progress
                        className={`meter ${account.quotas[0].usedPercent > 75 ? 'meter-warning' : ''}`}
                        max={100}
                        value={account.quotas[0].usedPercent}
                        aria-label={`${account.label} reported allowance used`}
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rail-empty">
                <UsersRound size={22} />
                <p>Connect native account slots to see identity and reported limits.</p>
                <button className="text-button" onClick={onAccounts}>
                  Add your accounts <ArrowRight size={14} />
                </button>
              </div>
            )}
          </section>
          <section className="continuity-note">
            <Network size={24} strokeWidth={1.3} />
            <h2>Built around your tools.</h2>
            <p>
              {data.connections.filter((c) => c.installed).length} native tools detected. Connect
              what you use; keep the rest asleep.
            </p>
            <button className="text-button" onClick={onConnections}>
              Explore connections <ArrowRight size={14} />
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}
