import { unknownPressure } from '../server/memory-pressure.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  installService,
  controlService,
  serviceStatus,
  serviceContext,
  type ServiceContext,
} from '../server/background-service.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'forge-service-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'Source & project');
  for (const name of ['dist/server', 'dist/client', 'bin'])
    await mkdir(join(root, name), { recursive: true });
  for (const name of ['dist/server/index.js', 'dist/client/index.html', 'bin/service-runner.mjs'])
    await writeFile(join(root, name), 'fixture');
  const calls: string[][] = [];
  const context = serviceContext({
    platform: 'darwin',
    uid: process.getuid?.() ?? 1000,
    home,
    root,
    agentDirectory: join(home, 'Agents & definitions'),
    control: async (args) => {
      calls.push(args);
      return null;
    },
  });
  const dataDirectory = join(home, 'Work & private');
  const options = {
    dataDirectory,
    environment: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      ANTHROPIC_API_KEY: 'fixture-secret-not-to-persist',
      NODE_OPTIONS: 'fixture-injection-not-to-persist',
    },
  };
  return { context, calls, options, home, dataDirectory, root };
}
async function record(f: Awaited<ReturnType<typeof fixture>>) {
  const receipt = JSON.parse(await readFile(join(f.dataDirectory, '.forge-service.json'), 'utf8'));
  return { receipt, plist: join(f.context.agentDirectory, `${receipt.label}.plist`) };
}

test('unsupported background platforms do not create files or issue native controls', async (t) => {
  const f = await fixture(t);
  await assert.rejects(installService(f.options, { ...f.context, platform: 'linux' }), /macOS/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(stat(f.dataDirectory));
});
test('reviewed native service configuration retains explicit extension modules without loading their code or provider keys', async (t) => {
  const f = await fixture(t),
    module = join(f.home, 'native-extension.mjs');
  await writeFile(module, "throw Error('This module must not execute during service review.');\n");
  const options = {
    ...f.options,
    environment: { ...f.options.environment, FORGE_EXTENSION_MODULES: JSON.stringify([module]) },
  };
  await installService(options, f.context);
  const { receipt } = await record(f);
  assert.equal(receipt.environment.FORGE_EXTENSION_MODULES, JSON.stringify([module]));
  assert.equal(JSON.stringify(receipt).includes('fixture-secret'), false);
  assert.equal((await serviceStatus(f.dataDirectory, f.context)).state, 'installed');
  await controlService('uninstall', f.dataDirectory, f.context);
  await assert.rejects(
    installService(
      {
        ...options,
        environment: { ...options.environment, FORGE_EXTENSION_MODULES: '["relative.mjs"]' },
      },
      f.context,
    ),
  );
});
test('service install uses private exact ownership, escapes native arguments and excludes provider keys', async (t) => {
  const f = await fixture(t);
  const result = await installService(f.options, f.context);
  assert.equal(result.state, 'installed');
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['print'],
  );
  const { receipt, plist } = await record(f);
  assert.deepEqual(Object.keys(receipt.environment).sort(), ['HOME', 'LANG', 'PATH']);
  const xml = await readFile(plist, 'utf8');
  assert(xml.includes('Agents &amp; definitions'));
  assert(xml.includes('<integer>360</integer>'));
  assert(xml.includes('<key>SuccessfulExit</key><false/>'));
  assert(!JSON.stringify(receipt).includes('fixture-secret'));
  assert(!JSON.stringify(receipt).includes('fixture-injection'));
  for (const filename of [
    plist,
    join(f.dataDirectory, '.forge-service.json'),
    join(f.dataDirectory, '.forge-service.stdout.log'),
  ])
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await serviceStatus(f.dataDirectory, f.context)).state, 'installed');
  await assert.rejects(installService(f.options, f.context), /already installed/);
  await controlService('uninstall', f.dataDirectory, f.context);
  await writeFile(
    join(f.dataDirectory, '.forge-service.stdout.log'),
    'synthetic log\n'.repeat(6000),
  );
  assert.equal((await installService(f.options, f.context)).state, 'installed');
});
test('changed native definitions block start, stop, restart and deletion without touching native service control', async (t) => {
  const f = await fixture(t);
  await installService(f.options, f.context);
  const { plist } = await record(f);
  await writeFile(plist, (await readFile(plist, 'utf8')) + '<!-- external change -->');
  const before = f.calls.length;
  for (const command of ['start', 'stop', 'restart', 'uninstall'] as const)
    await assert.rejects(controlService(command, f.dataDirectory, f.context), /definition changed/);
  assert.equal(f.calls.length, before);
  assert((await readFile(plist, 'utf8')).includes('external change'));
});
test('changed receipt settings cannot retain authority through an unchanged native definition', async (t) => {
  const f = await fixture(t);
  await installService(f.options, f.context);
  const { receipt, plist } = await record(f);
  const nativeDefinition = await readFile(plist, 'utf8');
  receipt.port = receipt.port + 1;
  await writeFile(join(f.dataDirectory, '.forge-service.json'), JSON.stringify(receipt));
  const before = f.calls.length;
  for (const command of ['start', 'stop', 'restart', 'uninstall'] as const)
    await assert.rejects(
      controlService(command, f.dataDirectory, f.context),
      /configuration changed/,
    );
  assert.equal(f.calls.length, before);
  assert.equal(await readFile(plist, 'utf8'), nativeDefinition);
});

