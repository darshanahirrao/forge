import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { lstat, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { OpenCodeClient } from '@opencode/client';
import type { Account } from '../../shared/types.js';
import { assert, ForgeError } from '../errors.js';
import { findBinary } from './discovery.js';

export interface OpenCodeConnection {
  readonly pid?: number;
  client: OpenCodeClient;
  readonly exited: boolean;
  readonly transportLost?: boolean;
  readonly version?: string;
  stop(): Promise<void>;
}
export type OpenCodeFactory = (account: Account, cwd: string) => Promise<OpenCodeConnection>;

/** Read native recovery metadata only. Never edit claims or let startup replay an uncertain turn. */
export async function assertIdleOpenCodeProfile(root: string) {
  const path = join(root, 'data', 'opencode', 'opencode.db');
  const file = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return;
  assert(
    file.isFile() && !file.isSymbolicLink(),
    409,
    'The native OpenCode database must be a regular file.',
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const claim = db
      .prepare('SELECT 1 FROM session_v2 WHERE time_suspended IS NOT NULL LIMIT 1')
      .get();
    const input = db.prepare('SELECT 1 FROM session_pending LIMIT 1').get();
    const background = db
      .prepare(
        "SELECT 1 FROM kv WHERE key >= 'job.background/' AND key < 'job.background0' LIMIT 1",
      )
      .get();
    assert(
      !claim && !input && !background,
      409,
      'This OpenCode profile has unfinished native recovery or input. Reconcile it through OpenCode before Forge starts a server.',
    );
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    if (error instanceof Error && error.name === 'Error')
      throw new Error(
        'The native OpenCode recovery schema could not be verified. Reconcile or upgrade this profile through OpenCode first.',
      );
    throw error;
  } finally {
    db.close();
  }
}

/** An explicit native profile, not a copy of another client's credentials or database. */
export function openCodeEnvironment(account: Account): NodeJS.ProcessEnv {
  assert(account.nativeHome, 409, 'Choose an OpenCode profile root before launching.');
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ])
    if (process.env[key]) env[key] = process.env[key];
  for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE'])
    env[`XDG_${name}_HOME`] = join(account.nativeHome, name.toLowerCase());
  env.OPENCODE_DB = join(account.nativeHome, 'data', 'opencode', 'opencode.db');
  if (account.credentialEnv) {
    assert(
      !/^(PATH|HOME|CODEX_HOME|XDG_|OPENCODE_|FORGE_DATA_DIR|TMP|TEMP|SystemRoot|COMSPEC)/i.test(
        account.credentialEnv,
      ),
      409,
      'Use a provider credential variable, not a native runtime setting.',
    );
    assert(
      process.env[account.credentialEnv],
      409,
      `Set ${account.credentialEnv} before launching.`,
    );
    env[account.credentialEnv] = process.env[account.credentialEnv];
  }
  return env;
}

/** Reuse the native v2 server and official client. Never attach to the user's global daemon. */
export async function openCodeWorker(
  account: Account,
  cwd: string,
  binaryOverride?: string,
): Promise<OpenCodeConnection> {
  const binary = binaryOverride ?? (await findBinary('opencode'));
  assert(binary, 409, 'Install OpenCode v2 through its native setup before launching.');
  const password = randomBytes(32).toString('hex');
  const env = { ...openCodeEnvironment(account), OPENCODE_SERVER_PASSWORD: password };
  const lease = new DatabaseSync(join(account.nativeHome, '.forge-native-owner.sqlite'));
  try {
    await chmod(join(account.nativeHome, '.forge-native-owner.sqlite'), 0o600);
    lease.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    await assertIdleOpenCodeProfile(account.nativeHome);
  } catch (error) {
    lease.close();
    throw error;
  }
  let child: ChildProcess;
  let exited = false;
  let failed = false;
  let output = '';
  let transportLost = false;
  let resolveReady!: (value: string | null) => void;
  const ready = new Promise<string | null>((resolve) => {
    resolveReady = resolve;
  });
  try {
    child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    lease.close();
    throw error;
  }
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolveReady(null);
      resolve();
    });
    child.once('error', () => {
      failed = true;
      if (!child.pid) {
        exited = true;
        resolveReady(null);
        resolve();
      }
    });
  });
  const read = (chunk: Buffer) => {
    // Startup text stays transient. Never expose native diagnostics or the server credential.
    output = (output + chunk.toString()).slice(-8192);
    const endpoint = output.match(/http:\/\/127\.0\.0\.1:(\d{1,5})\b/);
    if (endpoint && Number(endpoint[1]) > 0 && Number(endpoint[1]) <= 65535)
      resolveReady(endpoint[0]);
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        if (exited) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, 3000);
        try {
          await exit;
        } finally {
          clearTimeout(timer);
          output = '';
        }
      } finally {
        lease.close();
      }
    })());
  const timer = setTimeout(() => resolveReady(null), 15000);
  try {
    const baseUrl = await ready;
    assert(
      baseUrl && !failed && !exited,
      502,
      'The owned OpenCode server did not start. Inspect the native profile and version.',
    );
    const { OpenCode } = await import('@opencode/client');
    const client = OpenCode.make({
      baseUrl,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      fetch: async (input, init) => {
        assert(
          !transportLost && !exited,
          502,
          'The OpenCode transport was lost. No request was replayed.',
        );
        const url = new URL(String(input));
        assert(
          url.origin === baseUrl && url.pathname.startsWith('/api/'),
          502,
          'Unexpected native OpenCode endpoint.',
        );
        const timeout = new AbortController();
        const deadline = setTimeout(() => timeout.abort(), 10000);
        let response: Response;
        try {
          response = await fetch(input, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), timeout.signal]),
          });
        } catch (error) {
          clearTimeout(deadline);
          throw error;
        }
        if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
          clearTimeout(deadline);
          const reader = response.body.getReader();
          // The official client parses SSE. This only detects transport loss before a grant/retry.
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const item = await reader.read();
                if (item.done) {
                  transportLost = true;
                  controller.close();
                } else controller.enqueue(item.value);
              } catch (error) {
                transportLost = true;
                controller.error(error);
              }
            },
            async cancel() {
              await reader.cancel().catch(() => {});
            },
          });
          return new Response(body, { status: response.status, headers: response.headers });
        }
        if (!response.body) {
          clearTimeout(deadline);
          return response;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.byteLength;
            assert(
              bytes <= 2 * 1024 * 1024,
              502,
              'The native OpenCode response exceeds the current metadata limit.',
            );
            chunks.push(item.value);
          }
          return new Response(Buffer.concat(chunks), {
            status: response.status,
            headers: response.headers,
          });
        } finally {
          clearTimeout(deadline);
          await reader.cancel().catch(() => {});
        }
      },
    });
    const info = await client.server.info({ signal: AbortSignal.timeout(5000) });
    assert(
      /^2\.0\./.test(info.version) && info.pid === child.pid,
      409,
      'OpenCode must confirm its compatible v2.0 API and owned server process before task input.',
    );
    const anonymous = await fetch(`${baseUrl}/api/info`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    await anonymous.body?.cancel();
    assert(
      anonymous.status === 401,
      409,
      'OpenCode did not enforce the private server credential. No task input was sent.',
    );
    output = '';
    return {
      pid: child.pid,
      client,
      version: info.version,
      get exited() {
        return exited;
      },
      get transportLost() {
        return transportLost;
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
