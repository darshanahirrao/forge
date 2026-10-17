import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Account, Approval, Run, Settings, Usage, Work, WorkEvent } from '../shared/types.js';
import { assert } from './errors.js';

type Collection =
  | 'work'
  | 'work_summaries'
  | 'accounts'
  | 'backends'
  | 'events'
  | 'runs'
  | 'approvals'
  | 'usage'
  | 'capsules'
  | 'native_sources'
  | 'native_inventories'
  | 'profiles'
  | 'memory_sources'
  | 'settings'
  | 'config';
export const now = () => new Date().toISOString();
export const id = () => randomUUID();

// SQLite is the source of truth. Every mutation and its receipt share a transaction.
export class Store {
  readonly db: DatabaseSync;
  readonly migrationBackup: string | null;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    try {
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert(
        version.user_version <= 4,
        409,
        'This workspace was created by a newer Forge version. Open it with that version.',
      );
      // Native SQLite locks prevent a second Forge process from recovering or dispatching this workspace.
      this.db
        .exec(`PRAGMA busy_timeout = 1000; PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS events_by_work ON records(json_extract(data,'$.workId')) WHERE collection='events';
      `);
      let backup: string | null = null;
      if (version.user_version > 0 && version.user_version < 4 && filename !== ':memory:') {
        backup = `${filename}.before-v4.${randomUUID()}.sqlite`;
        writeFileSync(backup, '', { flag: 'wx', mode: 0o600 });
        try {
          this.db.prepare('VACUUM INTO ?').run(backup);
        } catch (error) {
          unlinkSync(backup);
          throw error;
        }
      }
      this.db.exec('PRAGMA user_version = 4');
      this.migrationBackup = backup;
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (!this.get<Settings>('settings', 'workspace'))
      this.put('settings', 'workspace', { quietMode: false, maxConcurrent: 1 });
    // Derived projections are rebuilt once at startup, rather than reading every context on a poll.
    for (const work of this.all<Work>('work')) {
      this.put('work', work.id, { ...work, revision: work.revision ?? 0 });
    }
  }
  all<T>(collection: Collection): T[] {
    return this.db
      .prepare('SELECT data FROM records WHERE collection = ? ORDER BY rowid DESC')
      .all(collection)
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  recentEvents(workId?: string, limit = 100): WorkEvent[] {
    const query = workId
      ? this.db
          .prepare(
            "SELECT data FROM records WHERE collection='events' AND json_extract(data,'$.workId')=? ORDER BY rowid DESC LIMIT ?",
          )
          .all(workId, limit)
      : this.db
          .prepare("SELECT data FROM records WHERE collection='events' ORDER BY rowid DESC LIMIT ?")
          .all(limit);
    return query.map((row) => JSON.parse(String(row.data)) as WorkEvent);
  }
  checkpoints(workId: string): WorkEvent[] {
    return this.db
      .prepare(
        "SELECT data FROM records WHERE collection='events' AND json_extract(data,'$.workId')=? AND json_extract(data,'$.kind')='checkpoint' ORDER BY rowid ASC",
      )
      .all(workId)
      .map((row) => JSON.parse(String(row.data)) as WorkEvent);
  }
  assistantResults(workId: string, limit = 5): WorkEvent[] {
    return this.db
      .prepare(
        "SELECT data FROM records WHERE collection='events' AND json_extract(data,'$.workId')=? AND json_extract(data,'$.kind')='assistant' ORDER BY rowid DESC LIMIT ?",
      )
      .all(workId, limit)
      .map((row) => JSON.parse(String(row.data)) as WorkEvent);
  }
  get<T>(collection: Collection, key: string): T | null {
    const row = this.db
      .prepare('SELECT data FROM records WHERE collection = ? AND id = ?')
      .get(collection, key);
    return row ? (JSON.parse(String(row.data)) as T) : null;
  }
  put<T>(collection: Collection, key: string, data: T): T {
    if (collection === 'work') {
      const summary = Object.fromEntries(
        Object.entries(data as Work).filter(
          ([name]) => !['goal', 'acceptance', 'context', 'contextReceipt'].includes(name),
        ),
      );
      // One SQLite statement commits canonical work and its list projection together.
      this.db
        .prepare(
          "INSERT INTO records(collection,id,data) VALUES('work',?,?),('work_summaries',?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data",
        )
        .run(key, JSON.stringify(data), key, JSON.stringify(summary));
      return data;
    }
    this.db
      .prepare(
        'INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data',
      )
      .run(collection, key, JSON.stringify(data));
    return data;
  }
  remove(collection: Collection, key: string) {
    this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(collection, key);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  work(workId: string): Work {
    const work = this.get<Work>('work', workId);
    assert(work, 404, 'This work record was not found. Refresh the workspace.');
    return work;
  }
  account(accountId: string): Account {
    const account = this.get<Account>('accounts', accountId);
    assert(account, 404, 'This account slot was not found. Choose another account.');
    return account;
  }
  event(
    workId: string,
    kind: string,
    title: string,
    detail = '',
    handoff?: WorkEvent['handoff'],
  ): WorkEvent {
    const event: WorkEvent = {
      id: id(),
      workId,
      kind,
      title,
      detail,
      createdAt: now(),
      generation: this.work(workId).generation,
      ...(handoff ? { handoff } : {}),
    };
    return this.put('events', event.id, event);
  }
  updateWork(workId: string, patch: Partial<Work>): Work {
    const previous = this.work(workId);
    const work = {
      ...previous,
      ...patch,
      revision: (previous.revision ?? 0) + 1,
      updatedAt: now(),
    };
    return this.put('work', workId, work);
  }
  settings(): Settings {
    return this.get<Settings>('settings', 'workspace')!;
  }
  invalidateApprovals(runId: string) {
    for (const approval of this.all<Approval>('approvals').filter(
      (a) => a.runId === runId && a.status === 'pending',
    )) {
      this.put('approvals', approval.id, { ...approval, status: 'invalidated', resolvedAt: now() });
    }
  }
  recoverInterruptedRuns() {
    this.transaction(() => {
      for (const run of this.all<Run>('runs').filter((r) =>
        ['starting', 'running'].includes(r.status),
      )) {
        this.put('runs', run.id, {
          ...run,
          status: 'interrupted',
          endedAt: now(),
          ...(run.settlement
            ? { settlement: { ...run.settlement, confirmed: false, observedAt: now() } }
            : { exitConfirmed: false }),
        });
        this.invalidateApprovals(run.id);
        this.updateWork(run.workId, {
          status: 'interrupted',
          activeRunId: null,
          stopRequestedAt: null,
        });
        this.event(
          run.workId,
          'recovery',
          'Connection ended before completion',
          'Review native activity and external effects before starting another attempt. Forge has not replayed any action.',
        );
      }
    });
  }
  expireApprovals() {
    for (const approval of this.all<Approval>('approvals')) {
      if (approval.status === 'pending' && approval.expiresAt <= now()) {
        this.put('approvals', approval.id, { ...approval, status: 'expired', resolvedAt: now() });
      }
    }
  }
  saveUsage(usage: Usage) {
    this.put('usage', usage.key, usage);
  }
  close() {
    this.db.close();
  }
}
