import { version } from '../shared/version.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import type {
  Account,
  AgentProfile,
  Approval,
  NativeSession,
  Run,
  RuntimeProbe,
  Settings,
  Snapshot,
  Usage,
  Work,
  WorkSummary,
  WorkspaceMode,
} from '../shared/types.js';
import { Store, id, now } from './store.js';
import { assert, ForgeError, safeMessage } from './errors.js';
import { MachineMonitor } from './machine.js';
import { discover } from './adapters/discovery.js';
import { failedProbe, probeAccount } from './adapters/accounts.js';
import {
  loopbackEndpoint,
  probeHermes,
  readCcusage,
  readDeckSessions,
} from './adapters/sources.js';
import { CodexDriver, type RpcFactory } from './adapters/codex-driver.js';
import { ClaudeDriver } from './adapters/claude-driver.js';
import { OpenCodeDriver } from './adapters/opencode-driver.js';
import { HermesDriver } from './adapters/hermes-driver.js';
import { OpenClawDriver } from './adapters/openclaw-driver.js';
import { ExecutionController } from './execution.js';
import { Continuity } from './continuity.js';
import { NativeSources, type NativeSourcesOptions } from './native-sources.js';
import { Profiles, inspectMemory } from './memory.js';
import type { DriverFactory } from './adapters/driver.js';
import { workspaceHeaders } from './http-security.js';
import { bridgeActor, type PhoneBridge } from './phone.js';
import { seedDemo } from './demo.js';
import { checkMemoryAdmission } from './memory-pressure.js';
import { T3Connections, t3Endpoint } from './t3.js';
import { T3Backends } from './backends/t3-backend.js';
import { T3Driver } from './backends/t3-driver.js';
import { Companions } from './companions.js';
import { registerCompanionMcp } from './companion-mcp.js';
import { Blueprints, blueprintSchema } from './blueprints.js';
import { AccountRouting, routePrepareSchema } from './routing.js';
import { Notifications } from './notifications.js';

const builtinHarness = z.enum(['codex', 'claude', 'opencode', 'hermes', 'openclaw']);
const harness = z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/);
const text = (max: number) => z.string().trim().max(max);
const workSchema = z
  .object({
    title: text(140).min(1),
    project: text(80).min(1),
    cwd: text(2000).default(''),
    goal: text(20000).min(1),
    acceptance: text(10000).default(''),
    context: text(50000).default(''),
    harness,
    accountId: z.string().nullable().default(null),
    priority: z.enum(['normal', 'high']).default('normal'),
    profileId: z.string().optional(),
  })
  .strict();
const accountSchema = z
  .object({
    label: text(80).min(1),
    harness: builtinHarness,
    nativeHome: text(2000).default(''),
    credentialEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
      .optional(),
    billingMode: z.enum(['native', 'subscription', 'api']).default('native'),
  })
  .strict();
export interface AppOptions {
  notificationFetch?: typeof fetch;
  notificationTimeoutMs?: number;
  filename: string;
  background?: Snapshot['service'];
  memoryPressureReader?: () =>
    | NonNullable<Snapshot['machine']['memoryPressure']>
    | Promise<NonNullable<Snapshot['machine']['memoryPressure']>>;
  port?: number;
  csrf?: string;
  phoneBridge?: PhoneBridge;
  rpcFactory?: RpcFactory;
  driverFactory?: DriverFactory;
  accountProbe?: typeof probeAccount;
  nativeSourcesOptions?: NativeSourcesOptions;
  resolveDirectory?: (value: string) => Promise<string>;
  codexBinary?: string;
  staticRoot?: string;
  test?: boolean;
  development?: boolean;
}

