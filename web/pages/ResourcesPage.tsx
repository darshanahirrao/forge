import { type MachineSnapshot } from '../../shared/types';
import { Cpu, HardDrive, Activity, Play, Pause, Terminal } from 'lucide-react';
import { gb, age } from '../lib/format';
import { Empty } from '../components/primitives';

export function ResourcesPage({
  machine,
  quiet,
  onQuiet,
  busy,
}: {
  machine: MachineSnapshot;
  quiet: boolean;
  onQuiet: () => void;
  busy: string;
}) {
  return (
    <div className="page-stack">
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
          <h2>Leave space for your next thought.</h2>
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
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Processes using memory</h2>
            <p>Operating-system RSS. Shared memory can appear in multiple processes.</p>
          </div>
          <span className="live-label">
            <span className="status-dot" />
            {age(machine.sampledAt)}
          </span>
        </div>
        {machine.processes.length ? (
          <div className="table-scroll">
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
                {machine.processes.map((p) => (
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
                      <span className="observed-label">Observed only</span>
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
      <p className="source-note">
        Command arguments and environment variables are excluded. Forge does not claim ownership of
        observed processes or offer a blanket kill action.
      </p>
    </div>
  );
}
