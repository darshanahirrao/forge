import os from 'node:os';
import type { Account, MachineSnapshot, Run } from '../shared/types.js';
import { attributeWorkers, processTable, type ProcessObservation } from './processes.js';
export function processSummary(rows: ProcessObservation[]): MachineSnapshot['processes'] {
  return rows
    .map(({ uid: _uid, startedAt: _start, ...p }) => p)
    .sort((a, b) => b.rss - a.rss)
    .slice(0, 30);
}
export class MachineMonitor {
  private previous = this.cpu();
  private cached: MachineSnapshot | null = null;
  private pending: Promise<MachineSnapshot> | null = null;
  private observed: ProcessObservation[] | null = null;
  async workers(runs: Run[], accounts: Account[]) {
    const sample = await this.sample();
    return attributeWorkers(
      runs,
      new Map(accounts.map((a) => [a.id, a.harness])),
      this.observed,
      sample.sampledAt,
    );
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
    this.observed = await processTable();
    const processes = processSummary(this.observed ?? []);
    const processCoverage = this.observed ? 'available' : 'unavailable';
    this.cached = {
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
      processCoverage,
    };
    return this.cached;
  }
}
