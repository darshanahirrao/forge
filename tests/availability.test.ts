import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';
import { serviceContext, prepareService, installService } from '../server/background-service.js';
import { activationLease, readActivation } from '../server/service-activation.js';
import { writePrivateJson } from '../server/private-json.js';
import type { AvailabilityOptions } from '../server/availability.js';
import type { ActivationReceipt, AvailabilityReview } from '../shared/availability.js';
import type { Run } from '../shared/types.js';

const headers = { host: '127.0.0.1:4710', 'x-forge-csrf': 'owned-availability-csrf' };
async function fixture(t: test.TestContext, overrides: Partial<AvailabilityOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-availability-')));
  const source = join(root, 'Owned source & files');
  const dataDirectory = join(root, 'State & data');
  for (const sub of ['dist/server', 'dist/client', 'bin'])
    await mkdir(join(source, sub), { recursive: true });
  for (const name of [
    'dist/server/index.js',
    'dist/client/index.html',
    'bin/service-runner.mjs',
    'bin/service-activate.mjs',
  ])
    await writeFile(join(source, name), 'owned fixture');
  let controls = 0,
    launches = 0,
    shutdowns = 0;
  const context = serviceContext({
    root: source,
    home: root,
    agentDirectory: join(root, 'Owned definitions'),
    platform: 'darwin',
    uid: process.getuid?.() ?? 1000,
    control: async () => {
      controls++;
      return null;
    },
  });
  const options: AvailabilityOptions = {
    dataDirectory,
    port: 4710,
    phone: null,
    context,
    environment: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      OPENAI_API_KEY: 'public-synthetic-excluded-secret',
    },
    launch: async (filename, intent, commit) => {
      launches++;
      commit();
      await writePrivateJson(filename, {
        ...intent,
        state: 'committed',
        detail: 'Owned fixture committed the handoff.',
      });
      return 'committed';
    },
    requestShutdown: () => {
      shutdowns++;
    },
    ...overrides,
  };
  const appOptions = {
    phoneBridge: {
      origin: 'https://availability.fixture.ts.net',
      proof: 'owned-availability-bridge-proof',
    },
    filename: join(dataDirectory, 'workspace.sqlite'),
    csrf: headers['x-forge-csrf'],
    memoryPressureReader: unknownPressure,
    availability: options,
    test: true,
  };
  let current = await createApp(appOptions);
  t.after(async () => {
    await current.app.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...current,
    root,
    source,
    dataDirectory,
    context,
    options,
    get controls() {
      return controls;
    },
    get launches() {
      return launches;
    },
    get shutdowns() {
      return shutdowns;
    },
    send: (url: string, payload: unknown = {}, extra: Record<string, string> = {}) =>
      current.app.inject({
        method: 'POST',
        url: `/api${url}`,
        headers: { ...headers, 'content-type': 'application/json', ...extra },
        payload: JSON.stringify(payload),
      }),
    restart: async () => {
      await current.app.close();
      current = await createApp(appOptions);
      return current;
    },
  };
}
const input = (review: AvailabilityReview) => ({
  planId: review.id,
  digest: review.digest,
  reviewed: true,
});

test('availability review is read-only, exact-workspace bound and excludes provider material', async (t) => {
  const f = await fixture(t);
  const response = await f.send('/availability/prepare');
  assert.equal(response.statusCode, 200, response.body);
  const review = response.json<AvailabilityReview>();
  assert.equal(review.action, 'install-and-start');
  assert.equal(review.dataDirectory, f.dataDirectory);
  assert.equal(review.startsAtLogin, false);
  assert.deepEqual(review.environment, { HOME: f.root, PATH: '/usr/bin:/bin', LANG: 'C' });
  assert(!response.body.includes('public-synthetic-excluded-secret'));
  assert.equal(f.launches, 0);
  assert.equal(f.shutdowns, 0);
  for (const name of [
    '.forge-service.json',
    '.forge-activation-owner.sqlite',
    `.forge-activation-${review.id}.json`,
  ])
    await assert.rejects(stat(join(f.dataDirectory, name)));
  await assert.rejects(stat(f.context.agentDirectory));
  assert.equal(f.local.get('config', 'background-activation'), null);
  assert.equal(
    (await f.send('/availability/activate', { ...input(review), digest: '0'.repeat(64) }))
      .statusCode,
    409,
  );
  assert.equal(
    (await f.send('/availability/activate', { ...input(review), reviewed: false })).statusCode,
    400,
  );
  assert.equal(f.launches, 0);
});

