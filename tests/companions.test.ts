import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app.js';
import { Profiles, inspectMemory } from '../server/memory.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { id } from '../server/store.js';
import type { Account, Approval, CompanionGrant, Run, Work } from '../shared/types.js';
import type { DriverContext, DriverSink, NativeDriver } from '../server/adapters/driver.js';

class Driver implements NativeDriver {
  readonly harness = 'codex';
  closed = false;
  context!: DriverContext;
  sink!: DriverSink;
  decisions = 0;
  async start(context: DriverContext, sink: DriverSink) {
    this.context = context;
    this.sink = sink;
    sink.account(context.account);
    sink.session(`fixture-${context.run.id}`);
    sink.turn('turn-1');
  }
  request() {
    this.sink.approval({
      requestId: 'native-request',
      method: 'fixture/permission',
      sessionId: `fixture-${this.context.run.id}`,
      turnId: 'turn-1',
      params: { effect: 'synthetic-only' },
      title: 'Native decision',
      detail: 'No external effect.',
      command: 'synthetic-only',
      cwd: this.context.work.cwd,
      respond: () => {
        this.decisions++;
        this.sink.ended('completed', 'Fixture finished', 'No paid inference.');
      },
    });
  }
  async interrupt() {
    this.sink.ended('interrupted', 'Stopped', 'Fixture only.');
  }
  async close() {
    this.closed = true;
  }
}
async function fixture(
  options: {
    pressure?: () =>
      ReturnType<typeof unknownPressure> | Promise<ReturnType<typeof unknownPressure>>;
    disk?: boolean;
    phoneBridge?: { origin: string; proof: string };
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-companion-')));
  const project = join(root, 'project'),
    outside = join(root, 'project-neighbor');
  await mkdir(project);
  await mkdir(outside);
  const drivers: Driver[] = [];
  const state = await createApp({
    filename: options.disk ? join(root, 'workspace.sqlite') : ':memory:',
    port: 0,
    test: true,
    memoryPressureReader: options.pressure ?? unknownPressure,
    phoneBridge: options.phoneBridge,
    driverFactory: () => {
      const driver = new Driver();
      drivers.push(driver);
      return driver;
    },
  });
  await state.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${(state.app.server.address() as { port: number }).port}`;
  const human = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) =>
    state.app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:0',
        'x-forge-csrf': state.csrf,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const account = (
    await human('POST', '/api/accounts', { harness: 'codex', label: 'Granted native slot' })
  ).json<Account>();
  const profiles = new Profiles(state.local);
  const grant = async (dispatch = false, label = 'Hermes') =>
    state.companions.create({
      label,
      profileId: profiles.defaultId,
      root: project,
      scopes: ['work:read', 'context:read', 'work:write', ...(dispatch ? ['work:dispatch'] : [])],
      accountIds: [account.id],
      dispatch: dispatch ? { allowMetered: false, maxRuns: 1 } : null,
    });
  const clients: Client[] = [];
  const client = async (token: string) => {
    const client = new Client({ name: 'native-compatible-test-client', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + '/mcp/companions'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const createWork = (grantId: string, requestId = 'create-work') =>
    state.companions.createWork(grantId, {
      requestId,
      title: 'Persistent work',
      goal: 'Use the same profile and work across native companions.',
      accountId: account.id,
    });
  return {
    ...state,
    root,
    project,
    outside,
    origin,
    account,
    profiles,
    human,
    grant,
    client,
    createWork,
    drivers,
    close: async () => {
      for (const client of clients) await client.close();
      await state.app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function wait(fn: () => boolean) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The expected native lifecycle transition was not observed.');
}

test('native MCP discovery enforces project/profile scopes, selected-memory privacy and companion replacement', async () => {
  const f = await fixture();
  try {
    const filename = join(f.root, 'shared.md');
    await writeFile(filename, '# Shared\nselected-native-fact\n# Private\nexcluded-native-fact\n');
    const selected = await inspectMemory(filename, ['Shared']);
    const source = await f.profiles.addSource(
      {
        label: 'Shared fact',
        owner: 'markdown',
        path: filename,
        section: ['Shared'],
        scope: { kind: 'global' },
      },
      selected.sha256,
      selected.selectionSha256,
    );
    const profile = f.profiles.profile();
    f.profiles.update(profile.id, profile.revision, { ...profile, memorySourceIds: [source.id] });
    const first = await f.grant();
    const work = await f.createWork(first.grant.id);
    const client = await f.client(first.token);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(
      tools.sort(),
      [
        'forge_workspace',
        'forge_work',
        'forge_context',
        'forge_create_work',
        'forge_checkpoint',
      ].sort(),
    );
    const context = await client.callTool({
      name: 'forge_context',
      arguments: { workId: work.id },
    });
    assert(!context.isError);
    assert(JSON.stringify(context).includes('selected-native-fact'));
    assert(!JSON.stringify(context).includes('excluded-native-fact'));
    assert.equal(
      await readFile(filename, 'utf8'),
      '# Shared\nselected-native-fact\n# Private\nexcluded-native-fact\n',
    );
    const neighbor: Work = {
      ...work,
      id: id(),
      cwd: f.outside,
      title: 'Excluded neighboring project',
    };
    const otherProfile = f.profiles.create({
      name: 'Other',
      instructions: '',
      companionSourceId: null,
      memorySourceIds: [],
    });
    const privateWork: Work = {
      ...work,
      id: id(),
      profileId: otherProfile.id,
      title: 'Excluded other profile',
    };
    f.local.put('work', neighbor.id, neighbor);
    f.local.put('work', privateWork.id, privateWork);
    const workspace = await client.callTool({ name: 'forge_workspace', arguments: {} });
    assert(!JSON.stringify(workspace).includes(neighbor.title));
    assert(!JSON.stringify(workspace).includes(privateWork.title));
    assert(
      (await client.callTool({ name: 'forge_work', arguments: { workId: neighbor.id } })).isError,
    );
    assert(
      (await client.callTool({ name: 'forge_work', arguments: { workId: privateWork.id } }))
        .isError,
    );
    const second = await f.grant(false, 'Replacement companion');
    f.companions.revoke(first.grant.id);
    assert.throws(() => f.companions.authenticate(`Bearer ${first.token}`), /revoked/);
    const replacement = await f.client(second.token);
    const retained = await replacement.callTool({
      name: 'forge_work',
      arguments: { workId: work.id },
    });
    assert.equal((retained.structuredContent as { work: Work }).work.id, work.id);
    assert.equal(f.local.work(work.id).profileId, profile.id);
    assert.equal(f.profiles.profile().memorySourceIds[0], source.id);
  } finally {
    await f.close();
  }
});

test('companion writes keep source attribution and durable idempotency without escaping symlinks or silently changing intent', async () => {
  const f = await fixture();
  try {
    const { grant } = await f.grant();
    const work = await f.createWork(grant.id);
    assert.equal((await f.createWork(grant.id)).id, work.id);
    assert.equal(f.local.all('work').length, 1);
    const note = {
      requestId: 'stable-note',
      workId: work.id,
      expectedRevision: work.revision,
      note: 'Observed progress from Hermes.',
    };
    const first = await f.companions.checkpoint(grant.id, note);
    assert.equal((await f.companions.checkpoint(grant.id, note)).id, first.id);
    assert.equal(f.local.checkpoints(work.id).length, 1);
    assert.equal(first.actor?.grantId, grant.id);
    assert.equal(f.local.work(work.id).revision, work.revision + 1);
    await assert.rejects(
      f.companions.checkpoint(grant.id, {
        ...note,
        note: 'Changed intent with the same request ID.',
      }),
      /different operation/,
    );
    await symlink(f.outside, join(f.project, 'escape'));
    await assert.rejects(
      f.companions.createWork(grant.id, {
        requestId: 'escape',
        title: 'Denied',
        goal: 'Not allowed.',
        directory: 'escape',
      }),
      /escapes/,
    );
    await assert.rejects(
      f.companions.createWork(grant.id, {
        requestId: 'prefix-neighbor',
        title: 'Denied',
        goal: 'Not allowed.',
        directory: f.outside,
      }),
      /escapes/,
    );
    assert.equal(f.local.all('work').length, 1);
  } finally {
    await f.close();
  }
});

test('companion bearer cannot reach human APIs or decisions, and snapshots/exports contain no bearer or hash', async () => {
  const f = await fixture();
  try {
    const result = await f.human('POST', '/api/companions', {
      label: 'Native client',
      root: f.project,
      profileId: f.profiles.defaultId,
      scopes: ['work:read'],
    });
    assert.equal(result.statusCode, 201);
    const { token, grant } = result.json<{ token: string; grant: CompanionGrant }>();
    const bearer = { authorization: `Bearer ${token}` };
    for (const [method, url, body] of [
      ['GET', '/api/snapshot'],
      ['POST', '/api/approvals/foreign/decision', { decision: 'accept' }],
      ['POST', '/api/companions', {}],
    ] as const)
      assert.equal((await f.human(method, url, body, bearer)).statusCode, 403);
    const mcp = (headers: Record<string, string>) =>
      f.app.inject({
        method: 'POST',
        url: '/mcp/companions',
        headers: { host: '127.0.0.1:0', 'content-type': 'application/json', ...headers },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
    assert.equal((await mcp({})).statusCode, 401);
    assert.equal((await mcp({ ...bearer, origin: 'https://foreign.invalid' })).statusCode, 403);
    assert.equal((await mcp({ ...bearer, host: 'foreign.invalid' })).statusCode, 403);
    assert.equal((await mcp({ ...bearer, 'x-forge-workspace': 'demo' })).statusCode, 403);
    const snapshot = (await f.human('GET', '/api/snapshot')).body;
    const exported = (await f.human('GET', '/api/blueprint')).body;
    for (const value of [snapshot, exported]) {
      assert(!value.includes(token));
      assert(!value.includes('tokenHash'));
      assert(!value.includes('bindings'));
    }
    assert(!JSON.stringify(f.local.all('companion_grants')).includes(token));
    const stored = f.local.get<Record<string, unknown>>('companion_grants', grant.id)!;
    f.local.put('companion_grants', grant.id, {
      ...stored,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    assert.throws(() => f.companions.authenticate(`Bearer ${token}`), /expired/);
  } finally {
    await f.close();
  }
});

test('finite companion dispatch remains idempotent, preserves human native approval authority and forbids billing escalation', async () => {
  const f = await fixture();
  try {
    const { grant, token } = await f.grant(true);
    const work = await f.createWork(grant.id);
    const client = await f.client(token);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert(tools.includes('forge_start_work') && tools.includes('forge_interrupt_work'));
    assert(tools.every((name) => !/approval|settings|grant|reconcile/.test(name)));
    await f.companions.checkpoint(grant.id, {
      requestId: 'before-dispatch',
      workId: work.id,
      expectedRevision: work.revision,
      note: 'Companion observed the preparation result.',
    });
    const context = await f.companions.context(grant.id, work.id);
    const input = {
      requestId: 'start-once',
      workId: work.id,
      expectedRevision: context.revision,
      contextDigest: context.reviewDigest,
    };
    assert(
      (
        await client.callTool({
          name: 'forge_start_work',
          arguments: { ...input, allowMetered: true },
        })
      ).isError,
    );
    const started = await client.callTool({ name: 'forge_start_work', arguments: input });
    assert(!started.isError, JSON.stringify(started));
    const run = started.structuredContent as unknown as Run;
    assert.equal((await f.companions.start(grant.id, input)).id, run.id);
    assert.equal(f.drivers.length, 1);
    assert.equal(f.drivers[0].context.allowMetered, false);
    assert(f.drivers[0].context.prompt.includes('[Companion: Hermes]'));
    assert(f.drivers[0].context.prompt.includes('Work proposed by companion Hermes'));
    f.drivers[0].request();
    await wait(() =>
      f.local.all<Approval>('approvals').some((value) => value.status === 'pending'),
    );
    assert.equal(f.drivers[0].decisions, 0);
    assert(
      (await client.callTool({ name: 'forge_approve', arguments: { decision: 'accept' } })).isError,
    );
    const approval = f.local
      .all<Approval>('approvals')
      .find((value) => value.status === 'pending')!;
    assert.equal(
      (
        await f.human('POST', `/api/approvals/${approval.id}/decision`, {
          digest: approval.digest,
          decision: 'accept',
        })
      ).statusCode,
      200,
    );
    await wait(() => f.local.work(work.id).status === 'completed');
    assert.equal(f.drivers[0].decisions, 1);
    assert.equal(f.local.get<Run>('runs', run.id)?.requestedBy?.grantId, grant.id);
    await writeFile(join(f.project, 'proof.txt'), 'Fixture artifact');
    const captured = await f.human('POST', `/api/work/${work.id}/capsules`, {
      expectedRevision: f.local.work(work.id).revision,
      paths: ['proof.txt'],
    });
    assert.equal(captured.statusCode, 200, captured.body);
    assert.equal(captured.json().capsule.checkpoints[0].actor.grantId, grant.id);
    const latest = await f.companions.context(grant.id, work.id);
    await assert.rejects(
      f.companions.start(grant.id, {
        ...input,
        requestId: 'beyond-limit',
        expectedRevision: latest.revision,
        contextDigest: latest.reviewDigest,
      }),
      /finite native run limit/,
    );
    assert.equal(f.drivers.length, 1);
    assert.equal(f.companions.list()[0].runsStarted, 1);
    // Crash between canonical run persistence and the MCP outcome receipt: never replay it.
    const key = `${grant.id}:${input.requestId}`;
    const receipt = f.local.get<Record<string, unknown>>('companion_operations', key)!;
    f.local.put('companion_operations', key, { ...receipt, state: 'pending', result: undefined });
    assert.equal((await f.companions.start(grant.id, input)).id, run.id);
    assert.equal(f.drivers.length, 1);
  } finally {
    await f.close();
  }
});

test('active companion grants keep their profile reference intact until explicit revocation', async () => {
  const f = await fixture();
  try {
    const profile = f.profiles.create({
      name: 'Scoped companion profile',
      instructions: '',
      companionSourceId: null,
      memorySourceIds: [],
    });
    const access = await f.companions.create({
      label: 'Native client',
      root: f.project,
      profileId: profile.id,
      scopes: ['work:read'],
    });
    assert.throws(() => f.profiles.removeProfile(profile.id), /Revoke active companion access/);
    f.companions.revoke(access.grant.id);
    f.profiles.removeProfile(profile.id);
    assert.throws(() => f.companions.authenticate(`Bearer ${access.token}`), /revoked/);
  } finally {
    await f.close();
  }
});

test('companion dispatch inherits human spending holds without acquiring budget or outcome authority', async () => {
  const f = await fixture();
  try {
    const { grant, token } = await f.grant(true);
    const work = await f.createWork(grant.id);
    f.controller.spending.configure({
      expectedRevision: 0,
      monthlyUsd: 0.5,
      workUsd: 2,
      attemptUsd: 1,
    });
    const context = await f.companions.context(grant.id, work.id);
    const input = {
      requestId: 'blocked-budget',
      workId: work.id,
      expectedRevision: context.revision,
      contextDigest: context.reviewDigest,
    };
    await assert.rejects(f.companions.start(grant.id, input), /monthly budget/);
    assert.equal(f.drivers.length, 0);
    assert.equal(f.companions.list()[0].runsStarted, 0);
    assert.equal(f.companions.work(grant.id, work.id).spendingAdmission.allowed, false);
    const client = await f.client(token);
    assert(
      (await client.listTools()).tools.every((tool) => !/spending|budget|outcome/.test(tool.name)),
    );
    f.controller.spending.configure({
      expectedRevision: 1,
      monthlyUsd: 2,
      workUsd: 2,
      attemptUsd: 1,
    });
    const run = await f.companions.start(grant.id, { ...input, requestId: 'allowed-budget' });
    assert.equal(f.drivers[0].context.maxBudgetUsd, 1);
    assert.equal(f.controller.spending.attempts()[0].runId, run.id);
    assert.equal(f.controller.spending.attempts()[0].reservedUsd, 1);
    await f.controller.interrupt(work.id);
    assert.equal(f.controller.spending.attempts()[0].state, 'unknown');
  } finally {
    await f.close();
  }
});

test('native account revalidation preserves finite companion admission and rejects changed or revoked authority', async () => {
  const f = await fixture();
  try {
    const { grant } = await f.grant(true);
    const work = await f.createWork(grant.id),
      context = await f.companions.context(grant.id, work.id);
    await f.companions.start(grant.id, {
      requestId: 'native-check',
      workId: work.id,
      expectedRevision: context.revision,
      contextDigest: context.reviewDigest,
    });
    assert.equal(f.drivers.length, 1);
    assert.equal(f.companions.list()[0].runsStarted, 1);
    assert.throws(
      () => f.drivers[0].sink.account({ ...f.account, identityKey: 'new-native-login' }),
      /changed its companion grant binding/,
    );
    assert.equal(f.local.account(f.account.id).identityKey, f.account.identityKey);
    f.companions.revoke(grant.id);
    assert.throws(() => f.drivers[0].sink.account(f.account), /revoked/);
  } finally {
    await f.close();
  }
});

test('native backend account IDs remain opaque and shared quota evidence is preserved without exposing identity keys', async () => {
  const f = await fixture();
  try {
    const quota = {
      label: 'Native weekly bucket',
      usedPercent: 45,
      resetsAt: null,
      scope: 'private-native-quota-identity',
      source: 'native' as const,
      observedAt: new Date().toISOString(),
    };
    const first: Account = {
      ...f.account,
      id: 't3-' + 'a'.repeat(32),
      harness: 'customAcp',
      identityKey: 'private-native-identity',
      quotas: [quota],
    };
    const second: Account = { ...first, id: 't3-' + 'b'.repeat(32) };
    f.local.put('accounts', first.id, first);
    f.local.put('accounts', second.id, second);
    const access = await f.companions.create({
      label: 'Native account planner',
      root: f.project,
      profileId: f.profiles.defaultId,
      scopes: ['work:read', 'work:write'],
      accountIds: [first.id, second.id],
    });
    const work = await f.companions.createWork(access.grant.id, {
      requestId: 'native-opaque-id',
      title: 'Native-backed work',
      goal: 'Retain registered native driver and account IDs.',
      accountId: first.id,
    });
    assert.equal(work.harness, 'customAcp');
    const view = f.companions.workspace(access.grant.id);
    const one = view.accounts[0],
      two = view.accounts[1];
    assert('quotas' in one && 'quotas' in two);
    assert(one.quotas && two.quotas);
    assert.equal(one.quotas[0].scope, two.quotas[0].scope);
    assert.equal(one.quotas[0].usedPercent, 45);
    assert.equal(one.quotas[0].source, 'native');
    assert(!JSON.stringify(view).includes('private-native-quota-identity'));
    assert(!JSON.stringify(view).includes('private-native-identity'));
    assert.equal(one.ordinaryUsageAllowed, null);
  } finally {
    await f.close();
  }
});

test('grant revocation during preparation prevents native dispatch, and changed account bindings require a new grant', async () => {
  let release: (() => void) | undefined;
  let gated = false;
  const f = await fixture({
    pressure: async () => {
      if (gated)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return unknownPressure();
    },
  });
  try {
    const first = await f.grant(true);
    const work = await f.createWork(first.grant.id);
    const context = await f.companions.context(first.grant.id, work.id);
    gated = true;
    const pending = f.companions.start(first.grant.id, {
      requestId: 'revoke-during-read',
      workId: work.id,
      expectedRevision: work.revision,
      contextDigest: context.reviewDigest,
    });
    const denied = assert.rejects(pending, /revoked/);
    await wait(() => Boolean(release));
    f.companions.revoke(first.grant.id);
    gated = false;
    release!();
    await denied;
    assert.equal(f.drivers.length, 0);
    const second = await f.grant(true, 'Replacement');
    f.local.put('accounts', f.account.id, { ...f.account, nativeHome: f.outside });
    await assert.rejects(
      f.companions.start(second.grant.id, {
        requestId: 'changed-account',
        workId: work.id,
        expectedRevision: work.revision,
        contextDigest: context.reviewDigest,
      }),
      /binding changed/,
    );
    assert.equal(f.drivers.length, 0);
    assert.equal(f.local.work(work.id).generation, 0);
  } finally {
    gated = false;
    release?.();
    await f.close();
  }
});

test('companion handoff stages read-only native access, requires target acknowledgement and preserves context, operations and shared allowance', async () => {
  const f = await fixture();
  try {
    const old = await f.grant(true),
      work = await f.createWork(old.grant.id);
    const context = await f.companions.context(old.grant.id, work.id);
    const input = {
      requestId: 'native-once-before-switch',
      workId: work.id,
      expectedRevision: context.revision,
      contextDigest: context.reviewDigest,
    };
    const run = await f.companions.start(old.grant.id, input);
    await assert.rejects(
      f.companionHandoffs.prepare({ grantId: old.grant.id, label: 'OpenClaw' }),
      /native|workers/,
    );
    f.drivers[0].sink.ended('completed', 'Native fixture complete', 'No external effects.');
    await wait(() => f.controller.activeCount === 0);
    const plan = await f.companionHandoffs.prepare({ grantId: old.grant.id, label: 'OpenClaw' });
    const staged = await f.companionHandoffs.stage(plan.id, plan.digest, { kind: 'local' });
    assert(staged.token);
    assert.equal(staged.grant.lineageId, old.grant.id);
    assert.equal(staged.grant.expiresAt, old.grant.expiresAt);
    assert.equal(staged.grant.runsStarted, 1);
    await assert.rejects(f.createWork(old.grant.id, 'old-after-stage'), /replacement/);
    await assert.rejects(f.createWork(staged.grant.id, 'new-before-activate'), /replacement/);
    assert.equal(f.companions.work(staged.grant.id, work.id).work.profileId, work.profileId);
    const target = await f.client(staged.token);
    const tools = (await target.listTools()).tools.map((tool) => tool.name);
    assert(tools.includes('forge_companion_ready'));
    assert(tools.includes('forge_start_work') && tools.includes('forge_create_work'));
    assert(
      (
        await target.callTool({
          name: 'forge_create_work',
          arguments: {
            requestId: 'held-staged-native-call',
            title: 'Held',
            goal: 'No staged write.',
          },
        })
      ).isError,
    );
    await assert.rejects(f.companionHandoffs.activate(plan.id, plan.digest, 0), /acknowledge/);
    const wrong = await target.callTool({
      name: 'forge_companion_ready',
      arguments: { handoffId: plan.id, digest: '0'.repeat(64) },
    });
    assert(wrong.isError);
    const ready = await target.callTool({
      name: 'forge_companion_ready',
      arguments: { handoffId: plan.id, digest: plan.digest },
    });
    assert(!ready.isError, JSON.stringify(ready));
    const receipt = f.companionHandoffs.list()[0];
    assert.equal(receipt.state, 'ready');
    const activated = await f.companionHandoffs.activate(
      receipt.id,
      receipt.digest,
      receipt.revision,
    );
    assert.equal(activated.state, 'activated');
    assert.deepEqual(
      await f.companionHandoffs.activate(receipt.id, receipt.digest, receipt.revision),
      activated,
    );
    assert.throws(() => f.companions.authenticate(`Bearer ${old.token}`), /revoked/);
    // The same lost operation response survives a change of native runtime.
    const continued = await target.callTool({
      name: 'forge_create_work',
      arguments: {
        requestId: 'create-work',
        title: 'Persistent work',
        goal: 'Use the same profile and work across native companions.',
        accountId: f.account.id,
      },
    });
    assert(!continued.isError, JSON.stringify(continued));
    assert.equal((continued.structuredContent as unknown as Work).id, work.id);
    assert.equal((await f.companions.start(staged.grant.id, input)).id, run.id);
    const next = await f.companions.context(staged.grant.id, work.id);
    await assert.rejects(
      f.companions.start(staged.grant.id, {
        ...input,
        requestId: 'cannot-reset-allowance',
        expectedRevision: next.revision,
        contextDigest: next.reviewDigest,
      }),
      /finite native run limit/,
    );
    assert.equal(f.drivers.length, 1);
    assert.equal(f.local.all('work').length, 1);
    assert.equal(f.local.work(work.id).profileId, work.profileId);
    assert.equal(
      (await f.companionHandoffs.stage(plan.id, plan.digest, { kind: 'local' })).token,
      null,
    );
    const snapshot = (await f.human('GET', '/api/snapshot')).body;
    assert(
      !snapshot.includes(staged.token) &&
        !snapshot.includes(old.token) &&
        !snapshot.includes('tokenHash'),
    );
  } finally {
    await f.close();
  }
});

test('changed memory and work invalidate replacement readiness; explicit refresh requires a new target acknowledgement', async () => {
  const f = await fixture();
  try {
    const file = join(f.root, 'handoff-memory.md');
    await writeFile(file, '# Selected\nfirst fact\n# Private\nnot selected\n');
    const selected = await inspectMemory(file, ['Selected']);
    const source = await f.profiles.addSource(
      {
        label: 'Selected handoff fact',
        owner: 'markdown',
        path: file,
        section: ['Selected'],
        scope: { kind: 'global' },
      },
      selected.sha256,
      selected.selectionSha256,
    );
    const profile = f.profiles.profile();
    f.profiles.update(profile.id, profile.revision, { ...profile, memorySourceIds: [source.id] });
    const old = await f.grant(),
      work = await f.createWork(old.grant.id);
    const stale = await f.companionHandoffs.prepare({
      grantId: old.grant.id,
      label: 'Another MCP runtime',
    });
    f.local.updateWork(work.id, { title: 'Changed during review' });
    await assert.rejects(
      f.companionHandoffs.stage(stale.id, stale.digest, { kind: 'local' }),
      /Context changed/,
    );
    const plan = await f.companionHandoffs.prepare({
      grantId: old.grant.id,
      label: 'Another MCP runtime',
    });
    const staged = await f.companionHandoffs.stage(plan.id, plan.digest, { kind: 'local' });
    await f.companionHandoffs.ready(staged.grant.id, plan.id, plan.digest);
    let row = f.companionHandoffs.list()[0];
    f.local.put('memory_sources', source.id, {
      ...source,
      revision: source.revision + 1,
      scope: { kind: 'project', root: f.project },
    });
    await assert.rejects(
      f.companionHandoffs.activate(row.id, row.digest, row.revision),
      /Context changed/,
    );
    row = await f.companionHandoffs.refresh(row.id, row.digest, row.revision);
    await f.companionHandoffs.ready(staged.grant.id, row.id, row.digest);
    row = f.companionHandoffs.list()[0];
    await writeFile(file, '# Selected\ncorrected fact\n# Private\nnot selected\n');
    await assert.rejects(
      f.companionHandoffs.activate(row.id, row.digest, row.revision),
      /Context changed/,
    );
    row = await f.companionHandoffs.refresh(row.id, row.digest, row.revision);
    assert.equal(row.state, 'staged');
    assert.notEqual(row.digest, plan.digest);
    await assert.rejects(
      f.companionHandoffs.ready(staged.grant.id, plan.id, plan.digest),
      /does not match/,
    );
    await f.companionHandoffs.ready(staged.grant.id, row.id, row.digest);
    row = f.companionHandoffs.list()[0];
    await f.companionHandoffs.activate(row.id, row.digest, row.revision);
    const context = await f.companions.context(staged.grant.id, work.id);
    assert(context.memories[0].content.includes('corrected fact'));
    assert(!JSON.stringify(context).includes('not selected'));
    assert.equal(f.local.all('work').length, 1);
  } finally {
    await f.close();
  }
});

test('abort revokes staged credentials without resurrecting manually revoked access, and setup remains local human only', async () => {
  const f = await fixture();
  try {
    const old = await f.grant(),
      input = { grantId: old.grant.id, label: 'Replacement' };
    const deniedHeaders: Record<string, string>[] = [
      { 'x-forge-workspace': 'demo' },
      { authorization: `Bearer ${old.token}` },
      { 'x-forge-csrf': 'invalid' },
    ];
    for (const extra of deniedHeaders)
      assert.equal(
        (await f.human('POST', '/api/companions/handoffs/prepare', input, extra)).statusCode,
        403,
      );
    const prepared = await f.human('POST', '/api/companions/handoffs/prepare', input);
    assert.equal(prepared.statusCode, 200, prepared.body);
    const plan = prepared.json();
    const stage = await f.human('POST', '/api/companions/handoffs/stage', {
      id: plan.id,
      digest: plan.digest,
    });
    assert.equal(stage.statusCode, 201, stage.body);
    const staged = stage.json();
    f.companions.revoke(old.grant.id);
    const cancelled = await f.companionHandoffs.abort(
      staged.handoff.id,
      staged.handoff.digest,
      staged.handoff.revision,
    );
    assert.equal(cancelled.state, 'aborted');
    assert.throws(() => f.companions.authenticate(`Bearer ${old.token}`), /revoked/);
    assert.throws(() => f.companions.authenticate(`Bearer ${staged.token}`), /revoked/);
    assert.deepEqual(
      await f.companionHandoffs.abort(cancelled.id, cancelled.digest, cancelled.revision - 1),
      cancelled,
    );
    assert.equal(
      (await f.human('GET', '/api/snapshot', undefined, { 'x-forge-workspace': 'demo' })).json()
        .companionHandoffs.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('restart retains staged handoff and read-only fences without returning a credential or automatically activating', async () => {
  const f = await fixture({ disk: true });
  let reopened: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const old = await f.grant(),
      work = await f.createWork(old.grant.id);
    const plan = await f.companionHandoffs.prepare({
      grantId: old.grant.id,
      label: 'Restarted runtime',
    });
    const stage = await f.companionHandoffs.stage(plan.id, plan.digest, { kind: 'local' });
    await f.app.close();
    reopened = await createApp({
      filename: join(f.root, 'workspace.sqlite'),
      port: 0,
      test: true,
      memoryPressureReader: unknownPressure,
    });
    const row = reopened.companionHandoffs.list()[0];
    assert.equal(row.state, 'staged');
    assert.equal(reopened.companions.work(stage.grant.id, work.id).work.id, work.id);
    await assert.rejects(
      reopened.companions.createWork(stage.grant.id, {
        requestId: 'before-ready',
        title: 'Held',
        goal: 'No automatic activation.',
      }),
      /replacement/,
    );
    assert.equal(
      (await reopened.companionHandoffs.stage(plan.id, plan.digest, { kind: 'local' })).token,
      null,
    );
    await reopened.companionHandoffs.abort(row.id, row.digest, row.revision);
    assert.equal(reopened.companions.authenticate(`Bearer ${old.token}`).id, old.grant.id);
    assert.throws(() => reopened!.companions.authenticate(`Bearer ${stage.token}`), /revoked/);
    assert.equal(reopened.local.all('work').length, 1);
  } finally {
    await reopened?.app.close();
    await f.close();
  }
});

test('failed metadata staging rolls back both access states and exposes no replacement credential', async () => {
  const f = await fixture();
  try {
    const old = await f.grant(),
      plan = await f.companionHandoffs.prepare({
        grantId: old.grant.id,
        label: 'Atomic replacement',
      });
    const put = f.local.put.bind(f.local);
    f.local.put = (collection, key, value) => {
      if (collection === 'companion_handoffs')
        throw new Error('Injected checkpoint write failure.');
      return put(collection, key, value);
    };
    await assert.rejects(
      f.companionHandoffs.stage(plan.id, plan.digest, { kind: 'local' }),
      /Injected/,
    );
    f.local.put = put;
    assert.equal(f.companions.list().length, 1);
    assert.equal(f.companions.authenticate(`Bearer ${old.token}`).id, old.grant.id);
    assert.equal(f.companionHandoffs.list().length, 0);
    const staged = await f.companionHandoffs.stage(plan.id, plan.digest, { kind: 'local' });
    assert(staged.token);
    assert.equal(f.companions.list().length, 2);
    assert.equal(f.companionHandoffs.list().length, 1);
  } finally {
    await f.close();
  }
});

test('a human-started unconfirmed native attempt in the project cannot be bypassed through companion replacement', async () => {
  const f = await fixture();
  try {
    const old = await f.grant(),
      work = await f.createWork(old.grant.id);
    f.local.put('runs', 'unconfirmed-human-run', {
      id: 'unconfirmed-human-run',
      workId: work.id,
      accountId: f.account.id,
      harness: 'codex',
      generation: 1,
      status: 'interrupted',
      nativeSessionId: null,
      nativeTurnId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitConfirmed: false,
    });
    await assert.rejects(
      f.companionHandoffs.prepare({ grantId: old.grant.id, label: 'Must wait for native exit' }),
      /Reconcile.*native attempts/,
    );
    assert.equal(f.companions.list().length, 1);
    assert.equal(f.companionHandoffs.list().length, 0);
    assert.equal(f.companions.authenticate(`Bearer ${old.token}`).id, old.grant.id);
  } finally {
    await f.close();
  }
});

test('the private phone reviewer can activate an already staged native replacement without provisioning a secret', async () => {
  const bridge = {
    origin: 'https://forge-handoff.fixture.invalid',
    proof: 'owned-phone-handoff-proof',
  };
  const f = await fixture({ phoneBridge: bridge });
  const remote = {
    origin: bridge.origin,
    'x-forge-bridge-proof': bridge.proof,
    'x-forge-bridge-identity': 'reviewer@example.invalid',
  };
  try {
    const old = await f.grant();
    assert.equal(
      (
        await f.human(
          'POST',
          '/api/companions/handoffs/prepare',
          { grantId: old.grant.id, label: 'Phone cannot provision' },
          remote,
        )
      ).statusCode,
      403,
    );
    const plan = await f.companionHandoffs.prepare({
      grantId: old.grant.id,
      label: 'Phone reviewed replacement',
    });
    const staged = await f.companionHandoffs.stage(plan.id, plan.digest, { kind: 'local' });
    await f.companionHandoffs.ready(staged.grant.id, plan.id, plan.digest);
    const row = f.companionHandoffs.list()[0];
    assert.equal(
      (
        await f.human(
          'POST',
          `/api/companions/handoffs/${row.id}/activate`,
          { digest: row.digest, revision: row.revision },
          remote,
        )
      ).statusCode,
      400,
    );
    const activated = await f.human(
      'POST',
      `/api/companions/handoffs/${row.id}/activate`,
      { digest: row.digest, revision: row.revision, nativeActivityReviewed: true },
      remote,
    );
    assert.equal(activated.statusCode, 200, activated.body);
    assert.deepEqual(activated.json().reviewedBy, {
      kind: 'tailscale',
      identity: 'reviewer@example.invalid',
    });
    assert(!activated.body.includes(staged.token!));
    assert.throws(() => f.companions.authenticate(`Bearer ${old.token}`), /revoked/);
    assert.equal(f.companions.authenticate(`Bearer ${staged.token}`).id, staged.grant.id);
  } finally {
    await f.close();
  }
});
