import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { Store } from './store.js';
import { assert } from './errors.js';
import { workspaceHeaders } from './http-security.js';

/** Payload-free UI invalidation over ordinary HTTP. No event history, control authority or model loop. */
export function registerWorkspaceChanges(app: FastifyInstance, store: Store) {
  const clients = new Set<ServerResponse>();
  const relevant = new Set([
    'work',
    'approvals',
    'accounts',
    'companion_grants',
    'companion_handoffs',
    'companion_runtimes',
    'companion_launches',
    'native_controls',
    'notifications',
    'profiles',
    'memory_sources',
    'connectors',
    'config',
    'backends',
    'native_sources',
    'settings',
  ]);
  let pending: NodeJS.Timeout | undefined, heartbeat: NodeJS.Timeout | undefined;
  const send = (client: ServerResponse, message: string) => {
    if (client.destroyed || client.writableEnded) {
      clients.delete(client);
      return;
    }
    // Slow clients receive a fresh snapshot on reconnect, never a growing queue.
    try {
      if (!client.write(message)) client.end();
    } catch {
      client.destroy();
    }
  };
  const unsubscribe = store.onChange((collections) => {
    if (!clients.size || pending || !Array.from(collections).some((name) => relevant.has(name)))
      return;
    pending = setTimeout(() => {
      pending = undefined;
      for (const client of clients) send(client, 'event: workspace-change\ndata: {}\n\n');
    }, 200);
    pending.unref();
  });
  app.get('/api/changes', (request, reply) => {
    assert(
      request.headers['x-forge-workspace'] !== 'demo',
      409,
      'Demo does not subscribe to local changes.',
    );
    assert(clients.size < 16, 429, 'Too many live workspace views. Polling remains available.');
    workspaceHeaders(reply);
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(name, value);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.setTimeout(0);
    clients.add(reply.raw);
    reply.raw.once('error', () => reply.raw.destroy());
    reply.raw.once('close', () => {
      clients.delete(reply.raw);
      if (!clients.size) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    });
    send(reply.raw, 'retry: 5000\n: connected\n\n');
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const client of clients) send(client, ': keepalive\n\n');
      }, 20000);
      heartbeat.unref();
    }
  });
  app.addHook('preClose', async () => {
    unsubscribe();
    clearTimeout(pending);
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear();
  });
}
