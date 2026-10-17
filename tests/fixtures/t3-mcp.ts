import Fastify from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export async function t3Fixture() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  const tokens = new Set<string>();
  const grants = new Map<string, URL>();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Set<McpServer>();
  const calls: { name: string; arguments: unknown }[] = [];
  const settings = {
    scope: 'orchestration:read',
    name: 'T3 Code',
    readHints: true,
    revoked: false,
    externalMetadata: '',
    oversized: false,
    tokenRequests: 0,
    registrations: 0,
    projectCursor: null as number | null,
    threadCursor: null as number | null,
    projects: [{ id: 'project-1', title: 'T3 project', workspaceRoot: '/fixture/t3-project' }],
    threads: [
      {
        threadId: 'thread-1',
        title: 'Native T3 work',
        status: 'waiting',
        providerInstanceId: 'codex-work',
        updatedAt: '2026-10-17T05:00:00.000Z',
        messages: ['excluded-native-transcript'],
        approval: { action: 'excluded-native-command' },
      },
    ],
  };
  let origin = '';
  const metadata = () => ({
    issuer: origin,
    authorization_endpoint: (settings.externalMetadata || origin) + '/authorize',
    token_endpoint: (settings.externalMetadata || origin) + '/token',
    registration_endpoint: (settings.externalMetadata || origin) + '/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['orchestration:read', 'orchestration:operate'],
  });
  app.get('/.well-known/oauth-authorization-server', () => metadata());
  const resource = () => ({
    resource: origin + '/mcp',
    authorization_servers: [origin],
    scopes_supported: ['orchestration:read'],
    bearer_methods_supported: ['header'],
  });
  app.get('/.well-known/oauth-protected-resource', resource);
  app.get('/.well-known/oauth-protected-resource/mcp', resource);
  app.post('/register', async (request, reply) => {
    settings.registrations++;
    return reply.code(201).send({
      ...(request.body as object),
      client_id: 'forge-fixture',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });
  const approve = (authorizationUrl: string) => {
    const url = new URL(authorizationUrl);
    const code = randomUUID();
    grants.set(code, url);
    const result = new URL(url.searchParams.get('redirect_uri')!);
    result.searchParams.set('state', url.searchParams.get('state')!);
    result.searchParams.set('code', code);
    result.searchParams.set('iss', origin);
    return result;
  };
  app.get('/authorize', async (request, reply) => {
    const key = randomUUID();
    grants.set(key, new URL(origin + request.url));
    return reply
      .type('text/html')
      .send(
        `<!doctype html><html lang="en"><title>T3 Code test sign-in</title><body><main><h1>T3 Code test sign-in</h1><p>Allow Forge to read activity. No agent will start.</p><form action="/consent"><input type="hidden" name="key" value="${key}"><button>Allow read-only activity</button></form></main></body></html>`,
      );
  });
  app.get('/consent', async (request, reply) => {
    const url = grants.get((request.query as { key: string }).key);
    if (!url) return reply.code(400).send({ error: 'Unknown fixture flow.' });
    return reply.redirect(approve(url.toString()).toString());
  });
  app.post('/token', async (request, reply) => {
    settings.tokenRequests++;
    const body = request.body as Record<string, string>;
    const grant = grants.get(body.code);
    grants.delete(body.code);
    const challenge = createHash('sha256')
      .update(body.code_verifier ?? '')
      .digest('base64url');
    if (
      !grant ||
      challenge !== grant.searchParams.get('code_challenge') ||
      body.redirect_uri !== grant.searchParams.get('redirect_uri')
    )
      return reply.code(400).send({ error: 'invalid_grant' });
    const token = randomUUID();
    tokens.add(token);
    return { access_token: token, token_type: 'Bearer', expires_in: 1800, scope: settings.scope };
  });
  const payload = (value: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  });
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      const bearer = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!tokens.has(bearer) || settings.revoked)
        return reply
          .code(401)
          .header(
            'WWW-Authenticate',
            `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          )
          .send({ error: 'Unauthorized' });
      if (request.method === 'GET') return reply.code(405).send();
      const session = request.headers['mcp-session-id'] as string | undefined;
      let transport = session ? transports.get(session) : undefined;
      if (!transport) {
        if (
          session ||
          request.method !== 'POST' ||
          (request.body as { method?: string })?.method !== 'initialize'
        )
          return reply.code(404).send();
        const server = new McpServer({ name: settings.name, version: '0.1.0-fixture' });
        servers.add(server);
        server.registerTool(
          't3_project_list',
          {
            inputSchema: { limit: z.number().int().min(1).max(100).optional() },
            annotations: { readOnlyHint: settings.readHints },
          },
          async (args) => {
            calls.push({ name: 't3_project_list', arguments: args });
            return payload({
              projects: settings.projects,
              nextCursor: settings.projectCursor,
              ...(settings.oversized ? { excluded: 'x'.repeat(3 * 1024 * 1024) } : {}),
            });
          },
        );
        server.registerTool(
          't3_thread_list',
          {
            inputSchema: {
              projectId: z.string(),
              limit: z.number().int().min(1).max(100),
              includeSubagents: z.boolean().optional(),
            },
            annotations: { readOnlyHint: settings.readHints },
          },
          async (args) => {
            calls.push({ name: 't3_thread_list', arguments: args });
            return payload({
              threads: settings.threads,
              nextCursor: settings.threadCursor,
              total: settings.threads.length,
              projectId: args.projectId,
              currentThreadId: null,
            });
          },
        );
        server.registerTool(
          't3_project_create',
          { inputSchema: { title: z.string() } },
          async (args) => {
            calls.push({ name: 't3_project_create', arguments: args });
            return {
              content: [{ type: 'text', text: 'Read-only credentials cannot create projects.' }],
              isError: true,
            };
          },
        );
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        await server.connect(transport);
      }
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return {
    origin,
    settings,
    calls,
    approve,
    close: async () => {
      app.server.closeAllConnections();
      await Promise.allSettled([...servers].map((server) => server.close()));
      await app.close();
    },
  };
}
