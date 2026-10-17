import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { Account, Run, Work, WorkspaceBackend } from '../../shared/types.js';
import { assert, ForgeError } from '../errors.js';
import { Store, id, now } from '../store.js';
import { loopbackEndpoint } from '../adapters/sources.js';
import { readPrivateJson, writePrivateJson } from '../private-json.js';
import { T3Rpc } from './t3-rpc.js';
import { t3Config, t3Projects, t3Projection, terminalRunStates } from './t3-contract.js';

const scopes = ['orchestration:read', 'orchestration:operate'];
const credential = z.object({
  version: z.literal(1),
  token: z.string().min(1).max(16384),
  environmentId: z.string(),
});
type Credential = z.infer<typeof credential>;
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
export const driverHarness = (driver: string) =>
  driver === 'claudeAgent' ? 'claude' : driver === 'openCode' ? 'opencode' : driver;

/** Human native-app authority is separate from the read-only MCP source and never forwarded to agents. */
export class T3Backends {
  private ephemeral = new Map<string, Credential>();
  constructor(
    private store: Store,
    private directory?: string,
    private options: {
      fetch?: typeof fetch;
      rpc?: (endpoint: string, token: string) => T3Rpc;
    } = {},
  ) {}
  private client(endpoint: string, token: string) {
    return this.options.rpc?.(endpoint, token) ?? new T3Rpc(endpoint, token);
  }
  list() {
    return this.store.all<WorkspaceBackend>('backends');
  }
  private filename(id: string) {
    return join(this.directory!, `.forge-t3-control-${id}.json`);
  }
  private async secret(backend: WorkspaceBackend) {
    const saved = credential.parse(
      this.directory
        ? await readPrivateJson(this.filename(backend.id))
        : this.ephemeral.get(backend.id),
    );
    assert(
      saved.environmentId === backend.environmentId,
      409,
      'The native T3 environment changed. Pair again.',
    );
    return saved;
  }
  async rpc(backendId: string) {
    const backend = this.store.get<WorkspaceBackend>('backends', backendId);
    assert(
      backend && backend.state !== 'disconnected',
      409,
      'Connect this native execution backend first.',
    );
    const saved = await this.secret(backend);
    return this.client(backend.endpoint, saved.token);
  }
  async inspect(rpc: T3Rpc, expectedEnvironment?: string) {
    const parsed = t3Config.safeParse(await rpc.request('server.getConfig'));

    assert(
      parsed.success,
      502,
      'This T3 version returned an unsupported provider catalogue. No configuration was imported.',
    );
    assert(
      parsed.data.environment.orchestrationProtocolVersion === 2,
      409,
      'Use a T3 server with orchestration protocol 2.',
    );
    assert(
      !expectedEnvironment || parsed.data.environment.environmentId === expectedEnvironment,
      409,
      'The native server identity changed. Nothing was dispatched.',
    );
    return parsed.data;
  }
  async projects(rpc: T3Rpc) {
    let resolve!: (value: ReturnType<typeof t3Projects.parse>['snapshot']['projects']) => void;
    let reject!: (error: Error) => void;
    const first = new Promise<ReturnType<typeof t3Projects.parse>['snapshot']['projects']>(
      (yes, no) => {
        resolve = yes;
        reject = no;
      },
    );
    const timer = setTimeout(
      () => reject(new ForgeError(502, 'The native project catalogue timed out.')),
      15000,
    );
    let subscription;
    try {
      subscription = await rpc.subscribe('orchestration.subscribeShell', {}, (value) => {
        const result = t3Projects.safeParse(value);
        if (result.success) resolve(result.data.snapshot.projects);
      });
      void subscription.ended.catch(() =>
        reject(new ForgeError(502, 'The native project catalogue ended.')),
      );
      return await first;
    } finally {
      clearTimeout(timer);
      subscription?.close();
    }
  }
  async connect(input: { endpoint: string; label: string; code: string }) {
    const endpoint = new URL(loopbackEndpoint.parse(input.endpoint)).origin;
    const response = await (this.options.fetch ?? fetch)(endpoint + '/oauth/token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: input.code,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: scopes.join(' '),
        client_label: 'Forge workspace',
        client_device_type: 'desktop',
        client_os: process.platform,
      }),
    }).catch(() => {
      throw new ForgeError(502, 'The native T3 pairing endpoint is unavailable.');
    });
    assert(
      response.ok,
      401,
      'T3 rejected the pairing code or its scopes. Create a new native read/operate pairing code.',
    );
    // Bound reads even if a local endpoint reports a misleading Content-Length.
    const reader = response.body?.getReader();
    assert(reader, 502, 'T3 returned no pairing response.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        assert(bytes <= 32768, 502, 'The native pairing response was too large.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const parsed = z
      .object({
        access_token: z.string().min(1).max(16384),
        token_type: z.literal('Bearer'),
        scope: z.string(),
      })
      .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    assert(
      parsed.success &&
        parsed.data.scope.split(/\s+/).sort().join(' ') === [...scopes].sort().join(' '),
      409,
      'Pair with exactly native orchestration read and operate scopes.',
    );
    const rpc = this.client(endpoint, parsed.data.access_token);
    try {
      await rpc.request('server.refreshProviders', {});
      const config = await this.inspect(rpc);
      const sameAddress = this.list().find((item) => item.endpoint === endpoint);
      assert(
        !sameAddress || sameAddress.environmentId === config.environment.environmentId,
        409,
        'A different native environment is using this saved address. Its earlier work cannot be rebound automatically.',
      );
      const prior =
        sameAddress ??
        this.list().find((item) => item.environmentId === config.environment.environmentId);
      const backendId = prior?.id ?? id();
      const saved: Credential = {
        version: 1,
        token: parsed.data.access_token,
        environmentId: config.environment.environmentId,
      };
      if (this.directory) await writePrivateJson(this.filename(backendId), saved);
      else this.ephemeral.set(backendId, saved);
      const backend: WorkspaceBackend = {
        contractVersion: 1,
        id: backendId,
        kind: 't3',
        label: input.label,
        endpoint,
        environmentId: saved.environmentId,
        state: 'connected',
        checkedAt: now(),
        error: null,
        providerCount: prior?.providerCount ?? 0,
      };
      try {
        this.import(backend, config);
      } catch (error) {
        if (!prior) {
          if (this.directory) await unlink(this.filename(backendId)).catch(() => {});
          else this.ephemeral.delete(backendId);
        }
        throw error;
      }
      return this.store.get<WorkspaceBackend>('backends', backendId)!;
    } finally {
      rpc.close();
    }
  }
  private import(backend: WorkspaceBackend, config: z.infer<typeof t3Config>) {
    this.store.transaction(() => {
      const seen = new Set<string>();
      for (const provider of config.providers.filter((p) => p.enabled)) {
        const accountId = `t3-${fingerprint(`${backend.id}:${provider.instanceId}`).slice(0, 32)}`;
        const old = this.store.get<Account>('accounts', accountId);
        if (!provider.installed && !old) continue;
        seen.add(accountId);
        const ready =
          provider.installed &&
          ['ready', 'warning'].includes(provider.status) &&
          provider.auth?.status !== 'unauthenticated' &&
          provider.models.length > 0;
        const identity =
          provider.auth?.email ?? provider.auth?.label ?? provider.auth?.profileId ?? null;
        const identityKey =
          provider.auth?.workspaceId ||
          provider.usageLimits?.credentialFingerprint ||
          provider.auth?.profileId;
        const model =
          old?.backend && provider.models.some((m) => m.id === old.backend!.model)
            ? old.backend.model
            : (provider.models.find((model) => model.isDefault)?.id ??
              provider.models[0]?.id ??
              '');
        const account: Account = {
          id: accountId,
          label: provider.displayName ?? provider.instanceId,
          harness: driverHarness(provider.driver),
          nativeHome: provider.runtimePaths?.homePath ?? '',
          billingMode: 'native',
          backend: {
            id: backend.id,
            instanceId: provider.instanceId,
            model,
            ...(old?.backend?.projectId ? { projectId: old.backend.projectId } : {}),
          },
          models: provider.models.map((m) => m.id),
          providerReady: ready,
          state: ready
            ? provider.auth?.status === 'authenticated'
              ? 'verified'
              : 'configured'
            : 'unavailable',
          identity,
          identityKey: identityKey
            ? `t3:${backend.environmentId}:${provider.driver}:${fingerprint(identityKey)}`
            : null,
          plan: null,
          checkedAt: now(),
          error: ready ? null : 'Check this provider instance in T3.',
          quotas: (provider.usageLimits?.windows ?? []).map((window) => ({
            label: window.label,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt ?? null,
            scope: identityKey
              ? `t3:${backend.environmentId}:${provider.driver}:${fingerprint(identityKey)}:${window.id}`
              : `t3:unknown:${backend.id}:${provider.instanceId}:${window.id}`,
            source: 'native',
            observedAt: provider.usageLimits!.checkedAt,
          })),
          createdAt: old?.createdAt ?? now(),
        };
        this.store.put('accounts', accountId, account);
        if (
          old &&
          (old.backend?.model !== account.backend?.model ||
            old.nativeHome !== account.nativeHome ||
            old.harness !== account.harness ||
            old.identityKey !== account.identityKey)
        ) {
          for (const work of this.store
            .all<Work>('work')
            .filter((work) => work.accountId === accountId))
            this.store.updateWork(work.id, {});
        }
      }
      for (const old of this.store
        .all<Account>('accounts')
        .filter((a) => a.backend?.id === backend.id && !seen.has(a.id)))
        this.store.put('accounts', old.id, {
          ...old,
          providerReady: false,
          state: 'unavailable',
          error: 'This native provider instance is disabled or missing.',
          checkedAt: now(),
        });
      this.store.put('backends', backend.id, {
        ...backend,
        state: 'connected',
        checkedAt: now(),
        error: null,
        providerCount: seen.size,
      });
    });
  }
  async refresh(backendId: string) {
    const backend = this.store.get<WorkspaceBackend>('backends', backendId);
    assert(backend, 404, 'This backend was not found.');
    const rpc = await this.rpc(backendId);
    try {
      await rpc.request('server.refreshProviders', {});
      this.import(backend, await this.inspect(rpc, backend.environmentId));
      return this.store.get<WorkspaceBackend>('backends', backendId)!;
    } catch {
      this.store.put('backends', backendId, {
        ...backend,
        state: 'error',
        checkedAt: now(),
        error: 'Native catalogue unavailable. Reconnect or inspect T3.',
      });
      throw new ForgeError(502, 'The native catalogue could not be refreshed.');
    } finally {
      rpc.close();
    }
  }
  async disconnect(backendId: string) {
    const backend = this.store.get<WorkspaceBackend>('backends', backendId);
    assert(backend, 404, 'This backend was not found.');
    if (this.directory) await unlink(this.filename(backendId)).catch(() => {});
    else this.ephemeral.delete(backendId);
    this.store.transaction(() => {
      this.store.put('backends', backendId, {
        ...backend,
        state: 'disconnected',
        checkedAt: now(),
      });
      for (const account of this.store
        .all<Account>('accounts')
        .filter((a) => a.backend?.id === backendId))
        this.store.put('accounts', account.id, {
          ...account,
          providerReady: false,
          state: 'unavailable',
          error: 'The native backend is disconnected.',
        });
    });
    // Native grant revocation remains available in T3. Disconnect never cancels someone else's tasks.
  }
  async reconcile(run: Run, interrupt: boolean) {
    const receipt = run.settlement;
    assert(receipt && !receipt.confirmed, 409, 'This run has no unsettled delegated reference.');
    const account = this.store.account(run.accountId);
    assert(
      account.backend?.id === receipt.backendId,
      409,
      'This account no longer matches the delegated run.',
    );
    const rpc = await this.rpc(receipt.backendId);
    try {
      await this.inspect(
        rpc,
        this.list().find((item) => item.id === receipt.backendId)?.environmentId,
      );
      const read = async () => {
        const parsed = t3Projection.safeParse(
          await rpc.request('orchestration.getThreadProjection', { threadId: receipt.threadId }),
        );
        assert(
          parsed.success && parsed.data.thread.id === receipt.threadId,
          409,
          'This exact native thread could not be read. Nothing was replayed.',
        );
        const native = parsed.data.runs.find((item) => item.userMessageId === receipt.messageId);
        assert(
          native &&
            (!receipt.runId || receipt.runId === native.id) &&
            native.providerInstanceId === account.backend!.instanceId,
          409,
          'This exact native run could not be matched. Inspect T3 before continuing.',
        );
        return {
          native,
          background:
            parsed.data.providerThreads.some((thread) => thread.pendingBackgroundTasks?.length) ||
            parsed.data.runs.some((run) => !terminalRunStates.has(run.status)),
        };
      };
      let current = await read();
      if (interrupt && !terminalRunStates.has(current.native.status)) {
        await rpc.request('orchestration.dispatchCommand', {
          type: 'run.interrupt',
          commandId: `forge-reconcile-stop-${run.id}`,
          threadId: receipt.threadId,
          runId: current.native.id,
          holdQueue: true,
          reason: 'Forge user requested exact run reconciliation and stop',
        });
        const deadline = Date.now() + 12000;
        do {
          current = await read();
          if (terminalRunStates.has(current.native.status) && !current.background) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        } while (Date.now() < deadline);
      }
      assert(
        terminalRunStates.has(current.native.status) && !current.background,
        409,
        'T3 still owns active or background work. Stop and reconcile that exact run before another launch.',
      );
      return {
        ...receipt,
        runId: current.native.id,
        state: current.native.status,
        confirmed: true,
        observedAt: now(),
      };
    } finally {
      rpc.close();
    }
  }
}