export async function createApp(options: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024, requestTimeout: 35000 });
  const local = new Store(options.filename);
  local.recoverInterruptedRuns();
  const demo = new Store(':memory:');
  seedDemo(demo);
  const backends = new T3Backends(
    local,
    options.filename === ':memory:' ? undefined : dirname(options.filename),
  );
  const controller: ExecutionController = new ExecutionController(
    local,
    options.driverFactory ??
      ((context) => {
        if (context.account.backend) return new T3Driver(backends, context);
        if (context.work.harness === 'codex')
          return new CodexDriver(
            options.rpcFactory,
            options.codexBinary ? async () => options.codexBinary! : undefined,
          );
        if (context.work.harness === 'claude') return new ClaudeDriver();
        if (context.work.harness === 'opencode') return new OpenCodeDriver();
        if (context.work.harness === 'hermes') return new HermesDriver();
        if (context.work.harness === 'openclaw') return new OpenClawDriver();
        assert(
          false,
          409,
          'Managed execution for this adapter is not connected yet. Continue through its native client.',
        );
      }),
    (work, digest) => profiles.prepare(work, digest),
    async () => {
      const pressure = await machine.freshPressure();
      checkMemoryAdmission(local.settings(), pressure);
    },
    (work, account, allowMetered) => routing.authorize(work, account, allowMetered),
  );
  const profiles: Profiles = new Profiles(local, () => controller.activeCount > 0);
  const demoProfiles = new Profiles(demo);
  const companions = new Companions(local, profiles, controller);
  const machine = new MachineMonitor(options.memoryPressureReader);
  const continuity = new Continuity(local, controller);
  const routing = new AccountRouting(local, controller, continuity);
  const notifications = new Notifications(
    local,
    options.filename === ':memory:' ? undefined : dirname(options.filename),
    options.phoneBridge?.origin ?? `http://127.0.0.1:${options.port ?? 4710}`,
    { fetch: options.notificationFetch, timeoutMs: options.notificationTimeoutMs },
  );
  const probing = new Set<string>();
  const t3 = new T3Connections(
    local,
    options.filename === ':memory:' ? undefined : dirname(options.filename),
  );
  const nativeSources = new NativeSources(local, {
    rpcFactory: options.rpcFactory,
    codexBinary: options.codexBinary,
    t3Reader: (source) => t3.read(source),
    ...options.nativeSourcesOptions,
    isManagedBusy: () => controller.activeCount > 0 || probing.size > 0,
  });
  const blueprints = new Blueprints(
    local,
    profiles,
    () =>
      controller.activeCount > 0 ||
      controller.hasLiveExecution ||
      nativeSources.isReading ||
      probing.size > 0,
  );
  const csrf = options.csrf ?? randomBytes(32).toString('hex');
  const port = options.port ?? 4710;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));
  if (options.development) {
    allowedOrigins.add('http://127.0.0.1:5173');
    allowedOrigins.add('http://localhost:5173');
  }
  let sessions: NativeSession[] = [];
  const savedHermes = local.get<{ endpoint: string }>('config', 'hermes');
  let hermes: RuntimeProbe = {
    status: 'disconnected',
    endpoint: savedHermes?.endpoint ?? '',
    version: null,
    capabilities: [],
    checkedAt: null,
    error: null,
  };
  let connections = await discover();
  const mode = (request: { headers: Record<string, unknown> }): WorkspaceMode =>
    request.headers['x-forge-workspace'] === 'demo' ? 'demo' : 'local';
  const store = (request: { headers: Record<string, unknown> }) =>
    mode(request) === 'demo' ? demo : local;

  app.addHook('onRequest', async (request, reply) => {
    const actor = bridgeActor(request.headers, options.phoneBridge);
    const dynamicHost =
      options.port === 0 && request.raw.socket.localPort
        ? [`127.0.0.1:${request.raw.socket.localPort}`, `localhost:${request.raw.socket.localPort}`]
        : [];
    if (
      !allowedHosts.has(request.headers.host ?? '') &&
      !dynamicHost.includes(request.headers.host ?? '')
    )
      return reply.code(403).send({ error: 'Use the printed local Forge address.' });
    if (
      request.headers['x-forge-workspace'] &&
      !['demo', 'local'].includes(String(request.headers['x-forge-workspace']))
    )
      return reply.code(400).send({ error: 'Choose the local or demo workspace explicitly.' });
    const origin = request.headers.origin;
    if (
      origin &&
      !allowedOrigins.has(origin) &&
      !dynamicHost.some((host) => origin === `http://${host}`) &&
      !(actor.kind === 'tailscale' && origin === options.phoneBridge?.origin)
    )
      return reply
        .code(403)
        .send({ error: 'This origin is not allowed to access the local workspace.' });
    if (request.url.split('?')[0] === '/mcp/companions') {
      assert(
        actor.kind === 'local' && !request.headers['x-forge-workspace'],
        403,
        'Companion MCP connects directly to the local workspace.',
      );
      companions.authenticate(request.headers.authorization);
      if (request.method === 'POST')
        assert(
          request.headers['content-type']?.startsWith('application/json'),
          415,
          'Send MCP requests as JSON.',
        );
      return;
    }
    assert(
      !request.headers.authorization,
      403,
      'Bearer credentials do not grant access to the human workspace API.',
    );
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const token = request.headers['x-forge-csrf'];
      const valid =
        typeof token === 'string' &&
        Buffer.byteLength(token) === Buffer.byteLength(csrf) &&
        timingSafeEqual(Buffer.from(token), Buffer.from(csrf));
      if (!valid)
        return reply
          .code(403)
          .send({ error: 'Workspace protection expired. Reload Forge before changing anything.' });
      if (!request.headers['content-type']?.startsWith('application/json'))
        return reply.code(415).send({ error: 'Send workspace changes as JSON.' });
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    workspaceHeaders(reply);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: error.issues
          .map((i) => `${i.path.join('.') || 'Input'}: ${i.message}`)
          .join(' ')
          .slice(0, 600),
      });
    if (error instanceof ForgeError)
      return reply.code(error.status).send({ error: safeMessage(error) });
    if ((error as any).statusCode === 413)
      return reply
        .code(413)
        .send({ error: 'This request is too large. Keep context below 50,000 characters.' });
    return reply.code(500).send({
      error: options.test
        ? safeMessage(error)
        : 'Forge could not complete this operation. Refresh and inspect the current state before retrying.',
    });
  });
  app.get('/api/health', async () => ({
    processId: process.pid,
    status: 'ok',
    version,
    service: options.background ?? { mode: 'foreground' },
    stateVersion: (local.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
  }));
  registerCompanionMcp(app, companions);
  app.get('/api/companions', async (request) =>
    mode(request) === 'demo' ? [] : companions.list(),
  );
  app.post('/api/companions', async (request, reply) => {
    assert(
      mode(request) === 'local' &&
        bridgeActor(request.headers, options.phoneBridge).kind === 'local',
      403,
      'Grant companion access from the local Forge host.',
    );
    const result = await companions.create(request.body);
    return reply
      .code(201)
      .send({ ...result, endpoint: `http://${request.headers.host}/mcp/companions` });
  });
  app.delete('/api/companions/:id', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo companions have no access grant.');
    return companions.revoke((request.params as { id: string }).id);
  });
  app.get('/api/notifications', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo has no notification destination.');
    return notifications.snapshot();
  });
  app.post('/api/notifications/connect', async (request) => {
    assert(
      mode(request) === 'local' &&
        bridgeActor(request.headers, options.phoneBridge).kind === 'local',
      403,
      'Configure notification credentials from the local Forge host.',
    );
    return notifications.configure(request.body);
  });
  app.delete('/api/notifications', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo has no notification destination.');
    const input = z
      .object({ expectedRevision: z.number().int().nonnegative() })
      .strict()
      .parse(request.body);
    return notifications.disconnect(input.expectedRevision);
  });
  app.post('/api/notifications/test', async (request, reply) => {
    assert(mode(request) === 'local', 409, 'Demo never sends notifications.');
    return reply.code(202).send(notifications.test());
  });
  app.post('/api/notifications/:id/acknowledge', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo has no native delivery receipts.');
    return notifications.acknowledge((request.params as { id: string }).id);
  });
  app.get('/api/snapshot', async (request) => {
    const db = store(request);
    const result: Snapshot = {
      service: options.background ?? { mode: 'foreground' },
      access: bridgeActor(request.headers, options.phoneBridge),
      mode: mode(request),
      spending: mode(request) === 'demo' ? undefined : controller.spending.snapshot(),
      notifications: mode(request) === 'demo' ? undefined : notifications.snapshot(),
      outcomes: mode(request) === 'demo' ? [] : controller.spending.outcomes(),
      version,
      csrf,
      work: db.all<WorkSummary>('work_summaries').sort((a, b) => {
        const rank = { waiting: 0, running: 1, failed: 2, interrupted: 2, ready: 3, completed: 4 };
        return rank[a.status] - rank[b.status] || b.updatedAt.localeCompare(a.updatedAt);
      }),
      accounts: db.all<Account>('accounts'),
      companionGrants: mode(request) === 'demo' ? [] : companions.list(),
      backends: mode(request) === 'demo' ? [] : backends.list(),
      approvals: db.all<Approval>('approvals'),
      events: db
        .recentEvents()
        .map(({ handoff: _handoff, ...event }) => ({ ...event, detail: '' })),
      usage: db.all<Usage>('usage'),
      settings: db.settings(),
      connections,
      machine: await machine.sample(),
      nativeWorkers:
        mode(request) === 'demo'
          ? []
          : await machine.workers(local.all<Run>('runs'), local.all<Account>('accounts')),
      nativeSessions:
        mode(request) === 'demo'
          ? []
          : [...sessions, ...nativeSources.inventories().flatMap((i) => i.sessions)],
      nativeSources: mode(request) === 'demo' ? [] : nativeSources.list(),
      nativeSchedules:
        mode(request) === 'demo' ? [] : nativeSources.inventories().flatMap((i) => i.schedules),
      profiles: mode(request) === 'demo' ? demoProfiles.list() : profiles.list(),
      defaultProfileId: mode(request) === 'demo' ? demoProfiles.defaultId : profiles.defaultId,
      memorySources: mode(request) === 'demo' ? [] : profiles.sources(),
      hermes:
        mode(request) === 'demo'
          ? {
              status: 'connected',
              endpoint: 'Fictional Hermes connection',
              version: 'Example',
              capabilities: ['session_resources', 'run_status', 'memory_recall'],
              checkedAt: now(),
              error: null,
            }
          : hermes,
      now: now(),
    };
    return result;
  });
  app.get('/api/work/:id', async (request) => {
    const workId = (request.params as { id: string }).id;
    const db = store(request);
    return {
      work: db.work(workId),
      events: db.recentEvents(workId, 50),
      runs: db
        .all<Run>('runs')
        .filter((run) => run.workId === workId)
        .sort(
          (a, b) =>
            Number(Boolean(b.settlement && !b.settlement.confirmed)) -
              Number(Boolean(a.settlement && !a.settlement.confirmed)) ||
            b.generation - a.generation,
        )
        .slice(0, 20),
    };
  });
  app.get('/api/work/:id/route', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo cannot inspect native account routing.');
    return routing.review((request.params as { id: string }).id);
  });
  app.put('/api/work/:id/route', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo cannot authorize native account routing.');
    assert(
      !nativeSources.isReading && probing.size === 0,
      409,
      'Wait for native account checks before changing routing.',
    );
    return routing.configure((request.params as { id: string }).id, request.body);
  });
  app.delete('/api/work/:id/route', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo has no native account routing.');
    const body = z
      .object({ expectedRevision: z.number().int().nonnegative() })
      .strict()
      .parse(request.body);
    return routing.remove((request.params as { id: string }).id, body.expectedRevision);
  });
  app.post('/api/work/:id/route/prepare', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo cannot prepare native account routing.');
    assert(
      !nativeSources.isReading && probing.size === 0,
      409,
      'Wait for native catalogue checks before preparing a routed handoff.',
    );
    return routing.prepare(
      (request.params as { id: string }).id,
      routePrepareSchema.parse(request.body),
    );
  });
  app.post('/api/work/:id/route/refresh', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo does not check native routing evidence.');
    assert(
      controller.activeCount === 0 &&
        !controller.hasLiveExecution &&
        !nativeSources.isReading &&
        probing.size === 0,
      409,
      'Wait for native execution and other native account checks before refreshing a route.',
    );
    const workId = (request.params as { id: string }).id;
    const policy = routing.policy(workId);
    assert(policy, 409, 'Authorize an account route first.');
    probing.add(`route:${workId}`);
    const checked: string[] = [],
      backendsRead = new Set<string>();
    try {
      // Bounded, sequential native checks. No resident router or parallel worker burst.
      for (const accountId of policy.accountIds) {
        const review = routing.review(workId);
        const first = review.candidates.find((candidate) => candidate.eligible);
        if (
          first &&
          policy.accountIds.indexOf(first.accountId) < policy.accountIds.indexOf(accountId)
        )
          break;
        const account = local.account(accountId);
        const staleEvidence = (timestamp: string | null) => {
          const elapsed = Date.now() - Date.parse(timestamp ?? '');
          return (
            !Number.isFinite(elapsed) ||
            elapsed < -5000 ||
            elapsed > policy.maxEvidenceAgeSeconds * 1000
          );
        };
        const stale =
          staleEvidence(account.checkedAt) ||
          account.ordinaryUsageAllowed === false ||
          account.quotas.some(
            (quota) => staleEvidence(quota.observedAt) || quota.usedPercent >= 100,
          );
        if (!stale && account.state !== 'unavailable' && !account.error) continue;
        if (checked.length >= 4) break;
        if (account.backend && backendsRead.has(account.backend.id)) continue;
        if (account.backend) backendsRead.add(account.backend.id);
        try {
          await refreshAccount(account);
        } catch (error) {
          local.put('accounts', account.id, failedProbe(account, error));
        }
        checked.push(accountId);
      }
      return { ...routing.review(workId), refreshedAccountIds: checked };
    } finally {
      probing.delete(`route:${workId}`);
    }
  });
  app.get('/api/spending', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo has no managed spending ledger.');
    return controller.spending.snapshot();
  });
  app.patch('/api/spending/policy', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo cannot change managed spending policy.');
    return controller.spending.configure(request.body);
  });
  app.get('/api/work/:id/spending', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo has no managed spending ledger.');
    const work = local.work((request.params as { id: string }).id);
    return {
      review: controller.spending.review(work),
      attempts: controller.spending.attempts(work.id),
      outcome: controller.spending.outcomes().find((row) => row.workId === work.id) ?? null,
    };
  });
  app.post('/api/spending/:runId/review', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo cannot review managed spending.');
    return controller.spending.reconcile(
      (request.params as { runId: string }).runId,
      request.body,
      bridgeActor(request.headers, options.phoneBridge),
    );
  });
  app.post('/api/work/:id/outcome', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo cannot accept real managed work.');
    return controller.spending.outcome(
      (request.params as { id: string }).id,
      request.body,
      bridgeActor(request.headers, options.phoneBridge),
    );
  });
  async function directory(value: string, required = false) {
    if (!value && !required) return '';
    assert(isAbsolute(value), 400, 'Use an absolute path to an existing local directory.');
    const canonical = await (options.resolveDirectory ?? realpath)(value).catch(() => null);
    assert(
      canonical && (await stat(canonical)).isDirectory(),
      400,
      'This directory was not found. Choose an existing local directory.',
    );
    return canonical;
  }
  function knownHarness(db: Store, value: string) {
    assert(
      builtinHarness.safeParse(value).success ||
        db.all<Account>('accounts').some((account) => account.harness === value && account.backend),
      400,
      'Connect a native backend offering this harness first.',
    );
  }
  app.post('/api/work', async (request, reply) => {
    const body = workSchema.parse(request.body);
    const db = store(request);
    knownHarness(db, body.harness);
    const cwd = mode(request) === 'demo' ? body.cwd : await directory(body.cwd);
    if (body.accountId)
      assert(
        db.account(body.accountId).harness === body.harness,
        400,
        'Choose an account for the selected harness.',
      );
    const work: Work = {
      ...body,
      profileId: (mode(request) === 'demo' ? demoProfiles : profiles).profile(body.profileId).id,
      cwd,
      id: id(),
      status: 'ready',
      generation: 0,
      revision: 0,
      nativeSessionId: null,
      nativeSessionKey: null,
      activeRunId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    db.transaction(() => {
      db.put('work', work.id, work);
      db.event(
        work.id,
        'created',
        'Work record created',
        'Goal and context are saved independently of any native session.',
      );
    });
    return reply.code(201).send(work);
  });
  app.patch('/api/work/:id', async (request) => {
    const { expectedRevision, ...body } = workSchema
      .partial()
      .extend({ expectedRevision: z.number().int().nonnegative() })
      .parse(request.body);
    const db = store(request);
    if (body.harness) knownHarness(db, body.harness);
    const work = db.work((request.params as { id: string }).id);
    assert(
      work.revision === expectedRevision,
      409,
      'This work changed since you opened it. Close the form and review the latest context before saving.',
    );
    assert(
      !work.activeRunId,
      409,
      'Wait for this native attempt to finish before editing its work context.',
    );
    const bindingChanged =
      (body.accountId !== undefined && body.accountId !== work.accountId) ||
      (body.harness !== undefined && body.harness !== work.harness) ||
      (body.cwd !== undefined && body.cwd !== work.cwd);
    assert(
      !bindingChanged || (!work.nativeSessionId && !work.capsuleId),
      409,
      'Use the verified handoff flow to change this native binding while retaining the same work record.',
    );
    if (body.accountId)
      assert(
        db.account(body.accountId).harness === (body.harness ?? work.harness),
        400,
        'The account and harness must match.',
      );
    if (body.harness && body.harness !== work.harness && body.accountId === undefined)
      body.accountId = null;
    if (body.cwd !== undefined && mode(request) !== 'demo') body.cwd = await directory(body.cwd);
    if (body.profileId)
      (mode(request) === 'demo' ? demoProfiles : profiles).profile(body.profileId);
    return db.transaction(() => {
      const current = db.work(work.id);
      assert(
        current.revision === expectedRevision && !current.activeRunId,
        409,
        'This work changed while checking the directory. Review the latest context before saving.',
      );
      const updated = db.updateWork(work.id, body);
      db.event(work.id, 'updated', 'Work context updated');
      return updated;
    });
  });
  app.post('/api/work/:id/checkpoint', async (request) => {
    const body = z
      .object({ note: text(20000).min(1) })
      .strict()
      .parse(request.body);
    const db = store(request);
    const work = db.work((request.params as { id: string }).id);
    return db.transaction(() => {
      const event = db.event(work.id, 'checkpoint', 'User checkpoint saved', body.note);
      db.updateWork(work.id, {});
      return event;
    });
  });
  app.post('/api/work/:id/capsules', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo checkpoints never inspect local project files.');
    const body = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        paths: z.array(z.string().min(1).max(2000)).min(1).max(2000).optional(),
      })
      .strict()
      .parse(request.body);
    return continuity.capture(
      (request.params as { id: string }).id,
      body.expectedRevision,
      body.paths,
    );
  });
  app.get('/api/work/:id/capsules/:capsuleId', async (request) => {
    const { id: workId, capsuleId } = request.params as { id: string; capsuleId: string };
    const capsule = store(request).get<import('../shared/types.js').WorkCapsule>(
      'capsules',
      capsuleId,
    );
    assert(capsule?.workId === workId, 404, 'This work checkpoint was not found.');
    return capsule;
  });
  app.post('/api/work/:id/handoff', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo work cannot change real native bindings.');
    const body = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        capsuleId: z.string().min(1),
        targetAccountId: z.string().min(1),
        reconciled: z.boolean().default(false),
      })
      .strict()
      .parse(request.body);
    return continuity.handoff(
      (request.params as { id: string }).id,
      body.expectedRevision,
      body.capsuleId,
      body.targetAccountId,
      body.reconciled,
    );
  });
  app.post('/api/work/:id/launch', async (request, reply) => {
    assert(
      mode(request) === 'local',
      409,
      'Demo work never starts native execution. Switch to your local workspace to run a real task.',
    );
    const body = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        allowMetered: z.boolean().default(false),
        reconciled: z.boolean().default(false),
        spendingRevision: z.number().int().nonnegative().optional(),
        contextDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(request.body);
    const workId = (request.params as { id: string }).id;
    const work = local.work(workId);
    assert(work.cwd, 400, 'Add a project directory before starting a native task.');
    await directory(work.cwd, true);
    // Check after filesystem awaits. The controller reserves capacity synchronously before yielding.
    assert(
      !nativeSources.isReading && probing.size === 0,
      409,
      'Wait for the native account check or inventory read to finish before starting a managed worker.',
    );
    return reply
      .code(202)
      .send(
        await controller.launch(
          workId,
          body.allowMetered,
          body.reconciled,
          body.expectedRevision,
          body.contextDigest,
          undefined,
          body.spendingRevision,
        ),
      );
  });
  app.post('/api/work/:id/interrupt', async (request, reply) => {
    assert(mode(request) === 'local', 409, 'This is a fictional demo task.');
    const stopping = controller.interrupt((request.params as { id: string }).id);
    void stopping.catch(() => {});
    return reply.code(202).send({ ok: true, stopping: true });
  });
  app.get('/api/work/:id/export', async (request, reply) => {
    const db = store(request);
    const work = db.work((request.params as { id: string }).id);
    // Explicit, user-selected context only. Never copy credentials, native auth, transcripts, or live grants.
    const checkpoints = db
      .checkpoints(work.id)
      .map((e) => ({ note: e.detail, recordedAt: e.createdAt, source: 'user' }));
    reply.header('Content-Disposition', `attachment; filename="forge-work-${work.id}.json"`);
    return {
      format: 'forge.work-context',
      version: 1,
      workId: work.id,
      title: work.title,
      project: work.project,
      goal: work.goal,
      acceptance: work.acceptance,
      context: work.context,
      checkpoints,
      coverage:
        'User-authored context and checkpoints only. Native transcripts, artifacts, permissions, and hidden state are not included.',
      exportedAt: now(),
    };
  });
  app.post('/api/accounts', async (request, reply) => {
    const body = accountSchema.parse(request.body);
    const db = store(request);
    const nativeHome = mode(request) === 'demo' ? '' : await directory(body.nativeHome);
    const account: Account = {
      ...body,
      nativeHome,
      id: id(),
      state: 'configured',
      identity: null,
      identityKey: null,
      plan: null,
      checkedAt: null,
      error: null,
      quotas: [],
      createdAt: now(),
    };
    db.put('accounts', account.id, account);
    return reply.code(201).send(account);
  });
  async function refreshAccount(account: Account) {
    const result = account.backend
      ? await backends.refresh(account.backend.id).then(() => local.account(account.id))
      : await (options.accountProbe ?? probeAccount)(account).catch((error) =>
          failedProbe(account, error),
        );
    return local.put('accounts', account.id, result);
  }
  app.post('/api/accounts/:id/probe', async (request) => {
    const db = store(request);
    const account = db.account((request.params as { id: string }).id);
    assert(
      mode(request) === 'local',
      409,
      'Demo identities are fictional and never contact native accounts.',
    );
    assert(!probing.has(account.id), 409, 'This native account check is already in progress.');
    assert(
      probing.size === 0 && controller.activeCount === 0 && !nativeSources.isReading,
      409,
      'Wait for the current native worker, account check or inventory read before checking another account.',
    );
    assert(
      !db.all<Work>('work').some((w) => w.accountId === account.id && w.activeRunId),
      409,
      'Wait for the active native attempt to finish before probing this account.',
    );
    probing.add(account.id);
    try {
      return await refreshAccount(account);
    } finally {
      probing.delete(account.id);
    }
  });
  app.delete('/api/accounts/:id', async (request) => {
    const db = store(request);
    const account = db.account((request.params as { id: string }).id);
    assert(!probing.has(account.id), 409, 'Wait for this native account check to finish.');
    assert(
      !db.all<Work>('work').some((w) => w.accountId === account.id) &&
        !db.all<Run>('runs').some((run) => run.accountId === account.id) &&
        !db
          .all<import('../shared/routing.js').AccountRoute>('account_routes')
          .some((route) => route.accountIds.includes(account.id)),
      409,
      'This slot is referenced by work history. Keep it to preserve account attribution.',
    );
    db.remove('accounts', account.id);
    return { ok: true };
  });
  app.post('/api/approvals/:id/decision', async (request) => {
    const body = z
      .object({ digest: z.string().length(64), decision: z.enum(['accept', 'decline']) })
      .strict()
      .parse(request.body);
    const approvalId = (request.params as { id: string }).id;
    if (mode(request) === 'demo') {
      const approval = demo.get<Approval>('approvals', approvalId);
      assert(
        approval?.status === 'pending' &&
          approval.digest === body.digest &&
          approval.expiresAt > now(),
        409,
        'This example decision is no longer pending.',
      );
      demo.transaction(() => {
        demo.put('approvals', approvalId, {
          ...approval,
          status: body.decision === 'accept' ? 'accepted' : 'declined',
          resolvedAt: now(),
        });
        demo.updateWork(approval.workId, { status: 'ready' });
        demo.event(
          approval.workId,
          'decision',
          body.decision === 'accept' ? 'Example request allowed once' : 'Example request declined',
          'Only the isolated demo state changed. No native command was run.',
        );
      });
    } else
      await controller.decide(
        approvalId,
        body.digest,
        body.decision,
        bridgeActor(request.headers, options.phoneBridge),
      );
    return { ok: true };
  });
  app.patch('/api/settings', async (request) => {
    const body = z
      .object({
        quietMode: z.boolean().optional(),
        maxConcurrent: z.literal(1).optional(),
        memoryPressurePolicy: z.enum(['protect', 'observe']).optional(),
      })
      .strict()
      .parse(request.body);
    const db = store(request);
    return db.put<Settings>('settings', 'workspace', { ...db.settings(), ...body });
  });
  app.post('/api/connections/refresh', async () => {
    connections = await discover();
    return connections;
  });
  app.post('/api/connections/hermes', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo connections do not contact your machine.');
    const body = z
      .object({
        endpoint: loopbackEndpoint,
        tokenEnv: z
          .string()
          .regex(/^FORGE_[A-Z0-9_]+$/)
          .optional(),
      })
      .strict()
      .parse(request.body);
    try {
      hermes = await probeHermes(body.endpoint, body.tokenEnv);
      local.put('config', 'hermes', body);
      return hermes;
    } catch (error) {
      hermes = {
        status: 'error',
        endpoint: body.endpoint,
        version: null,
        capabilities: [],
        checkedAt: now(),
        error: safeMessage(error),
      };
      throw new ForgeError(502, hermes.error!);
    }
  });
  app.post('/api/connections/agent-deck/refresh', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo sources never read native sessions.');
    sessions = await readDeckSessions();
    return sessions;
  });
  app.post('/api/native/discover', async (request) => {
    assert(
      mode(request) === 'local',
      409,
      'Demo discovery never reads native profile directories.',
    );
    return nativeSources.discover();
  });
  async function backendChange<T>(
    request: { headers: Record<string, unknown> },
    action: () => Promise<T>,
  ) {
    assert(mode(request) === 'local', 409, 'Demo work cannot connect native execution.');
    assert(
      !controller.hasLiveExecution && !nativeSources.isReading && probing.size === 0,
      409,
      'Wait for native execution and catalogue reads before changing a backend.',
    );
    probing.add('backend');
    try {
      return await action();
    } finally {
      probing.delete('backend');
    }
  }
  app.post('/api/backends/t3', async (request, reply) => {
    const input = z
      .object({
        endpoint: t3Endpoint,
        label: text(80).min(1),
        code: z.string().trim().min(1).max(16384),
      })
      .strict()
      .parse(request.body);
    return reply.code(201).send(await backendChange(request, () => backends.connect(input)));
  });
  app.post('/api/backends/:id/refresh', async (request) =>
    backendChange(request, () => backends.refresh((request.params as { id: string }).id)),
  );
  app.delete('/api/backends/:id', async (request) =>
    backendChange(request, async () => {
      const backendId = (request.params as { id: string }).id;
      assert(
        !local
          .all<Run>('runs')
          .some((run) => run.settlement?.backendId === backendId && !run.settlement.confirmed),
        409,
        'Reconcile the exact native run before disconnecting this backend.',
      );
      await backends.disconnect(backendId);
      return { ok: true };
    }),
  );
  app.patch('/api/accounts/:id/backend', async (request) =>
    backendChange(request, async () => {
      const input = z
        .object({
          model: z.string().min(1).max(500),
          projectId: z.string().min(1).max(500).optional(),
        })
        .strict()
        .parse(request.body);
      const account = local.account((request.params as { id: string }).id);
      assert(
        account.backend && account.models?.includes(input.model),
        400,
        'Choose a model from this native provider catalogue.',
      );
      assert(
        !local
          .all<Run>('runs')
          .some(
            (run) => run.accountId === account.id && run.settlement && !run.settlement.confirmed,
          ),
        409,
        'Reconcile this provider instance before changing its binding.',
      );
      const result = { ...account, backend: { ...account.backend, ...input } };
      local.transaction(() => {
        local.put('accounts', account.id, result);
        if (JSON.stringify(account.backend) !== JSON.stringify(result.backend)) {
          for (const work of local
            .all<Work>('work')
            .filter((work) => work.accountId === account.id))
            local.updateWork(work.id, {});
        }
      });
      return result;
    }),
  );
  app.post('/api/runs/:id/reconcile', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo work has no native run.');
    const input = z
      .object({ interrupt: z.boolean().default(false) })
      .strict()
      .parse(request.body);
    assert(
      !nativeSources.isReading && probing.size === 0,
      409,
      'Wait for native catalogue reads before reconciling.',
    );
    return controller.reconcileDelegated((request.params as { id: string }).id, (run) =>
      backends.reconcile(run, input.interrupt),
    );
  });
  app.post('/api/native/t3/authorize', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo activity never connects to a native server.');
    assert(
      bridgeActor(request.headers, options.phoneBridge).kind === 'local',
      409,
      'Connect T3 Code from a browser on the Forge host, then view saved activity on your phone.',
    );
    const input = z
      .object({ endpoint: t3Endpoint, label: text(100).min(1) })
      .strict()
      .parse(request.body);
    return t3.begin(input, `http://${request.headers.host}/api/native/t3/callback`);
  });
  const t3Return = (result: 'connected' | 'denied' | 'failed') =>
    `${options.development ? 'http://127.0.0.1:5173' : ''}/?t3=${result}`;
  app.get('/api/native/t3/callback', async (request, reply) => {
    const input = z
      .object({
        state: z.string().length(64),
        code: text(4000).optional(),
        iss: text(300).optional(),
        error: text(200).optional(),
      })
      .parse(request.query);
    if (input.error) {
      t3.cancel(input.state);
      return reply.redirect(t3Return('denied'));
    }
    try {
      assert(input.code && input.iss, 400, 'T3 Code sign-in did not include its code and issuer.');
      await t3.finish(input.state, input.code, input.iss);
      return reply.redirect(t3Return('connected'));
    } catch {
      return reply.redirect(t3Return('failed'));
    }
  });
  app.post('/api/native/sources', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo sources never connect to native services.');
    const body = z
      .object({
        kind: z.enum([
          'codex',
          'claude',
          'codex-schedules',
          'hermes-schedules',
          'hermes',
          'openclaw',
        ]),
        label: text(100).min(1),
        home: text(2000).default(''),
        endpoint: text(300).default(''),
        tokenEnv: z
          .string()
          .regex(/^FORGE_[A-Z0-9_]+$/)
          .optional(),
      })
      .strict()
      .parse(request.body);
    if (['hermes', 'openclaw'].includes(body.kind)) {
      body.endpoint = loopbackEndpoint.parse(body.endpoint);
      body.home = '';
    } else {
      body.home = await directory(body.home, true);
      body.endpoint = '';
      assert(!body.tokenEnv, 400, 'Local metadata sources do not use a gateway token.');
    }
    return nativeSources.add(body);
  });
  app.post('/api/native/sources/:id/refresh', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo sources never read native activity.');
    return nativeSources.refresh((request.params as { id: string }).id);
  });
  app.delete('/api/native/sources/:id', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo sources never disconnect native profiles.');
    const sourceId = (request.params as { id: string }).id;
    const source = local.get<import('../shared/types.js').NativeSource>('native_sources', sourceId);
    t3.assertCanForget(sourceId);
    assert(
      !profiles.list().some((profile) => profile.companionSourceId === sourceId),
      409,
      'A profile references this native companion. Change its binding before forgetting the source.',
    );
    nativeSources.remove(sourceId);
    if (source?.kind === 't3-code') await t3.forget(source);
    return { ok: true };
  });
  const profileSchema = z
    .object({
      name: text(100).min(1),
      instructions: text(8000).default(''),
      companionSourceId: z.string().nullable().default(null),
      memorySourceIds: z.array(z.string()).max(8).default([]),
    })
    .strict();
  app.post('/api/profiles', async (request) =>
    (mode(request) === 'demo' ? demoProfiles : profiles).create(profileSchema.parse(request.body)),
  );
  app.patch('/api/profiles/:id', async (request) => {
    const { expectedRevision, ...body } = profileSchema
      .extend({ expectedRevision: z.number().int().nonnegative() })
      .parse(request.body);
    return (mode(request) === 'demo' ? demoProfiles : profiles).update(
      (request.params as { id: string }).id,
      expectedRevision,
      body,
    );
  });
  app.delete('/api/profiles/:id', async (request) => {
    (mode(request) === 'demo' ? demoProfiles : profiles).removeProfile(
      (request.params as { id: string }).id,
    );
    return { ok: true };
  });
  const memorySelection = {
    path: text(2000).min(1),
    section: z.array(text(500).min(1)).max(12).default([]),
  };
  app.post('/api/memory/inspect', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo memory never reads native files.');
    const body = z.object(memorySelection).strict().parse(request.body);
    return inspectMemory(body.path, body.section);
  });
  app.post('/api/memory/discover', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo memory never discovers native files.');
    return profiles.discover();
  });
  app.post('/api/memory/sources', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo memory never registers native files.');
    const body = z
      .object({
        ...memorySelection,
        label: text(100).min(1),
        owner: z.enum(['hermes', 'openclaw', 'obsidian', 'markdown']),
        scope: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('global') }).strict(),
          z.object({ kind: z.literal('project'), root: text(2000).min(1) }).strict(),
          z.object({ kind: z.literal('work'), workId: z.string() }).strict(),
        ]),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
        expectedSelectionSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(request.body);
    if (body.scope.kind === 'project') body.scope.root = await directory(body.scope.root, true);
    if (body.scope.kind === 'work') local.work(body.scope.workId);
    const { expectedSha256, expectedSelectionSha256, ...input } = body;
    return profiles.addSource(input, expectedSha256, expectedSelectionSha256);
  });
  app.delete('/api/memory/sources/:id', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo memory never removes native references.');
    profiles.removeSource((request.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/work/:id/context-review', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo memory never reads native work context.');
    return profiles.review(local.work((request.params as { id: string }).id));
  });
  app.post('/api/connections/ccusage/refresh', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo usage never reads native billing data.');
    const entries = await readCcusage();
    local.transaction(() => entries.forEach((entry) => local.saveUsage(entry)));
    return { imported: entries.length };
  });
  app.get('/api/blueprint', async (request, reply) => {
    const db = store(request);
    reply.header('Content-Disposition', 'attachment; filename="forge-blueprint.json"');
    return {
      format: 'forge.workspace-blueprint',
      version: 1,
      harnesses: [...new Set(db.all<Account>('accounts').map((a) => a.harness))],
      accounts: db.all<Account>('accounts').map((a, i) => ({
        role: `account-${i + 1}`,
        harness: a.harness,
        billingMode: a.billingMode,
      })),
      settings: {
        maxConcurrent: 1,
        memoryPressurePolicy: db.settings().memoryPressurePolicy ?? 'protect',
      },
      profiles: db.all<AgentProfile>('profiles').map((profile, index) => ({
        role: `profile-${index + 1}`,
        memoryOwners: (mode(request) === 'demo' ? demoProfiles : profiles)
          .sources()
          .filter((source) => profile.memorySourceIds.includes(source.id))
          .map((source) => ({ owner: source.owner, scope: source.scope.kind })),
        preferredCompanion: profile.companionSourceId
          ? (db.get<import('../shared/types.js').NativeSource>(
              'native_sources',
              profile.companionSourceId,
            )?.kind ?? null)
          : null,
      })),
      requirements: [
        'Connect your own native accounts',
        'Choose project data and local paths explicitly',
      ],
    };
  });
  app.get('/api/blueprints/schema', async () => z.toJSONSchema(blueprintSchema));
  app.get('/api/blueprints/imports', async (request) =>
    mode(request) === 'demo' ? [] : blueprints.list(),
  );
  app.post('/api/blueprints/parse', async (request) => {
    assert(mode(request) === 'local', 409, 'Switch to the local workspace before importing setup.');
    return blueprints.parse(
      z.object({ definition: z.unknown() }).strict().parse(request.body).definition,
    );
  });
  app.post('/api/blueprints/inspect', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo imports never inspect local bindings.');
    return blueprints.inspect(request.body);
  });
  app.post('/api/blueprints/apply', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo imports never change local setup.');
    const input = z
      .object({ planId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(request.body);
    return blueprints.apply(input.planId, input.digest);
  });
  app.post('/api/blueprints/:id/rollback', async (request) => {
    assert(mode(request) === 'local', 409, 'Demo imports have no local rollback.');
    return blueprints.rollback((request.params as { id: string }).id);
  });
  const staticRoot = options.staticRoot ?? fileURLToPath(new URL('../client/', import.meta.url));
  if (existsSync(resolve(staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'This workspace operation does not exist.' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => {
    await t3.close();
    await controller.close();
    await notifications.close();
    local.close();
    demo.close();
  });
  return { app, local, demo, controller, csrf, companions, blueprints, routing, notifications };
}
