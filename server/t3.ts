import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import type { NativeInventory, NativeSession, NativeSource } from '../shared/types.js';
import { assert, ForgeError } from './errors.js';
import { Store, now } from './store.js';
import { loopbackEndpoint } from './adapters/sources.js';
import { version } from '../shared/version.js';

const MAX_RESPONSE = 2 * 1024 * 1024;
const LIFETIME = 10 * 60 * 1000;
const PROJECT_LIMIT = 20;
const SESSION_LIMIT = 100;
const readScope = 'orchestration:read';
export const t3Endpoint = z
  .string()
  .trim()
  .max(300)
  .transform((value) => value.replace(/\/mcp\/?$/, ''))
  .pipe(loopbackEndpoint)
  .transform((value) => new URL(value).origin);
const short = z.string().max(200);
const cursor = z.number().int().nonnegative().nullable();
const projectsSchema = z.object({
  projects: z
    .array(
      z.object({
        id: short.min(1),
        title: z.string().max(20000),
        workspaceRoot: z.string().max(2000),
      }),
    )
    .max(PROJECT_LIMIT),
  nextCursor: cursor,
});
const threadsSchema = z.object({
  threads: z
    .array(
      z.object({
        threadId: short.min(1),
        title: z.string().max(20000),
        status: short,
        providerInstanceId: short,
        updatedAt: z.iso.datetime({ offset: true }),
      }),
    )
    .max(SESSION_LIMIT),
  nextCursor: cursor,
});
const credentialSchema = z.object({
  version: z.literal(1),
  endpoint: t3Endpoint,
  client: OAuthClientInformationSchema.extend({ issuer: z.string().optional() }),
  tokens: OAuthTokensSchema,
});
type Credential = z.infer<typeof credentialSchema>;
type Flow = {
  id: string;
  endpoint: string;
  label: string;
  expiresAt: number;
  state: string;
  redirectUrl: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  authorizationUrl?: string;
};

function readonlyTokens(tokens: OAuthTokens) {
  const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [];
  assert(
    tokens.token_type.toLowerCase() === 'bearer' && scopes.length === 1 && scopes[0] === readScope,
    409,
    'Choose Read only on the T3 Code sign-in page. Forge does not accept an execution grant for activity discovery.',
  );
}

/** SDK framing, OAuth/PKCE and native tools are reused; there is no general tool proxy. */
export class T3Connections {
  private pending: Flow | null = null;
  private completing = new Set<string>();
  private memory = new Map<string, Credential>();
  private tasks = new Set<Promise<unknown>>();
  private shutdown = new AbortController();
  constructor(
    private store: Store,
    private credentialDirectory?: string,
  ) {}

