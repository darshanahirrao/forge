import { z } from 'zod';
import { assert, ForgeError } from '../errors.js';
import { loopbackEndpoint } from '../adapters/sources.js';

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_PENDING = 16;
const RPC_TIMEOUT = 15000;
const methods = new Set([
  'server.getConfig',
  'server.probe',
  'server.refreshProviders',
  'orchestration.dispatchCommand',
  'orchestration.getThreadProjection',
  'orchestration.getTurnItem',
  'orchestration.subscribeShell',
  'orchestration.subscribeThread',
]);
export type T3Method =
  | 'server.getConfig'
  | 'server.probe'
  | 'server.refreshProviders'
  | 'orchestration.dispatchCommand'
  | 'orchestration.getThreadProjection'
  | 'orchestration.getTurnItem'
  | 'orchestration.subscribeShell'
  | 'orchestration.subscribeThread';

export class T3TransportError extends ForgeError {
  constructor(
    message: string,
    readonly requestSent: boolean,
  ) {
    super(502, message);
  }
}
interface Pending {
  sent: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  stream?: (value: unknown) => void;
}
export interface T3RpcOptions {
  fetch?: typeof fetch;
  socket?: (url: URL) => WebSocket;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** T3 protocol 2 over its native ticketed Effect RPC transport. Never reconnects or replays. */
export class T3Rpc {
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private opening?: Promise<void>;
  private stopped = false;
  private stop = new AbortController();
  private readonly endpoint: string;
  private readonly fetch: typeof fetch;
  private readonly timeout: number;
  private readonly abort: () => void;

  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly options: T3RpcOptions = {},
  ) {
    this.endpoint = new URL(loopbackEndpoint.parse(endpoint)).origin;
    assert(
      token.length > 0 && token.length <= 16384 && !/\s/.test(token),
      400,
      'Pair with the native T3 server again.',
    );
    this.fetch = options.fetch ?? fetch;
    this.timeout = options.timeoutMs ?? RPC_TIMEOUT;
    this.abort = () => this.fail('The native T3 connection was closed.');
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  get closed() {
    return this.stopped;
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.stop.abort();
    this.options.signal?.removeEventListener('abort', this.abort);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new T3TransportError(message, item.sent));
    }
    this.pending.clear();
    this.socket?.close();
  }

  private async open() {
    assert(
      !this.stopped,
      409,
      'This native T3 connection ended. Review native state before reconnecting.',
    );
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.opening = this.connect();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async connect() {
    try {
      const response = await this.fetch(this.endpoint + '/api/auth/websocket-ticket', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(this.timeout)]),
      });
      assert(
        response.ok,
        401,
        'T3 rejected this control connection. Pair with its native app again.',
      );
      const reader = response.body?.getReader();
      assert(reader, 502, 'T3 did not return a connection ticket.');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          assert(length <= 32768, 502, 'T3 returned an oversized connection ticket.');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const ticket = z
        .object({ ticket: z.string().min(1).max(16384), expiresAt: z.string() })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert(!this.stopped, 409, 'The native T3 connection ended before it opened.');
      const url = new URL(this.endpoint.replace(/^http/, 'ws') + '/ws');
      url.searchParams.set('wsTicket', ticket.ticket);
      url.searchParams.set('orchestrationProtocol', '2');
      const socket = this.options.socket?.(url) ?? new WebSocket(url);
      this.socket = socket;
      socket.addEventListener('message', (event) => this.receive(event.data));
      socket.addEventListener('close', () =>
        this.fail('The native T3 stream ended. Nothing was replayed.'),
      );
      socket.addEventListener('error', () =>
        this.fail('The native T3 stream failed. Nothing was replayed.'),
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.fail('The native T3 connection timed out.');
          reject(new T3TransportError('The native T3 connection timed out.', false));
        }, this.timeout);
        const cancelled = () => {
          clearTimeout(timer);
          reject(new T3TransportError('The native T3 connection ended.', false));
        };
        this.stop.signal.addEventListener('abort', cancelled, { once: true });
        socket.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            this.stop.signal.removeEventListener('abort', cancelled);
            resolve();
          },
          { once: true },
        );
      });
    } catch (error) {
      this.fail('The native T3 connection could not open.');
      throw error instanceof ForgeError
        ? error
        : new T3TransportError('The native T3 connection could not open.', false);
    }
  }

  private receive(data: unknown) {
    try {
      assert(
        typeof data === 'string' && Buffer.byteLength(data) <= MAX_FRAME,
        502,
        'The native T3 stream exceeded its response bound.',
      );
      const parsed: unknown = JSON.parse(data);
      const frames = Array.isArray(parsed) ? parsed : [parsed];
      assert(frames.length <= 1000, 502, 'The native T3 stream returned too many frames.');
      for (const frame of frames) {
        assert(
          frame && typeof frame === 'object',
          502,
          'The native T3 stream returned an invalid frame.',
        );
        const value = frame as Record<string, unknown>;
        if (value._tag === 'Ping') {
          this.send({ _tag: 'Pong' });
          continue;
        }
        if (value._tag === 'Pong') continue;
        assert(
          typeof value.requestId === 'string',
          502,
          'The native T3 stream omitted its request identity.',
        );
        const item = this.pending.get(value.requestId);
        if (!item) continue; // A cancelled native subscription can have in-flight frames.
        if (value._tag === 'Chunk') {
          assert(
            item.stream && Array.isArray(value.values) && value.values.length <= 1000,
            502,
            'The native T3 stream returned an unexpected chunk.',
          );
          for (const chunk of value.values) item.stream(chunk);
          this.send({ _tag: 'Ack', requestId: value.requestId });
          continue;
        }
        assert(
          value._tag === 'Exit' && value.exit && typeof value.exit === 'object',
          502,
          'The native T3 stream returned an unsupported frame.',
        );
        clearTimeout(item.timer);
        this.pending.delete(value.requestId);
        const exit = value.exit as Record<string, unknown>;
        if (exit._tag === 'Success') item.resolve(exit.value);
        else
          item.reject(
            new T3TransportError(
              'The native T3 operation was rejected. Inspect its native state before retrying.',
              item.sent,
            ),
          );
      }
    } catch {
      this.fail(
        'The native T3 stream returned unsupported or oversized data. Nothing was replayed.',
      );
    }
  }

  private send(value: unknown) {
    assert(
      !this.stopped && this.socket?.readyState === WebSocket.OPEN,
      409,
      'The native T3 connection is no longer live.',
    );
    this.socket.send(JSON.stringify(value));
  }

  async request(method: T3Method, payload: unknown = {}): Promise<unknown> {
    assert(
      methods.has(method) && !method.startsWith('orchestration.subscribe'),
      400,
      'This native T3 operation is not available here.',
    );
    await this.open();
    assert(
      this.pending.size < MAX_PENDING,
      409,
      'Wait for the current native T3 operations to finish.',
    );
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const item: Pending = { sent: false, resolve, reject };
      item.timer = setTimeout(
        () =>
          this.fail(
            'A native T3 operation timed out. Its outcome must be reviewed before retrying.',
          ),
        this.timeout,
      );
      this.pending.set(id, item);
      try {
        this.send({ _tag: 'Request', id, tag: method, payload, headers: [] });
        item.sent = true;
      } catch {
        this.fail('The native T3 request could not be sent.');
      }
    });
  }

  async subscribe(
    method: 'orchestration.subscribeShell' | 'orchestration.subscribeThread',
    payload: unknown,
    receive: (value: unknown) => void,
  ): Promise<{ close: () => void; ended: Promise<void> }> {
    assert(methods.has(method), 400, 'This native T3 subscription is not available here.');
    await this.open();
    assert(
      this.pending.size < MAX_PENDING,
      409,
      'Wait for the current native T3 operations to finish.',
    );
    const id = String(++this.sequence);
    const ended = new Promise<void>((resolve, reject) => {
      const item: Pending = { sent: false, resolve: () => resolve(), reject, stream: receive };
      this.pending.set(id, item);
      try {
        this.send({ _tag: 'Request', id, tag: method, payload, headers: [] });
        item.sent = true;
      } catch {
        this.fail('The native T3 subscription could not start.');
      }
    });
    void ended.catch(() => {});
    return {
      ended,
      close: () => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        if (!this.stopped) this.send({ _tag: 'Interrupt', requestId: id });
        item.resolve(undefined);
      },
    };
  }

  close() {
    this.fail('The native T3 connection was closed.');
  }
}
