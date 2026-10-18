import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const binary = new URL('../bin/forge.mjs', import.meta.url).pathname;
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('the packaged CLI reports the manifest version without starting the application', async () => {
  assert.equal(
    (await exec(process.execPath, [binary, '--version'])).stdout.trim(),
    manifest.version,
  );
  const help = (await exec(process.execPath, [binary, '--help'])).stdout;
  assert(help.includes(`Forge ${manifest.version}`));
  assert(help.includes('--phone-origin'));
  assert(help.includes('--phone-user'));
  assert(help.includes('forge service install'));
});

test('the public extension SDK imports without starting a workspace and ships usable TypeScript contracts', async () => {
  await mkdir('artifacts', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'artifacts', 'forge-sdk-package-'));
  const absent = join(root, 'not-created');
  try {
    const imported = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const sdk=await import('@forge-workspace/forge/sdk'); console.log(JSON.stringify(Object.keys(sdk)));",
      ],
      { env: { PATH: process.env.PATH, FORGE_DATA_DIR: absent } },
    );
    const names = JSON.parse(imported.stdout);
    for (const name of [
      'defineExtension',
      'nativeCompanion',
      'hermesCompanion',
      'openClawCompanion',
    ])
      assert(names.includes(name));
    await assert.rejects(stat(absent));
    const consumer = join(root, 'consumer.mts');
    await writeFile(
      consumer,
      `import { defineExtension, nativeCompanion } from '@forge-workspace/forge/sdk';
export default defineExtension({ format:'forge.extension', version:1, id:'owned.consumer', name:'Owned consumer', release:'1', companions:[{
 id:'ext.owned.consumer', name:'Native consumer', contract:1, nativeVersion:'1', profileFiles:['config.json'],
 connect:async(account,root,_credentials,spawn)=>nativeCompanion({ account,root,spawn,command:'/native/owned',args:[],environment:{},version:'1',probe:async(_pid,signal)=>!signal.aborted })
}]});
// @ts-expect-error The public SDK must retain its versioned contract, not any.
defineExtension({format:'forge.extension',version:99});\n`,
    );
    await exec(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--skipLibCheck',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2023',
        consumer,
      ],
      { timeout: 20000 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicit packaged CLI extension appears as a first-class native provider without starting a native runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-extension-package-')),
    port = await freePort(),
    module = join(root, 'owned.mjs');
  await writeFile(
    module,
    "export default {format:'forge.extension',version:1,id:'owned.package',name:'Owned package',release:'1',companions:[{id:'ext.owned.package',name:'Owned native package',contract:1,nativeVersion:'1',profileFiles:['config.json'],connect:async()=>{throw Error('No runtime start is authorized by this fixture.');}}]};",
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      binary,
      'start',
      '--data-dir',
      join(root, 'state'),
      '--port',
      String(port),
      '--extension',
      module,
    ],
    { env: { PATH: process.env.PATH, LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (part) => {
      output = (output + part).slice(-8000);
    });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    const deadline = Date.now() + 10000;
    let snapshot;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
        if (response.ok) {
          snapshot = await response.json();
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(snapshot?.runtimeProviders[0].id, 'ext.owned.package', output);
    assert.equal(snapshot.companionRuntime.providers.includes('ext.owned.package'), true);
    assert.equal(snapshot.accounts.length, 0);
    assert.equal(snapshot.companionRuntime.launches.length, 0);
    assert.equal(snapshot.nativeWorkers.length, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('future workspace versions are refused before explicit extension initialization executes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-extension-future-')),
    module = join(root, 'owned.mjs'),
    marker = join(root, 'extension-executed');
  const database = new DatabaseSync(join(root, 'workspace.sqlite'));
  database.exec('PRAGMA user_version = 15');
  database.close();
  await writeFile(
    module,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'should never execute');export default {};`,
    { mode: 0o600 },
  );
  try {
    await assert.rejects(
      exec(
        process.execPath,
        [
          binary,
          'start',
          '--data-dir',
          root,
          '--port',
          String(await freePort()),
          '--extension',
          module,
        ],
        { env: { PATH: process.env.PATH }, timeout: 10000 },
      ),
      (error) => error.stderr.includes('newer Forge version'),
    );
    await assert.rejects(stat(marker));
    const check = new DatabaseSync(join(root, 'workspace.sqlite'), { readOnly: true });
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 15);
    check.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live original workspace owner prevents a second CLI from initializing extension code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-extension-owner-')),
    module = join(root, 'owned.mjs'),
    marker = join(root, 'extension-executed');
  const { Store } = await import('../dist/server/store.js');
  const owner = new Store(join(root, 'workspace.sqlite'));
  await writeFile(
    module,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'should never execute');export default {};`,
    { mode: 0o600 },
  );
  try {
    await assert.rejects(
      exec(
        process.execPath,
        [
          binary,
          'start',
          '--data-dir',
          root,
          '--port',
          String(await freePort()),
          '--extension',
          module,
        ],
        { env: { PATH: process.env.PATH }, timeout: 10000 },
      ),
      (error) => error.stderr.includes('locked'),
    );
    await assert.rejects(stat(marker));
  } finally {
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('compiled service status is explicit, platform-aware and does not install or create a workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-package-status-'));
  const missing = join(directory, 'not-created');
  try {
    if (process.platform === 'darwin') {
      const result = await exec(process.execPath, [
        binary,
        'service',
        'status',
        '--data-dir',
        missing,
      ]);
      assert.deepEqual(JSON.parse(result.stdout), { state: 'not-installed' });
    } else {
      await assert.rejects(
        exec(process.execPath, [binary, 'service', 'status', '--data-dir', missing]),
        (error) => error.stderr.includes('macOS user login sessions'),
      );
    }
    await assert.rejects(readFile(join(missing, 'workspace.sqlite')));
    await assert.rejects(readFile(join(missing, '.forge-service.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the compiled service owns both private listeners and shuts them down together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-package-'));
  const port = await freePort();
  let phonePort = await freePort();
  while (phonePort === port) phonePort = await freePort();
  const origin = 'https://forge.package.ts.net:8443';
  const child = spawn(
    process.execPath,
    [
      binary,
      'start',
      '--data-dir',
      directory,
      '--port',
      String(port),
      '--phone-origin',
      origin,
      '--phone-user',
      'alice@example.com',
      '--phone-port',
      String(phonePort),
    ],
    { env: { PATH: process.env.PATH, LANG: process.env.LANG }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-8000);
  });
  child.stderr.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-8000);
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    const deadline = Date.now() + 10000;
    let health;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(health?.version, manifest.version, output);
    const base = `http://127.0.0.1:${phonePort}`;
    const anonymous = await fetch(base + '/api/snapshot');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    await anonymous.body.cancel();
    const response = await fetch(base + '/api/snapshot', {
      headers: { 'tailscale-user-login': 'alice@example.com' },
    });
    assert.equal(response.status, 200, output);
    const snapshot = await response.json();
    assert.deepEqual(snapshot.access, { kind: 'tailscale', identity: 'alice@example.com' });
    assert.equal(snapshot.work.length, 0);
    const direct = await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
      headers: { 'tailscale-user-login': 'alice@example.com' },
    });
    assert.equal(direct.status, 403);
    await direct.body.cancel();
    const mutation = await fetch(base + '/api/accounts', {
      method: 'POST',
      headers: {
        'tailscale-user-login': 'alice@example.com',
        origin,
        'x-forge-csrf': snapshot.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ label: 'Package fixture reference', harness: 'codex' }),
    });
    assert.equal(mutation.status, 201, await mutation.clone().text());
    await mutation.body.cancel();
    child.kill('SIGTERM');
    assert.equal(
      await Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error('Owned listeners did not stop.')), 5000).unref(),
        ),
      ]),
      0,
      output,
    );
    for (const closedPort of [port, phonePort])
      await assert.rejects(fetch(`http://127.0.0.1:${closedPort}/api/health`));
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
