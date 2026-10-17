import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account, Run } from '../shared/types.js';
import type { NativeRecoveryRow, WorkerProofDescriptor } from '../shared/recovery.js';
import { assert } from './errors.js';
import { Store, id, now } from './store.js';
import {
  checkWorkerProfile,
  privateDirectory,
  readWorkerExit,
  scopeHash,
} from './worker-proof.mjs';

export interface SupervisedChild extends ChildProcessWithoutNullStreams {
  nativePid?: number;
  nativeStarted: Promise<number | null>;
}
export type NativeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
  policy?: { input?: 'pipe' | 'ignore'; graceMs?: number },
) => SupervisedChild;
interface Supervision extends WorkerProofDescriptor {
  phase: 'prepared' | 'armed' | 'committed';
  createdAt: string;
}

/** Finite child owners retain wait authority across a Forge crash. No native agent behavior lives here. */
export class WorkerSupervisions {
  readonly directory?: string;
  constructor(
    private store: Store,
    directory?: string,
  ) {
    if (directory && process.platform !== 'win32') {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.directory = realpathSync(directory);
      privateDirectory(this.directory);
    }
  }
  spawner(run: Run, account: Account): NativeSpawn | undefined {
    if (!this.directory) return undefined;
    let used = false;
    return (command, args, options, policy = {}) => {
      const current = this.store.get<Run>('runs', run.id);
      assert(
        !used && current?.generation === run.generation && current.status === 'starting',
        409,
        'Native startup requires one committed Forge attempt. Replacement roots are not adopted.',
      );
      used = true;
      const profileRoot = account.nativeHome ? realpathSync(account.nativeHome) : undefined;
      if (profileRoot) checkWorkerProfile(profileRoot);
      const keys = generateKeyPairSync('ed25519');
      const workerId = id();
      const directory = join(this.directory!, workerId);
      mkdirSync(directory, { mode: 0o700 });
      const scope = {
        runId: run.id,
        workId: run.workId,
        accountId: run.accountId,
        generation: run.generation,
        harness: run.harness ?? account.harness,
      };
      const record: Supervision = {
        id: workerId,
        scope,
        scopeHash: scopeHash(scope),
        directory,
        publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        guardianPid: null,
        phase: 'prepared',
        createdAt: now(),
      };
      run.supervisionId = record.id;
      this.store.transaction(() => {
        this.store.put('worker_supervisions', record.id, record);
        this.store.put('runs', run.id, run);
      });
      // Provider credentials, argv and signing material travel only over this
      // original private IPC channel. The guardian itself inherits no provider env.
      const guardianEnv: NodeJS.ProcessEnv = {};
      for (const name of ['PATH', 'LANG', 'SystemRoot', 'WINDIR', 'TMPDIR'])
        if (process.env[name]) guardianEnv[name] = process.env[name];
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./native-worker.mjs', import.meta.url))],
        {
          env: guardianEnv,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
        },
      ) as SupervisedChild;
      let settled = false;
      let resolveStarted: (pid: number | null) => void = () => {};
      child.nativeStarted = new Promise((resolve) => {
        resolveStarted = resolve;
      });
      const settle = (pid: number | null) => {
        if (!settled) {
          settled = true;
          resolveStarted(pid);
        }
      };
      const send = (message: unknown) => {
        if (!child.connected) return false;
        try {
          child.send(message as object, () => {});
          return true;
        } catch {
          return false;
        }
      };
      let stopped = false;
      child.kill = (signal = 'SIGTERM') => {
        if (
          !['SIGTERM', 'SIGINT', 'SIGKILL'].includes(String(signal)) ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          return false;
        stopped = true;
        return send({ type: 'stop', signal });
      };
      const abort = () => {
        child.kill('SIGTERM');
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, 15000);
      child.once('error', () => {
        settle(null);
      });
      child.once('close', () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        settle(null);
      });
      child.on('message', (message: unknown) => {
        try {
          const event = message as { type?: string; id?: string; nativePid?: number | null };
          if (event.id !== record.id) return;
          if (event.type === 'ready' && record.phase === 'armed') {
            const live = this.store.get<Run>('runs', run.id);
            if (
              stopped ||
              options.signal?.aborted ||
              live?.status !== 'starting' ||
              this.store.work(run.workId).activeRunId !== run.id
            ) {
              child.kill('SIGTERM');
              return;
            }
            // This durable commit MUST precede the only IPC message that can spawn.
            record.phase = 'committed';
            this.store.put('worker_supervisions', record.id, record);
            if (!send({ type: 'launch', id: record.id })) child.kill('SIGTERM');
          } else if (event.type === 'started' && record.phase === 'committed') {
            clearTimeout(timer);
            const pid =
              Number.isSafeInteger(event.nativePid) && event.nativePid! > 1
                ? event.nativePid!
                : null;
            if (pid) child.nativePid = pid;
            settle(pid);
          }
        } catch {
          child.kill('SIGTERM');
          settle(null);
        }
      });
      if (child.pid) {
        record.guardianPid = child.pid;
        record.phase = 'armed';
        this.store.put('worker_supervisions', record.id, record);
        const configuration = {
          command,
          args: [...args],
          cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
          env: options.env ?? process.env,
          input: policy.input ?? 'pipe',
          graceMs: policy.graceMs ?? 3000,
          profileRoot,
        };
        send({
          type: 'bootstrap',
          descriptor: record,
          configuration,
          privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        });
        if (options.signal?.aborted) abort();
      }
      return child;
    };
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
    };
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