test('availability setup requires a local human, current CSRF and a supported compiled workspace', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.send('/availability/prepare', {}, { 'x-forge-workspace': 'demo' })).statusCode,
    403,
  );
  assert.equal(
    (await f.send('/availability/prepare', {}, { 'x-forge-csrf': 'expired' })).statusCode,
    403,
  );
  assert.equal(
    (await f.send('/availability/prepare', {}, { authorization: 'Bearer untrusted' })).statusCode,
    403,
  );
  assert.equal(
    (await f.send('/availability/prepare', {}, { 'tailscale-user-login': 'alice@example.com' }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await f.send(
        '/availability/prepare',
        {},
        {
          origin: 'https://availability.fixture.ts.net',
          'x-forge-bridge-proof': 'owned-availability-bridge-proof',
          'x-forge-bridge-identity': 'alice@example.com',
        },
      )
    ).statusCode,
    403,
  );
  const other = await createApp({
    filename: ':memory:',
    csrf: headers['x-forge-csrf'],
    test: true,
  });
  t.after(() => other.app.close());
  const unsupported = await other.app.inject({
    method: 'POST',
    url: '/api/availability/prepare',
    headers,
    payload: {},
  });
  assert.equal(unsupported.statusCode, 409);
  assert.equal(f.controls, 0);
  assert.equal(f.launches, 0);
});

test('committed handoff persists before native action, fences new mutations and is idempotent without restart replay', async (t) => {
  const f = await fixture(t);
  const review = (await f.send('/availability/prepare')).json<AvailabilityReview>();
  const result = await f.send('/availability/activate', input(review));
  assert.equal(result.statusCode, 202, result.body);
  assert.equal(result.json<ActivationReceipt>().state, 'committed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.launches, 1);
  assert.equal(f.shutdowns, 1);
  assert.equal((await f.send('/work', { title: 'Should hold' })).statusCode, 409);
  const repeated = await f.send('/availability/activate', input(review));
  assert.equal(repeated.statusCode, 202);
  assert.equal(f.launches, 1);
  const saved = await readActivation(join(f.dataDirectory, `.forge-activation-${review.id}.json`));
  assert.equal(saved.review.digest, review.digest);
  assert.equal(
    (await stat(join(f.dataDirectory, `.forge-activation-${review.id}.json`))).mode & 0o777,
    0o600,
  );
  assert(!JSON.stringify(saved).includes('public-synthetic-excluded-secret'));
  assert.equal(saved.parentPid, process.pid);
  await f.restart();
  assert.equal(f.launches, 1);
  assert.equal((await f.send('/availability/prepare')).statusCode, 409);
  assert.equal((await f.send('/availability/activate', input(review))).statusCode, 202);
  assert.equal(f.launches, 1);
});

test('an uncommitted helper failure keeps the foreground workspace and permits a new explicit review', async (t) => {
  const f = await fixture(t, { launch: async () => 'aborted' });
  const review = (await f.send('/availability/prepare')).json<AvailabilityReview>();
  const result = await f.send('/availability/activate', input(review));
  assert.equal(result.statusCode, 202, result.body);
  assert.equal(result.json<ActivationReceipt>().state, 'aborted');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.shutdowns, 0);
  assert.equal((await f.send('/availability/prepare')).statusCode, 200);
  await assert.rejects(stat(join(f.dataDirectory, '.forge-service.json')));
});

test('inactive review requires released helper ownership and retains the uncertain original outcome', async (t) => {
  const f = await fixture(t);
  const review = (await f.send('/availability/prepare')).json<AvailabilityReview>();
  await f.send('/availability/activate', input(review));
  await f.restart();
  const payload = {
    id: review.id,
    digest: review.digest,
    note: 'Checked the native target; no service is loaded.',
    reviewed: true,
  };
  const release = await activationLease(f.dataDirectory, true);
  assert(release);
  try {
    assert.equal((await f.send('/availability/review', payload)).statusCode, 409);
  } finally {
    release();
  }
  const result = await f.send('/availability/review', payload);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json<ActivationReceipt>().state, 'committed');
  assert.equal(result.json<ActivationReceipt>().review?.native, 'not-loaded');
  assert.equal(result.json<ActivationReceipt>().review?.note, payload.note);
  assert.equal((await f.send('/availability/prepare')).statusCode, 200);
  assert.equal(f.launches, 1);
  assert.equal(
    (await f.send('/availability/review', { ...payload, digest: '0'.repeat(64) })).statusCode,
    409,
  );
});

