import { useState } from 'react';
import {
  type MachineSnapshot,
  type NativeWorkerResources,
  type WorkSummary,
  type Settings,
} from '../../shared/types';
import { Cpu, HardDrive, Activity, Play, Pause, Terminal } from 'lucide-react';
import { gb, age, harnessName } from '../lib/format';
import { Empty } from '../components/primitives';
import type { ResourceObservation } from '../../shared/resources';
import { ResourceMap } from '../components/ResourceMap';
import { NativeRecovery } from '../components/NativeRecovery';
import type { NativeRecoverySnapshot, NativeRecoveryRow } from '../../shared/recovery';
import type { CompanionRuntime } from '../../shared/companion-runtime';

export function ResourcesPage({
  machine,
  quiet,
  onQuiet,
  busy,
  workers = [],
  work = [],
  onWork,
  memoryPolicy = 'protect',
  onMemoryPolicy,
  resources,
  recovery,
  onReconcile,
  runtimes,
  onRuntime,
}: {
  machine: MachineSnapshot;
  quiet: boolean;
  onQuiet: () => void;
  busy: string;
  workers?: NativeWorkerResources[];
  work?: WorkSummary[];
  onWork?: (id: string) => void;
  memoryPolicy?: Settings['memoryPressurePolicy'];
  onMemoryPolicy?: () => void;
  resources?: ResourceObservation;
  recovery?: NativeRecoverySnapshot;
  onReconcile?: (row: NativeRecoveryRow) => void;
  runtimes?: CompanionRuntime[];
  onRuntime?: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [order, setOrder] = useState<'memory' | 'cpu'>('memory');
  const processes =
    order === 'cpu' ? (machine.busiestProcesses ?? machine.processes) : machine.processes;
  const observedOwner = new Map(workers.flatMap((w) => w.pids.map((pid) => [pid, w] as const)));
  const active = work.filter((w) => w.activeRunId);
  return (
    <div className="page-stack">
      <NativeRecovery
        recovery={recovery}
        work={work}
        busy={busy}
        onReconcile={onReconcile}
        onWork={onWork}
      />
      <section className="panel resource-controls" aria-label="Memory pressure protection">
        <div>
          <span className="eyebrow">LAPTOP HEADROOM</span>
          <h2>
            {machine.memoryPressure?.state === 'warning' ||
            machine.memoryPressure?.state === 'critical'
              ? 'Memory pressure is high.'
              : 'Memory pressure protection'}
          </h2>
          <p>
            {machine.memoryPressure?.state === 'warning' ||
            machine.memoryPressure?.state === 'critical'
              ? `macOS reports ${machine.memoryPressure.state} memory pressure. ${memoryPolicy === 'observe' ? 'Observe-only mode allows new managed work.' : 'New managed launches wait while this signal is high.'}`
              : machine.memoryPressure?.state === 'normal'
                ? 'macOS reports normal memory pressure. The report is checked again before creating a native worker.'
                : 'Automatic memory pressure detection is unavailable here. Quiet mode can still pause new managed work.'}
          </p>
          <p className="source-note">
            {memoryPolicy === 'observe'
              ? 'Protection is off. Pressure remains visible.'
              : 'Protection is on for reported warning or critical pressure.'}{' '}
            Running work keeps its native controls. This is admission guidance, not a memory limit.
          </p>
        </div>
        <button
          className="button secondary"
          role="switch"
          aria-checked={memoryPolicy !== 'observe'}
          aria-label="Memory pressure protection"
          onClick={onMemoryPolicy}
          disabled={busy === 'headroom'}
        >
          {memoryPolicy === 'observe' ? 'Enable memory protection' : 'Use observe-only mode'}
        </button>
      </section>
      <div className="metrics-row">
        <div className="metric">
          <span>
            CPU in use <Cpu size={16} />
          </span>
          <strong>
            {machine.cpuPercent === null ? 'Sampling' : `${Math.round(machine.cpuPercent)}%`}
          </strong>
          <small>Across {machine.cores} logical cores · Live sample</small>
        </div>
        <div className="metric">
          <span>
            OS memory in use <HardDrive size={16} />
          </span>
          <strong>{gb(machine.totalMemory - machine.freeMemory)}</strong>
          <small>Of {gb(machine.totalMemory)} · Includes reclaimable cache</small>
        </div>
        <div className="metric">
          <span>
            Forge service memory <Activity size={16} />
          </span>
          <strong>{Math.round(machine.forgeRss / 1024 ** 2)} MB</strong>
          <small>Service RSS only; native workers are separate</small>
        </div>
      </div>
      <section className="resource-controls panel">
        <div>
          <h2>Managed work admission</h2>
          <p>
            Quiet mode pauses new Forge-managed work. Existing native sessions continue under their
            own controls.
          </p>
        </div>
        <button
          className={`button ${quiet ? 'primary' : 'secondary'}`}
          onClick={onQuiet}
          disabled={busy === 'quiet'}
        >
          {quiet ? <Play size={16} /> : <Pause size={16} />}
          {quiet ? 'Allow new managed work' : 'Pause new managed work'}
        </button>
      </section>
      <ResourceMap
        observation={resources}
        order={order}
        onOrder={setOrder}
        work={work}
        onWork={onWork}
        runtimes={runtimes}
        onRuntime={onRuntime}
      />
      <section className="panel" aria-label="Native worker ownership">
        <div className="section-heading">
          <div>
            <h2>What your native work is using</h2>
            <p>Work, native worker and observed child processes in one place.</p>
          </div>
        </div>
        {workers.length ? (
          <div className="native-worker-list">
            {workers.map((row) => {
              const current = work.find((w) => w.id === row.workId);
              const label = current?.title ?? 'Saved native work';
              const state = current?.stopRequestedAt
                ? 'Stopping'
                : row.state === 'not-observed'
                  ? 'Not in latest sample'
                  : row.state === 'identity-changed'
                    ? 'PID identity changed'
                    : row.state === 'unavailable'
                      ? 'Identity unavailable'
                      : row.state === 'ambiguous'
                        ? 'Conflicting saved identity'
                        : current?.activeRunId !== row.runId
                          ? 'Needs native reconciliation'
                          : `${row.pids.length} observed ${row.pids.length === 1 ? 'process' : 'processes'}`;
              return (
                <article className="native-worker-row" key={row.runId}>
                  <div className="native-worker-work">
                    <strong>{label}</strong>
                    <span>
                      {harnessName(row.harness)} · <span className="mono">PID {row.root.pid}</span>
                    </span>
                    <small>{state}</small>
                  </div>
                  <div className="native-worker-metrics">
                    <span>Observed memory</span>
                    <strong>
                      {row.rss === null
                        ? 'Unknown'
                        : row.rss >= 1024 ** 3
                          ? gb(row.rss)
                          : `${Math.round(row.rss / 1024 ** 2)} MB`}
                    </strong>
                    {row.cpuPercent !== null && <small>{row.cpuPercent.toFixed(1)}% CPU</small>}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => onWork?.(row.workId)}
                    aria-label={`Review native work: ${label}`}
                  >
                    Review work
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={Activity}
            title={
              active.length ? 'Preparing native worker ownership.' : 'No managed native workers.'
            }
          >
            {active.length
              ? 'Native startup is in progress. Open the work to review activity or request shutdown.'
              : 'Start native work to see its recorded process and observed memory here.'}
          </Empty>
        )}
        <p className="source-note native-worker-note">
          Matches use the recorded process start and OS user. A missing or changed PID does not
          confirm exit or release work. Stop a live managed attempt from its work panel; other
          sessions retain their native controls.
        </p>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>{order === 'cpu' ? 'Processes using CPU' : 'Processes using memory'}</h2>
            <p>Operating-system RSS. Shared memory can appear in multiple processes.</p>
          </div>
          <span className="live-label">
            <span className="status-dot" />
            {age(machine.sampledAt)}
          </span>
        </div>
        {processes.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Observed operating-system process table"
          >
            <table className="process-table">
              <thead>
                <tr>
                  <th scope="col">Process</th>
                  <th scope="col">PID</th>
                  <th scope="col" className="align-right">
                    Resident memory
                  </th>
                  <th scope="col" className="align-right">
                    CPU
                  </th>
                  <th scope="col">Control</th>
                </tr>
              </thead>
              <tbody>
                {(showAll ? processes : processes.slice(0, 10)).map((p) => (
                  <tr key={p.pid}>
                    <td>
                      <span className="process-name">
                        <Terminal size={15} />
                        {p.name}
                      </span>
                    </td>
                    <td className="mono muted">{p.pid}</td>
                    <td className="align-right mono">
                      {p.rss >= 1024 ** 3 ? gb(p.rss) : `${Math.round(p.rss / 1024 ** 2)} MB`}
                    </td>
                    <td className="align-right mono">{p.cpuPercent.toFixed(1)}%</td>
                    <td>
                      {observedOwner.has(p.pid) ? (
                        <button
                          className="text-button"
                          onClick={() => onWork?.(observedOwner.get(p.pid)!.workId)}
                        >
                          Review owning work
                        </button>
                      ) : (
                        <span className="observed-label">Observed only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Activity} title="Process inventory is unavailable here.">
            Machine totals remain available. Per-process collection currently uses the native macOS
            or Linux process interface.
          </Empty>
        )}
      </section>
      {processes.length > 10 && (
        <button
          className="text-button"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll
            ? `Show the ten ${order === 'cpu' ? 'busiest' : 'largest'} processes`
            : `Show all ${processes.length} observed processes`}
        </button>
      )}
      <p className="source-note">
        Command arguments and environment variables are excluded. Forge does not claim ownership of
        observed processes or offer a blanket kill action.
      </p>
    </div>
  );
}
