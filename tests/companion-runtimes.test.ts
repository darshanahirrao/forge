import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { now } from '../server/store.js';
import type { Account } from '../shared/types.js';
import type { CompanionProviderDefinition } from '../server/companion-providers.js';

const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error(`Timeout: ${label}`);
}
async function fixture(options: { beforeSpawn?: () => Promise<void> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-companion-runtime-'))),
    home = join(root, 'home'),
    project = join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  await writeFile(join(home, 'config.yaml'), 'native-fixture: true\n');
  let starts = 0;
  const definition: CompanionProviderDefinition = {
    contract: 1,
    nativeVersion: 'fixture-native',
    profileFiles: ['config.yaml'],
    connect: async (account, cwd, credentials, spawn) => {
      void account;
      void credentials;
      await options.beforeSpawn?.();
      starts++;
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000);",
        ],
        { cwd, env: { PATH: process.env.PATH } },
        { input: 'ignore', graceMs: 2000 },
      );
      const lost = new AbortController();
      const exit = new Promise<{ clean: boolean }>((resolve) => {
        child.once('close', (code, signal) => {
          lost.abort();
          resolve({ clean: code === 0 && signal === null });
        });
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('close', () => reject(Error('Fixture closed before readiness.')));
      });
      const pid = await child.nativeStarted;
      assert(pid);
      return {
        pid,
        version: 'fixture-native',
        signal: lost.signal,
        stop: () => {
          child.kill('SIGTERM');
          return exit;
        },
      };
    },
  };
  const filename = join(root, 'state.sqlite');
  const make = () =>
    createApp({
      filename,
      port: 0,
      test: true,
      memoryPressureReader: unknownPressure,
      companionProviders: { hermes: definition },
    });
  const state = await make();
  const account: Account = {
    id: 'native-hermes-runtime',
    label: 'Native runtime account',
    harness: 'hermes',
    nativeHome: home,
    billingMode: 'native',
    state: 'configured',
    identity: null,
    identityKey: null,
    plan: null,
    checkedAt: null,
    error: null,
    quotas: [],
    createdAt: now(),
  };
  state.local.put('accounts', account.id, account);
  const profile = state.local.all<{ id: string }>('profiles')[0];
  const grant = await state.companions.create({
    label: 'Native runtime access',
    profileId: profile.id,
    root: project,
    scopes: ['work:read', 'context:read', 'work:write'],
    accountIds: [],
  });
  const runtime = state.companionRuntimes.register({
    label: 'Owned native planner',
    accountId: account.id,
    grantId: grant.grant.id,
  });
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
      payload:
        payload === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(payload),
    });
  const start = async () => {
    const plan = await state.companionRuntimes.prepare(runtime.id);
    const body = {
      id: plan.id,
      digest: plan.digest,
      nativeActivityReviewed: true as const,
      nativeSpendingAccepted: true as const,
    };
    const launch = await state.companionRuntimes.start(body, { kind: 'local' });
    return { launch, body, plan };
  };
  return {
    ...state,
    root,
    home,
    project,
    account,
    grant,
    runtime,
    human,
    start,
    make,
    starts: () => starts,
    close: async () => {
      await state.app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

nativeTest(
  'native lifecycle retains an original child, disjoint resources and one intent through an idempotent stop/start review',
  async () => {
    const f = await fixture();
    try {
      const { launch, body } = await f.start();
      assert.equal(launch.state, 'starting');
      await until(
        () => f.companionRuntimes.snapshot().launches[0].state === 'running',
        'owned native readiness',
      );
      await until(
        () => Boolean(f.companionRuntimes.snapshot().launches[0].nativeWorker),
        'native root identity',
      );
      const current = f.companionRuntimes.snapshot().launches[0];
      assert.equal((await f.companionRuntimes.start(body, { kind: 'local' })).id, launch.id);
      assert.equal(f.starts(), 1);
      assert.equal(f.local.all('runs').length, 0, 'A companion gateway is not a work attempt.');
      assert.doesNotThrow(() => f.companionRuntimes.assertDispatch());
      const snapshot = (await f.human('GET', '/api/snapshot')).json();
      assert.equal(snapshot.nativeWorkers.length, 0);
      assert.equal(snapshot.companionWorkers.length, 1);
      assert.equal(
        snapshot.resources.groups.find((group: { kind: string }) => group.kind === 'companion')
          .rootPids[0],
        current.nativeWorker!.pid,
      );
      assert.equal(
        snapshot.resources.groups.reduce(
          (sum: number, group: { processCount: number }) => sum + group.processCount,
          0,
        ),
        snapshot.resources.processCount,
      );
      const stopping = f.companionRuntimes.stop(
        f.runtime.id,
        { launchId: launch.id, revision: 0 },
        { kind: 'local' },
      );
      assert.equal(stopping.state, 'stopping');
      assert.equal(
        f.companionRuntimes.stop(
          f.runtime.id,
          { launchId: launch.id, revision: 0 },
          { kind: 'local' },
        ).id,
        launch.id,
      );
      await until(
        () => f.companionRuntimes.snapshot().launches[0].exitConfirmed,
        'signed native close',
      );
      const ended = f.companionRuntimes.snapshot().launches[0];
      assert.equal(ended.exit!.method, 'signed-native-close');
      assert.equal(ended.exit!.native!.started, true);
      assert.equal(ended.exit!.native!.code, 0);
      assert.equal(ended.state, 'closed');
      assert.equal(f.starts(), 1);
    } finally {
      await f.close();
    }
  },
);

nativeTest(
  'profile review, native side-effect consent and human-only routes cannot be bypassed',
  async () => {
    const f = await fixture();
    try {
      const plan = await f.companionRuntimes.prepare(f.runtime.id);
      assert.equal(
        (
          await f.human('POST', '/api/companion-runtimes/start', {
            id: plan.id,
            digest: plan.digest,
          })
        ).statusCode,
        400,
      );
      await writeFile(join(f.home, 'config.yaml'), 'native-fixture: changed\n');
      await assert.rejects(
        f.companionRuntimes.start(
          {
            id: plan.id,
            digest: plan.digest,
            nativeActivityReviewed: true,
            nativeSpendingAccepted: true,
          },
          { kind: 'local' },
        ),
        /changed after review/,
      );
      await until(() => !f.companionRuntimes.isBusy, 'failed review barrier release');
      assert.equal(f.starts(), 0);
      for (const extra of [
        { authorization: `Bearer ${f.grant.token}` },
        { 'x-forge-workspace': 'demo' },
      ] as Record<string, string>[]) {
        assert.equal(
          (await f.human('POST', `/api/companion-runtimes/${f.runtime.id}/prepare`, {}, extra))
            .statusCode,
          extra.authorization ? 403 : 409,
        );
      }
      const demo = (
        await f.human('GET', '/api/snapshot', undefined, { 'x-forge-workspace': 'demo' })
      ).json();
      assert(!demo.companionRuntime);
      assert.deepEqual(demo.companionWorkers, []);
      const fresh = await f.start();
      await until(
        () => f.companionRuntimes.snapshot().launches[0].state === 'running',
        'fresh reviewed runtime',
      );
      assert.equal(fresh.launch.id, f.companionRuntimes.snapshot().launches[0].id);
    } finally {
      await f.close();
    }
  },
);

nativeTest(
  'an explicit stop before preparation commits never launches a replacement native process',
  async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ beforeSpawn: () => held });
    try {
      const { launch } = await f.start();
      const response = await f.human('POST', `/api/companion-runtimes/${f.runtime.id}/stop`, {
        launchId: launch.id,
        revision: launch.revision,
      });
      assert.equal(response.statusCode, 202);
      release();
      await until(() => !f.companionRuntimes.isBusy, 'cancelled native startup');
      assert.equal(f.companionRuntimes.snapshot().launches[0].exitConfirmed, true);
      assert.equal(f.companionRuntimes.snapshot().launches[0].nativeWorker, undefined);
      assert.equal(f.local.all('companion_supervisions').length, 0);
      assert.equal(f.local.all('runs').length, 0);
    } finally {
      release();
      await f.close();
    }
  },
);

