import { unknownPressure } from '../server/memory-pressure.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApp } from '../server/app.js';
import { NativeRpc } from '../server/adapters/rpc.js';
import type { Account, Approval, Usage, Work } from '../shared/types.js';
import type { DriverSink } from '../server/adapters/driver.js';
const host = '127.0.0.1:4710';
const token = 'test-protection-token';
async function fixture(
  badPolicy = false,
  nativeOptions: { metered?: boolean; withdraw?: boolean } = {},
) {
  const state = await createApp({
    memoryPressureReader: unknownPressure,
    filename: ':memory:',
    csrf: token,
    test: true,
    codexBinary: process.execPath,
    rpcFactory: (options) =>
      new NativeRpc({
        ...options,
        binary: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))],
        env: {
          ...options.env,
          ...(badPolicy ? { FORGE_FIXTURE_BAD_POLICY: '1' } : {}),
          ...(nativeOptions.metered ? { FORGE_FIXTURE_METERED: '1' } : {}),
          ...(nativeOptions.withdraw ? { FORGE_FIXTURE_WITHDRAW: '1' } : {}),
        },
        timeoutMs: 1500,
      }),
  });
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    mode = 'local',
  ) =>
    state.app.inject({
      method,
      url,
      headers: {
        host,
        'x-forge-csrf': token,
        'x-forge-workspace': mode,
        ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      },
      payload:
        method === 'GET'
          ? undefined
          : url.endsWith('/launch')
            ? {
                expectedRevision: state.local.get<Work>('work', url.split('/')[3])?.revision ?? 0,
                ...((payload as object) ?? {}),
              }
            : (payload ?? {}),
    });
  return { ...state, call };
}
async function waitFor<T>(fn: () => T | null | undefined, label: string): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function prepared(state: Awaited<ReturnType<typeof fixture>>) {
  const account = (
    await state.call('POST', '/api/accounts', { label: 'Fixture account', harness: 'codex' })
  ).json<Account>();
  const work = (
    await state.call('POST', '/api/work', {
      title: 'Protocol fixture',
      project: 'Synthetic project',
      cwd: process.cwd(),
      goal: 'Exercise native permission correlation without running commands.',
      harness: 'codex',
      accountId: account.id,
    })
  ).json<Work>();
  return { account, work };
}

test('stop acknowledges immediately, withdraws decisions and retains ownership until native exit', async () => {
  let sink!: DriverSink;
  let release!: () => void;
  const exit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await createApp({
    memoryPressureReader: unknownPressure,
    filename: ':memory:',
    csrf: token,
    test: true,
    driverFactory: () => ({
      harness: 'codex',
      closed: false,
      start: async (_context, next) => {
        sink = next;
        sink.session('session');
        sink.turn('turn');
      },
      interrupt: () => exit,
      close: () => exit,
    }),
  });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    state.app.inject({
      method: 'POST',
      url,
      headers: { host, 'x-forge-csrf': token, 'content-type': 'application/json' },
      payload,
    });
  try {
    const account = (
      await post('/api/accounts', { label: 'Stop fixture', harness: 'codex' })
    ).json<Account>();
    const work = (
      await post('/api/work', {
        title: 'Slow native cleanup',
        project: 'Fixture',
        cwd: process.cwd(),
        goal: 'Keep native ownership through cleanup.',
        harness: 'codex',
        accountId: account.id,
      })
    ).json<Work>();
    const launch = await post(`/api/work/${work.id}/launch`, { expectedRevision: work.revision });
    assert.equal(launch.statusCode, 202);
    await waitFor(() => sink, 'native binding');
    sink.approval({
      requestId: 'request',
      method: 'fixture',
      sessionId: 'session',
      turnId: 'turn',
      params: { action: 'none' },
      title: 'Synthetic review',
      detail: 'No real command.',
      command: 'none',
      cwd: process.cwd(),
      respond: () => {},
    });
    const approval = state.local.all<Approval>('approvals')[0];
    assert.equal(approval.status, 'pending');
    const response = await post(`/api/work/${work.id}/interrupt`);
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().stopping, true);
    assert(state.local.work(work.id).stopRequestedAt);
    assert(state.local.work(work.id).activeRunId);
    assert.equal(state.local.get<Approval>('approvals', approval.id)?.status, 'invalidated');
    assert.equal((await post(`/api/work/${work.id}/interrupt`)).statusCode, 409);
    assert.equal(
      (
        await post(`/api/work/${work.id}/launch`, {
          expectedRevision: state.local.work(work.id).revision,
        })
      ).statusCode,
      409,
    );
    release();
    await waitFor(() => !state.local.work(work.id).activeRunId, 'confirmed native exit');
    assert.equal(state.local.work(work.id).status, 'interrupted');
    assert.equal(state.local.work(work.id).stopRequestedAt, null);
  } finally {
    release();
    await state.app.close();
  }
});

