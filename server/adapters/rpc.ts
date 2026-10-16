import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ForgeError } from '../errors.js';

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}
export interface RpcOptions {
  binary: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
export class NativeRpc extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private buffer = '';
  private stopping: Promise<void> | null = null;
  closed = false;
  constructor(private options: RpcOptions) {
    super();
    this.child = spawn(options.binary, options.args ?? ['app-server'], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.read(chunk));
    // Drain native diagnostic output. Never forward arbitrary stderr or credentials to the browser.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.stop());
    this.child.on('error', () =>
      this.finish('The native app-server could not start. Check the installation.'),
    );
    this.child.on('exit', () => this.finish('The native app-server connection closed.'));
  }
  private read(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
      this.stop();
      return;
    }
    let next: number;
    while ((next = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, next);
      this.buffer = this.buffer.slice(next + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as RpcMessage;
        if (message.method) this.emit('message', message);
        else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error)
            pending.reject(
              new ForgeError(
                502,
                `Native operation failed (${message.error.code}). Check native access and compatibility.`,
              ),
            );
          else pending.resolve(message.result);
        }
      } catch {
        this.stop();
        return;
      }
    }
  }
  private send(message: RpcMessage) {
    if (this.closed || !this.child.stdin.writable)
      throw new ForgeError(
        409,
        'The native connection has ended. Refresh the task before continuing.',
      );
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new ForgeError(
            504,
            'The native request timed out. Its outcome may be uncertain; inspect the task before retrying.',
          ),
        );
      }, this.options.timeoutMs ?? 20000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({ id: requestId, method, params });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  notify(method: string, params: unknown = {}) {
    this.send({ method, params });
  }
  respond(requestId: string | number, result: unknown) {
    this.send({ id: requestId, result });
  }
  refuse(requestId: string | number) {
    this.send({
      id: requestId,
      error: {
        code: -32601,
        message: 'Forge does not support this native request. No permission was granted.',
      },
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'forge_workspace', title: 'Forge', version: '0.1.0' },
    });
    this.notify('initialized');
  }
  private finish(message: string) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ForgeError(502, message));
    }
    this.pending.clear();
    this.emit('closed');
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    this.stopping = new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1500);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.finish('The native connection was closed.');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    return this.stopping;
  }
}
