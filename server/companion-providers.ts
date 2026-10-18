import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account } from '../shared/types.js';
import type { CredentialMaterial } from './credentials.js';
import type { NativeSpawn, SupervisedChild } from './owned-native.js';
import { assert } from './errors.js';
import { findBinary } from './adapters/discovery.js';
import { hermesPython } from './adapters/hermes-install.js';
import { hermesEnvironment } from './adapters/hermes-driver.js';
import { acquireProfileLease } from './adapters/profile-lease.js';
import { openClawEnvironment, openClawInstallation } from './adapters/openclaw-worker.js';

const exec = promisify(execFile);
export interface CompanionConnection {
  pid: number;
  version: string;
  signal: AbortSignal;
  stop(): Promise<{ clean: boolean }>;
}
/** Native implementation owns its planner, interfaces, model, channels, memory and scheduling. */
export type CompanionProvider = (
  account: Account,
  root: string,
  credentials: CredentialMaterial | undefined,
  spawn: NativeSpawn,
) => Promise<CompanionConnection>;
export interface CompanionProviderDefinition {
  contract: 1;
  nativeVersion: string;
  profileFiles: readonly string[];
  connect: CompanionProvider;
  extension?: import('../shared/extensions.js').NativeRuntimeProvider;
}

function nativeLifetime(child: SupervisedChild, release: () => void) {
  child.stdout.resume();
  child.stderr.resume();
  const lost = new AbortController();
  let closed = false;
  const exit = new Promise<{ clean: boolean }>((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      lost.abort();
      resolve({ clean: code === 0 && signal === null });
    });
    child.once('error', () => {
      if (!child.pid) {
        closed = true;
        lost.abort();
        resolve({ clean: false });
      }
    });
  });
  let stopping: Promise<{ clean: boolean }> | undefined;
  return {
    signal: lost.signal,
    get closed() {
      return closed;
    },
    stop: () =>
      (stopping ??= (async () => {
        if (!closed) child.kill('SIGTERM');
        try {
          return await exit;
        } finally {
          release();
        }
      })()),
  };
}
async function waitReady(lifetime: { closed: boolean }, probe: () => Promise<boolean>) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !lifetime.closed) {
    try {
      if (await probe()) return;
    } catch {
      /* native startup observations can be temporarily unavailable */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert(
    false,
    409,
    'The native gateway did not become ready. Inspect this native profile and its configured interfaces.',
  );
}
/** Reuse original-child signing, native profile fencing and finite readiness for extension providers. */
export async function nativeCompanion(options: {
  account: Account;
  root: string;
  spawn: NativeSpawn;
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  version: string;
  probe: (pid: number, signal: AbortSignal) => Promise<boolean>;
  graceMs?: number;
}): Promise<CompanionConnection> {
  const release = await acquireProfileLease(options.account.nativeHome);
  let handedOff = false;
  try {
    const child = options.spawn(
      options.command,
      options.args,
      { cwd: options.root, env: options.environment, windowsHide: true },
      { input: 'ignore', graceMs: options.graceMs ?? 5000 },
    );
    const lifetime = nativeLifetime(child, release);
    try {
      const pid = await child.nativeStarted;
      assert(pid, 409, 'The original extension runtime did not start.');
      await waitReady(lifetime, async () => {
        const abort = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            options.probe(pid, abort.signal),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => {
                abort.abort();
                resolve(false);
              }, 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          abort.abort();
        }
      });
      assert(!lifetime.closed, 409, 'The extension runtime closed during native readiness.');
      handedOff = true;
      return { pid, version: options.version, signal: lifetime.signal, stop: lifetime.stop };
    } catch (error) {
      await lifetime.stop();
      throw error;
    }
  } finally {
    if (!handedOff) release();
  }
}
async function nativeStatus(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    assert(
      info.isFile() && info.size <= 65536 && (await realpath(path)) === path,
      409,
      'Native gateway status is unavailable.',
    );
    const data = Buffer.alloc(65537);
    const result = await file.read(data, 0, data.length, 0);
    assert(result.bytesRead <= 65536, 409, 'Native gateway status exceeds its contract.');
    return JSON.parse(data.subarray(0, result.bytesRead).toString('utf8')) as {
      pid?: number;
      gateway_state?: string;
      updated_at?: string;
    };
  } finally {
    await file.close();
  }
}

