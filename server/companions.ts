import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  Account,
  CompanionActor,
  CompanionGrant,
  CompanionScope,
  Run,
  Work,
  WorkEvent,
  WorkSummary,
} from '../shared/types.js';
import { assert, ForgeError, safeMessage } from './errors.js';
import { ExecutionController } from './execution.js';
import { Profiles } from './memory.js';
import { Store, id, now } from './store.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = (account: Account) =>
  digest({
    harness: account.harness,
    home: account.nativeHome,
    credential: account.credentialEnv,
    billing: account.billingMode,
    backend: account.backend,
    identity: account.identityKey,
  });
const within = (root: string, directory: string) => {
  const path = relative(root, directory);
  return (
    isAbsolute(directory) &&
    (path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)))
  );
};
export const companionIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
export const companionGrantSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    profileId: companionIdentifier,
    root: z.string().min(1).max(2000),
    scopes: z
      .array(z.enum(['work:read', 'context:read', 'work:write', 'work:dispatch']))
      .min(1)
      .max(4),
    accountIds: z.array(companionIdentifier).max(32).default([]),
    dispatch: z
      .object({ allowMetered: z.boolean(), maxRuns: z.number().int().min(1).max(1000) })
      .strict()
      .nullable()
      .default(null),
    expiresInDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();
export const companionRequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/);
export const companionWorkInput = z
  .object({
    requestId: companionRequestId,
    title: z.string().trim().min(1).max(140),
    goal: z.string().trim().min(1).max(20000),
    acceptance: z.string().trim().max(10000).default(''),
    context: z.string().trim().max(30000).default(''),
    directory: z.string().max(2000).default('.'),
    accountId: companionIdentifier.optional(),
  })
  .strict();
export const companionCheckpointInput = z
  .object({
    requestId: companionRequestId,
    workId: companionIdentifier,
    expectedRevision: z.number().int().nonnegative(),
    note: z.string().trim().min(1).max(8000),
  })
  .strict();
