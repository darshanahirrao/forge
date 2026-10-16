import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import type { MachineSnapshot } from '../shared/types.js';
const exec = promisify(execFile);
export function parseProcesses(output: string): MachineSnapshot['processes'] {
  return output
    .split('\n')
    .flatMap((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(.+)$/);
      if (!m) return [];
      return [
        {
          pid: Number(m[1]),
          parentPid: Number(m[2]),
          rss: Number(m[3]) * 1024,
          cpuPercent: Number(m[4].replace(',', '.')),
          name: basename(m[5]).slice(0, 100),
        },
      ];
    })
    .sort((a, b) => b.rss - a.rss)
    .slice(0, 30);
}
export class MachineMonitor {
  private previous = this.cpu();
  private cached: MachineSnapshot | null = null;
  private pending: Promise<MachineSnapshot> | null = null;
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
    let processes: MachineSnapshot['processes'] = [];
    let processCoverage: MachineSnapshot['processCoverage'] = 'unavailable';
    if (process.platform !== 'win32') {
      try {
        // comm intentionally excludes command arguments, tokens, and environment variables.
        const result = await exec('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], {
          timeout: 2500,
          maxBuffer: 2 * 1024 * 1024,
        });
        processes = parseProcesses(result.stdout);
        processCoverage = 'available';
      } catch {
        /* Platform coverage stays explicit. */
      }
    }
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
