import type { ResourceObservation } from '../../shared/resources';
import type { WorkSummary } from '../../shared/types';
import { age, gb } from '../lib/format';
import { Empty } from './primitives';
import { Activity } from 'lucide-react';

const memory = (value: number | null) =>
  value === null
    ? 'Unknown'
    : value >= 1024 ** 3
      ? gb(value)
      : `${Math.round(value / 1024 ** 2)} MB`;
const states = {
  'not-observed': 'Not in latest sample',
  'identity-changed': 'Identity changed',
  ambiguous: 'Conflicting saved identity',
  unavailable: 'Measurement unavailable',
  observed: '',
};

export function ResourceMap({
  observation,
  order,
  onOrder,
  work,
  onWork,
}: {
  observation?: ResourceObservation;
  order: 'memory' | 'cpu';
  onOrder: (order: 'memory' | 'cpu') => void;
  work: WorkSummary[];
  onWork?: (id: string) => void;
}) {
  const download = () => {
    const blob = new Blob([JSON.stringify(observation, null, 2) + '\n'], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'forge-resource-observation.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const groups = [...(observation?.groups ?? [])].sort(
    (a, b) =>
      (order === 'cpu'
        ? (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)
        : (b.rss ?? -1) - (a.rss ?? -1)) || a.id.localeCompare(b.id),
  );
  return (
    <section className="panel" aria-label="Workspace resource map">
      <div className="section-heading">
        <div>
          <h2>Where resources are going</h2>
          <p>Forge, native work and recognizable apps in one OS sample.</p>
        </div>
        <label className="resource-order">
          Sort resource use
          <select
            value={order}
            onChange={(event) => onOrder(event.target.value as 'memory' | 'cpu')}
          >
            <option value="memory">Memory</option>
            <option value="cpu">CPU</option>
          </select>
        </label>
      </div>
      {!observation || observation.coverage === 'unavailable' ? (
        <Empty icon={Activity} title="Resource grouping is unavailable.">
          The OS process sample could not be read. Machine totals and managed work controls remain
          available.
        </Empty>
      ) : (
        <>
          <div
            className="table-scroll"
            role="region"
            aria-label="Grouped resource use"
            tabIndex={0}
          >
            <table className="process-table resource-map-table">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col" className="align-right">
                    Processes
                  </th>
                  <th scope="col" className="align-right">
                    Resident memory
                  </th>
                  <th scope="col" className="align-right">
                    CPU
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const current = work.find((item) => item.id === group.workId);
                  return (
                    <tr key={group.id}>
                      <td>
                        <div className="resource-group-label">
                          {group.kind === 'managed' ? (
                            <button
                              className="text-button"
                              onClick={() => onWork?.(group.workId!)}
                              aria-label={`Open resource work: ${current?.title ?? group.label}`}
                            >
                              {current?.title ?? group.label}
                            </button>
                          ) : (
                            <strong>{group.label}</strong>
                          )}
                          <small>
                            {states[group.state] ||
                              (group.kind === 'native-app'
                                ? 'Name match; native controls'
                                : group.kind === 'host'
                                  ? 'Service and observed helpers'
                                  : group.kind === 'managed'
                                    ? 'Review work for native controls'
                                    : 'Includes shared and unrecognized runtimes')}
                          </small>
                        </div>
                      </td>
                      <td className="align-right mono" data-label="Processes">
                        {group.state === 'observed' ? group.processCount : 'Unknown'}
                      </td>
                      <td className="align-right mono" data-label="Resident memory">
                        {memory(group.rss)}
                      </td>
                      <td className="align-right mono" data-label="CPU">
                        {group.cpuPercent === null ? 'Unknown' : `${group.cpuPercent.toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="source-note resource-map-summary">
            {observation.processCount} OS-visible processes, each counted in one group. Sampled{' '}
            {age(observation.sampledAt)}.
            {observation.unresolvedWorkers > 0 &&
              ` ${observation.unresolvedWorkers} saved native worker ${observation.unresolvedWorkers === 1 ? 'needs' : 'identities need'} reconciliation.`}
          </p>
        </>
      )}
      <details className="resource-coverage">
        <summary>Measurement coverage and diagnostics</summary>
        <p className="source-note">
          App groups use exact executable names and observed ancestry for the current OS user. Names
          identify candidates, not native accounts or control authority. Generic node, Python and
          shared services can remain in Other. Detached tools and a browser embedded in another app
          cannot be charged to Forge automatically.
        </p>
        <p className="source-note">
          RSS can include the same shared pages in different processes. CPU is the native per-core
          process scale and can exceed 100%; the machine total above is normalized across cores.
          Samples are shared and cached for five seconds. Arguments and environment values are never
          collected. The download contains group IDs, root PIDs and measurements; it is a private
          diagnostic snapshot.
        </p>
        <button className="text-button" onClick={download} disabled={!observation}>
          Download resource snapshot
        </button>
      </details>
    </section>
  );
}