export const companionStartInput = z
  .object({
    requestId: companionRequestId,
    workId: companionIdentifier,
    expectedRevision: z.number().int().nonnegative(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const companionInterruptInput = z
  .object({ requestId: companionRequestId, workId: companionIdentifier })
  .strict();
interface StoredGrant extends Omit<CompanionGrant, 'runsStarted'> {
  tokenHash: string;
  bindings: Record<string, string>;
}
interface Operation {
  grantId: string;
  requestId: string;
  tool: string;
  inputHash: string;
  state: 'pending' | 'succeeded' | 'failed';
  result?: unknown;
  reference?: { collection: 'work' | 'events' | 'runs'; id: string };
  error?: string;
  status?: number;
  workId?: string;
  createdAt: string;
}

/** Native MCP clients keep their own agent loop. This grants only explicit Forge operations. */
export class Companions {
  constructor(
    private store: Store,
    private profiles: Profiles,
    private controller: ExecutionController,
  ) {}
  private public(grant: StoredGrant): CompanionGrant {
    const { tokenHash: _secret, bindings: _bindings, ...value } = grant;
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS total FROM records WHERE collection='runs' AND json_extract(data,'$.requestedBy.grantId')=?",
      )
      .get(grant.id) as { total: number };
    return {
      ...value,
      runsStarted: count.total,
    };
  }
  list() {
    return this.store
      .all<StoredGrant>('companion_grants')
      .slice(0, 100)
      .map((grant) => this.public(grant));
  }
  async create(value: unknown) {
    const input = companionGrantSchema.parse(value);
    this.profiles.profile(input.profileId);
    assert(
      isAbsolute(input.root) && !/[\x00-\x1f]/.test(input.root),
      400,
      'Choose an absolute project directory.',
    );
    const root = await realpath(input.root).catch(() => null);
    assert(
      root && (await stat(root)).isDirectory(),
      400,
      'The companion project directory was not found.',
    );
    this.profiles.profile(input.profileId);
    assert(
      new Set(input.scopes).size === input.scopes.length && input.scopes.includes('work:read'),
      400,
      'Choose distinct scopes including work:read.',
    );
    assert(
      new Set(input.accountIds).size === input.accountIds.length,
      400,
      'Choose distinct native account bindings.',
    );
    assert(
      input.scopes.includes('work:dispatch') === Boolean(input.dispatch),
      400,
      'Dispatch access needs an explicit finite run limit and billing choice.',
    );
    assert(
      !input.dispatch || (input.accountIds.length > 0 && input.scopes.includes('context:read')),
      400,
      'Dispatch needs selected accounts and context access.',
    );
    assert(
      this.store
        .all<StoredGrant>('companion_grants')
        .filter((grant) => !grant.revokedAt && grant.expiresAt > now()).length < 32,
      409,
      'Revoke an unused companion grant before adding another.',
    );
    const bindings = Object.fromEntries(
      input.accountIds.map((accountId) => [accountId, binding(this.store.account(accountId))]),
    );
    const grantId = id();
    const token = `forgec_${grantId}.${randomBytes(32).toString('base64url')}`;
    const grant: StoredGrant = {
      contractVersion: 1,
      id: grantId,
      label: input.label,
      root,
      profileId: input.profileId,
      scopes: input.scopes,
      accountIds: input.accountIds,
      dispatch: input.dispatch,
      createdAt: now(),
      expiresAt: new Date(Date.now() + input.expiresInDays * 86400000).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      bindings,
      tokenHash: digest(token),
    };
    this.store.put('companion_grants', grant.id, grant);
    // The caller receives the bearer once. Only its hash is retained in SQLite.
    return { grant: this.public(grant), token };
  }
  revoke(grantId: string) {
    const grant = this.store.get<StoredGrant>('companion_grants', grantId);
    assert(grant, 404, 'This companion grant was not found.');
    return this.public(
      this.store.put('companion_grants', grantId, {
        ...grant,
        revokedAt: grant.revokedAt ?? now(),
      }),
    );
  }
  authenticate(header: string | undefined) {
    const match = /^Bearer (forgec_([0-9a-f-]{36})\.[A-Za-z0-9_-]{43})$/.exec(header ?? '');
    const grant = match ? this.store.get<StoredGrant>('companion_grants', match[2]) : null;
    const actual = digest(match?.[1] ?? '');
    assert(
      grant && timingSafeEqual(Buffer.from(grant.tokenHash, 'hex'), Buffer.from(actual, 'hex')),
      401,
      'Use a valid companion bearer for this MCP endpoint.',
    );
    this.authorize(grant.id, 'work:read');
    if (!grant.lastUsedAt || Date.now() - Date.parse(grant.lastUsedAt) >= 60000)
      this.store.put('companion_grants', grant.id, { ...grant, lastUsedAt: now() });
    return this.public(grant);
  }
  private authorize(grantId: string, scope: CompanionScope, workId?: string) {
    const grant = this.store.get<StoredGrant>('companion_grants', grantId);
    assert(
      grant && !grant.revokedAt && grant.expiresAt > now(),
      401,
      'This companion grant expired or was revoked.',
    );
    assert(
      grant.scopes.includes(scope),
      403,
      'This companion grant does not allow that operation.',
    );
    this.profiles.profile(grant.profileId);
    if (workId) {
      const work = this.store.work(workId);
      assert(
        work.profileId === grant.profileId && within(grant.root, work.cwd),
        403,
        'This work is outside the companion profile or project scope.',
      );
    }
    return grant;
  }
  private account(grant: StoredGrant, accountId: string) {
    assert(
      grant.accountIds.includes(accountId),
      403,
      'This native account was not granted to the companion.',
    );
    const account = this.store.account(accountId);
    assert(
      grant.bindings[accountId] === binding(account),
      409,
      'This native account binding changed. Create a new companion grant before dispatching through it.',
    );
    return account;
  }
  private async directory(grant: StoredGrant, value: string) {
    const [currentRoot, directory] = await Promise.all([
      realpath(grant.root).catch(() => null),
      realpath(resolve(grant.root, value)).catch(() => null),
    ]);
    assert(
      currentRoot === grant.root &&
        directory &&
        within(grant.root, directory) &&
        (await stat(directory)).isDirectory(),
      403,
      'This directory is unavailable or escapes the granted project.',
    );
    return directory;
  }
  workspace(grantId: string) {
    const grant = this.authorize(grantId, 'work:read');
    const all = this.store
      .all<WorkSummary>('work_summaries')
      .filter((work) => work.profileId === grant.profileId && within(grant.root, work.cwd));
    return {
      contractVersion: 1,
      grant: this.public(grant),
      profile: { id: grant.profileId, name: this.profiles.profile(grant.profileId).name },
      work: all.slice(0, 100),
      total: all.length,
      truncated: all.length > 100,
      accounts: grant.accountIds.map((accountId) => {
        const account = this.store.get<Account>('accounts', accountId);
        return account
          ? {
              id: account.id,
              label: account.label,
              harness: account.harness,
              billingMode: account.billingMode,
              state: account.state,
              models: account.models,
              model: account.backend?.model,
              providerReady: account.providerReady,
              checkedAt: account.checkedAt,
              ordinaryUsageAllowed: account.ordinaryUsageAllowed ?? null,
              quotas: account.quotas.map((quota) => ({
                ...quota,
                scope: `quota:${digest(quota.scope)}`,
              })),
              bindingCurrent: grant.bindings[accountId] === binding(account),
            }
          : { id: accountId, state: 'unavailable', bindingCurrent: false };
      }),
      admission: {
        quietMode: this.store.settings().quietMode,
        maxConcurrent: this.store.settings().maxConcurrent,
      },
    };
  }
  work(grantId: string, workId: string) {
    this.authorize(grantId, 'work:read', workId);
    return {
      work: this.store.work(workId),
      events: this.store.recentEvents(workId, 30).map((event) => ({
        ...event,
        detail: event.detail.slice(0, 2000),
        clipped: event.detail.length > 2000,
      })),
      runs: this.store.db
        .prepare(
          "SELECT data FROM records WHERE collection='runs' AND json_extract(data,'$.workId')=? ORDER BY rowid DESC LIMIT 10",
        )
        .all(workId)
        .map((row) => JSON.parse(String(row.data)) as Run),
    };
  }
  async context(grantId: string, workId: string) {
    const grant = this.authorize(grantId, 'context:read', workId);
    const work = this.store.work(workId);
    const directory = await this.directory(grant, work.cwd);
    assert(
      directory === work.cwd,
      409,
      'The saved project directory changed. Review the work in Forge.',
    );
    const review = await this.profiles.review(work);
    this.authorize(grantId, 'context:read', workId);
    return {
      workId,
      revision: work.revision,
      profileId: review.receipt.profileId,
      profileRevision: review.receipt.profileRevision,
      instructions: review.instructions,
      memories: review.memories,
      sources: review.receipt.sources.map((source) => ({
        id: source.id,
        label: source.label,
        selectionSha256: source.selectionSha256,
      })),
      reviewDigest: review.receipt.reviewDigest,
      contentDigest: review.receipt.contentDigest,
      coverage:
        'Current selected profile memory only. Reading context does not grant tools or approve execution.',
    };
  }
  private actor(grant: StoredGrant, requestId: string): CompanionActor {
    return { kind: 'companion', grantId: grant.id, label: grant.label, requestId };
  }
  private async operation<T>(
    grantId: string,
    scope: CompanionScope,
    tool: string,
    input: { requestId: string; workId?: string },
    action: (grant: StoredGrant, complete: (result: T) => T) => T | Promise<T>,
  ): Promise<T> {
    const grant = this.authorize(grantId, scope, input.workId);
    companionRequestId.parse(input.requestId);
    const key = `${grantId}:${input.requestId}`,
      inputHash = digest({ tool, input });
    const previous = this.store.get<Operation>('companion_operations', key);
    if (previous) {
      assert(
        previous.inputHash === inputHash,
        409,
        'This request ID was already used with a different operation.',
      );
      if (previous.state === 'succeeded') {
        if (previous.reference) {
          const value = this.store.get<Work | WorkEvent | Run>(
            previous.reference.collection,
            previous.reference.id,
          );
          assert(
            value,
            409,
            'This saved result is unavailable. Inspect work before creating a new intent.',
          );
          this.authorize(grantId, scope, 'workId' in value ? value.workId : value.id);
          return value as T;
        }
        return previous.result as T;
      }
      if (previous.state === 'failed')
        throw new ForgeError(
          previous.status ?? 409,
          previous.error ?? 'This operation failed. Inspect its saved work before a new request.',
        );
      const row =
        tool === 'forge_start_work'
          ? this.store.db
              .prepare(
                "SELECT data FROM records WHERE collection='runs' AND json_extract(data,'$.requestedBy.grantId')=? AND json_extract(data,'$.requestedBy.requestId')=? LIMIT 1",
              )
              .get(grantId, input.requestId)
          : null;
      const run = row ? (JSON.parse(String(row.data)) as Run) : null;
      if (run) return run as T;
      throw new ForgeError(
        409,
        'This operation has an uncertain or pending outcome. Inspect the saved work. Nothing was replayed.',
      );
    }
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS total FROM records WHERE collection='companion_operations' AND json_extract(data,'$.grantId')=?",
      )
      .get(grantId) as { total: number };
    assert(
      count.total < 2048,
      409,
      'This companion grant reached its operation limit. Create a new grant to continue.',
    );
    const receipt: Operation = {
      grantId,
      requestId: input.requestId,
      tool,
      inputHash,
      state: 'pending',
      ...(input.workId ? { workId: input.workId } : {}),
      createdAt: now(),
    };
    this.store.put('companion_operations', key, receipt);
    let completedInAction = false;
    const complete = (result: T) => {
      const collection =
        tool === 'forge_create_work'
          ? 'work'
          : tool === 'forge_checkpoint'
            ? 'events'
            : tool === 'forge_start_work'
              ? 'runs'
              : null;
      const reference = collection ? { collection, id: (result as { id: string }).id } : undefined;
      this.store.put('companion_operations', key, {
        ...receipt,
        state: 'succeeded',
        ...(reference ? { reference } : { result }),
      });
      completedInAction = true;
      return result;
    };
    try {
      const result = await action(grant, complete);
      return completedInAction ? result : complete(result);
    } catch (error) {
      if (this.store.get<Operation>('companion_operations', key)?.state !== 'succeeded')
        this.store.put('companion_operations', key, {
          ...receipt,
          state: 'failed',
          error: safeMessage(error),
          status: error instanceof ForgeError ? error.status : 409,
        });
      throw error;
    }
  }
  async createWork(grantId: string, value: z.input<typeof companionWorkInput>) {
    const input = companionWorkInput.parse(value);
    return this.operation<Work>(
      grantId,
      'work:write',
      'forge_create_work',
      input,
      async (grant, complete) => {
        const cwd = await this.directory(grant, input.directory);
        this.authorize(grantId, 'work:write');
        const account = input.accountId ? this.account(grant, input.accountId) : null;
        return this.store.transaction(() => {
          const work: Work = {
            createdBy: this.actor(grant, input.requestId),
            id: id(),
            title: input.title,
            project: basename(grant.root),
            cwd,
            goal: input.goal,
            acceptance: input.acceptance,
            context: input.context,
            profileId: grant.profileId,
            harness: account?.harness ?? 'codex',
            accountId: account?.id ?? null,
            status: 'ready',
            priority: 'normal',
            generation: 0,
            revision: 0,
            nativeSessionId: null,
            nativeSessionKey: null,
            activeRunId: null,
            createdAt: now(),
            updatedAt: now(),
          };
          this.store.put('work', work.id, work);
          const event = this.store.event(
            work.id,
            'created',
            'Companion saved a work record',
            'Native execution has not started.',
          );
          this.store.put('events', event.id, {
            ...event,
            actor: this.actor(grant, input.requestId),
          });
          return complete(work);
        });
      },
    );
  }
  checkpoint(grantId: string, value: z.input<typeof companionCheckpointInput>) {
    const input = companionCheckpointInput.parse(value);
    return this.operation<WorkEvent>(
      grantId,
      'work:write',
      'forge_checkpoint',
      input,
      (grant, complete) =>
        this.store.transaction(() => {
          const work = this.store.work(input.workId);
          assert(
            work.revision === input.expectedRevision,
            409,
            'This work changed. Read its current revision before saving a checkpoint.',
          );
          const event: WorkEvent = {
            ...this.store.event(work.id, 'checkpoint', 'Companion checkpoint saved', input.note),
            actor: this.actor(grant, input.requestId),
          };
          this.store.put('events', event.id, event);
          this.store.updateWork(work.id, {});
          return complete(event);
        }),
    );
  }
  start(grantId: string, value: z.input<typeof companionStartInput>) {
    const input = companionStartInput.parse(value);
    return this.operation<Run>(
      grantId,
      'work:dispatch',
      'forge_start_work',
      input,
      async (grant) => {
        const work = this.store.work(input.workId);
        assert(work.accountId, 409, 'Choose a granted native account in Forge first.');
        const directory = await this.directory(grant, work.cwd);
        assert(directory === work.cwd, 409, 'The saved directory changed. Review it in Forge.');
        const authorize = () => {
          const current = this.authorize(grantId, 'work:dispatch', work.id);
          this.account(current, work.accountId!);
          assert(
            current.dispatch && this.public(current).runsStarted < current.dispatch.maxRuns,
            409,
            'This companion reached its finite native run limit.',
          );
        };
        authorize();
        return this.controller.launch(
          work.id,
          grant.dispatch!.allowMetered,
          false,
          input.expectedRevision,
          input.contextDigest,
          { actor: this.actor(grant, input.requestId), authorize },
        );
      },
    );
  }
  interrupt(grantId: string, value: z.input<typeof companionInterruptInput>) {
    const input = companionInterruptInput.parse(value);
    return this.operation(grantId, 'work:dispatch', 'forge_interrupt_work', input, (grant) => {
      const work = this.store.work(input.workId);
      const run = work.activeRunId ? this.store.get<Run>('runs', work.activeRunId) : null;
      assert(
        run?.requestedBy?.grantId === grant.id,
        403,
        'Only native runs started by this companion grant can be interrupted through it.',
      );
      this.controller.interrupt(work.id);
      return { runId: run.id, state: 'stop-requested', settled: false };
    });
  }
}
