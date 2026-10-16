import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
