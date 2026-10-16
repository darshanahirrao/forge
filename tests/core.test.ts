import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { parseProcesses } from '../server/machine.js';
import { normalizeQuotas } from '../server/adapters/accounts.js';
import {
  loopbackEndpoint,
  normalizeCcusage,
  normalizeDeckSessions,
} from '../server/adapters/sources.js';
import type { Account, Approval, Run, Work } from '../shared/types.js';

const account: Account = {
  id: 'account',
  label: 'Test',
  harness: 'codex',
  nativeHome: '',
  billingMode: 'native',
  state: 'configured',
  identity: null,
  identityKey: null,
  plan: null,
  checkedAt: null,
  error: null,
  quotas: [],
  createdAt: new Date().toISOString(),
};
const work: Work = {
  id: 'work',
  title: 'Test',
  project: 'Test',
  cwd: '',
  goal: 'A fixture',
  acceptance: '',
  context: '',
  harness: 'codex',
  accountId: account.id,
  status: 'ready',
  priority: 'normal',
  generation: 1,
  revision: 0,
  nativeSessionId: null,
  activeRunId: 'run',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test('work and receipts roll back together, and survive reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-store-'));
  const filename = join(directory, 'test.sqlite');
  let store = new Store(filename);
  try {
    store.put('work', work.id, work);
    assert.throws(() =>
      store.transaction(() => {
        store.updateWork(work.id, { title: 'Uncommitted' });
        store.event(work.id, 'test', 'Uncommitted receipt');
        throw new Error('fault');
      }),
    );
    assert.equal(store.work(work.id).title, 'Test');
    assert.equal(store.all('events').length, 0);
    store.transaction(() => {
      store.updateWork(work.id, { context: 'Durable context' });
      store.event(work.id, 'checkpoint', 'Durable receipt');
    });
    store.close();
    store = new Store(filename);
    assert.equal(store.work(work.id).context, 'Durable context');
    assert.equal(store.all('events').length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('restart invalidates pending approvals and never replays a running attempt', () => {
  const store = new Store(':memory:');
  try {
    store.put('work', work.id, work);
    store.put<Run>('runs', 'run', {
      id: 'run',
      workId: work.id,
      accountId: account.id,
      generation: 1,
      nativeSessionId: 'native',
      nativeTurnId: 'turn',
      status: 'running',
      startedAt: work.createdAt,
      endedAt: null,
    });
    store.put('approvals', 'approval', { id: 'approval', runId: 'run', status: 'pending' });
    store.recoverInterruptedRuns();
    assert.equal(store.work(work.id).status, 'interrupted');
    assert.equal(store.work(work.id).activeRunId, null);
    assert.equal(store.get<Approval>('approvals', 'approval')?.status, 'invalidated');
    assert.equal(store.get<Run>('runs', 'run')?.status, 'interrupted');
    store.recoverInterruptedRuns();
    assert.equal(store.all('events').length, 1);
  } finally {
    store.close();
  }
});
test('SQLite ownership prevents a second service from recovering an active workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-owner-'));
  const filename = join(directory, 'test.sqlite');
  const owner = new Store(filename);
  try {
    assert.throws(() => new Store(filename), /locked|busy/i);
  } finally {
    owner.close();
  }
  const successor = new Store(filename);
  successor.close();
  await rm(directory, { recursive: true, force: true });
});
test('native quota buckets prefer the multi-bucket view without double counting the legacy view', () => {
  const bucket = { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 } };
  const result = normalizeQuotas(
    {
      accountId: 'same-native-account',
      rateLimits: bucket,
      rateLimitsByLimitId: { codex: bucket },
    },
    'local-slot',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].usedPercent, 25);
  assert.equal(result[0].scope, 'same-native-account:codex:primary');
  assert.equal(normalizeQuotas(null, 'unknown').length, 0);
});
test('ccusage estimates retain unknown pricing and use stable daily snapshot keys', () => {
  const source = {
    daily: [
      {
        date: '2026-10-16',
        inputTokens: 10,
        outputTokens: 5,
        totalCost: 0,
        unpricedModels: ['new-model'],
      },
    ],
  };
  const result = normalizeCcusage(source);
  assert.equal(result[0].estimatedUsd, null);
  assert.equal(result[0].key, normalizeCcusage(source)[0].key);
  assert.equal(result[0].accountId, null);
});
test('native session inventory retains native state without claiming control', () => {
  const result = normalizeDeckSessions([
    {
      id: 'native-id',
      title: 'A session',
      tool: 'claude',
      status: 'waiting',
      path: '/fixture/project',
    },
  ]);
  assert.equal(result[0].source, 'agent-deck');
  assert.equal(result[0].project, 'project');
  assert.equal(result[0].status, 'waiting');
});
test('process parser excludes command arguments and handles localized CPU decimals', () => {
  const result = parseProcesses(
    ' 77 1 2048 2,5 /Applications/Codex.app/Contents/MacOS/Codex\n 3 1 1024 0.0 /usr/bin/node',
  );
  assert.equal(result[0].name, 'Codex');
  assert.equal(result[0].rss, 2097152);
  assert.equal(result[0].cpuPercent, 2.5);
});
test('runtime endpoints cannot redirect credential references to arbitrary hosts', () => {
  for (const value of [
    'https://example.com',
    'http://127.0.0.1@evil.invalid',
    'http://127.0.0.1:8000/credentials',
    'file:///tmp/data',
    'http://localhost:8000?token=x',
  ])
    assert.equal(loopbackEndpoint.safeParse(value).success, false);
  assert.equal(loopbackEndpoint.parse('http://127.0.0.1:8642/'), 'http://127.0.0.1:8642');
});

test('opening a future workspace version fails without rewriting its version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-future-'));
  const filename = join(directory, 'test.sqlite');
  const store = new Store(filename);
  store.db.exec('PRAGMA user_version = 3');
  store.close();
  try {
    assert.throws(() => new Store(filename), /newer Forge version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('upgrading a legacy workspace preserves its records and creates a native SQLite rollback copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-upgrade-'));
  const filename = join(directory, 'workspace.sqlite');
  let store = new Store(filename);
  store.put('work', work.id, work);
  store.db.exec('PRAGMA user_version = 1');
  store.close();
  store = new Store(filename);
  try {
    assert.ok(store.migrationBackup);
    assert.equal(store.work(work.id).goal, work.goal);
    assert.equal(
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      2,
    );
    const { DatabaseSync } = await import('node:sqlite');
    const backup = new DatabaseSync(store.migrationBackup!, { readOnly: true });
    try {
      assert.equal(
        (backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        1,
      );
      assert.ok(
        backup.prepare("SELECT data FROM records WHERE collection='work' AND id=?").get(work.id),
      );
    } finally {
      backup.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
