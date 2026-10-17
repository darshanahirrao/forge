import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import type { NativeWorkerIdentity, NativeWorkerResources, Run, Harness } from '../shared/types.js';
import { assert } from './errors.js';
const exec = promisify(execFile);

export interface ProcessObservation {
  pid: number;
  parentPid: number;
  uid: number;
  startedAt: string;
  name: string;
  rss: number;
  cpuPercent: number;
}
/** Native comm only. Arguments and environment values never enter this inventory. */
export function parseProcessTable(output: string): ProcessObservation[] {
  return output
    .split('\n')
    .flatMap((line) => {
      const m = line
        .trim()
        .match(
          /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+([\d.,]+)\s+(.+)$/,
        );
      if (!m) return [];
      return [
        {
          pid: Number(m[1]),
          parentPid: Number(m[2]),
          uid: Number(m[3]),
          startedAt: m[4].replace(/\s+/g, ' '),
          rss: Number(m[5]) * 1024,
          cpuPercent: Number(m[6].replace(',', '.')),
          name: basename(m[7]).slice(0, 100),
        },
      ];
    })
    .filter(
      (p) =>
        p.pid > 0 &&
        Number.isSafeInteger(p.pid) &&
        Number.isFinite(p.rss) &&
        Number.isFinite(p.cpuPercent),
    );
}
export async function processTable(pid?: number): Promise<ProcessObservation[] | null> {
  if (process.platform === 'win32') return null;
  try {
    const result = await exec(
      'ps',
      [...(pid ? ['-p', String(pid)] : ['-ax']), '-o', 'pid=,ppid=,uid=,lstart=,rss=,%cpu=,comm='],
      {
        timeout: 2500,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          LC_ALL: 'C',
          LANG: 'C',
          TZ: 'UTC',
        },
      },
    );
    const rows = parseProcessTable(result.stdout);
    if (new Set(rows.map((p) => p.pid)).size !== rows.length) return null;
    return rows;
  } catch {
    return null;
  }
}
export async function captureWorker(
  pid: number,
): Promise<Pick<NativeWorkerIdentity, 'uid' | 'startedAt'>> {
  const rows = await processTable(pid);
  if (rows === null) return { uid: null, startedAt: null };
  const row = rows.find((row) => row.pid === pid);
  assert(
    rows.length === 1 &&
      row &&
      row.parentPid === process.pid &&
      (!process.getuid || row.uid === process.getuid()),
    409,
    'Native worker ownership changed before task input. No replacement process was adopted.',
  );
  return { uid: row.uid, startedAt: row.startedAt };
}
/** Observation only. Never signal a process, grant a native action or clear an exit receipt from a PID. */
export function attributeWorkers(
  runs: Run[],
  harnesses: Map<string, Harness>,
  rows: ProcessObservation[] | null,
  sampledAt: string,
): NativeWorkerResources[] {
  const table =
    rows && new Set(rows.map((p) => p.pid)).size === rows.length
      ? new Map(rows.map((p) => [p.pid, p]))
      : null;
  const boundaries = new Set(
    runs.flatMap((run) => {
      const root = run.nativeWorker;
      const current = root && table?.get(root.pid);
      return root && current && current.uid === root.uid && current.startedAt === root.startedAt
        ? [root.pid]
        : [];
    }),
  );
  return runs
    .filter(
      (run) =>
        run.nativeWorker && (!run.exitConfirmed || ['starting', 'running'].includes(run.status)),
    )
    .map((run): NativeWorkerResources => {
      const root = run.nativeWorker!;
      const base: NativeWorkerResources = {
        runId: run.id,
        workId: run.workId,
        accountId: run.accountId,
        harness: run.harness ?? harnesses.get(run.accountId)!,
        root,
        state: 'unavailable',
        pids: [],
        rss: null,
        cpuPercent: null,
        sampledAt,
      };
      if (!table || !root.startedAt || root.uid === null) return base;
      const current = table.get(root.pid);
      if (!current) return { ...base, state: 'not-observed' };
      if (current.uid !== root.uid || current.startedAt !== root.startedAt)
        return { ...base, state: 'identity-changed' };
      const owned = new Set([root.pid]);
      // OS parentage is an observed tree, not fencing of detached tools or external effects.
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of table.values())
          if (
            !owned.has(p.pid) &&
            !boundaries.has(p.pid) &&
            p.pid !== process.pid &&
            owned.has(p.parentPid)
          ) {
            owned.add(p.pid);
            changed = true;
          }
      }
      const observed = [...owned].map((pid) => table.get(pid)!);
      return {
        ...base,
        state: 'live',
        pids: [...owned],
        rss: observed.reduce((sum, p) => sum + p.rss, 0),
        cpuPercent: observed.reduce((sum, p) => sum + p.cpuPercent, 0),
      };
    })
    .filter((row) => row.harness);
}
