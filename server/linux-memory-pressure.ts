import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import type { MemoryPressure, MemoryStalls } from '../shared/types.js';
import { linuxPressureThresholds as thresholds } from '../shared/memory-pressure.js';

type PressureReader = (path: string, limit: number) => Promise<string>;
const membershipPath = '/proc/self/cgroup';
const mountsPath = '/proc/self/mountinfo';
const pressureLimit = 4096;
const discoveryLimit = 128 * 1024;
const maximumCgroups = 32;

/** Fixed-size reads also bound procfs files whose stat size is zero. No writes or watchers. */
async function readNativeFile(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Not a native pressure file.');
    const data = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < data.length) {
      const result = await file.read(data, length, data.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error('Native pressure file exceeds the read bound.');
    return data.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

/** Linux documents two percentage lines, with 10/60/300 second trends and a total. */
export function parseLinuxMemoryStalls(output: string): MemoryStalls | null {
  if (Buffer.byteLength(output) > pressureLimit) return null;
  const rows = new Map<string, number[]>();
  for (const line of output.trim().split('\n')) {
    const match =
      /^(some|full)\s+avg10=(\d+(?:\.\d+)?)\s+avg60=(\d+(?:\.\d+)?)\s+avg300=(\d+(?:\.\d+)?)\s+total=(\d+)\s*$/.exec(
        line,
      );
    if (!match || rows.has(match[1])) return null;
    const averages = match.slice(2, 5).map(Number);
    if (averages.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) return null;
    rows.set(match[1], averages);
  }
  const some = rows.get('some'),
    full = rows.get('full');
  if (!some || !full || full.some((value, index) => value > some[index])) return null;
  return { someAvg10: some[0], fullAvg10: full[0] };
}

function nativePath(value: string): string | null {
  // mountinfo escapes whitespace and backslashes using these four octal sequences.
  const path = value.replace(/\\(040|011|012|134)/g, (_, code: string) =>
    String.fromCharCode(Number.parseInt(code, 8)),
  );
  return path.startsWith('/') &&
    path.length <= 4096 &&
    !/[\x00-\x1f\x7f\\]/.test(path) &&
    posix.normalize(path) === path &&
    !path.split('/').some((part) => part === '.' || part === '..')
    ? path
    : null;
}

/** Resolve only an unambiguous visible cgroup v2 mount; never guess a container's hidden path. */
export function linuxPressureCgroups(membership: string, mounts: string): string[] | null {
  if (Buffer.byteLength(membership) > discoveryLimit || Buffer.byteLength(mounts) > discoveryLimit)
    return null;
  const entries = membership
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('0::'));
  if (entries.length !== 1) return null;
  const group = nativePath(entries[0].slice(3));
  if (!group) return null;
  const candidates: { root: string; mount: string }[] = [];
  for (const line of mounts.trim().split('\n')) {
    const parts = line.split(' - ');
    if (parts.length !== 2 || parts[1].split(' ')[0] !== 'cgroup2') continue;
    const fields = parts[0].split(' ');
    const root = nativePath(fields[3] ?? ''),
      mount = nativePath(fields[4] ?? '');
    if (root && mount && (group === root || group.startsWith(root === '/' ? '/' : root + '/')))
      candidates.push({ root, mount });
  }
  if (candidates.length !== 1) return null;
  const { root, mount } = candidates[0];
  let directory = posix.join(mount, group.slice(root.length));
  const paths: string[] = [];
  for (;;) {
    paths.push(directory);
    if (paths.length > maximumCgroups) return null;
    if (directory === mount) return paths;
    directory = posix.dirname(directory);
    if (directory !== mount && !directory.startsWith(mount === '/' ? '/' : mount + '/'))
      return null;
  }
}

function severity(value: MemoryStalls | null) {
  if (!value) return 0;
  return value.fullAvg10 >= thresholds.criticalFullAvg10
    ? 2
    : value.fullAvg10 >= thresholds.warningFullAvg10 ||
        value.someAvg10 >= thresholds.warningSomeAvg10
      ? 1
      : 0;
}
function mergeStalls(left: MemoryStalls | null, right: MemoryStalls): MemoryStalls {
  return {
    someAvg10: Math.max(left?.someAvg10 ?? 0, right.someAvg10),
    fullAvg10: Math.max(left?.fullAvg10 ?? 0, right.fullAvg10),
  };
}

/** Read current host and visible ancestor contention. A partial low sample is unknown, not healthy. */
export async function readLinuxMemoryPressure(
  read: PressureReader = readNativeFile,
): Promise<MemoryPressure> {
  const deadline = Date.now() + 1000;
  const boundedRead: PressureReader = async (path, limit) => {
    if (Date.now() >= deadline) throw new Error('Native pressure read expired.');
    const value = await read(path, limit);
    if (Date.now() >= deadline || Buffer.byteLength(value) > limit)
      throw new Error('Native pressure read exceeded its bound.');
    return value;
  };
  const [host, discovered] = await Promise.all([
    boundedRead('/proc/pressure/memory', pressureLimit)
      .then(parseLinuxMemoryStalls)
      .catch(() => null),
    Promise.all([
      boundedRead(membershipPath, discoveryLimit),
      boundedRead(mountsPath, discoveryLimit),
    ]).catch(() => null),
  ]);
  const paths = discovered && linuxPressureCgroups(discovered[0], discovered[1]);
  let complete = paths !== null,
    observedCgroups = 0;
  let cgroup: MemoryStalls | null = null;
  for (const path of paths ?? []) {
    try {
      // Newer kernels can disable tracking while retaining the pressure interface.
      try {
        if ((await boundedRead(path + '/cgroup.pressure', 32)).trim() !== '1')
          throw new Error('Cgroup pressure tracking is disabled.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const value = parseLinuxMemoryStalls(
        await boundedRead(path + '/memory.pressure', pressureLimit),
      );
      if (!value) throw new Error('Invalid native cgroup pressure.');
      observedCgroups++;
      cgroup = mergeStalls(cgroup, value);
    } catch {
      complete = false;
    }
  }
  if (discovered) {
    try {
      const after = await Promise.all([
        boundedRead(membershipPath, discoveryLimit),
        boundedRead(mountsPath, discoveryLimit),
      ]);
      if (after[0] !== discovered[0] || after[1] !== discovered[1]) {
        complete = false;
        cgroup = null;
        observedCgroups = 0;
      }
    } catch {
      complete = false;
      cgroup = null;
      observedCgroups = 0;
    }
  }
  const elevated = Math.max(severity(host), severity(cgroup));
  return {
    state:
      elevated === 2
        ? 'critical'
        : elevated === 1
          ? 'warning'
          : host && complete
            ? 'normal'
            : 'unknown',
    source: host || cgroup ? 'linux-psi' : 'unavailable',
    nativeValue: null,
    checkedAt: new Date().toISOString(),
    linux: {
      interpretation: 'forge-linux-psi/1',
      host,
      cgroup,
      cgroupCoverage: complete ? 'complete' : 'unavailable',
      observedCgroups,
    },
  };
}
