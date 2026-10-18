import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayClientRequestError, type GatewayClientOptions } from '@openclaw/gateway-client';
import {
  OpenClawSchedules,
  type OpenClawScheduleClientFactory,
} from '../server/openclaw-schedules.js';
import { NativeSources } from '../server/native-sources.js';
import { NativeControls } from '../server/native-controls.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';
import type { NativeSource } from '../shared/types.js';

const envName = 'FORGE_TEST_SCHEDULE_BOOTSTRAP';
function fakeGateway() {
  let native = {
    id: 'owned-native-job',
    name: 'Owned native job',
    enabled: false,
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    payload: { kind: 'agentTurn', message: 'Native instructions remain native.' },
    configRevision: 'opaque-native-revision:first',
    nextRunAtMs: null as number | null,
    lastRunAtMs: null,
    lastRunStatus: null,
  };
  let revoked = false;
  let writes = 0,
    conflict = false,
    loseAck = false,
    absent = false,
    refused = false,
    nativeVersion = '2026.10.4',
    stopped = 0;
  let hold: ((error: Error) => void) | undefined;
  const options: GatewayClientOptions[] = [],
    requests: { method: string; params: any }[] = [];
  const factory: OpenClawScheduleClientFactory = (config) => {
    options.push(config);
    return {
      start: () => {
        void (async () => {
          if (revoked) {
            await config.hostDeps?.clearDeviceAuthToken?.({
              deviceId: config.deviceIdentity!.deviceId,
              role: 'operator',
              expectedToken: 'synthetic-device-grant-only',
            });
            config.onConnectError?.(new Error('Native device token revoked'));
            return;
          }
          if (refused) {
            config.onConnectError?.(new Error('pairing required'));
            return;
          }
          await config.hostDeps?.storeDeviceAuthToken?.({
            deviceId: config.deviceIdentity!.deviceId,
            role: 'operator',
            token: 'synthetic-device-grant-only',
            scopes: config.scopes!,
          });
          config.onHelloOk?.({
            protocol: 4,
            server: { version: nativeVersion },
            auth: { scopes: config.scopes, deviceToken: 'synthetic-device-grant-only' },
            features: { methods: ['cron.list', 'cron.get', 'cron.update'] },
          } as Parameters<NonNullable<GatewayClientOptions['onHelloOk']>>[0]);
        })().catch((error) => config.onConnectError?.(error));
      },
      stopAndWait: async () => {
        stopped++;
        hold?.(new Error('Owned native connection stopped'));
      },
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        requests.push({ method, params });
        if (method === 'cron.list')
          return { jobs: [{ ...native, scheduleKind: 'cron' }], hasMore: false } as T;
        if (method === 'cron.get') {
          if (absent)
            throw new GatewayClientRequestError({
              code: 'INVALID_REQUEST',
              message: `unknown cron job id: ${native.id}`,
              details: { code: 'CRON_JOB_NOT_FOUND', jobId: native.id },
            });
          return structuredClone(native) as T;
        }
        assert.equal(method, 'cron.update');
        const p = params as { expectedConfigRevision: string; patch: { enabled: boolean } };
        assert.equal(p.expectedConfigRevision, native.configRevision);
        if (conflict)
          throw new GatewayClientRequestError({
            code: 'INVALID_REQUEST',
            message: 'Native job changed.',
            details: { code: 'CRON_JOB_CHANGED' },
          });
        writes++;
        native = {
          ...native,
          enabled: p.patch.enabled,
          configRevision: `opaque-native-revision:${writes}`,
        };
        if (loseAck) throw new Error('Native acknowledgement lost after commit');
        return structuredClone(native) as T;
      },
    };
  };
  return {
    factory,
    options,
    requests,
    writes: () => writes,
    stopped: () => stopped,
    change: () => {
      native = { ...native, configRevision: 'changed-externally' };
    },
    conflict: () => {
      conflict = true;
    },
    lose: () => {
      loseAck = true;
    },
    absent: () => {
      absent = true;
    },
    refuse: () => {
      refused = true;
    },
    revoke: () => {
      revoked = true;
    },
    allow: () => {
      revoked = false;
      refused = false;
    },
    version: (value: string) => {
      nativeVersion = value;
    },
    oversized: () => {
      native = { ...native, payload: { ...native.payload, message: 'x'.repeat(21000) } };
    },
    holdUpdates: () => {
      loseAck = false;
      const base = factory;
      return ((config: GatewayClientOptions) => {
        const client = base(config),
          call = client.request.bind(client),
          stop = client.stopAndWait.bind(client);
        client.request = async <T>(method: string, params?: unknown): Promise<T> =>
          method === 'cron.update'
            ? new Promise<T>((_resolve, reject) => {
                hold = reject;
              })
            : call<T>(method, params);
        client.stopAndWait = async () => {
          await stop();
        };
        return client;
      }) as OpenClawScheduleClientFactory;
    },
  };
}
async function fixture(t: test.TestContext, controls = true) {
  const root = await mkdtemp(join(tmpdir(), 'forge-openclaw-schedules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = process.env[envName];
  process.env[envName] = 'synthetic-bootstrap-only';
  t.after(() => {
    if (old === undefined) delete process.env[envName];
    else process.env[envName] = old;
  });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sources = new NativeSources(store);
  const source = sources.add({
    kind: 'openclaw-schedules',
    label: 'Owned native scheduler',
    home: '',
    endpoint: 'http://127.0.0.1:18789',
    tokenEnv: envName,
    scheduleControls: controls,
  });
  const native = fakeGateway(),
    manager = new OpenClawSchedules(root, native.factory);
  t.after(() => manager.close());
  return {
    root,
    store,
    sources,
    source,
    native,
    manager,
    controls: new NativeControls(store, sources, manager.control),
    path: join(root, `.forge-openclaw-source-${source.id}.json`),
  };
}
test('native read-only pairing preserves one private device across restarts and requests compact metadata without control authority', async (t) => {
  const f = await fixture(t, false);
  const result = await f.manager.read(f.source);
  assert.equal(result.inventory.schedules[0].owner, 'openclaw');
  assert.equal(
    result.inventory.schedules[0].rule,
    JSON.stringify({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }),
  );
  assert.deepEqual(f.native.options[0].scopes, ['operator.read']);
  assert.equal(f.native.requests[0].params.compact, true);
  assert.equal(f.native.writes(), 0);
  assert.equal(f.native.stopped(), 1);
  const first = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  delete process.env[envName];
  await f.manager.close();
  const replacement = new OpenClawSchedules(f.root, f.native.factory);
  try {
    await replacement.read(f.source);
    assert.equal(f.native.options.at(-1)!.token, undefined);
    assert.equal(f.native.options.at(-1)!.deviceIdentity?.deviceId, first.device.deviceId);
    const persisted = JSON.parse(await readFile(f.path, 'utf8'));
    assert.deepEqual(persisted.device, first.device);
    await assert.rejects(
      f.controls.prepare({ sourceId: f.source.id, jobId: 'owned-native-job', action: 'resume' }),
      /Enable reviewed scheduler controls/,
    );
    assert.equal(f.native.writes(), 0);
    const canonical = JSON.stringify(f.store.db.prepare('SELECT data FROM records').all());
    assert(!canonical.includes('synthetic-device-grant-only'));
    assert(!canonical.includes('PRIVATE KEY'));
  } finally {
    await replacement.close();
  }
});
test('exact opaque native revisions fence changed definitions and human receipts do not replay a successful native control', async (t) => {
  const f = await fixture(t);
  const first = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'owned-native-job',
    action: 'resume',
  });
  assert.equal(first.contract, 'openclaw-native-revision/1');
  assert.match(first.jobsDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.native.options[0].scopes, ['operator.read', 'operator.admin']);
  f.native.change();
  assert.equal((await f.controls.apply(first.id, { kind: 'local' })).state, 'rejected');
  assert.equal(f.native.writes(), 0);
  const next = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'owned-native-job',
    action: 'resume',
  });
  const applied = await f.controls.apply(next.id, { kind: 'local' });
  assert.equal(applied.state, 'applied');
  assert.equal(applied.observed?.enabled, true);
  const requests = f.native.requests.length;
  assert.deepEqual(await f.controls.apply(next.id, { kind: 'local' }), applied);
  assert.equal(f.native.requests.length, requests);
  assert.equal(f.native.writes(), 1);
});
test('lost acknowledgements and uncorrelated missing-job errors retain uncertainty while disabled controls permit an outcome read', async (t) => {
  const f = await fixture(t);
  const plan = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'owned-native-job',
    action: 'resume',
  });
  f.native.lose();
  const receipt = await f.controls.apply(plan.id, { kind: 'local' });
  assert.equal(receipt.state, 'uncertain');
  assert.equal(f.native.writes(), 1);
  assert.throws(() => f.sources.remove(f.source.id), /uncertain native controls/);
  const next = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'owned-native-job',
    action: 'pause',
  });
  await assert.rejects(f.controls.apply(next.id, { kind: 'local' }), /prior uncertain/);
  assert.equal(f.native.writes(), 1);
  f.native.absent();
  f.store.put('native_sources', f.source.id, { ...f.source, scheduleControls: false, revision: 1 });
  await assert.rejects(
    f.controls.review(
      receipt.id,
      { kind: 'local' },
      'Checked native job history and delivery; the job may have been removed.',
    ),
    /unknown cron job id/,
  );
  assert.deepEqual(f.native.options.at(-1)!.scopes, ['operator.read']);
  assert.equal(f.store.get<any>('native_controls', receipt.id)?.review, undefined);
  assert.throws(() => f.sources.remove(f.source.id), /uncertain native controls/);
  assert.equal(f.native.writes(), 1);
});
test('pairing refusal, unsupported native versions and private identity changes send no scheduler mutation', async (t) => {
  const f = await fixture(t);
  f.native.refuse();
  await assert.rejects(f.manager.read(f.source), /native OpenClaw pairing/);
  assert.equal(f.native.requests.length, 0);
  assert.equal(f.native.stopped(), 1);
  const other = fakeGateway();
  other.version('unsupported');
  const old = new OpenClawSchedules(f.root, other.factory);
  try {
    await assert.rejects(old.read(f.source), /evaluated native scheduler/);
    assert.equal(other.requests.length, 0);
  } finally {
    await old.close();
  }
  await assert.rejects(
    f.manager.read({ ...f.source, endpoint: 'http://127.0.0.1:18790' }),
    /connection changed/,
  );
  await chmod(f.path, 0o644);
  await assert.rejects(f.manager.read(f.source), /private, owned regular/);
  assert.equal(f.native.requests.length, 0);
});
test('compact inventory remains available for an oversized native prompt while full review is refused before a write', async (t) => {
  const f = await fixture(t);
  f.native.oversized();
  assert.equal((await f.manager.read(f.source)).inventory.schedules.length, 1);
  await assert.rejects(
    f.controls.prepare({ sourceId: f.source.id, jobId: 'owned-native-job', action: 'resume' }),
    /instructions exceeds/,
  );
  assert.equal(f.native.writes(), 0);
});
test('a connection refusal before submission records a rejected control without an uncertain effect or retry', async (t) => {
  const f = await fixture(t);
  const plan = await f.controls.prepare({
    sourceId: f.source.id,
    jobId: 'owned-native-job',
    action: 'resume',
  });
  f.native.refuse();
  const receipt = await f.controls.apply(plan.id, { kind: 'local' });
  assert.equal(receipt.state, 'rejected');
  assert.equal(f.native.writes(), 0);
  const attempts = f.native.options.length;
  assert.deepEqual(await f.controls.apply(plan.id, { kind: 'local' }), receipt);
  assert.equal(f.native.options.length, attempts);
});
test('workspace shutdown persists a pending native mutation as uncertain before closing SQLite', async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const submitting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = f.native.holdUpdates();
  const factory: OpenClawScheduleClientFactory = (options) => {
    const client = held(options),
      call = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      const result = call<T>(method, params);
      if (method === 'cron.update') entered();
      return result;
    };
    return client;
  };
  const filename = join(f.root, 'closing.sqlite');
  const app = await createApp({
    filename,
    test: true,
    openClawScheduleClientFactory: factory,
    memoryPressureReader: unknownPressure,
  });
  t.after(() => app.app.close());
  app.local.put('native_sources', f.source.id, f.source);
  const plan = await app.nativeControls.prepare({
    sourceId: f.source.id,
    jobId: 'owned-native-job',
    action: 'resume',
  });
  const applying = app.nativeControls.apply(plan.id, { kind: 'local' });
  await submitting;
  const closing = app.app.close();
  assert.equal((await applying).state, 'uncertain');
  await closing;
  const reopened = new Store(filename);
  try {
    const receipt = reopened.get<{ state: string }>('native_controls', plan.id);
    assert.equal(receipt?.state, 'uncertain');
    assert.equal(f.native.writes(), 0);
  } finally {
    reopened.close();
  }
});
test('source shutdown drains an admitted native operation and refuses new work before storage can close', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = f.sources.atSource(f.source.id, async () => {
    await gate;
    f.store.put('config', 'owned-drain', { settled: true });
  });
  let closed = false;
  const closing = f.sources.close().then(() => {
    closed = true;
  });
  await assert.rejects(
    f.sources.atSource(f.source.id, async () => {}),
    /workspace is closing/,
  );
  assert.equal(closed, false);
  release();
  await admitted;
  await closing;
  assert.equal(f.store.get<{ settled: boolean }>('config', 'owned-drain')?.settled, true);
});
test('only a local human can choose native administrator scheduler access; revisions invalidate old native reviews', async (t) => {
  const f = await fixture(t, false);
  const app = await createApp({
    filename: join(f.root, 'api.sqlite'),
    csrf: 'native-scheduler-authority',
    test: true,
    openClawScheduleClientFactory: f.native.factory,
    phoneBridge: { origin: 'https://forge.fixture.invalid', proof: 'owned-private-phone-proof' },
  });
  t.after(() => app.app.close());
  const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': app.csrf };
  const payload = {
    kind: 'openclaw-schedules',
    label: 'Owned native access',
    endpoint: f.source.endpoint,
    tokenEnv: envName,
    scheduleControls: true,
  };
  assert.equal(
    (await app.app.inject({ method: 'POST', url: '/api/native/sources', headers, payload }))
      .statusCode,
    403,
  );
  const created = await app.app.inject({
    method: 'POST',
    url: '/api/native/sources',
    headers,
    payload: { ...payload, scheduleControls: false },
  });
  assert.equal(created.statusCode, 200);
  const source = created.json() as NativeSource;
  const url = `/api/native/sources/${source.id}/schedule-access`;
  const access = { expectedRevision: 0, scheduleControls: true, nativeAdminReviewed: true };
  assert.equal(
    (
      await app.app.inject({
        method: 'PATCH',
        url,
        headers: { ...headers, authorization: 'Bearer companion' },
        payload: access,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.app.inject({
        method: 'PATCH',
        url,
        headers: {
          ...headers,
          origin: 'https://forge.fixture.invalid',
          'x-forge-bridge-proof': 'owned-private-phone-proof',
          'x-forge-bridge-identity': 'owner@example.invalid',
        },
        payload: access,
      })
    ).statusCode,
    403,
  );
  const granted = await app.app.inject({ method: 'PATCH', url, headers, payload: access });
  assert.equal(granted.statusCode, 200);
  assert.equal(granted.json().revision, 1);
  assert.equal(
    (await app.app.inject({ method: 'PATCH', url, headers, payload: access })).statusCode,
    409,
  );
  const review = await app.nativeControls.prepare({
    sourceId: source.id,
    jobId: 'owned-native-job',
    action: 'resume',
  });
  assert.equal(
    (
      await app.app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { expectedRevision: 1, scheduleControls: false, nativeAdminReviewed: true },
      })
    ).statusCode,
    200,
  );
  await assert.rejects(app.nativeControls.apply(review.id, { kind: 'local' }), /source changed/);
  assert.equal(f.native.writes(), 0);
});