test('native account checks share admission with each other, inventory and managed launches', async () => {
  let release!: () => void;
  let checks = 0;
  let drivers = 0;
  let reads = 0;
  const checking = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await createApp({
    memoryPressureReader: unknownPressure,
    filename: ':memory:',
    csrf: token,
    test: true,
    accountProbe: async (account) => {
      checks++;
      await checking;
      return account;
    },
    nativeSourcesOptions: {
      reader: async () => {
        reads++;
        throw new Error('Not expected.');
      },
    },
    driverFactory: () => {
      drivers++;
      return {
        harness: 'codex',
        closed: false,
        start: async () => {},
        interrupt: async () => {},
        close: async () => {},
      };
    },
  });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    state.app.inject({
      method: 'POST',
      url,
      headers: { host, 'x-forge-csrf': token, 'content-type': 'application/json' },
      payload,
    });
  try {
    const one = (
      await post('/api/accounts', { label: 'Probe one', harness: 'codex' })
    ).json<Account>();
    const two = (
      await post('/api/accounts', { label: 'Probe two', harness: 'codex' })
    ).json<Account>();
    const work = (
      await post('/api/work', {
        title: 'Native admission',
        project: 'Fixture',
        cwd: process.cwd(),
        goal: 'Preserve headroom while checking accounts.',
        harness: 'codex',
        accountId: one.id,
      })
    ).json<Work>();
    const source = (
      await post('/api/native/sources', {
        kind: 'codex',
        label: 'Probe inventory',
        home: process.cwd(),
      })
    ).json<{ id: string }>();
    const first = post(`/api/accounts/${one.id}/probe`).then((result) => result);
    await waitFor(() => checks === 1, 'first native status check');
    assert.equal((await post(`/api/accounts/${two.id}/probe`)).statusCode, 409);
    assert.equal((await post(`/api/native/sources/${source.id}/refresh`)).statusCode, 409);
    assert.equal(
      (await post(`/api/work/${work.id}/launch`, { expectedRevision: work.revision })).statusCode,
      409,
    );
    assert.equal(checks, 1);
    assert.equal(reads, 0);
    assert.equal(drivers, 0);
    release();
    assert.equal((await first).statusCode, 200);
    assert.equal(
      (await post(`/api/work/${work.id}/launch`, { expectedRevision: work.revision })).statusCode,
      202,
    );
    assert.equal((await post(`/api/accounts/${two.id}/probe`)).statusCode, 409);
    assert.equal(drivers, 1);
  } finally {
    release();
    await state.app.close();
  }
});

