import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLinuxMemoryStalls,
  linuxPressureCgroups,
  readLinuxMemoryPressure,
} from '../server/linux-memory-pressure.js';
import { checkMemoryAdmission } from '../server/memory-pressure.js';
import { memoryPressureDescription } from '../shared/memory-pressure.js';

const psi = (some = 0, full = 0) =>
  `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=123\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=12\n`;
const mounts = '29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n';
const membership = '0::/user.slice/forge.scope\n';
const paths = [
  '/sys/fs/cgroup/user.slice/forge.scope',
  '/sys/fs/cgroup/user.slice',
  '/sys/fs/cgroup',
];
function fixture(
  options: {
    host?: string;
    groups?: string[];
    missing?: string;
    disabled?: string;
    moved?: boolean;
  } = {},
) {
  const reads: string[] = [];
  const files = new Map<string, string>([
    ['/proc/pressure/memory', options.host ?? psi()],
    ['/proc/self/cgroup', membership],
    ['/proc/self/mountinfo', mounts],
    ...paths.flatMap((path, i): [string, string][] => [
      [path + '/memory.pressure', options.groups?.[i] ?? psi()],
      [path + '/cgroup.pressure', path === options.disabled ? '0\n' : '1\n'],
    ]),
  ]);
  if (options.missing) files.delete(options.missing);
  return {
    reads,
    read: async (path: string) => {
      const repeated = reads.includes(path);
      reads.push(path);
      if (options.moved && path === '/proc/self/cgroup' && repeated) return '0::/another.scope\n';
      const value = files.get(path);
      if (value === undefined)
        throw Object.assign(new Error('Native file absent'), { code: 'ENOENT' });
      return value;
    },
  };
}

test('Linux PSI parses both kernel stall scopes and rejects partial, conflicting and unbounded samples', () => {
  assert.deepEqual(parseLinuxMemoryStalls(psi(3.2, 1.1)), { someAvg10: 3.2, fullAvg10: 1.1 });
  for (const value of [
    psi().split('\n')[0],
    psi() + psi(),
    psi(0, 1),
    psi(101),
    psi().replace('avg10=0.00', 'avg10=NaN'),
    psi().replace('avg60=0.00', 'avg60=-1'),
    psi().replace('total=123', 'total=-1'),
    'x'.repeat(4097),
  ])
    assert.equal(parseLinuxMemoryStalls(value), null);
});

test('cgroup discovery maps only one canonical v2 mount and includes visible ancestors', () => {
  assert.deepEqual(linuxPressureCgroups(membership, mounts), paths);
  assert.deepEqual(
    linuxPressureCgroups(
      '0::/delegate/forge.scope\n',
      mounts.replace(' / /sys/', ' /delegate /sys/'),
    ),
    ['/sys/fs/cgroup/forge.scope', '/sys/fs/cgroup'],
  );
  assert.deepEqual(linuxPressureCgroups('0::/\n', mounts), ['/sys/fs/cgroup']);
  assert.deepEqual(
    linuxPressureCgroups('0::/work\n', mounts.replace('/sys/fs/cgroup', '/sys/forge\\040groups')),
    ['/sys/forge groups/work', '/sys/forge groups'],
  );
  for (const [members, table] of [
    ['0::/../../escape\n', mounts],
    ['0::/x\n0::/y\n', mounts],
    ['2:memory:/legacy\n', mounts],
    [membership, mounts + mounts],
    [membership, mounts.replace(' / /sys/', ' /hidden /sys/')],
    ['0::/' + 'x/'.repeat(33) + 'x\n', mounts],
    [membership, 'x'.repeat(128 * 1024 + 1)],
  ])
    assert.equal(linuxPressureCgroups(members, table), null);
});

test('complete low native observations report normal without inventing a kernel warning code or exposing paths', async () => {
  const f = fixture();
  const result = await readLinuxMemoryPressure(f.read);
  assert.equal(result.state, 'normal');
  assert.equal(result.source, 'linux-psi');
  assert.equal(result.nativeValue, null);
  assert.equal(result.linux?.observedCgroups, 3);
  assert.equal(result.linux?.cgroupCoverage, 'complete');
  assert.equal(f.reads.filter((path) => path === '/proc/self/cgroup').length, 2);
  assert(!JSON.stringify(result).includes('/sys/'));
  assert.match(memoryPressureDescription(result), /below Forge admission thresholds/);
});

test('host or ancestor pressure independently holds new native admission at the documented boundaries', async () => {
  for (const [host, groups, expected] of [
    [psi(9.99, 0.99), [], 'normal'],
    [psi(10, 0), [], 'warning'],
    [psi(1, 1), [], 'warning'],
    [psi(10, 10), [], 'critical'],
    [psi(), [psi(), psi(15, 12), psi()], 'critical'],
  ] as const) {
    const result = await readLinuxMemoryPressure(fixture({ host, groups: [...groups] }).read);
    assert.equal(result.state, expected);
    if (expected === 'normal') checkMemoryAdmission({ quietMode: false, maxConcurrent: 1 }, result);
    else {
      assert.throws(
        () => checkMemoryAdmission({ quietMode: false, maxConcurrent: 1 }, result),
        /Linux memory stalls.*No native attempt was created/,
      );
      checkMemoryAdmission(
        { quietMode: false, maxConcurrent: 1, memoryPressurePolicy: 'observe' },
        result,
      );
    }
  }
});

test('partial or disabled cgroup coverage cannot fabricate normal; a known elevated host still protects admission', async () => {
  for (const options of [
    { missing: paths[1] + '/memory.pressure' },
    { disabled: paths[0] },
    { missing: '/proc/self/mountinfo' },
    { host: 'invalid' },
  ]) {
    const result = await readLinuxMemoryPressure(fixture(options).read);
    assert.equal(result.state, 'unknown');
    assert.equal(result.nativeValue, null);
  }
  const elevated = await readLinuxMemoryPressure(
    fixture({ host: psi(12, 2), missing: paths[1] + '/memory.pressure' }).read,
  );
  assert.equal(elevated.state, 'warning');
  assert.equal(elevated.linux?.cgroupCoverage, 'unavailable');
  const unavailable = await readLinuxMemoryPressure(async () => {
    throw new Error('Denied');
  });
  assert.equal(unavailable.state, 'unknown');
  assert.equal(unavailable.source, 'unavailable');
});

test('membership changes discard old cgroup evidence and older kernels without the tracking toggle remain readable', async () => {
  const moved = await readLinuxMemoryPressure(fixture({ moved: true, groups: [psi(40, 20)] }).read);
  assert.equal(moved.state, 'unknown');
  assert.equal(moved.linux?.cgroup, null);
  assert.equal(moved.linux?.observedCgroups, 0);
  assert.equal(moved.linux?.cgroupCoverage, 'unavailable');
  const older = await readLinuxMemoryPressure(
    fixture({ missing: paths[0] + '/cgroup.pressure' }).read,
  );
  assert.equal(older.state, 'normal');
});