test('revoked native grants do not silently reuse bootstrap credentials; a new local access review is required', async (t) => {
  const f = await fixture(t, false);
  await f.manager.read(f.source);
  f.native.revoke();
  await assert.rejects(f.manager.read(f.source), /connection or authorization is unavailable/);
  const attempts = f.native.options.length;
  await assert.rejects(f.manager.read(f.source), /Review scheduler access on the local Forge host/);
  assert.equal(f.native.options.length, attempts);
  assert.equal(f.native.writes(), 0);
  f.native.allow();
  const revision = await f.manager.nextAccessRevision(f.source);
  await f.manager.read({ ...f.source, revision });
  assert.equal(f.native.options.at(-1)!.token, 'synthetic-bootstrap-only');
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).pairedRevision, revision);
});

test('an older restored access revision cannot regain control and a local review advances past the private receipt', async (t) => {
  const f = await fixture(t);
  await f.manager.read({ ...f.source, revision: 3 });
  const attempts = f.native.options.length;
  await assert.rejects(f.manager.read(f.source), /predates its private pairing receipt/);
  assert.equal(f.native.options.length, attempts);
  const revision = await f.manager.nextAccessRevision(f.source);
  assert.equal(revision, 4);
  await f.manager.read({ ...f.source, revision });
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).pairedRevision, 4);
  assert.equal(f.native.writes(), 0);
});

test('a lost previously observed pairing identity is replaced only through an explicit local access review', async (t) => {
  const f = await fixture(t, false);
  await f.manager.read(f.source);
  const before = JSON.parse(await readFile(f.path, 'utf8'));
  const observed = { ...f.source, checkedAt: new Date().toISOString() };
  await rm(f.path);
  const attempts = f.native.options.length;
  await assert.rejects(f.manager.read(observed), /private scheduler identity is missing/);
  assert.equal(f.native.options.length, attempts);
  const revision = await f.manager.nextAccessRevision(observed);
  await assert.rejects(f.manager.read(observed), /native device grant changed/);
  await f.manager.read({ ...observed, revision });
  const replacement = JSON.parse(await readFile(f.path, 'utf8'));
  assert.notEqual(replacement.device.deviceId, before.device.deviceId);
  assert.equal(f.native.writes(), 0);
});
