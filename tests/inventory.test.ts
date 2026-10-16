import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { NativeSources } from '../server/native-sources.js';
import { createApp } from '../server/app.js';
import { ForgeError } from '../server/errors.js';
import {
  codexSessionRows,
  claudeSessionRows,
  hermesSessionRows,
  openclawSessionRows,
  readNativeInventory,
  nativeFile,
} from '../server/adapters/inventory.js';
import type { NativeSource, Snapshot, Work, Account } from '../shared/types.js';

const source = (kind: NativeSource['kind'], home = '', endpoint = ''): NativeSource => ({
  id: `test-${kind}`,
  kind,
  label: 'Synthetic native source',
  home,
  endpoint,
  state: 'configured',
  checkedAt: null,
  error: null,
  capabilities: [],
});

test('session inventories preserve native identity and bounded titles without importing transcripts or granting control', () => {
  const codex = codexSessionRows(
    {
      data: [
        {
          id: 'codex-session',
          name: 'A native title',
          cwd: '/fixture/project',
          updatedAt: 1792170000,
          status: { type: 'notLoaded' },
          turns: [{ secret: 'excluded' }],
        },
      ],
    },
    'codex',
  );
  assert.equal(codex[0].control, 'observed');
  assert.match(codex[0].status, /live state unknown/);
  assert.equal(codex[0].project, 'project');
  const claude = claudeSessionRows(
    [
      {
        sessionId: 'claude-session',
        summary: 'x'.repeat(5000),
        lastModified: 1792170000000,
        firstPrompt: 'excluded',
        messages: ['excluded'],
      },
    ],
    'claude',
  );
  assert.equal(claude[0].title.length, 160);
  const hermes = hermesSessionRows(
    {
      data: [
        {
          id: 'hermes-session',
          title: 'Hermes native title',
          last_active: 1792170000,
          ended_at: 1792170000,
          system_prompt: 'excluded',
        },
      ],
    },
    'hermes',
  );
  assert.equal(hermes[0].updatedAt, codex[0].updatedAt);
  assert.equal(hermes[0].status, 'Ended in native records');
  const openclaw = openclawSessionRows(
    {
      ok: true,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              sessions: [
                { key: 'agent:main:session', label: 'A gateway session', messages: ['excluded'] },
              ],
            }),
          },
        ],
      },
    },
    'openclaw',
  );
  assert.equal(openclaw[0].id, 'agent:main:session');
  assert.equal(openclaw[0].source, 'openclaw/gateway');
  assert.equal(JSON.stringify([codex, claude, hermes, openclaw]).includes('excluded'), false);
  assert.throws(
    () => openclawSessionRows({ ok: true, result: { sessions: [{}] } }, 'bad'),
    /identifier/,
  );
  assert.throws(() => codexSessionRows({ data: new Array(102).fill({ id: 'too-many' }) }, 'bad'));
});

