import test from 'node:test';
import assert from 'node:assert/strict';
import { T3TransportError } from '../server/backends/t3-rpc.js';
import { rpcFixture } from './fixtures/t3-rpc.js';

test('native T3 ticketed protocol supports request, streamed ACK, scoped interruption and credential redaction', async () => {
  const fixture = rpcFixture((frame, socket) => {
    if (frame._tag !== 'Request') return;
    if (frame.tag === 'orchestration.subscribeThread')
      socket.emit({
        _tag: 'Chunk',
        requestId: frame.id,
        values: [{ kind: 'snapshot', projection: { fixture: true } }],
      });
    else if (frame.tag === 'orchestration.dispatchCommand')
      socket.emit({
        _tag: 'Exit',
        requestId: frame.id,
        exit: { _tag: 'Failure', cause: { secret: 'native-private-detail' } },
      });
    else socket.success(frame.id, { ok: true });
  });
  const rpc = fixture.create();
  try {
    assert.deepEqual(await rpc.request('server.getConfig'), { ok: true });
    assert.equal(
      new Headers(fixture.tickets[0].headers).get('authorization'),
      'Bearer synthetic-human-token',
    );
    assert.equal(fixture.urls[0].searchParams.get('orchestrationProtocol'), '2');
    assert.equal(fixture.urls[0].searchParams.has('token'), false);
    const received: unknown[] = [];
    const subscription = await rpc.subscribe(
      'orchestration.subscribeThread',
      { threadId: 'exact-thread' },
      (item) => received.push(item),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(received.length, 1);
    assert(fixture.sockets[0].sent.some((frame) => frame._tag === 'Ack'));
    subscription.close();
    await subscription.ended;
    assert(fixture.sockets[0].sent.some((frame) => frame._tag === 'Interrupt'));
    assert.deepEqual(
      await rpc.request('server.probe'),
      { ok: true },
      'Cancelling one stream must leave unrelated requests usable.',
    );
    await assert.rejects(
      rpc.request('orchestration.dispatchCommand', { type: 'fixture' }),
      (error) =>
        error instanceof T3TransportError &&
        error.requestSent &&
        !error.message.includes('native-private-detail'),
    );
    assert.equal(fixture.tickets.length, 1);
  } finally {
    rpc.close();
  }
});

test('native T3 lost acknowledgements retain uncertainty and never reconnect or replay a mutation', async () => {
  let nativeWrites = 0;
  const fixture = rpcFixture((frame, socket) => {
    if (frame._tag === 'Request') {
      nativeWrites++;
      socket.close();
    }
  });
  const rpc = fixture.create();
  await assert.rejects(
    rpc.request('orchestration.dispatchCommand', { commandId: 'stable-exact-command' }),
    (error) => error instanceof T3TransportError && error.requestSent,
  );
  await assert.rejects(
    rpc.request('orchestration.dispatchCommand', { commandId: 'stable-exact-command' }),
    /ended/,
  );
  assert.equal(nativeWrites, 1);
  assert.equal(fixture.tickets.length, 1);
  assert(rpc.closed);
});

test('native T3 timeouts and malformed stream data fail all outstanding requests without leaking native payloads', async () => {
  const silent = rpcFixture(() => {}, { timeoutMs: 20 });
  const timed = silent.create();
  await assert.rejects(
    timed.request('server.probe'),
    (error) => error instanceof T3TransportError && error.requestSent,
  );
  assert(timed.closed);
  const malformed = rpcFixture((frame, socket) => {
    if (frame._tag === 'Request') socket.emit({ private: 'native-private-data' });
  });
  const rpc = malformed.create();
  await assert.rejects(
    rpc.request('server.getConfig'),
    (error) => error instanceof T3TransportError && !error.message.includes('native-private-data'),
  );
  assert(rpc.closed);
});

test('native T3 cancellation before ticket exchange submits no command', async () => {
  const abort = new AbortController();
  abort.abort();
  const fixture = rpcFixture(
    () => {
      throw Error('Nothing may be sent.');
    },
    { signal: abort.signal },
  );
  const rpc = fixture.create();
  await assert.rejects(rpc.request('server.probe'), /ended/);
  assert.equal(fixture.tickets.length, 0);
  assert.equal(fixture.sockets.length, 0);
});