test('background review refuses an in-flight setup request and expires before helper creation', async (t) => {
  const f = await fixture(t);
  let finish!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.app.post('/api/fixture/held-setup', async () => {
    started();
    await waiting;
    return { ok: true };
  });
  const active = f.send('/fixture/held-setup');
  void active.then(() => {});
  await entered;
  assert.equal((await f.send('/availability/prepare')).statusCode, 409);
  finish();
  await active;
  const review = (await f.send('/availability/prepare')).json<AvailabilityReview>();
  t.mock.method(Date, 'now', () => Date.parse(review.expiresAt) + 1);
  assert.equal((await f.send('/availability/activate', input(review))).statusCode, 409);
  assert.equal(f.launches, 0);
});

test('a native definition appearing after review cannot be replaced by a handoff', async (t) => {
  const f = await fixture(t);
  const review = (await f.send('/availability/prepare')).json<AvailabilityReview>();
  await installService(
    { dataDirectory: f.dataDirectory, port: 4710, environment: f.options.environment },
    f.context,
  );
  const before = await readFile(join(f.dataDirectory, '.forge-service.json'), 'utf8');
  assert.equal((await f.send('/availability/activate', input(review))).statusCode, 409);
  assert.equal(await readFile(join(f.dataDirectory, '.forge-service.json'), 'utf8'), before);
  assert.equal(f.launches, 0);
});

test('native handoff lease excludes another helper and unsafe ownership paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-availability-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await activationLease(root, true);
  assert(release);
  try {
    assert.equal(await activationLease(root), null);
    assert.equal(await activationLease(root, true), null);
  } finally {
    release();
  }
  assert(await activationLease(root));
  const foreign = join(root, 'foreign');
  await mkdir(foreign);
  await symlink(
    join(root, '.forge-activation-owner.sqlite'),
    join(foreign, '.forge-activation-owner.sqlite'),
  );
  await assert.rejects(activationLease(foreign));
});

test('an asynchronous service review fences new workspace mutations until it finishes', async (t) => {
  const f = await fixture(t);
  let finish!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.context.control = async () => {
    started();
    await waiting;
    return null;
  };
  const preparing = f.send('/availability/prepare');
  void preparing.then(() => {});
  await entered;
  const change = await f.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers,
    payload: { quietMode: true },
  });
  assert.equal(change.statusCode, 409);
  finish();
  assert.equal((await preparing).statusCode, 200);
  assert.equal(f.local.settings().quietMode, false);
});

test('reviewed installation preserves the reviewed ID and refuses a changed configuration digest', async (t) => {
  const f = await fixture(t);
  const definition = await prepareService(
    { dataDirectory: f.dataDirectory, environment: f.options.environment },
    f.context,
  );
  await assert.rejects(
    installService({ dataDirectory: f.dataDirectory }, f.context, { ...definition, port: 4711 }),
    /configuration changed/,
  );
  await assert.rejects(stat(join(f.dataDirectory, '.forge-service.json')));
  await installService({ dataDirectory: f.dataDirectory }, f.context, definition);
  const receipt = JSON.parse(await readFile(join(f.dataDirectory, '.forge-service.json'), 'utf8'));
  assert.equal(receipt.id, definition.id);
  assert.equal(receipt.configurationHash, definition.configurationHash);
});

test('an unconfirmed native exit survives foreground recovery and holds background activation', async (t) => {
  const f = await fixture(t);
  const run: Run = {
    id: 'owned-native-exit',
    workId: 'owned-work',
    accountId: 'owned-account',
    generation: 1,
    nativeSessionId: 'owned-session',
    nativeTurnId: null,
    status: 'interrupted',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitConfirmed: false,
  };
  f.local.put('runs', run.id, run);
  const response = await f.send('/availability/prepare');
  assert.equal(response.statusCode, 409);
  assert.match(response.body, /unconfirmed native exits/);
  assert.equal(f.launches, 0);
});
