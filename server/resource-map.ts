import type { NativeWorkerResources } from '../shared/types.js';
import type { ResourceGroup, ResourceObservation } from '../shared/resources.js';
import type { ProcessObservation } from './processes.js';

// Exact executable basenames only. Generic node/python/Electron processes have no
// reliable harness identity and remain in Other unless native ancestry links them.
const nativeNames = new Map([
  ['codex', ['codex', 'Codex']],
  ['codex helper', ['codex', 'Codex']],
  ['codex helper (renderer)', ['codex', 'Codex']],
  ['codex helper (gpu)', ['codex', 'Codex']],
  ['codex helper (plugin)', ['codex', 'Codex']],
  ['claude', ['claude', 'Claude']],
  ['claude helper', ['claude', 'Claude']],
  ['claude helper (renderer)', ['claude', 'Claude']],
  ['claude helper (gpu)', ['claude', 'Claude']],
  ['claude helper (plugin)', ['claude', 'Claude']],
  ['opencode', ['opencode', 'OpenCode']],
  ['hermes', ['hermes', 'Hermes']],
  ['openclaw', ['openclaw', 'OpenClaw']],
  ['t3', ['t3', 'T3 Code']],
  ['t3 code', ['t3', 'T3 Code']],
]);

/** A disjoint partition for observation, never a process-control capability. */
export function resourceMap(
  rows: ProcessObservation[] | null,
  workers: NativeWorkerResources[],
  sampledAt: string,
  host: { pid: number; uid: number | null },
): ResourceObservation {
  const valid = rows && new Set(rows.map((row) => row.pid)).size === rows.length;
  const groups: ResourceGroup[] = [];
  const result: ResourceObservation = {
    contract: 'forge.resource-observation/1',
    sampledAt,
    coverage: valid ? 'observed' : 'unavailable',
    processCount: valid ? rows.length : 0,
    rss: null,
    cpuPercent: null,
    unresolvedWorkers: workers.filter((worker) => worker.state !== 'live').length,
    groups,
  };
  const table = new Map(valid ? rows.map((row) => [row.pid, row]) : []);
  const children = new Map<number, number[]>();
  for (const row of table.values()) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row.pid);
    children.set(row.parentPid, siblings);
  }
  const assigned = new Set<number>();
  const make = (
    value: Pick<ResourceGroup, 'id' | 'kind' | 'label' | 'state'> & Partial<ResourceGroup>,
    roots: number[],
    pids: number[],
  ) => {
    const selected = pids.flatMap((pid) => {
      const row = table.get(pid);
      if (!row || assigned.has(pid)) return [];
      assigned.add(pid);
      return [row];
    });
    groups.push({
      ...value,
      rootPids: roots.slice(0, 32),
      rootCount: roots.length,
      processCount: selected.length,
      rss: value.state === 'observed' ? selected.reduce((sum, row) => sum + row.rss, 0) : null,
      cpuPercent:
        value.state === 'observed' ? selected.reduce((sum, row) => sum + row.cpuPercent, 0) : null,
    });
  };
  // Recorded managed roots, including unresolved roots, are boundaries. An old
  // receipt's recycled PID must not become part of the host's reported overhead.
  const managedRoots = new Set(workers.map((worker) => worker.root.pid));
  const walk = (roots: number[], boundaries: Set<number>) => {
    const seen = new Set<number>();
    const queue = [...roots];
    for (let index = 0; index < queue.length; index++) {
      const pid = queue[index];
      if (seen.has(pid) || !table.has(pid) || assigned.has(pid)) continue;
      seen.add(pid);
      for (const child of children.get(pid) ?? []) if (!boundaries.has(child)) queue.push(child);
    }
    return [...seen];
  };
  const hostRow = table.get(host.pid);
  make(
    {
      id: 'forge-host',
      kind: 'host',
      label: 'Forge host and helpers',
      state:
        !valid || host.uid === null
          ? 'unavailable'
          : !hostRow
            ? 'not-observed'
            : hostRow.uid !== host.uid || managedRoots.has(host.pid)
              ? 'identity-changed'
              : 'observed',
    },
    [host.pid],
    hostRow && hostRow.uid === host.uid && !managedRoots.has(host.pid)
      ? walk([host.pid], managedRoots)
      : [],
  );
  for (const worker of workers) {
    // The coordinator's verified run identity remains separate from this view.
    // A malformed overlapping receipt cannot inflate the partition totals.
    const overlap = worker.pids.some((pid) => assigned.has(pid));
    make(
      {
        id: `run:${worker.runId}`,
        kind: 'managed',
        label: 'Managed native work',
        workId: worker.workId,
        runId: worker.runId,
        harness: worker.harness,
        state: !valid
          ? 'unavailable'
          : overlap
            ? 'ambiguous'
            : worker.state === 'live'
              ? 'observed'
              : worker.state === 'exited'
                ? 'not-observed'
                : worker.state,
      },
      [worker.root.pid],
      valid && !overlap && worker.state === 'live' ? worker.pids : [],
    );
    if (overlap && worker.state === 'live') result.unresolvedWorkers++;
  }
  if (valid) {
    const roots = [...table.values()].flatMap((row) => {
      const native = nativeNames.get(row.name.toLowerCase());
      return native && row.uid === host.uid && !assigned.has(row.pid)
        ? [{ pid: row.pid, key: native[0], label: native[1] }]
        : [];
    });
    const boundaries = new Set([host.pid, ...managedRoots, ...roots.map((root) => root.pid)]);
    for (const key of new Set(roots.map((root) => root.key))) {
      const matches = roots.filter((root) => root.key === key);
      make(
        {
          id: `native-app:${key}`,
          kind: 'native-app',
          label: matches[0].label,
          state: 'observed',
          harness: key,
        },
        matches.map((root) => root.pid),
        matches.flatMap((root) => walk([root.pid], boundaries)),
      );
    }
    make(
      { id: 'other', kind: 'other', label: 'Other observed processes', state: 'observed' },
      [],
      [...table.keys()].filter((pid) => !assigned.has(pid)),
    );
    result.rss = groups.reduce((sum, group) => sum + (group.rss ?? 0), 0);
    result.cpuPercent = groups.reduce((sum, group) => sum + (group.cpuPercent ?? 0), 0);
  }
  return result;
}
