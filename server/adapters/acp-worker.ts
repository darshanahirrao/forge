import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { ClientApp, ClientConnection } from '@agentclientprotocol/sdk';

export interface AcpWorker {
  readonly pid?: number;
  connection: ClientConnection;
  readonly exited: boolean;
  stop(): Promise<void>;
}
export type AcpWorkerFactory = (app: ClientApp) => Promise<AcpWorker>;

export async function boundedAcpRequest<T>(
  worker: AcpWorker,
  request: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            'The native ACP startup request timed out. No request was replayed.',
          );
          worker.connection.close(error);
          reject(error);
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The official SDK owns ACP framing and dispatch. Capacity is held through native process exit. */
export async function spawnAcpWorker(
  app: ClientApp,
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<AcpWorker> {
  const { ndJsonStream } = await import('@agentclientprotocol/sdk');
  const child = spawn(binary, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      if (!child.pid) {
        exited = true;
        resolve();
      }
    });
  });
  // Native diagnostics can contain credentials or private context; never persist or forward them.
  child.stderr.resume();
  const terminate = async () => {
    if (exited) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 3000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
  };
  let connection: ClientConnection;
  try {
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      { maxMessageBytes: 2 * 1024 * 1024 },
    );
    connection = app.connect(stream);
  } catch (error) {
    await terminate();
    throw error;
  }
  let stopping: Promise<void> | null = null;
  return {
    pid: child.pid,
    connection,
    get exited() {
      return exited;
    },
    stop: () =>
      (stopping ??= (async () => {
        connection.close();
        await terminate();
      })()),
  };
}
