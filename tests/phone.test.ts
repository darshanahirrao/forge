import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import { createPhoneGateway, phoneConfig, bridgeActor, type PhoneConfig } from '../server/phone.js';
import type { Account, Approval, Snapshot, Work } from '../shared/types.js';
import type { NativeDriver, DriverSink } from '../server/adapters/driver.js';

const origin = 'https://forge.synthetic.ts.net';
const owner = 'alice@example.com';
const config: PhoneConfig = { origin, users: [owner], port: 4712 };
async function fixture() {
  const bridge = { origin, proof: randomBytes(32).toString('hex') };
  let sink!: DriverSink;
  const decisions: string[] = [];
  let driverClosed = false;
  const driver: NativeDriver = {
    harness: 'codex',
    get closed() {
      return driverClosed;
    },
    async start(context, target) {
      sink = target;
      sink.session('native-session');
      sink.turn('native-turn');
      sink.approval({
        requestId: 'request',
        sessionId: 'native-session',
        turnId: 'native-turn',
        method: 'fixture/native',
        params: { path: 'proof.txt', content: 'Exact native payload' },
        title: 'Native request',
        detail: 'Review the exact native input.',
        command: 'Write proof.txt with exact content',
        cwd: context.work.cwd,
        respond(decision) {
          decisions.push(decision);
        },
      });
    },
    async interrupt() {},
    async close() {
      driverClosed = true;
    },
  };
  const state = await createApp({
    filename: ':memory:',
    port: 0,
    test: true,
    csrf: 'phone-protection',
    phoneBridge: bridge,
    driverFactory: () => driver,
  });
  const upstream = await state.app.listen({ host: '127.0.0.1', port: 0 });
  const gateway = await createPhoneGateway(config, upstream, bridge);
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const headers = { host: new URL(origin).host, 'tailscale-user-login': owner };
  const remote = async (
    path: string,
    method = 'GET',
    body?: unknown,
    changes: Record<string, string> = {},
  ) =>
    fetch(address + path, {
      method,
      headers: {
        ...headers,
        ...(method === 'GET'
          ? {}
          : { origin, 'content-type': 'application/json', 'x-forge-csrf': 'phone-protection' }),
        ...changes,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  const local = async <T>(path: string, body: unknown) => {
    const r = await state.app.inject({
      method: 'POST',
      url: path,
      headers: {
        host: '127.0.0.1:0',
        'content-type': 'application/json',
        'x-forge-csrf': 'phone-protection',
      },
      payload: body as object,
    });
    assert(r.statusCode < 300, r.body);
    return r.json<T>();
  };
  return {
    ...state,
    localStore: state.local,
    gateway,
    bridge,
    remote,
    local,
    decisions,
    sink: () => sink,
    async close() {
      await gateway.close();
      await state.app.close();
    },
  };
}

test('phone access is opt-in, private-HTTPS scoped and bound to explicit identities and a separate port', () => {
  assert.equal(phoneConfig({}, 4710), null);
  assert.deepEqual(
    phoneConfig({ FORGE_PHONE_ORIGIN: origin, FORGE_PHONE_USERS: ` ${owner},${owner} ` }, 4710),
    config,
  );
  assert.equal(
    phoneConfig({ FORGE_PHONE_ORIGIN: origin + ':8443', FORGE_PHONE_USERS: owner }, 4710)?.origin,
    origin + ':8443',
  );
  for (const bad of [
    'http://forge.synthetic.ts.net',
    'https://public.example.com',
    'https://forge.synthetic.ts.net/path',
    'https://user@forge.synthetic.ts.net',
    'https://forge.synthetic.ts.net:22',
    'https://forge.synthetic.ts.net/?query=1',
  ])
    assert.throws(() => phoneConfig({ FORGE_PHONE_ORIGIN: bad, FORGE_PHONE_USERS: owner }, 4710));
  assert.throws(() => phoneConfig({ FORGE_PHONE_USERS: owner }, 4710));
  assert.throws(() => phoneConfig({ FORGE_PHONE_ORIGIN: origin }, 4710));
  assert.throws(() =>
    phoneConfig(
      { FORGE_PHONE_ORIGIN: origin, FORGE_PHONE_USERS: owner, FORGE_PHONE_PORT: '4710' },
      4710,
    ),
  );
  assert.throws(() =>
    phoneConfig({ FORGE_PHONE_ORIGIN: origin, FORGE_PHONE_USERS: 'alice\r\ninjected' }, 4710),
  );
  assert.deepEqual(bridgeActor({}), { kind: 'local' });
  assert.throws(() => bridgeActor({ 'tailscale-user-login': owner }), /private Forge gateway/);
});

test('the phone gateway rejects anonymous, non-owner, foreign-origin and non-loopback requests before native API access', async () => {
  const f = await fixture();
  try {
    for (const headers of [
      { host: new URL(origin).host },
      { host: new URL(origin).host, 'tailscale-user-login': 'mallory@example.com' },
      { host: new URL(origin).host, 'tailscale-user-login': `${owner},mallory@example.com` },
    ]) {
      const r = await f.gateway.inject({ url: '/api/snapshot', headers });
      assert.equal(r.statusCode, 401);
      assert(!r.body.includes('csrf'));
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    for (const headers of [
      { host: 'evil.invalid', 'tailscale-user-login': owner },
      { host: new URL(origin).host, 'tailscale-user-login': owner, origin: 'https://evil.invalid' },
      { host: new URL(origin).host, 'tailscale-user-login': owner, 'sec-fetch-site': 'cross-site' },
    ])
      assert.equal((await f.gateway.inject({ url: '/api/snapshot', headers })).statusCode, 403);
    assert.equal(
      (
        await f.gateway.inject({
          url: '/api/snapshot',
          remoteAddress: '198.51.100.8',
          headers: { host: new URL(origin).host, 'tailscale-user-login': owner },
        })
      ).statusCode,
      403,
    );
    const navigation = await f.gateway.inject({
      url: '/api/snapshot',
      headers: {
        host: new URL(origin).host,
        'tailscale-user-login': owner,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    assert.equal(
      navigation.statusCode,
      200,
      'A private link must allow an authenticated top-level navigation.',
    );
    const noOrigin = await f.remote('/api/work', 'POST', { title: 'blocked' }, { origin: '' });
    assert.equal(noOrigin.status, 403);
    assert.equal(f.localStore.all<Work>('work').length, 0);
  } finally {
    await f.close();
  }
});

test('phone decisions reach the same native owner once, carry the authenticated actor and preserve all stale/digest checks', async () => {
  const f = await fixture();
  try {
    const r = await f.remote('/api/snapshot');
    assert.equal(r.status, 200, await r.clone().text());
    const snapshot = (await r.json()) as Snapshot;
    assert.deepEqual(snapshot.access, { kind: 'tailscale', identity: owner });
    assert.equal(snapshot.csrf, 'phone-protection');
    assert(
      !JSON.stringify(snapshot).includes(f.bridge.proof),
      'The server-only identity proof must never reach the browser.',
    );
    const account = await f.local<Account>('/api/accounts', {
      label: 'Native fixture',
      harness: 'codex',
    });
    const work = await f.local<Work>('/api/work', {
      title: 'Phone-reviewed work',
      project: 'Synthetic',
      cwd: process.cwd(),
      goal: 'Review the exact request from a phone surface.',
      harness: 'codex',
      accountId: account.id,
    });
    await f.local(`/api/work/${work.id}/launch`, { expectedRevision: work.revision });
    for (let i = 0; i < 200 && f.localStore.all<Approval>('approvals').length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const approval = f.localStore.all<Approval>('approvals')[0];
    assert(approval);
    const path = `/api/approvals/${approval.id}/decision`;
    assert.equal(
      (await f.remote(path, 'POST', { digest: '0'.repeat(64), decision: 'accept' })).status,
      409,
    );
    assert.equal(
      (
        await f.remote(
          path,
          'POST',
          { digest: approval.digest, decision: 'accept' },
          { 'x-forge-csrf': '' },
        )
      ).status,
      403,
    );
    assert.deepEqual(f.decisions, []);
    assert.equal(
      (
        await f.remote(
          path,
          'POST',
          { digest: approval.digest, decision: 'accept' },
          {
            'x-forge-bridge-identity': 'mallory@example.com',
            'x-forge-bridge-proof': 'forged',
            authorization: 'Bearer must-not-forward',
          },
        )
      ).status,
      200,
    );
    assert.deepEqual(f.decisions, ['accept']);
    assert.deepEqual(f.localStore.get<Approval>('approvals', approval.id)?.decidedBy, {
      kind: 'tailscale',
      identity: owner,
    });
    assert.equal(
      (await f.remote(path, 'POST', { digest: approval.digest, decision: 'accept' })).status,
      409,
    );
    assert.deepEqual(f.decisions, ['accept']);
    for (const headers of [
      { 'tailscale-user-login': owner },
      { 'x-forge-bridge-proof': 'bad', 'x-forge-bridge-identity': owner, origin },
      {
        'x-forge-bridge-proof': f.bridge.proof,
        'x-forge-bridge-identity': owner,
        origin: 'https://evil.invalid',
      },
    ])
      assert.equal(
        (await f.app.inject({ url: '/api/snapshot', headers: { host: '127.0.0.1:0', ...headers } }))
          .statusCode,
        403,
      );
  } finally {
    await f.close();
  }
});

test('the maintained phone proxy never retries a failed mutation and only targets loopback', async () => {
  const upstream = Fastify({ logger: false });
  let calls = 0;
  upstream.post('/api/decision', async (_req, reply) => {
    calls++;
    return reply.code(503).send({ error: 'Synthetic unavailable' });
  });
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const bridge = { origin, proof: randomBytes(32).toString('hex') };
  const gateway = await createPhoneGateway(config, address, bridge);
  try {
    const response = await gateway.inject({
      method: 'POST',
      url: '/api/decision',
      headers: {
        host: new URL(origin).host,
        'tailscale-user-login': owner,
        origin,
        'content-type': 'application/json',
      },
      payload: { decision: 'accept' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(calls, 1);
    await assert.rejects(
      createPhoneGateway(config, 'https://outside.example.com', bridge),
      /owned local Forge service/,
    );
  } finally {
    await gateway.close();
    await upstream.close();
  }
});
