import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import type { NativeSpawn } from './owned-native.js';
import { ownedNativeSpawner } from './owned-native.js';
import type { Account, Run } from '../shared/types.js';
import type { NativeRecoveryRow, WorkerProofDescriptor } from '../shared/recovery.js';
import { Store } from './store.js';
import { privateDirectory, readWorkerExit, scopeHash } from './worker-proof.mjs';
import { validateResourceReceipt, type ResourceGovernance } from './resource-governance.js';

interface Supervision extends WorkerProofDescriptor {
  phase: 'prepared' | 'armed' | 'committed';
  createdAt: string;
}
export type { NativeSpawn, SupervisedChild } from './owned-native.js';
/** Finite child owners retain wait authority across a Forge crash. No native agent behavior lives here. */
export class WorkerSupervisions {
  readonly directory?: string;
  constructor(
    private store: Store,
    directory?: string,
    private resources?: ResourceGovernance,
  ) {
    if (directory && process.platform !== 'win32') {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.directory = realpathSync(directory);
      privateDirectory(this.directory);
    }
  }
  spawner(run: Run, account: Account): NativeSpawn | undefined {
    if (!this.directory) return undefined;
    return ownedNativeSpawner({
      directory: this.directory,
      scope: {
        runId: run.id,
        workId: run.workId,
        accountId: run.accountId,
        generation: run.generation,
        harness: run.harness ?? account.harness,
        ...(run.nativeResources ? { resourcePolicyDigest: run.nativeResources.digest } : {}),
      },
      resources: run.nativeResources,
      nativeHome: account.nativeHome || undefined,
      mayPrepare: () => {
        this.resources?.assertCurrent(run.nativeResources, account);
        const current = this.store.get<Run>('runs', run.id);
        return current?.generation === run.generation && current.status === 'starting';
      },
      prepared: (record) => {
        run.supervisionId = record.id;
        this.store.transaction(() => {
          this.store.put('worker_supervisions', record.id, record);
          this.store.put('runs', run.id, run);
        });
      },
      phaseChanged: (record) => this.store.put('worker_supervisions', record.id, record),
      mayCommit: () => {
        this.resources?.assertCurrent(run.nativeResources, account);
        return (
          this.store.get<Run>('runs', run.id)?.status === 'starting' &&
          this.store.work(run.workId).activeRunId === run.id
        );
      },
    });
  }
  inspect(run: Run): NativeRecoveryRow {
    const base = {
      runId: run.id,
      workId: run.workId,
      harness: run.harness ?? 'unknown',
      revision: this.store.work(run.workId).revision,
    };
    const record = run.supervisionId
      ? this.store.get<Supervision>('worker_supervisions', run.supervisionId)
      : null;
    if (!record)
      return {
        ...base,
        state: 'unsupported',
        detail:
          'This attempt has no durable native exit evidence. Process observations cannot release its reservation.',
      };
    const scope = {
      runId: run.id,
      workId: run.workId,
      accountId: run.accountId,
      generation: run.generation,
      harness: run.harness ?? 'unknown',
      ...(run.nativeResources ? { resourcePolicyDigest: run.nativeResources.digest } : {}),
    };
    try {
      if (run.nativeResources) validateResourceReceipt(run.nativeResources);
    } catch {
      return {
        ...base,
        state: 'unavailable' as const,
        detail: 'The native resource-policy receipt changed. Exact original evidence remains held.',
      };
    }
    if (
      record.id !== run.supervisionId ||
      record.scopeHash !== scopeHash(scope) ||
      record.scopeHash !== scopeHash(record.scope)
    )
      return {
        ...base,
        state: 'unavailable',
        detail: 'The saved worker evidence does not match this exact attempt.',
      };
    if (record.phase === 'prepared' || record.phase === 'armed')
      return {
        ...base,
        state: 'ready',
        method: 'not-committed',
        digest: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
        detail:
          'The native launch was never committed. No native worker could start under this receipt.',
      };
    if (record.phase !== 'committed')
      return {
        ...base,
        state: 'unavailable',
        detail: 'The saved launch phase is invalid. Its reservation stays held.',
      };
    try {
      const proof = readWorkerExit(record);
      return {
        ...base,
        state: 'ready',
        method: 'signed-native-close',
        digest: proof.digest,
        native: proof.payload,
        detail:
          'The original child owner verified native process and inherited stdio closure. External effects and unknown spending still need review.',
      };
    } catch (error) {
      return {
        ...base,
        state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'waiting' : 'unavailable',
        detail:
          'Verified native closure is unavailable. The worker may still be stopping, or its owner may have failed. The reservation stays held.',
      };
    }
  }
  snapshot() {
    const rows = this.store.unconfirmedNativeRuns().map((run) => this.inspect(run));
    return { needsReview: rows.length, rows };
  }
}