nativeTest(
  'an owned gateway must stop before MCP handoff, account removal or profile retirement',
  async () => {
    const f = await fixture();
    try {
      const { launch } = await f.start();
      await until(
        () => f.companionRuntimes.snapshot().launches[0].state === 'running',
        'native readiness',
      );
      await assert.rejects(
        f.companionHandoffs.prepare({ grantId: f.grant.grant.id, label: 'Next native companion' }),
        /Stop and reconcile/,
      );
      assert.equal((await f.human('DELETE', `/api/accounts/${f.account.id}`)).statusCode, 409);
      assert.equal(
        (await f.human('DELETE', `/api/profiles/${f.runtime.profileId}`)).statusCode,
        409,
      );
      const latest = f.companionRuntimes.snapshot().launches[0];
      f.companionRuntimes.stop(
        f.runtime.id,
        { launchId: launch.id, revision: latest.revision },
        { kind: 'local' },
      );
      await until(
        () => f.companionRuntimes.snapshot().launches[0].exitConfirmed,
        'native source closure',
      );
      const handoff = await f.companionHandoffs.prepare({
        grantId: f.grant.grant.id,
        label: 'Next native companion',
      });
      assert(handoff.boundary.nativeRuntimeBinding);
      await f.companionHandoffs.stage(handoff.id, handoff.digest, { kind: 'local' });
      await assert.rejects(
        f.companionRuntimes.prepare(f.runtime.id),
        /access changed|preparing to drain/,
      );
    } finally {
      await f.close();
    }
  },
);

