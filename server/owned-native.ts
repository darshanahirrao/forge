import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerProofDescriptor } from '../shared/recovery.js';
import { assert } from './errors.js';
import { id, now } from './store.js';
import { checkWorkerProfile, privateDirectory, scopeHash } from './worker-proof.mjs';

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
export interface OwnedNativeReceipt<Scope extends object> extends WorkerProofDescriptor<Scope> {
  phase: 'prepared' | 'armed' | 'committed';
  createdAt: string;
}
export interface NativeOwner<Scope extends object> {
  directory: string;
  scope: Scope;
  nativeHome?: string;
  mayPrepare(): boolean;
  prepared(record: OwnedNativeReceipt<Scope>): void;
  phaseChanged(record: OwnedNativeReceipt<Scope>): void;
  mayCommit(): boolean;
}

/** One original child handle, durable commit before spawn, no native agent behavior. */
export function ownedNativeSpawner<Scope extends object>(input: NativeOwner<Scope>): NativeSpawn {
  privateDirectory(input.directory);
  let used = false;
  return (command, args, options, policy = {}) => {
    assert(
      !used && input.mayPrepare(),
      409,
      'Native startup requires one current reviewed launch. Replacement roots are not adopted.',
    );
    used = true;
    const profileRoot = input.nativeHome ? realpathSync(input.nativeHome) : undefined;
    if (profileRoot) checkWorkerProfile(profileRoot);
    const keys = generateKeyPairSync('ed25519');
    const workerId = id();
    const directory = join(input.directory, workerId);
    mkdirSync(directory, { mode: 0o700 });
    const scope = structuredClone(input.scope);
    const record: OwnedNativeReceipt<Scope> = {
      id: workerId,
      scope,
      scopeHash: scopeHash(scope),
      directory,
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      guardianPid: null,
      phase: 'prepared',
      createdAt: now(),
    };
    input.prepared(record);
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
          if (stopped || options.signal?.aborted || !input.mayCommit()) {
            child.kill('SIGTERM');
            return;
          }
          // This durable commit MUST precede the only IPC message that can spawn.
          record.phase = 'committed';
          input.phaseChanged(record);
          if (!send({ type: 'launch', id: record.id })) child.kill('SIGTERM');
        } else if (event.type === 'started' && record.phase === 'committed') {
          clearTimeout(timer);
          const pid =
            Number.isSafeInteger(event.nativePid) && event.nativePid! > 1 ? event.nativePid! : null;
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
      input.phaseChanged(record);
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