test('local API rejects cross-origin mutations, missing protection, and hostile hosts', async () => {
  const state = await fixture();
  try {
    assert.equal(
      (await state.app.inject({ url: '/api/snapshot', headers: { host: 'attacker.invalid' } }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await state.app.inject({
          method: 'POST',
          url: '/api/accounts',
          headers: {
            host,
            origin: 'https://attacker.invalid',
            'content-type': 'application/json',
            'x-forge-csrf': token,
          },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await state.app.inject({
          method: 'PATCH',
          url: '/api/settings',
          headers: { host, 'content-type': 'application/json' },
          payload: { quietMode: true },
        })
      ).statusCode,
      403,
    );
    assert.equal((await state.call('GET', '/api/snapshot')).statusCode, 200);
  } finally {
    await state.app.close();
  }
});
test('demo mutations are isolated, and demo never starts native execution', async () => {
  const state = await fixture();
  try {
    assert.equal((await state.call('GET', '/api/snapshot')).json().work.length, 0);
    const data = (await state.call('GET', '/api/snapshot', undefined, 'demo')).json();
    assert.equal(data.work.length, 4);
    const approval = data.approvals[0];
    assert.equal(
      (
        await state.call(
          'POST',
          `/api/approvals/${approval.id}/decision`,
          { digest: approval.digest, decision: 'accept' },
          'local',
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await state.call(
          'POST',
          `/api/approvals/${approval.id}/decision`,
          { digest: approval.digest, decision: 'accept' },
          'demo',
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await state.call('POST', '/api/work/demo-design/launch', {}, 'demo')).statusCode,
      409,
    );
    assert.equal(state.local.all('work').length, 0);
    assert.equal(state.controller.activeCount, 0);
  } finally {
    await state.app.close();
  }
});
test('an exact native approval is consumed once, and repeated cumulative usage is deduplicated', async () => {
  const state = await fixture();
  try {
    const { work } = await prepared(state);
    const started = await state.call('POST', `/api/work/${work.id}/launch`, {});
    assert.equal(started.statusCode, 202, started.body);
    const approval = await waitFor(
      () => state.local.all<Approval>('approvals').find((a) => a.status === 'pending'),
      'native request',
    );
    assert.equal(state.local.work(work.id).status, 'waiting');
    const wrong = await state.call('POST', `/api/approvals/${approval.id}/decision`, {
      digest: '0'.repeat(64),
      decision: 'accept',
    });
    assert.equal(wrong.statusCode, 409);
    const accepted = await state.call('POST', `/api/approvals/${approval.id}/decision`, {
      digest: approval.digest,
      decision: 'accept',
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(
      (
        await state.call('POST', `/api/approvals/${approval.id}/decision`, {
          digest: approval.digest,
          decision: 'accept',
        })
      ).statusCode,
      409,
    );
    await waitFor(() => state.local.work(work.id).status === 'completed', 'native turn completion');
    const usage = state.local.all<Usage>('usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].totalTokens, 100);
    assert.equal(usage[0].estimatedUsd, null);
  } finally {
    await state.app.close();
  }
});
test('stale generations, expired decisions, and parallel writers are rejected', async () => {
  const state = await fixture();
  try {
    const { work } = await prepared(state);
    await state.call('POST', `/api/work/${work.id}/launch`, {});
    const approval = await waitFor(
      () => state.local.all<Approval>('approvals').find((a) => a.status === 'pending'),
      'native request',
    );
    assert.equal((await state.call('POST', `/api/work/${work.id}/launch`, {})).statusCode, 409);
    const other = (
      await state.call('POST', '/api/work', {
        title: 'Second writer',
        project: 'Fixture',
        cwd: process.cwd(),
        goal: 'Never start concurrently',
        harness: 'codex',
        accountId: work.accountId,
      })
    ).json<Work>();
    assert.equal((await state.call('POST', `/api/work/${other.id}/launch`, {})).statusCode, 409);
    state.local.updateWork(work.id, { generation: approval.generation + 1 });
    assert.equal(
      (
        await state.call('POST', `/api/approvals/${approval.id}/decision`, {
          digest: approval.digest,
          decision: 'accept',
        })
      ).statusCode,
      409,
    );
    state.local.updateWork(work.id, { generation: approval.generation });
    state.local.put('approvals', approval.id, {
      ...approval,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    assert.equal(
      (
        await state.call('POST', `/api/approvals/${approval.id}/decision`, {
          digest: approval.digest,
          decision: 'accept',
        })
      ).statusCode,
      409,
    );
  } finally {
    await state.app.close();
  }
});
test('native policy mismatch stops before any approval or usage event', async () => {
  const state = await fixture(true);
  try {
    const { work } = await prepared(state);
    await state.call('POST', `/api/work/${work.id}/launch`, {});
    await waitFor(() => state.local.work(work.id).status === 'failed', 'native policy rejection');
    assert.equal(state.local.all('approvals').length, 0);
    assert.equal(state.local.all('usage').length, 0);
  } finally {
    await state.app.close();
  }
});
test('quiet mode gates new work, and setup exports exclude private account details', async () => {
  const state = await fixture();
  try {
    const { work } = await prepared(state);
    await state.call('PATCH', '/api/settings', { quietMode: true });
    assert.equal((await state.call('POST', `/api/work/${work.id}/launch`, {})).statusCode, 409);
    const blueprint = await state.call('GET', '/api/blueprint');
    assert.equal(blueprint.statusCode, 200);
    assert.equal(blueprint.body.includes('Fixture account'), false);
    assert.equal(blueprint.body.includes(process.cwd()), false);
    assert.equal(
      (await state.call('GET', `/api/work/${work.id}/export`))
        .json()
        .coverage.includes('Native transcripts'),
      true,
    );
  } finally {
    await state.app.close();
  }
});
test('Hermes discovery uses the native read-only capability contract', async () => {
  const calls: string[] = [];
  const native = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/health'
          ? { status: 'ok', platform: 'hermes-agent', version: 'fixture' }
          : {
              platform: 'hermes-agent',
              features: { session_resources: true, run_status: true, memory_write_api: false },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => native.listen(0, '127.0.0.1', resolve));
  const address = native.address() as { port: number };
  const state = await fixture();
  try {
    const result = await state.call('POST', '/api/connections/hermes', {
      endpoint: `http://127.0.0.1:${address.port}`,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().status, 'connected');
    assert.deepEqual(result.json().capabilities, ['session_resources', 'run_status']);
    assert.deepEqual(calls, ['GET /health', 'GET /v1/capabilities']);
    assert.equal(
      (await state.call('POST', '/api/connections/hermes', { endpoint: 'https://example.invalid' }))
        .statusCode,
      400,
    );
  } finally {
    await state.app.close();
    await new Promise<void>((resolve) => native.close(() => resolve()));
  }
});
test('stale editors cannot overwrite a newer work revision', async () => {
  const state = await fixture();
  try {
    const { work } = await prepared(state);
    const first = await state.call('PATCH', `/api/work/${work.id}`, {
      expectedRevision: work.revision,
      context: 'New durable context',
    });
    assert.equal(first.statusCode, 200, first.body);
    const stale = await state.call('PATCH', `/api/work/${work.id}`, {
      expectedRevision: work.revision,
      context: 'Old editor context',
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(state.local.work(work.id).context, 'New durable context');
  } finally {
    await state.app.close();
  }
});

test('a metered native route requires explicit permission before any turn', async () => {
  const state = await fixture(false, { metered: true });
  try {
    const { work } = await prepared(state);
    await state.call('POST', `/api/work/${work.id}/launch`, {});
    await waitFor(() => state.local.work(work.id).status === 'failed', 'metered route rejection');
    assert.equal(state.local.all('approvals').length, 0);
    assert.equal(state.local.all('usage').length, 0);
  } finally {
    await state.app.close();
  }
});

test('a request withdrawn by the native server cannot receive a later decision', async () => {
  const state = await fixture(false, { withdraw: true });
  try {
    const { work } = await prepared(state);
    await state.call('POST', `/api/work/${work.id}/launch`, {});
    const approval = await waitFor(
      () => state.local.all<Approval>('approvals').find((a) => a.status === 'invalidated'),
      'native withdrawal',
    );
    assert.equal(
      (
        await state.call('POST', `/api/approvals/${approval.id}/decision`, {
          digest: approval.digest,
          decision: 'accept',
        })
      ).statusCode,
      409,
    );
  } finally {
    await state.app.close();
  }
});

test('overview projections omit full context while explicit work reads preserve it', async () => {
  const state = await fixture();
  try {
    const { work } = await prepared(state);
    const overview = (await state.call('GET', '/api/snapshot')).json();
    assert.equal(overview.work[0].goal, undefined);
    assert.equal(overview.work[0].context, undefined);
    assert.equal(overview.events[0].detail, '');
    assert.equal((await state.call('GET', `/api/work/${work.id}`)).json().work.goal, work.goal);
  } finally {
    await state.app.close();
  }
});

test('launch consent cannot be reused after the work revision changes', async () => {
  const state = await fixture();
  try {
    const { work } = await prepared(state);
    state.local.updateWork(work.id, { context: 'Changed after the launch dialog was opened.' });
    const launch = await state.call('POST', `/api/work/${work.id}/launch`, {
      expectedRevision: work.revision,
      allowMetered: true,
    });
    assert.equal(launch.statusCode, 409);
    assert.equal(state.local.all('runs').length, 0);
    assert.equal(state.local.all('approvals').length, 0);
  } finally {
    await state.app.close();
  }
});

test('demo handoff endpoints cannot inspect local files or change local work bindings', async () => {
  const state = await fixture();
  try {
    const { work } = await prepared(state);
    assert.equal(
      (await state.call('POST', `/api/work/${work.id}/capsules`, {}, 'demo')).statusCode,
      409,
    );
    assert.equal(
      (await state.call('POST', `/api/work/${work.id}/handoff`, {}, 'demo')).statusCode,
      409,
    );
    assert.equal(state.local.all('capsules').length, 0);
    assert.equal(state.local.work(work.id).harness, 'codex');
  } finally {
    await state.app.close();
  }
});