nativeTest(
  'restart holds a lost native-close acknowledgement for exact human reconciliation without replay',
  async () => {
    const f = await fixture();
    let reopened: Awaited<ReturnType<typeof f.make>> | undefined;
    try {
      const { launch } = await f.start();
      await until(
        () => f.companionRuntimes.snapshot().launches[0].state === 'running',
        'native startup',
      );
      f.companionRuntimes.stop(
        f.runtime.id,
        { launchId: launch.id, revision: 0 },
        { kind: 'local' },
      );
      await until(
        () => f.companionRuntimes.snapshot().launches[0].exitConfirmed,
        'original signed close',
      );
      const actual = f.companionRuntimes.snapshot().launches[0];
      // Crash boundary: the child wrote its actual signed close, but canonical acknowledgement was lost.
      f.local.put('companion_launches', actual.id, {
        ...actual,
        exitConfirmed: false,
        state: 'stopping',
        exit: undefined,
      });
      await f.app.close();
      reopened = await f.make();
      const recovery = reopened.companionRuntimes.snapshot().recovery[0];
      assert.equal(recovery.state, 'ready');
      assert.equal(f.starts(), 1);
      assert.throws(() => reopened!.companionRuntimes.assertDispatch(), /Reconcile/);
      assert.throws(
        () =>
          reopened!.companionRuntimes.reconcile(launch.id, '0'.repeat(64), recovery.revision, {
            kind: 'local',
          }),
        /evidence changed/,
      );
      const reconciled = reopened.companionRuntimes.reconcile(
        launch.id,
        recovery.digest!,
        recovery.revision,
        { kind: 'tailscale', identity: 'owner@example.invalid' },
      );
      assert.equal(reconciled.exitConfirmed, true);
      assert.deepEqual(reconciled.exit!.actor, {
        kind: 'tailscale',
        identity: 'owner@example.invalid',
      });
      assert.doesNotThrow(() => reopened!.companionRuntimes.assertDispatch());
      assert.equal(f.starts(), 1);
    } finally {
      await reopened?.app.close();
      await f.close();
    }
  },
);

nativeTest(
  'native gateway reviews bind resource policy and a running gateway retains its original policy through stop',
  async (t) => {
    const f = await fixture();
    try {
      if (!f.resourceGovernance.snapshot().supported) {
        t.skip('Native policy is unsupported on this host.');
        return;
      }
      await f.resourceGovernance.configure(
        { expectedRevision: 0, lowPriority: true, rootMemoryMiB: 512, effectsReviewed: true },
        { kind: 'local' },
      );
      const stale = await f.companionRuntimes.prepare(f.runtime.id);
      assert.equal(stale.nativeResources?.rootMemoryMiB, 512);
      await f.resourceGovernance.configure(
        { expectedRevision: 1, lowPriority: true, rootMemoryMiB: 1024, effectsReviewed: true },
        { kind: 'local' },
      );
      await assert.rejects(
        f.companionRuntimes.start(
          {
            id: stale.id,
            digest: stale.digest,
            nativeActivityReviewed: true,
            nativeSpendingAccepted: true,
          },
          { kind: 'local' },
        ),
        /changed after review/,
      );
      assert.equal(f.starts(), 0);
      const { launch } = await f.start();
      await until(
        () => f.companionRuntimes.snapshot().launches[0].state === 'running',
        'governed gateway readiness',
      );
      const current = f.companionRuntimes.snapshot().launches[0];
      assert.equal(current.nativeResources?.policyRevision, 2);
      assert.equal(current.nativeResources?.rootMemoryMiB, 1024);
      await f.resourceGovernance.configure(
        { expectedRevision: 2, lowPriority: false, rootMemoryMiB: null, effectsReviewed: true },
        { kind: 'local' },
      );
      assert.equal(
        f.companionRuntimes.snapshot().launches[0].nativeResources?.digest,
        current.nativeResources?.digest,
      );
      f.companionRuntimes.stop(
        f.runtime.id,
        { launchId: launch.id, revision: current.revision },
        { kind: 'local' },
      );
      await until(
        () => f.companionRuntimes.snapshot().launches[0].exitConfirmed,
        'governed gateway signed closure',
      );
      assert.equal(f.companionRuntimes.snapshot().launches[0].exit?.method, 'signed-native-close');
      assert.equal(f.starts(), 1);
    } finally {
      await f.close();
    }
  },
);