test('native schedule inventory leaves exact Codex and Hermes bytes unchanged and omits instructions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-native-jobs-'));
  try {
    await mkdir(join(directory, 'automations', 'sample'), { recursive: true });
    await mkdir(join(directory, 'automations', 'deleted-native-job'));
    await mkdir(join(directory, 'cron'));
    const codexPath = join(directory, 'automations', 'sample', 'automation.toml');
    const hermesPath = join(directory, 'cron', 'jobs.json');
    const codexBytes =
      'id = "sample"\nname = "Codex sample"\nkind = "heartbeat"\nstatus = "ACTIVE"\nrrule = "FREQ=HOURLY;INTERVAL=2"\nprompt = "private-native-instructions"\n';
    const hermesBytes = JSON.stringify({
      jobs: [
        {
          id: 'hermes-job',
          name: 'Hermes sample',
          state: 'scheduled',
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          next_run_at: '2026-10-18T09:00:00+05:30',
          last_status: 'ok',
          prompt: 'private-native-instructions',
          delivery: 'private-destination',
        },
      ],
    });
    await writeFile(codexPath, codexBytes);
    await writeFile(hermesPath, hermesBytes);
    const codex = await readNativeInventory(source('codex-schedules', directory));
    const hermes = await readNativeInventory(source('hermes-schedules', directory));
    assert.equal(codex.inventory.schedules[0].kind, 'heartbeat');
    assert.equal(codex.inventory.schedules[0].nextRunAt, null);
    assert.equal(hermes.inventory.schedules[0].kind, 'cron');
    assert.equal(hermes.inventory.schedules[0].rule, '0 9 * * *');
    assert.equal(hermes.inventory.schedules[0].nextRunAt, '2026-10-18T03:30:00.000Z');
    assert.equal(JSON.stringify([codex, hermes]).includes('private-'), false);
    assert.equal(await readFile(codexPath, 'utf8'), codexBytes);
    assert.equal(await readFile(hermesPath, 'utf8'), hermesBytes);
    await symlink(hermesPath, join(directory, 'linked.json'));
    await assert.rejects(nativeFile(join(directory, 'linked.json')));
    await assert.rejects(nativeFile(hermesPath, 10), /size/);
    // Hermes's native loader may repair this legacy shape; the observer must refuse it without repair.
    await writeFile(hermesPath, '[]');
    await assert.rejects(readNativeInventory(source('hermes-schedules', directory)));
    assert.equal(await readFile(hermesPath, 'utf8'), '[]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery registers references without reading, serializes reads and retains the last successful observation on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-native-catalog-'));
  const filename = join(directory, 'workspace.sqlite');
  const store = new Store(filename);
  let closed = false;
  let release: () => void = () => {};
  let wait = false;
  let fail = false;
  let calls = 0;
  let managedBusy = false;
  const inventory = {
    sessions: codexSessionRows({ data: [{ id: 'session', name: 'Fixture' }] }, 'native'),
    schedules: [],
    moreAvailable: true,
    checkedAt: '2026-10-17T00:00:00.000Z',
  };
  const sources = new NativeSources(store, {
    homes: {
      codex: directory,
      claude: join(directory, 'missing'),
      hermes: join(directory, 'missing'),
    },
    isManagedBusy: () => managedBusy,
    reader: async () => {
      calls++;
      if (wait)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (fail) throw new Error('native diagnostic with private-secret-output');
      return { inventory, capabilities: ['Observed only'] };
    },
  });
  try {
    const found = await sources.discover();
    assert.equal(found.length, 1);
    assert.equal(calls, 0);
    assert.equal(sources.inventories().length, 0);
    assert.equal((await sources.discover())[0].id, found[0].id);
    managedBusy = true;
    await assert.rejects(sources.refresh(found[0].id), /headroom/);
    managedBusy = false;
    wait = true;
    const first = sources.refresh(found[0].id);
    await assert.rejects(sources.refresh(found[0].id), /in progress/);
    assert.throws(() => sources.remove(found[0].id), /finish/);
    release();
    await first;
    wait = false;
    assert.equal(sources.list()[0].observation?.moreAvailable, true);
    fail = true;
    await assert.rejects(sources.refresh(found[0].id), /metadata could not be read/);
    assert.equal(sources.list()[0].state, 'error');
    assert.equal(sources.list()[0].checkedAt, inventory.checkedAt);
    assert.equal(sources.inventories()[0].sessions[0].id, 'session');
    assert.equal(JSON.stringify(sources.list()).includes('private-secret'), false);
    store.close();
    closed = true;
    const reopened = new Store(filename);
    try {
      const persisted = new NativeSources(reopened);
      assert.equal(persisted.inventories().length, 1);
      persisted.remove(found[0].id);
      assert.equal(persisted.inventories().length, 0);
      assert.equal(persisted.list().length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Hermes negotiates session resources and OpenClaw uses only its fixed native session-list tool', async () => {
  const calls: { method: string; url: string; body: unknown; authorized: boolean }[] = [];
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    calls.push({
      method: request.method!,
      url: request.url!,
      body: body ? JSON.parse(body) : null,
      authorized: request.headers.authorization === 'Bearer fixture-native-token',
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health')
      response.end(JSON.stringify({ platform: 'hermes-agent', status: 'ok', version: 'fixture' }));
    else if (request.url === '/v1/capabilities')
      response.end(
        JSON.stringify({
          platform: 'hermes-agent',
          features: { session_resources: true, jobs_admin: false, memory_write_api: false },
        }),
      );
    else if (request.url?.startsWith('/api/sessions?'))
      response.end(
        JSON.stringify({
          data: [{ id: 'hermes-session', title: 'Fixture', system_prompt: 'excluded' }],
          has_more: true,
        }),
      );
    else if (request.url === '/tools/invoke')
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            details: { sessions: [{ sessionId: 'openclaw-session', displayName: 'Fixture' }] },
          },
        }),
      );
    else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  process.env.FORGE_INVENTORY_TEST_TOKEN = 'fixture-native-token';
  try {
    const hermes = await readNativeInventory({
      ...source('hermes', '', endpoint),
      tokenEnv: 'FORGE_INVENTORY_TEST_TOKEN',
    });
    assert.equal(hermes.inventory.sessions[0].source, 'hermes/api');
    assert.equal(hermes.inventory.moreAvailable, true);
    assert.equal(hermes.capabilities.includes('jobs_admin'), false);
    const openclaw = await readNativeInventory({
      ...source('openclaw', '', endpoint),
      tokenEnv: 'FORGE_INVENTORY_TEST_TOKEN',
    });
    assert.equal(openclaw.inventory.sessions[0].source, 'openclaw/gateway');
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.authorized));
    assert.deepEqual(calls[3], {
      method: 'POST',
      url: '/tools/invoke',
      body: { tool: 'sessions_list', action: 'json', args: { limit: 100, messageLimit: 0 } },
      authorized: true,
    });
    assert.equal(JSON.stringify(hermes).includes('excluded'), false);
    await assert.rejects(
      readNativeInventory({
        ...source('openclaw', '', endpoint),
        tokenEnv: 'FORGE_INVENTORY_UNSET_TOKEN',
      }),
      /not set/,
    );
    assert.equal(calls.length, 4);
  } finally {
    delete process.env.FORGE_INVENTORY_TEST_TOKEN;
    await new Promise<void>((resolve, reject) =>
      gateway.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('native source HTTP operations stay local, reject unsafe endpoints and expose cached metadata without changing managed work', async () => {
  let reads = 0;
  const state = await createApp({
    filename: ':memory:',
    csrf: 'test-csrf',
    test: true,
    nativeSourcesOptions: {
      reader: async (nativeSource) => {
        reads++;
        if (reads === 2) throw new ForgeError(502, 'Fixture native API unavailable.');
        return {
          inventory: {
            sessions: codexSessionRows(
              { data: [{ id: 'source-session', name: 'Observed HTTP fixture' }] },
              nativeSource.id,
            ),
            schedules: [],
            moreAvailable: true,
            checkedAt: new Date().toISOString(),
          },
          capabilities: ['Observed metadata'],
        };
      },
    },
  });
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload: unknown = {},
    mode = 'local',
  ) =>
    state.app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:4710',
        'x-forge-csrf': 'test-csrf',
        'x-forge-workspace': mode,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      payload: method === 'GET' ? undefined : JSON.stringify(payload),
    });
  try {
    assert.equal((await call('POST', '/api/native/discover', {}, 'demo')).statusCode, 409);
    assert.equal(
      (
        await call('POST', '/api/native/sources', {
          kind: 'openclaw',
          label: 'Unsafe',
          endpoint: 'https://example.com',
        })
      ).statusCode,
      400,
    );
    const added = (
      await call('POST', '/api/native/sources', {
        kind: 'codex',
        label: 'Native fixture',
        home: process.cwd(),
      })
    ).json<NativeSource>();
    assert.ok(added.id);
    assert.equal(reads, 0);
    assert.equal((await call('POST', `/api/native/sources/${added.id}/refresh`)).statusCode, 200);
    let snapshot = (await call('GET', '/api/snapshot')).json<Snapshot>();
    assert.equal(snapshot.nativeSessions[0].id, 'source-session');
    assert.equal(snapshot.nativeSources[0].observation?.moreAvailable, true);
    assert.equal(snapshot.work.length, 0);
    assert.equal(
      (await call('GET', '/api/snapshot', {}, 'demo')).json<Snapshot>().nativeSessions.length,
      0,
    );
    assert.equal((await call('POST', `/api/native/sources/${added.id}/refresh`)).statusCode, 502);
    snapshot = (await call('GET', '/api/snapshot')).json<Snapshot>();
    assert.equal(snapshot.nativeSources[0].state, 'error');
    assert.equal(snapshot.nativeSessions.length, 1);
    assert.equal((await call('DELETE', `/api/native/sources/${added.id}`)).statusCode, 200);
    assert.equal((await call('GET', '/api/snapshot')).json<Snapshot>().nativeSessions.length, 0);
  } finally {
    await state.app.close();
  }
});

