import os from 'node:os';
import type {
  Account,
  MachineSnapshot,
  MemoryPressure,
  Run,
  CompanionWorkerResources,
  NativeWorkerResources,
} from '../shared/types.js';
import {
  attributeWorkers,
  attributeNativeRoots,
  processTable,
  type ProcessObservation,
} from './processes.js';
import { readMemoryPressure } from './memory-pressure.js';
import { resourceMap } from './resource-map.js';
export function processSummary(
  rows: ProcessObservation[],
  order: 'memory' | 'cpu' = 'memory',
): MachineSnapshot['processes'] {
  return rows
    .map(({ uid: _uid, startedAt: _start, ...p }) => p)
    .sort(
      (a, b) => (order === 'cpu' ? b.cpuPercent - a.cpuPercent : b.rss - a.rss) || a.pid - b.pid,
    )
    .slice(0, 30);
}
export class MachineMonitor {
  constructor(
    private pressureReader: () => MemoryPressure | Promise<MemoryPressure> = readMemoryPressure,
    private processReader: () => Promise<ProcessObservation[] | null> = processTable,
  ) {}
  private previous = this.cpu();
  private cached: MachineSnapshot | null = null;
  private pending: Promise<MachineSnapshot> | null = null;
  private observed: ProcessObservation[] | null = null;
  async freshPressure() {
    let result: MemoryPressure;
    try {
      result = await this.pressureReader();
    } catch {
      result = {
        state: 'unknown',
        source: 'unavailable',
        nativeValue: null,
        checkedAt: new Date().toISOString(),
      };
    }
    if (this.cached) this.cached.memoryPressure = result;
    return result;
  }
  async workers(runs: Run[], accounts: Account[]) {
    const sample = await this.sample();
    return attributeWorkers(
      runs,
      new Map(accounts.map((a) => [a.id, a.harness])),
      this.observed,
      sample.sampledAt,
    );
  }
  async observe(
    runs: Run[],
    accounts: Account[],
    companions: Pick<
      CompanionWorkerResources,
      'runtimeId' | 'launchId' | 'accountId' | 'harness' | 'root'
    >[] = [],
  ) {
    const machine = await this.sample();
    // Capture table reference before any subsequent asynchronous sample. A response
    // never mixes process epochs across its machine, workers and resource map.
    const harnesses = new Map(accounts.map((account) => [account.id, account.harness]));
    const roots = [
      ...runs
        .filter(
          (run) =>
            run.nativeWorker &&
            (!run.exitConfirmed || ['starting', 'running'].includes(run.status)),
        )
        .map((run) => ({
          kind: 'work' as const,
          runId: run.id,
          workId: run.workId,
          accountId: run.accountId,
          harness: run.harness ?? harnesses.get(run.accountId)!,
          root: run.nativeWorker!,
        })),
      ...companions.map((companion) => ({ kind: 'companion' as const, ...companion })),
    ];
    const observed = attributeNativeRoots(roots, this.observed, machine.sampledAt);
    const nativeWorkers: NativeWorkerResources[] = observed
      .filter((root) => root.kind === 'work')
      .map(({ kind: _kind, ...root }) => root);
    const companionWorkers: CompanionWorkerResources[] = observed
      .filter((root) => root.kind === 'companion')
      .map(({ kind: _kind, ...root }) => root);
    return {
      machine,
      nativeWorkers,
      companionWorkers,
      resources: resourceMap(
        this.observed,
        nativeWorkers,
        machine.sampledAt,
        {
          pid: process.pid,
          uid: process.getuid?.() ?? null,
        },
        companionWorkers,
      ),
    };
  }
  private cpu() {
    return os.cpus().reduce(
      (v, c) => ({
        idle: v.idle + c.times.idle,
        total: v.total + Object.values(c.times).reduce((a, b) => a + b, 0),
      }),
      { idle: 0, total: 0 },
    );
  }
  async sample(): Promise<MachineSnapshot> {
    if (this.cached && Date.now() - Date.parse(this.cached.sampledAt) < 5000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.measure();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  private async measure(): Promise<MachineSnapshot> {
    const current = this.cpu();
    const elapsed = current.total - this.previous.total;
    const cpuPercent =
      elapsed > 0
        ? Math.max(0, Math.min(100, (1 - (current.idle - this.previous.idle) / elapsed) * 100))
        : null;
    this.previous = current;
    const [observed, memoryPressure] = await Promise.all([
      this.processReader().catch(() => null),
      this.freshPressure(),
    ]);
    this.observed =
      observed && new Set(observed.map((row) => row.pid)).size === observed.length
        ? observed
        : null;
    const processes = processSummary(this.observed ?? []);
    const processCoverage = this.observed ? 'available' : 'unavailable';
    this.cached = {
      memoryPressure,
      platform: `${os.type()} ${os.release()}`,
      cores: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpuPercent,
      loadAverage: os.loadavg(),
      forgeRss: process.memoryUsage().rss,
      uptimeSeconds: process.uptime(),
      sampledAt: new Date().toISOString(),
      processes,
      busiestProcesses: processSummary(this.observed ?? [], 'cpu'),
      processCoverage,
    };
    return this.cached;
  }
}
