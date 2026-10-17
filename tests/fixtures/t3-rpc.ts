import { T3Rpc, type T3RpcOptions } from '../../server/backends/t3-rpc.js';

export type NativeFrame = Record<string, unknown>;
export class NativeSocket extends EventTarget {
  readyState = WebSocket.CONNECTING as number;
  sent: NativeFrame[] = [];
  constructor(private handle: (frame: NativeFrame, socket: NativeSocket) => void) {
    super();
    queueMicrotask(() => {
      if (this.readyState === WebSocket.CONNECTING) {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event('open'));
      }
    });
  }
  send(value: string) {
    const frame = JSON.parse(value) as NativeFrame;
    this.sent.push(frame);
    queueMicrotask(() => {
      if (this.readyState === WebSocket.OPEN) this.handle(frame, this);
    });
  }
  emit(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
  success(requestId: unknown, value: unknown) {
    this.emit({ _tag: 'Exit', requestId, exit: { _tag: 'Success', value } });
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}
export function rpcFixture(
  handle: (frame: NativeFrame, socket: NativeSocket) => void,
  overrides: T3RpcOptions = {},
) {
  const sockets: NativeSocket[] = [],
    urls: URL[] = [],
    tickets: RequestInit[] = [];
  const options: T3RpcOptions = {
    timeoutMs: 200,
    fetch: async (_url, request) => {
      tickets.push(request!);
      return Response.json({
        ticket: 'synthetic-ticket',
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      });
    },
    socket: (url) => {
      urls.push(url);
      const socket = new NativeSocket(handle);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    ...overrides,
  };
  return {
    create: (token = 'synthetic-human-token') => new T3Rpc('http://127.0.0.1:3773', token, options),
    sockets,
    urls,
    tickets,
  };
}
