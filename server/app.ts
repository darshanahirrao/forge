import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import type {
  Account,
  Approval,
  NativeSession,
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
import { ExecutionController } from './execution.js';
import { Continuity } from './continuity.js';
import { NativeSources, type NativeSourcesOptions } from './native-sources.js';
import type { DriverFactory } from './adapters/driver.js';
import { seedDemo } from './demo.js';

const harness = z.enum(['codex', 'claude', 'opencode', 'hermes', 'openclaw']);
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
  })
  .strict();
const accountSchema = z
  .object({
    label: text(80).min(1),
    harness,
    nativeHome: text(2000).default(''),
    credentialEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
      .optional(),
    billingMode: z.enum(['native', 'subscription', 'api']).default('native'),
  })
  .strict();
export interface AppOptions {
  filename: string;
  port?: number;
  csrf?: string;
  rpcFactory?: RpcFactory;
  driverFactory?: DriverFactory;
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
  const controller = new ExecutionController(
    local,
    options.driverFactory ??
      ((context) => {
        if (context.work.harness === 'codex')
          return new CodexDriver(
            options.rpcFactory,
            options.codexBinary ? async () => options.codexBinary! : undefined,
          );
        if (context.work.harness === 'claude') return new ClaudeDriver();
        assert(
          false,
          409,
          'Managed execution for this adapter is not connected yet. Continue through its native client.',
        );
      }),
  );
  const machine = new MachineMonitor();
  const continuity = new Continuity(local, controller);
  const nativeSources = new NativeSources(local, {
    rpcFactory: options.rpcFactory,
    codexBinary: options.codexBinary,
    ...options.nativeSourcesOptions,
    isManagedBusy: () => controller.activeCount > 0,
  });
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
  const probing = new Set<string>();
  const mode = (request: { headers: Record<string, unknown> }): WorkspaceMode =>
    request.headers['x-forge-workspace'] === 'demo' ? 'demo' : 'local';
  const store = (request: { headers: Record<string, unknown> }) =>
    mode(request) === 'demo' ? demo : local;

  app.addHook('onRequest', async (request, reply) => {
    if (!allowedHosts.has(request.headers.host ?? ''))
      return reply.code(403).send({ error: 'Use the printed local Forge address.' });
    if (
      request.headers['x-forge-workspace'] &&
      !['demo', 'local'].includes(String(request.headers['x-forge-workspace']))
    )
      return reply.code(400).send({ error: 'Choose the local or demo workspace explicitly.' });
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin))
      return reply
        .code(403)
        .send({ error: 'This origin is not allowed to access the local workspace.' });
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
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
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
  app.get('/api/health', async () => ({ status: 'ok', version: '0.4.1' }));
  app.get('/api/snapshot', async (request) => {
    const db = store(request);
    const result: Snapshot = {
      mode: mode(request),
      version: '0.4.1',
      csrf,
      work: db.all<WorkSummary>('work_summaries').sort((a, b) => {
        const rank = { waiting: 0, running: 1, failed: 2, interrupted: 2, ready: 3, completed: 4 };
        return rank[a.status] - rank[b.status] || b.updatedAt.localeCompare(a.updatedAt);
      }),
      accounts: db.all<Account>('accounts'),
      approvals: db.all<Approval>('approvals'),
      events: db
        .recentEvents()
        .map(({ handoff: _handoff, ...event }) => ({ ...event, detail: '' })),
      usage: db.all<Usage>('usage'),
      settings: db.settings(),
      connections,
      machine: await machine.sample(),
      nativeSessions:
        mode(request) === 'demo'
          ? []
          : [...sessions, ...nativeSources.inventories().flatMap((i) => i.sessions)],
      nativeSources: mode(request) === 'demo' ? [] : nativeSources.list(),
      nativeSchedules:
        mode(request) === 'demo' ? [] : nativeSources.inventories().flatMap((i) => i.schedules),
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
    return { work: db.work(workId), events: db.recentEvents(workId, 50) };
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
  app.post('/api/work', async (request, reply) => {
    const body = workSchema.parse(request.body);
    const db = store(request);
    const cwd = mode(request) === 'demo' ? body.cwd : await directory(body.cwd);
    if (body.accountId)
      assert(
        db.account(body.accountId).harness === body.harness,
        400,
        'Choose an account for the selected harness.',
      );
    const work: Work = {
      ...body,
      cwd,
      id: id(),
      status: 'ready',
      generation: 0,
      revision: 0,
      nativeSessionId: null,
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
      })
      .strict()
      .parse(request.body);
    const workId = (request.params as { id: string }).id;
    const work = local.work(workId);
    assert(work.cwd, 400, 'Add a project directory before starting a native task.');
    await directory(work.cwd, true);
    // Check after filesystem awaits. The controller reserves capacity synchronously before yielding.
    assert(
      !nativeSources.isReading,
      409,
      'Wait for the native inventory read to finish before starting a managed worker.',
    );
    return reply
      .code(202)
      .send(
        await controller.launch(workId, body.allowMetered, body.reconciled, body.expectedRevision),
      );
  });
  app.post('/api/work/:id/interrupt', async (request) => {
    assert(mode(request) === 'local', 409, 'This is a fictional demo task.');
    await controller.interrupt((request.params as { id: string }).id);
    return { ok: true };
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
      !db.all<Work>('work').some((w) => w.accountId === account.id && w.activeRunId),
      409,
      'Wait for the active native attempt to finish before probing this account.',
    );
    probing.add(account.id);
    try {
      const result = await probeAccount(account).catch((error) => failedProbe(account, error));
      db.put('accounts', account.id, result);
      return result;
    } finally {
      probing.delete(account.id);
    }
  });
  app.delete('/api/accounts/:id', async (request) => {
    const db = store(request);
    const account = db.account((request.params as { id: string }).id);
    assert(!probing.has(account.id), 409, 'Wait for this native account check to finish.');
    assert(
      !db.all<Work>('work').some((w) => w.accountId === account.id),
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
    } else await controller.decide(approvalId, body.digest, body.decision);
    return { ok: true };
  });
  app.patch('/api/settings', async (request) => {
    const body = z
      .object({ quietMode: z.boolean().optional(), maxConcurrent: z.literal(1).optional() })
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
    nativeSources.remove((request.params as { id: string }).id);
    return { ok: true };
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
      settings: { maxConcurrent: 1 },
      requirements: [
        'Connect your own native accounts',
        'Choose project data and local paths explicitly',
      ],
    };
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
    await controller.close();
    local.close();
    demo.close();
  });
  return { app, local, demo, controller, csrf };
}