  private track<T>(operation: () => Promise<T>): Promise<T> {
    assert(!this.shutdown.signal.aborted, 409, 'Forge is closing this connection.');
    const task = operation();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  private fetchFor(endpoint: string, signal?: AbortSignal): typeof fetch {
    return async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      assert(
        target.origin === endpoint && !target.username && !target.password,
        502,
        'T3 Code advertised an address outside the selected local server.',
      );
      const requestAbort = new AbortController();
      const response = await fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          this.shutdown.signal,
          requestAbort.signal,
          AbortSignal.timeout(8000),
          ...(signal ? [signal] : []),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      if (!response.body) return response;
      const reader = response.body.getReader();
      let bytes = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read();
              if (result.done) {
                controller.close();
                return;
              }
              bytes += result.value.byteLength;
              if (bytes > MAX_RESPONSE) {
                requestAbort.abort();
                void reader.cancel().catch(() => {});
                controller.error(new Error('Native MCP response size exceeded.'));
                return;
              }
              controller.enqueue(result.value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel: () => {
            requestAbort.abort();
            return reader.cancel().catch(() => {});
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    };
  }

  private provider(flow: Flow): OAuthClientProvider {
    return {
      redirectUrl: flow.redirectUrl,
      clientMetadata: {
        client_name: 'Forge activity',
        redirect_uris: [flow.redirectUrl],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: readScope,
      },
      state: () => flow.state,
      clientInformation: () => flow.client,
      saveClientInformation: (value) => {
        flow.client = value;
      },
      tokens: () => flow.tokens,
      saveTokens: (value) => {
        readonlyTokens(value);
        flow.tokens = value;
      },
      saveCodeVerifier: (value) => {
        flow.verifier = value;
      },
      codeVerifier: () => {
        assert(flow.verifier, 409, 'Start a new T3 Code connection from Activity.');
        return flow.verifier;
      },
      redirectToAuthorization: (url) => {
        assert(
          url.origin === flow.endpoint,
          502,
          'T3 Code sign-in must stay on the selected local server.',
        );
        flow.authorizationUrl = url.toString();
      },
    };
  }

  begin(input: { endpoint: string; label: string }, redirectUrl: string) {
    return this.track(async () => {
      const endpoint = t3Endpoint.parse(input.endpoint);
      assert(this.completing.size === 0, 409, 'Wait for the current T3 Code sign-in to finish.');
      const existing = this.store
        .all<NativeSource>('native_sources')
        .find((s) => s.kind === 't3-code' && s.endpoint === endpoint);
      const flow: Flow = {
        id: existing?.id ?? randomUUID(),
        label: input.label,
        endpoint,
        state: randomBytes(32).toString('hex'),
        expiresAt: Date.now() + LIFETIME,
        redirectUrl,
      };
      this.pending = flow; // A new explicit sign-in invalidates an unfinished browser flow.
      try {
        const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
        const result = await auth(this.provider(flow), {
          serverUrl: new URL(endpoint + '/mcp'),
          scope: readScope,
          fetchFn: this.fetchFor(endpoint, AbortSignal.timeout(20000)),
        });
        assert(
          result === 'REDIRECT' && flow.authorizationUrl,
          502,
          'The local server did not provide a T3 Code sign-in page.',
        );
        return { authorizationUrl: flow.authorizationUrl };
      } catch (error) {
        if (this.pending === flow) this.pending = null;
        throw error instanceof ForgeError
          ? error
          : new ForgeError(
              502,
              'T3 Code sign-in could not start. Check the local server address and its MCP OAuth support.',
            );
      }
    });
  }

  finish(state: string, code: string, issuer: string) {
    return this.track(async () => {
      const flow = this.pending;
      assert(
        flow && state === flow.state && flow.expiresAt > Date.now(),
        409,
        'This T3 Code sign-in expired or was already used. Start again from Activity.',
      );
      assert(
        issuer === flow.endpoint,
        409,
        'T3 Code sign-in returned a different server identity.',
      );
      this.pending = null; // A callback is consumed once, before token exchange.
      this.completing.add(flow.id);
      try {
        const signal = AbortSignal.timeout(20000);
        const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
        const result = await auth(this.provider(flow), {
          serverUrl: new URL(flow.endpoint + '/mcp'),
          authorizationCode: code,
          fetchFn: this.fetchFor(flow.endpoint, signal),
        });
        assert(
          result === 'AUTHORIZED' && flow.client && flow.tokens,
          502,
          'T3 Code did not complete read-only sign-in.',
        );
        readonlyTokens(flow.tokens);
        const credential: Credential = credentialSchema.parse({
          version: 1,
          endpoint: flow.endpoint,
          client: flow.client,
          tokens: flow.tokens,
        });
        // Identity and the required native read tools are checked before accepting credentials.
        await this.session(credential, async () => {}, signal);
        assert(!this.shutdown.signal.aborted, 409, 'Forge is closing this connection.');
        await this.save(flow.id, credential);
        const previous = this.store.get<NativeSource>('native_sources', flow.id);
        const source: NativeSource = {
          ...previous,
          id: flow.id,
          kind: 't3-code',
          label: flow.label,
          endpoint: flow.endpoint,
          home: '',
          authentication: 'oauth',
          state: 'configured',
          checkedAt: previous?.checkedAt ?? null,
          error: null,
          capabilities: ['read-only MCP', 'T3-owned execution'],
        };
        this.store.put('native_sources', source.id, source);
        return source;
      } catch (error) {
        throw error instanceof ForgeError
          ? error
          : new ForgeError(
              502,
              'T3 Code sign-in could not be completed. Reconnect from Activity and choose Read only.',
            );
      } finally {
        this.completing.delete(flow.id);
      }
    });
  }

  cancel(state: string) {
    if (this.pending?.state === state) this.pending = null;
  }

  private filename(id: string) {
    assert(/^[0-9a-f-]{36}$/.test(id), 409, 'This T3 Code source has an invalid identity.');
    return this.credentialDirectory ? join(this.credentialDirectory, `.forge-t3-${id}.json`) : null;
  }

  private async load(id: string) {
    const filename = this.filename(id);
    if (!filename) {
      const value = this.memory.get(id);
      assert(value, 409, 'Reconnect T3 Code from Activity to restore its read-only sign-in.');
      return value;
    }
    let handle;
    try {
      handle = await open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const info = await handle.stat();
      assert(
        info.isFile() &&
          info.size <= 32768 &&
          (process.platform === 'win32' ||
            ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())),
        409,
        'The T3 Code credential reference must be a private, owned regular file.',
      );
      const buffer = Buffer.alloc(32769);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      assert(length <= 32768, 409, 'The T3 Code credential file is too large.');
      return credentialSchema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    } catch (error) {
      throw error instanceof ForgeError
        ? error
        : new ForgeError(409, 'T3 Code sign-in is unavailable. Reconnect from Activity.');
    } finally {
      await handle?.close();
    }
  }

  private async save(id: string, value: Credential) {
    const encoded = JSON.stringify(value);
    assert(
      Buffer.byteLength(encoded) <= 32768,
      502,
      'T3 Code returned oversized sign-in metadata.',
    );
    const filename = this.filename(id);
    if (!filename) {
      this.memory.set(id, value);
      return;
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private async session<T>(
    credential: Credential,
    read: (client: Client, signal: AbortSignal) => Promise<T>,
    deadline?: AbortSignal,
  ) {
    readonlyTokens(credential.tokens);
    const [{ Client: NativeClient }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    const signal = deadline ?? AbortSignal.timeout(20000);
    const client = new NativeClient({ name: 'Forge activity', version });
    const transport = new StreamableHTTPClientTransport(new URL(credential.endpoint + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${credential.tokens.access_token}` } },
      fetch: this.fetchFor(credential.endpoint, signal),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    try {
      await client.connect(transport, { timeout: 8000, signal });
      assert(
        client.getServerVersion()?.name === 'T3 Code',
        502,
        'This server did not identify itself as T3 Code.',
      );
      const tools = await client.listTools({}, { timeout: 8000, signal });
      for (const name of ['t3_project_list', 't3_thread_list'])
        assert(
          tools.tools.some((t) => t.name === name && t.annotations?.readOnlyHint === true),
          502,
          'T3 Code did not advertise the required read-only activity tools. Update its MCP interface.',
        );
      return await read(client, signal);
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  }

  read(source: NativeSource) {
    return this.track(async () => {
      const credential = await this.load(source.id);
      assert(
        credential.endpoint === source.endpoint,
        409,
        'Reconnect this T3 Code source after changing its address.',
      );
      try {
        return await this.session(credential, async (client, signal) => {
          const call = async (
            name: 't3_project_list' | 't3_thread_list',
            args: Record<string, unknown>,
          ) => {
            const result = await client.callTool({ name, arguments: args }, undefined, {
              timeout: 8000,
              signal,
            });
            assert(
              !result.isError,
              502,
              'T3 Code could not read this activity page. Check the native client, then refresh.',
            );
            if (result.structuredContent) return result.structuredContent;
            const parts = result.content as { type: string; text?: string }[];
            assert(
              parts.length === 1 && parts[0].type === 'text' && parts[0].text,
              502,
              'T3 Code returned unsupported activity metadata.',
            );
            return JSON.parse(parts[0].text);
          };
          const projects = projectsSchema.parse(
            await call('t3_project_list', { limit: PROJECT_LIMIT }),
          );
          assert(
            new Set(projects.projects.map((project) => project.id)).size ===
              projects.projects.length,
            502,
            'T3 Code returned duplicate project identities.',
          );
          const sessions: NativeSession[] = [];
          const ids = new Set<string>();
          let moreAvailable = projects.nextCursor !== null;
          const checkedAt = now();
          for (let index = 0; index < projects.projects.length; index++) {
            const project = projects.projects[index];
            const page = threadsSchema.parse(
              await call('t3_thread_list', {
                projectId: project.id,
                limit: SESSION_LIMIT - sessions.length,
                includeSubagents: true,
              }),
            );
            assert(
              page.threads.length <= SESSION_LIMIT - sessions.length,
              502,
              'T3 Code exceeded the requested activity page size.',
            );
            moreAvailable ||= page.nextCursor !== null;
            for (const row of page.threads) {
              assert(
                !ids.has(row.threadId),
                502,
                'T3 Code returned duplicate native thread identities.',
              );
              ids.add(row.threadId);
              sessions.push({
                id: row.threadId,
                title: row.title.slice(0, 160),
                harness: 'T3 Code',
                providerInstanceId: row.providerInstanceId,
                status: `T3 reports ${row.status}`,
                project: project.title.slice(0, 160),
                cwd: project.workspaceRoot,
                source: 't3-code/mcp',
                sourceId: source.id,
                updatedAt: row.updatedAt,
                observedAt: checkedAt,
                control: 'observed',
              });
            }
            if (sessions.length >= SESSION_LIMIT) {
              moreAvailable ||= index + 1 < projects.projects.length;
              break;
            }
          }
          const inventory: NativeInventory = {
            sessions,
            schedules: [],
            moreAvailable,
            checkedAt,
            projects: projects.projects.length,
          };
          return {
            inventory,
            capabilities: [
              'read-only MCP',
              'native project/thread metadata',
              'T3-owned execution and approvals',
              'schedules not imported',
            ],
          };
        });
      } catch (error) {
        throw error instanceof ForgeError
          ? error
          : new ForgeError(
              502,
              'T3 Code activity could not be read. Check the native server or reconnect its read-only sign-in.',
            );
      }
    });
  }

  async forget(source: NativeSource) {
    if (this.pending?.id === source.id) this.pending = null;
    this.memory.delete(source.id);
    const filename = this.filename(source.id);
    if (filename)
      await unlink(filename).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT')
          throw new ForgeError(409, 'The local T3 Code credential reference could not be removed.');
      });
  }

  async close() {
    this.shutdown.abort();
    this.pending = null;
    await Promise.allSettled([...this.tasks]);
    this.memory.clear();
  }

  assertCanForget(id: string) {
    assert(
      !this.completing.has(id),
      409,
      'Wait for T3 Code sign-in to finish before disconnecting.',
    );
  }
}