test('a loaded label with foreign native origin cannot receive a stop', async (t) => {
  const f = await fixture(t);
  await installService(f.options, f.context);
  const c: ServiceContext = {
    ...f.context,
    control: async (args) => {
      f.calls.push(args);
      return 'path = /other/foreign.plist\nprogram = /other/program\npid = 123\n';
    },
  };
  await assert.rejects(controlService('stop', f.dataDirectory, c), /different or unverified/);
  assert(!f.calls.some((c) => c[0] === 'bootout'));
});
test('an active SQLite workspace owner prevents a second background service from bootstrapping', async (t) => {
  const f = await fixture(t);
  await installService(f.options, f.context);
  const store = new Store(join(f.dataDirectory, 'workspace.sqlite'));
  t.after(() => store.close());
  await assert.rejects(
    controlService('start', f.dataDirectory, f.context),
    /active or unconfirmed/,
  );
  assert(!f.calls.some((c) => c[0] === 'bootstrap'));
});
test('a busy port prevents native service bootstrap without stopping its foreign listener', async (t) => {
  const f = await fixture(t);
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  const port = (server.address() as { port: number }).port;
  await installService({ ...f.options, port }, f.context);
  await assert.rejects(
    controlService('start', f.dataDirectory, f.context),
    /port is already in use/,
  );
  assert(server.listening);
  assert(!f.calls.some((c) => c[0] === 'bootstrap'));
});
test('an existing foreign plist and symlinked receipt are preserved without registration', async (t) => {
  const f = await fixture(t);
  await installService(f.options, f.context);
  const { plist } = await record(f);
  const original = await readFile(plist, 'utf8');
  await rm(join(f.dataDirectory, '.forge-service.json'));
  await assert.rejects(installService(f.options, f.context));
  assert.equal(await readFile(plist, 'utf8'), original);
  await assert.rejects(stat(join(f.dataDirectory, '.forge-service.json')));
  const foreign = join(f.home, 'foreign.json');
  await writeFile(foreign, 'private-foreign-data', { mode: 0o600 });
  await symlink(foreign, join(f.dataDirectory, '.forge-service.json'));
  await assert.rejects(controlService('uninstall', f.dataDirectory, f.context));
  assert.equal(await readFile(foreign, 'utf8'), 'private-foreign-data');
});
test('native shutdown keeps its definition and receipt until the workspace owner actually releases SQLite', async (t) => {
  const f = await fixture(t);
  await installService(f.options, f.context);
  const { receipt, plist } = await record(f);
  const store = new Store(join(f.dataDirectory, 'workspace.sqlite'));
  let open = true;
  t.after(() => {
    if (open) store.close();
  });
  let present = true;
  const args = [
    receipt.node,
    receipt.runner,
    join(receipt.dataDirectory, '.forge-service.json'),
    receipt.id,
    receipt.agentDirectory,
    receipt.configurationHash,
  ];
  const c: ServiceContext = {
    ...f.context,
    settleTimeoutMs: 0,
    control: async (command) => {
      f.calls.push(command);
      if (command[0] === 'bootout') {
        present = false;
        return '';
      }
      return present
        ? `path = ${plist}\nprogram = ${receipt.node}\narguments = {\n${args.join('\n')}\n}\npid = 123\n`
        : null;
    },
  };
  assert.equal((await controlService('uninstall', f.dataDirectory, c)).state, 'stopping');
  assert((await stat(plist)).isFile());
  assert((await stat(join(f.dataDirectory, '.forge-service.json'))).isFile());
  assert(!f.calls.some((c) => c[0] === 'bootstrap'));
  store.close();
  open = false;
  assert.equal((await controlService('uninstall', f.dataDirectory, c)).state, 'not-installed');
  assert((await stat(join(f.dataDirectory, 'workspace.sqlite'))).isFile());
});

test('matching native label, path and executable still require the exact saved arguments', async (t) => {
  const f = await fixture(t);
  await installService(f.options, f.context);
  const { receipt, plist } = await record(f);
  const c: ServiceContext = {
    ...f.context,
    control: async (args) => {
      f.calls.push(args);
      return `path = ${plist}\nprogram = ${receipt.node}\narguments = {\nforeign arguments\n}\npid = 123\n`;
    },
  };
  await assert.rejects(controlService('stop', f.dataDirectory, c), /different or unverified/);
  assert(!f.calls.some((c) => c[0] === 'bootout'));
});

test('service runtime evidence is shared by health and workspace without depending on an open UI', async (t) => {
  const background = {
    mode: 'launchd' as const,
    installationId: '00000000-0000-4000-8000-000000000000',
    label: 'org.forgeworkspace.fixture',
    scope: 'user-login' as const,
  };
  const { app } = await createApp({
    memoryPressureReader: unknownPressure,
    filename: ':memory:',
    background,
    test: true,
  });
  t.after(() => app.close());
  for (const url of ['/api/health', '/api/snapshot']) {
    const response = await app.inject({ url, headers: { host: '127.0.0.1:4710' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().service, background);
  }
});
