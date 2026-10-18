import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Account, Approval, Run, Settings, Usage, Work, WorkEvent } from '../shared/types.js';
import { assert } from './errors.js';
import { withinProject } from './project-scope.js';

type Collection =
  | 'work'
  | 'work_summaries'
  | 'accounts'
  | 'backends'
  | 'events'
  | 'runs'
  | 'worker_supervisions'
  | 'approvals'
  | 'usage'
  | 'capsules'
  | 'native_sources'
  | 'native_inventories'
  | 'profiles'
  | 'memory_sources'
  | 'memory_packs'
  | 'companion_grants'
  | 'companion_operations'
  | 'companion_handoffs'
  | 'companion_runtimes'
  | 'companion_launches'
  | 'companion_supervisions'
  | 'blueprint_imports'
  | 'spend_attempts'
  | 'spend_counters'
  | 'work_outcomes'
  | 'account_routes'
  | 'notifications'
  | 'native_controls'
  | 'native_migrations'
  | 'schedule_transfers'
  | 'connectors'
  | 'settings'
  | 'config';
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const workspaceVersion = 15;

// SQLite is the source of truth. Every mutation and its receipt share a transaction.
export class Store {
  private changes: Set<Collection> | null = null;
  private listeners = new Set<(collections: ReadonlySet<Collection>) => void>();
  readonly db: DatabaseSync;
  readonly migrationBackup: string | null;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.function('forge_in_project', { deterministic: true }, (root, path) =>
      typeof root === 'string' && typeof path === 'string' && withinProject(root, path) ? 1 : 0,
    );
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    try {
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert(
        version.user_version <= workspaceVersion,
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
      CREATE INDEX IF NOT EXISTS companion_work_by_profile ON records(json_extract(data,'$.profileId')) WHERE collection='work_summaries';
      CREATE INDEX IF NOT EXISTS runs_by_companion_request ON records(json_extract(data,'$.requestedBy.grantId'), json_extract(data,'$.requestedBy.requestId')) WHERE collection='runs';
      CREATE INDEX IF NOT EXISTS runs_by_companion_lineage ON records(json_extract(data,'$.requestedBy.lineageId')) WHERE collection='runs';
      CREATE INDEX IF NOT EXISTS runs_by_work ON records(json_extract(data,'$.workId')) WHERE collection='runs';
      CREATE INDEX IF NOT EXISTS usage_by_work ON records(json_extract(data,'$.workId')) WHERE collection='usage';
      CREATE INDEX IF NOT EXISTS spend_by_work ON records(json_extract(data,'$.workId')) WHERE collection='spend_attempts';
      CREATE INDEX IF NOT EXISTS companion_operations_by_grant ON records(json_extract(data,'$.grantId')) WHERE collection='companion_operations';
      CREATE INDEX IF NOT EXISTS companion_operations_by_lineage ON records(json_extract(data,'$.lineageId')) WHERE collection='companion_operations';
      CREATE INDEX IF NOT EXISTS companion_open_launches ON records(json_extract(data,'$.runtimeId')) WHERE collection='companion_launches' AND json_extract(data,'$.exitConfirmed') IS NOT 1;
      CREATE INDEX IF NOT EXISTS notifications_by_state ON records(json_extract(data,'$.state')) WHERE collection='notifications';
      CREATE INDEX IF NOT EXISTS native_controls_by_job ON records(json_extract(data,'$.sourceId'), json_extract(data,'$.jobId'), json_extract(data,'$.state')) WHERE collection='native_controls';
      CREATE INDEX IF NOT EXISTS schedule_transfers_by_source ON records(json_extract(data,'$.sourceId'), json_extract(data,'$.sourceJobId'), json_extract(data,'$.state')) WHERE collection='schedule_transfers';
      `);
      let backup: string | null = null;
      if (
        version.user_version > 0 &&
        version.user_version < workspaceVersion &&
        filename !== ':memory:'
      ) {
        backup = `${filename}.before-v15.${randomUUID()}.sqlite`;
        writeFileSync(backup, '', { flag: 'wx', mode: 0o600 });
        try {
          this.db.prepare('VACUUM INTO ?').run(backup);
        } catch (error) {
          unlinkSync(backup);
          throw error;
        }
      }
      this.db.exec('PRAGMA user_version = 15');
      this.migrationBackup = backup;
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (!this.get<Settings>('settings', 'workspace'))
      this.put('settings', 'workspace', { quietMode: false, maxConcurrent: 1 });
    // Repair projections without holding every saved prompt/context in memory.
    const ceiling = Number(
      this.db
        .prepare("SELECT COALESCE(MAX(rowid),0) AS value FROM records WHERE collection='work'")
        .get()!.value,
    );
    let after = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          "SELECT rowid,data FROM records WHERE collection='work' AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 128",
        )
        .all(after, ceiling);
      if (!rows.length) break;
      this.transaction(() => {
        for (const row of rows) {
          const work = JSON.parse(String(row.data)) as Work;
          this.put('work', work.id, { ...work, revision: work.revision ?? 0 });
        }
      });
      after = Number(rows[rows.length - 1].rowid);
    }
  }
  all<T>(collection: Collection): T[] {
    return this.db
      .prepare('SELECT data FROM records WHERE collection = ? ORDER BY rowid DESC')
      .all(collection)
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  resourceRuns(): Run[] {
    // Filter inside SQLite rather than materializing finished run history on every
    // UI poll. Missing exit evidence remains eligible, including legacy records.
    return this.db
      .prepare(
        `SELECT data FROM records WHERE collection='runs'
         AND json_type(data,'$.nativeWorker')='object'
         AND (json_extract(data,'$.exitConfirmed') IS NOT 1
              OR json_extract(data,'$.status') IN ('starting','running'))
         ORDER BY rowid DESC`,
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as Run);
  }
  unconfirmedNativeRuns(): Run[] {
    return this.db
      .prepare(
        `SELECT data FROM records WHERE collection='runs'
        AND (json_extract(data,'$.exitConfirmed')=0 OR
          (json_type(data,'$.nativeWorker')='object' AND json_extract(data,'$.exitConfirmed') IS NOT 1
            AND json_extract(data,'$.status') NOT IN ('starting','running')))
        AND json_type(data,'$.settlement') IS NULL
      ORDER BY rowid DESC`,
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as Run);
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
      this.changed(collection);
      return data;
    }
    this.db
      .prepare(
        'INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data',
      )
      .run(collection, key, JSON.stringify(data));
    this.changed(collection);
    return data;
  }
  remove(collection: Collection, key: string) {
    this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(collection, key);
    this.changed(collection);
  }
  onChange(listener: (collections: ReadonlySet<Collection>) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(collection: Collection) {
    if (this.changes) this.changes.add(collection);
    else this.publish(new Set([collection]));
  }
  private publish(changes: ReadonlySet<Collection>) {
    // Observational listeners cannot roll back an already committed native receipt.
    for (const listener of this.listeners) {
      try {
        listener(changes);
      } catch {
        /* The observer owns its delivery status. */
      }
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.changes = new Set();
    try {
      const result = fn();
      this.db.exec('COMMIT');
      const changes = this.changes;
      this.changes = null;
      this.publish(changes);
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.changes = null;
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