export const hermesCompanion: CompanionProvider = async (account, root, credentials, spawn) => {
  const binary = await findBinary('hermes');
  assert(binary, 409, 'Install the supported native Hermes runtime.');
  const python = await hermesPython(binary),
    release = await acquireProfileLease(account.nativeHome);
  let handedOff = false;
  try {
    const startedAt = Date.now();
    const child = spawn(
      python,
      [fileURLToPath(new URL('./adapters/hermes-gateway.py', import.meta.url))],
      {
        cwd: root,
        env: { ...hermesEnvironment(account, credentials), PYTHONDONTWRITEBYTECODE: '1' },
        windowsHide: true,
      },
      { input: 'pipe', graceMs: 335000 },
    );
    const lifetime = nativeLifetime(child, release);
    try {
      child.stdin.end(JSON.stringify({ home: account.nativeHome }));
      const pid = await child.nativeStarted;
      assert(pid, 409, 'The owned native Hermes gateway did not start.');
      await waitReady(lifetime, async () => {
        const value = await nativeStatus(join(account.nativeHome, 'gateway_state.json'));
        return (
          value.pid === pid &&
          value.gateway_state === 'running' &&
          Number.isFinite(Date.parse(value.updated_at ?? '')) &&
          Date.parse(value.updated_at!) >= startedAt - 1000
        );
      });
      assert(!lifetime.closed, 409, 'The native Hermes gateway closed during readiness.');
      handedOff = true;
      return { pid, version: '0.17.0', signal: lifetime.signal, stop: lifetime.stop };
    } catch (error) {
      await lifetime.stop();
      throw error;
    }
  } finally {
    if (!handedOff) release();
  }
};

export const openClawCompanion: CompanionProvider = async (account, root, credentials, spawn) => {
  const env = openClawEnvironment(account, credentials, 'companion'),
    installation = await openClawInstallation(env),
    release = await acquireProfileLease(account.nativeHome);
  let handedOff = false;
  try {
    const info = await exec(
      installation.node,
      [installation.binary, 'config', 'get', 'gateway', '--json'],
      { env, timeout: 10000, maxBuffer: 262144 },
    );
    const config = JSON.parse(info.stdout) as { mode?: string; reload?: { mode?: string } };
    assert(
      config.mode === 'local' && config.reload?.mode === 'off',
      409,
      'A managed native companion requires a local OpenClaw gateway with reload off. Configure the native interface and authentication through OpenClaw.',
    );
    // Preserve its configured address, port, authentication, channels and native policies.
    const child = spawn(
        installation.node,
        [installation.binary, 'gateway', 'run'],
        { cwd: root, env, windowsHide: true },
        { input: 'ignore', graceMs: 335000 },
      ),
      lifetime = nativeLifetime(child, release);
    try {
      const pid = await child.nativeStarted;
      assert(pid, 409, 'The owned native OpenClaw gateway did not start.');
      await waitReady(lifetime, async () => {
        const result = await exec(
          installation.node,
          [installation.binary, 'gateway', 'health', '--json', '--timeout', '1000'],
          { env, timeout: 8000, maxBuffer: 262144 },
        );
        const health = JSON.parse(result.stdout) as { ok?: boolean };
        return typeof health.ok === 'boolean';
      });
      assert(!lifetime.closed, 409, 'The native OpenClaw gateway closed during readiness.');
      handedOff = true;
      return { pid, version: '2026.10.4', signal: lifetime.signal, stop: lifetime.stop };
    } catch (error) {
      await lifetime.stop();
      throw error;
    }
  } finally {
    if (!handedOff) release();
  }
};
export const companionProviders: Record<string, CompanionProviderDefinition> = {
  hermes: {
    contract: 1,
    nativeVersion: '0.17.0',
    profileFiles: ['config.yaml', '.env', 'cron/jobs.json'],
    connect: hermesCompanion,
  },
  openclaw: {
    contract: 1,
    nativeVersion: '2026.10.4',
    profileFiles: ['openclaw.json', '.env', 'cron/jobs.json'],
    connect: openClawCompanion,
  },
};
