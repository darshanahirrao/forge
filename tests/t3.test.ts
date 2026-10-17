import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  readFile,
  readdir,
  stat,
  chmod,
  rename,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3Connections } from '../server/t3.js';
import { Store } from '../server/store.js';
import { NativeSources } from '../server/native-sources.js';
import { createApp } from '../server/app.js';
import { t3Fixture } from './fixtures/t3-mcp.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'forge-t3-test-'));
  const fixture = await t3Fixture();
  const store = new Store(join(directory, 'workspace.sqlite'));
  const manager = new T3Connections(store, directory);
  const connect = async () => {
    const flow = await manager.begin(
      { endpoint: fixture.origin, label: 'T3 native work' },
      'http://127.0.0.1:4710/api/native/t3/callback',
    );
    const callback = fixture.approve(flow.authorizationUrl);
    const source = await manager.finish(
      callback.searchParams.get('state')!,
      callback.searchParams.get('code')!,
      callback.searchParams.get('iss')!,
    );
    return { flow, callback, source };
  };
  return {
    directory,
    fixture,
    store,
    manager,
    connect,
    close: async () => {
      await manager.close();
      store.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('T3 SDK OAuth/PKCE persists only a private read grant; native inventory excludes transcripts and survives restart', async () => {
  const f = await setup();
  let restarted: T3Connections | undefined;
  try {
    const { source, flow } = await f.connect();
    const url = new URL(flow.authorizationUrl);
    assert.equal(url.searchParams.get('scope'), 'orchestration:read');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state')?.length, 64);
    assert.equal(source.authentication, 'oauth');
    const filename = join(f.directory, `.forge-t3-${source.id}.json`);
    if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
    const secret = JSON.parse(await readFile(filename, 'utf8')).tokens.access_token as string;
    const result = await f.manager.read(source);
    assert.equal(result.inventory.sessions[0].title, 'Native T3 work');
    assert.equal(result.inventory.sessions[0].source, 't3-code/mcp');
    assert.equal(result.inventory.sessions[0].harness, 'T3 Code');
    assert.equal(result.inventory.sessions[0].providerInstanceId, 'codex-work');
    assert.equal(result.inventory.sessions[0].control, 'observed');
    assert.equal(result.inventory.schedules.length, 0);
    const recorded = JSON.stringify([result, f.store.all('native_sources'), f.store.all('config')]);
    assert.equal(recorded.includes(secret), false);
    assert.equal(recorded.includes('excluded-native-'), false);
    assert.deepEqual(
      f.fixture.calls.map((call) => call.name),
      ['t3_project_list', 't3_thread_list'],
    );
    await f.manager.close();
    restarted = new T3Connections(f.store, f.directory);
    assert.equal((await restarted.read(source)).inventory.sessions.length, 1);
    assert.equal(f.fixture.settings.tokenRequests, 1);
    await restarted.forget(source);
    await assert.rejects(restarted.read(source), /Reconnect/);
    assert.equal(
      (await readdir(f.directory)).some((name) => name.startsWith('.forge-t3-')),
      false,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('T3 callbacks bind state, issuer and one-time exchange without consuming a valid flow on a mismatched callback', async () => {
  const f = await setup();
  try {
    const abandoned = await f.manager.begin(
      { endpoint: f.fixture.origin, label: 'Scoped T3' },
      'http://127.0.0.1:4710/api/native/t3/callback',
    );
    const flow = await f.manager.begin(
      { endpoint: f.fixture.origin, label: 'Scoped T3' },
      'http://127.0.0.1:4710/api/native/t3/callback',
    );
    const abandonedCallback = f.fixture.approve(abandoned.authorizationUrl);
    await assert.rejects(
      f.manager.finish(
        abandonedCallback.searchParams.get('state')!,
        abandonedCallback.searchParams.get('code')!,
        f.fixture.origin,
      ),
      /expired|already used/,
    );
    const callback = f.fixture.approve(flow.authorizationUrl);
    const state = callback.searchParams.get('state')!;
    const code = callback.searchParams.get('code')!;
    await assert.rejects(
      f.manager.finish('0'.repeat(64), code, f.fixture.origin),
      /expired|already used/,
    );
    await assert.rejects(f.manager.finish(state, code, 'http://127.0.0.1:1'), /different server/);
    assert.equal(f.fixture.settings.tokenRequests, 0);
    await f.manager.finish(state, code, f.fixture.origin);
    await assert.rejects(f.manager.finish(state, code, f.fixture.origin), /already used/);
    assert.equal(f.fixture.settings.tokenRequests, 1);
  } finally {
    await f.close();
  }
});

test('T3 execution grants are rejected before any MCP session or credential file is accepted', async () => {
  const f = await setup();
  try {
    f.fixture.settings.scope = 'orchestration:read orchestration:operate';
    await assert.rejects(f.connect(), /Choose Read only/);
    assert.equal(f.store.all('native_sources').length, 0);
    assert.equal(f.fixture.calls.length, 0);
    assert.equal(
      (await readdir(f.directory)).some((name) => name.startsWith('.forge-t3-')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('T3 server identity and native read capabilities must pass before source registration', async () => {
  const f = await setup();
  try {
    f.fixture.settings.name = 'Unrelated local service';
    await assert.rejects(f.connect(), /identify itself as T3 Code/);
    f.fixture.settings.name = 'T3 Code';
    f.fixture.settings.readHints = false;
    await assert.rejects(f.connect(), /required read-only activity tools/);
    assert.equal(f.store.all('native_sources').length, 0);
    assert.equal(
      (await readdir(f.directory)).some((name) => name.startsWith('.forge-t3-')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('T3 OAuth discovery cannot send registration, codes or tokens to another origin', async () => {
  const f = await setup();
  try {
    f.fixture.settings.externalMetadata = 'http://127.0.0.1:1';
    await assert.rejects(
      f.manager.begin(
        { endpoint: f.fixture.origin, label: 'T3' },
        'http://127.0.0.1:4710/api/native/t3/callback',
      ),
      /outside|could not start|sign-in must stay/,
    );
    assert.equal(f.fixture.settings.registrations, 0);
    assert.equal(f.fixture.settings.tokenRequests, 0);
    assert.equal(f.store.all('native_sources').length, 0);
    await assert.rejects(
      f.manager.begin(
        { endpoint: 'https://example.com', label: 'T3' },
        'http://127.0.0.1:4710/api/native/t3/callback',
      ),
    );
  } finally {
    await f.close();
  }
});

test('T3 inventory respects project/thread budgets and reports native pagination without duplicate controls', async () => {
  const f = await setup();
  try {
    const { source } = await f.connect();
    const sample = f.fixture.settings.threads[0];
    f.fixture.settings.threads = Array.from({ length: 100 }, (_, index) => ({
      ...sample,
      threadId: `thread-${index}`,
      title: 'x'.repeat(500),
    }));
    f.fixture.settings.projects.push({
      id: 'second',
      title: 'Second project',
      workspaceRoot: '/fixture/second',
    });
    f.fixture.settings.projectCursor = 20;
    f.fixture.settings.threadCursor = 100;
    const result = await f.manager.read(source);
    assert.equal(result.inventory.sessions.length, 100);
    assert.equal(result.inventory.sessions[0].title.length, 160);
    assert.equal(result.inventory.moreAvailable, true);
    assert.equal(f.fixture.calls.filter((call) => call.name === 't3_thread_list').length, 1);
    f.fixture.settings.threads = [sample, sample];
    await assert.rejects(f.manager.read(source), /duplicate native thread/);
    f.fixture.settings.threads = [sample];
    f.fixture.settings.projects = [f.fixture.settings.projects[0], f.fixture.settings.projects[0]];
    await assert.rejects(f.manager.read(source), /duplicate project/);
  } finally {
    await f.close();
  }
});

test('T3 revocation retains the last successful observation and never starts a new authorization or mutation', async () => {
  const f = await setup();
  try {
    const { source } = await f.connect();
    const sources = new NativeSources(f.store, { t3Reader: (value) => f.manager.read(value) });
    const previous = await sources.refresh(source.id);
    f.fixture.settings.revoked = true;
    await assert.rejects(sources.refresh(source.id), /could not be read/);
    assert.equal(sources.list()[0].state, 'error');
    assert.equal(sources.list()[0].checkedAt, previous.checkedAt);
    assert.deepEqual(sources.inventories()[0].sessions, previous.sessions);
    assert.equal(f.fixture.settings.tokenRequests, 1);
    assert.equal(f.fixture.settings.registrations, 1);
    assert.ok(
      f.fixture.calls.every((call) => ['t3_project_list', 't3_thread_list'].includes(call.name)),
    );
  } finally {
    await f.close();
  }
});

test('T3 private credentials reject broad permissions and symlinks without reading or changing the target', async () => {
  const f = await setup();
  try {
    const { source } = await f.connect();
    const filename = join(f.directory, `.forge-t3-${source.id}.json`);
    if (process.platform !== 'win32') {
      await chmod(filename, 0o644);
      await assert.rejects(f.manager.read(source), /private, owned/);
      await chmod(filename, 0o600);
      const retained = filename + '.retained';
      await rename(filename, retained);
      await symlink(retained, filename);
      const bytes = await readFile(retained, 'utf8');
      await assert.rejects(f.manager.read(source), /unavailable/);
      assert.equal(await readFile(retained, 'utf8'), bytes);
      await unlink(filename);
      await rename(retained, filename);
    }
    await assert.rejects(
      f.manager.read({ ...source, endpoint: 'http://127.0.0.1:1' }),
      /changing its address/,
    );
    assert.equal(f.fixture.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('T3 oversized MCP responses fail boundedly and leave successful observations unchanged', async () => {
  const f = await setup();
  try {
    const { source } = await f.connect();
    const sources = new NativeSources(f.store, { t3Reader: (value) => f.manager.read(value) });
    const previous = await sources.refresh(source.id);
    f.fixture.settings.oversized = true;
    await assert.rejects(sources.refresh(source.id), /could not be read/);
    assert.deepEqual(sources.inventories()[0].sessions, previous.sessions);
    assert.equal(sources.list()[0].checkedAt, previous.checkedAt);
  } finally {
    await f.close();
  }
});

test('T3 reconnect cannot race source removal while an authorization exchange is completing', async () => {
  const f = await setup();
  try {
    const { source } = await f.connect();
    const flow = await f.manager.begin(
      { endpoint: f.fixture.origin, label: 'T3 reconnected' },
      'http://127.0.0.1:4710/api/native/t3/callback',
    );
    const callback = f.fixture.approve(flow.authorizationUrl);
    const completion = f.manager.finish(
      callback.searchParams.get('state')!,
      callback.searchParams.get('code')!,
      f.fixture.origin,
    );
    assert.throws(() => f.manager.assertCanForget(source.id), /Wait for T3 Code sign-in/);
    await assert.rejects(
      f.manager.begin(
        { endpoint: f.fixture.origin, label: 'Racing' },
        'http://127.0.0.1:4710/api/native/t3/callback',
      ),
      /current T3 Code/,
    );
    const updated = await completion;
    assert.equal(updated.id, source.id);
    assert.equal(f.store.all('native_sources').length, 1);
    f.manager.assertCanForget(source.id);
  } finally {
    await f.close();
  }
});

test('T3 native API requires local CSRF, returns to Vite in development and excludes grants from snapshots/blueprints', async () => {
  const fixture = await t3Fixture();
  const created = await createApp({
    filename: ':memory:',
    test: true,
    csrf: 't3-test-csrf',
    development: true,
  });
  const headers = {
    host: '127.0.0.1:4710',
    'content-type': 'application/json',
    'x-forge-csrf': created.csrf,
  };
  try {
    const body = { endpoint: fixture.origin + '/mcp', label: 'T3 workspace' };
    assert.equal(
      (
        await created.app.inject({
          method: 'POST',
          url: '/api/native/t3/authorize',
          headers: { host: headers.host },
          payload: body,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await created.app.inject({
          method: 'POST',
          url: '/api/native/t3/authorize',
          headers: { ...headers, 'x-forge-workspace': 'demo' },
          payload: body,
        })
      ).statusCode,
      409,
    );
    const begin = await created.app.inject({
      method: 'POST',
      url: '/api/native/t3/authorize',
      headers,
      payload: body,
    });
    assert.equal(begin.statusCode, 200, begin.body);
    const callback = fixture.approve(begin.json().authorizationUrl);
    const finished = await created.app.inject({
      method: 'GET',
      url: callback.pathname + callback.search,
      headers: { host: headers.host },
    });
    assert.equal(finished.headers.location, 'http://127.0.0.1:5173/?t3=connected');
    const snapshot = (
      await created.app.inject({
        method: 'GET',
        url: '/api/snapshot',
        headers: { host: headers.host },
      })
    ).json();
    const source = snapshot.nativeSources.find((s: { kind: string }) => s.kind === 't3-code');
    assert.ok(source);
    assert.equal(source.endpoint, fixture.origin);
    const refreshed = await created.app.inject({
      method: 'POST',
      url: `/api/native/sources/${source.id}/refresh`,
      headers,
      payload: {},
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const blueprint = await created.app.inject({
      method: 'GET',
      url: '/api/blueprint',
      headers: { host: headers.host },
    });
    assert.equal(JSON.stringify([snapshot, blueprint.json()]).includes('access_token'), false);
    const removed = await created.app.inject({
      method: 'DELETE',
      url: `/api/native/sources/${source.id}`,
      headers,
      payload: {},
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(created.local.all('native_sources').length, 0);
  } finally {
    await created.app.close();
    await fixture.close();
  }
});