test('an in-flight native inventory read excludes HTTP launch before any execution driver is created', async () => {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const readStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let driverCreated = false;
  const state = await createApp({
    filename: ':memory:',
    csrf: 'admission-test',
    test: true,
    driverFactory: () => {
      driverCreated = true;
      throw new Error('The execution driver must not be reached.');
    },
    nativeSourcesOptions: {
      reader: async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          inventory: {
            sessions: [],
            schedules: [],
            moreAvailable: false,
            checkedAt: new Date().toISOString(),
          },
          capabilities: [],
        };
      },
    },
  });
  const post = (url: string, payload: unknown = {}) =>
    state.app.inject({
      method: 'POST',
      url,
      headers: {
        host: '127.0.0.1:4710',
        'x-forge-csrf': 'admission-test',
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  try {
    const account = (
      await post('/api/accounts', { label: 'Admission fixture', harness: 'codex' })
    ).json<Account>();
    const work = (
      await post('/api/work', {
        title: 'Inventory admission',
        project: 'Fixture',
        cwd: process.cwd(),
        goal: 'Never launch during the native metadata read.',
        harness: 'codex',
        accountId: account.id,
      })
    ).json<Work>();
    const native = (
      await post('/api/native/sources', {
        kind: 'codex',
        label: 'Metadata fixture',
        home: process.cwd(),
      })
    ).json<NativeSource>();
    const reading = post(`/api/native/sources/${native.id}/refresh`).then((response) => response);
    await readStarted;
    const rejected = await post(`/api/work/${work.id}/launch`, { expectedRevision: work.revision });
    assert.equal(rejected.statusCode, 409);
    assert.match(rejected.json().error, /inventory read/);
    assert.equal(driverCreated, false);
    assert.equal(state.local.work(work.id).activeRunId, null);
    release();
    assert.equal((await reading).statusCode, 200);
  } finally {
    release();
    await state.app.close();
  }
});
