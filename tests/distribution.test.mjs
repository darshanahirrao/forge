import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRelease } from '../bin/package-release.mjs';
import manifest from '../package.json' with { type: 'json' };

const exec = promisify(execFile);
const binary = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));
async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
function privateEnvironment(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LANG: 'C',
    npm_config_userconfig: join(home, 'empty.npmrc'),
    npm_config_globalconfig: join(home, 'empty-global.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org',
    npm_config_cache: join(home, 'npm-cache'),
  };
}

test('doctor does not open a workspace or execute discovered native commands and reports incomplete archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-doctor-'));
  const absent = join(root, 'not-created');
  const marker = join(root, 'native-executed');
  await writeFile(join(root, 'codex'), '#!/bin/sh\nprintf invoked > "' + marker + '"\n', {
    mode: 0o700,
  });
  const env = {
    ...privateEnvironment(root),
    PATH: root,
    FORGE_DATA_DIR: absent,
    FORGE_EXTENSION_MODULES: 'this-must-not-be-parsed-or-loaded',
    OPENAI_API_KEY: 'PRIVATE-CANARY',
  };
  try {
    const result = await exec(process.execPath, [binary, 'doctor', '--json'], { env });
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'ready');
    assert.equal(report.optionalTools.find((tool) => tool.name === 'codex').availableOnPath, true);
    assert(!result.stdout.includes(root));
    assert(!result.stdout.includes('PRIVATE-CANARY'));
    await assert.rejects(stat(absent));
    await assert.rejects(stat(marker));
    const incomplete = join(root, 'incomplete');
    await mkdir(join(incomplete, 'bin'), { recursive: true });
    for (const filename of ['forge.mjs', 'doctor.mjs'])
      await cp(new URL('../bin/' + filename, import.meta.url), join(incomplete, 'bin', filename));
    await writeFile(join(incomplete, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(
      exec(process.execPath, [join(incomplete, 'bin/forge.mjs'), 'doctor', '--json'], { env }),
      (error) => {
        assert.equal(error.code, 1);
        const broken = JSON.parse(error.stdout);
        assert.equal(broken.status, 'incomplete');
        assert.equal(broken.checks.find((check) => check.id === 'build').status, 'fail');
        return true;
      },
    );
    await assert.rejects(stat(absent));
    await assert.rejects(
      exec(process.execPath, [binary, 'doctor', '--data-dir', absent], { env }),
      (error) => error.code === 1 && error.stderr.includes('Usage: forge doctor'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'the public archive installs globally with production dependencies and serves persistent work independently of the repository',
  { timeout: 240000, skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-release-install-'));
    const prefix = join(root, 'install');
    const home = join(root, 'home');
    const data = join(root, 'workspace');
    await mkdir(home);
    const env = privateEnvironment(home);
    let child;
    let exited;
    let output = '';
    async function stop() {
      if (!child) return;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const code = await Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error('Installed Forge did not stop.')), 10000).unref(),
        ),
      ]);
      assert.equal(code, 0, output);
      child = undefined;
    }
    try {
      const packed = await packRelease(join(root, 'release'));
      assert.equal(
        createHash('sha256')
          .update(await readFile(packed.artifact))
          .digest('hex'),
        packed.sha256,
      );
      assert((await readFile(join(root, 'release/SHA256SUMS'), 'utf8')).includes(packed.sha256));
      for (const filename of [
        'dist/client/index.html',
        'dist/server/index.js',
        'dist/server/native-worker.mjs',
        'dist/server/adapters/hermes-native.py',
        'dist/server/extension-sdk.d.ts',
        'npm-shrinkwrap.json',
        'SECURITY.md',
      ])
        assert(packed.files.includes(filename), filename);
      assert(
        !packed.files.some((filename) =>
          /^(web|server|shared|tests|node_modules|artifacts|runtime|\.github)\//.test(filename),
        ),
      );
      assert(!packed.files.some((filename) => /\.(map|sqlite|log|key|pem)$/.test(filename)));
      const args = [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        packed.artifact,
      ];
      await exec(process.execPath, [process.env.npm_execpath, ...args], {
        env,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
      });
      const installed = join(prefix, 'lib/node_modules/@forge-workspace/forge');
      const installedBinary = join(prefix, 'bin/forge');
      const report = JSON.parse(
        (
          await exec(process.execPath, [installedBinary, 'doctor', '--json'], {
            env: { ...env, FORGE_DATA_DIR: data },
          })
        ).stdout,
      );
      assert.equal(report.status, 'ready');
      assert.equal(report.version, manifest.version);
      await assert.rejects(stat(data));
      await assert.rejects(stat(join(installed, 'node_modules/vite')));
      const installedLock = JSON.parse(
        await readFile(join(installed, 'npm-shrinkwrap.json'), 'utf8'),
      );
      const fastify = JSON.parse(
        await readFile(join(installed, 'node_modules/fastify/package.json'), 'utf8'),
      );
      assert.equal(fastify.version, installedLock.packages['node_modules/fastify'].version);
      const port = await freePort();
      const origin = 'http://127.0.0.1:' + port;
      async function start() {
        output = '';
        child = spawn(
          process.execPath,
          [installedBinary, 'start', '--data-dir', data, '--port', String(port)],
          { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (chunk) => {
            output = (output + chunk).slice(-8000);
          });
        exited = new Promise((resolve) => child.once('exit', resolve));
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          assert.equal(child.exitCode, null, output);
          try {
            const response = await fetch(origin + '/api/health');
            if (response.ok) {
              assert.equal((await response.json()).version, manifest.version);
              return;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        throw Error('Installed Forge did not become ready: ' + output);
      }
      await start();
      const html = await (await fetch(origin)).text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
      assert(assets.length >= 2);
      for (const [, asset] of assets) {
        const response = await fetch(origin + asset);
        assert.equal(response.status, 200);
        assert.match(
          response.headers.get('content-type'),
          asset.endsWith('.css') ? /text\/css/ : /javascript/,
        );
        await response.body.cancel();
      }
      const snapshot = await (await fetch(origin + '/api/snapshot')).json();
      assert.equal(snapshot.work.length, 0);
      assert.equal(snapshot.accounts.length, 0);
      assert.equal(snapshot.nativeWorkers.length, 0);
      const created = await fetch(origin + '/api/work', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'x-forge-csrf': snapshot.csrf },
        body: JSON.stringify({
          title: 'Public installation check',
          project: 'Fictional project',
          cwd: home,
          goal: 'Retain this record after restart without a model call.',
          harness: 'codex',
        }),
      });
      assert.equal(created.status, 201, await created.clone().text());
      const work = await created.json();
      const receipt = await (
        await fetch(origin + '/api/work/' + work.id + '/public-receipt')
      ).json();
      assert.equal(receipt.recordedAttempts, 0);
      assert(!JSON.stringify(receipt).includes(work.id));
      await stop();
      await start();
      const retained = await (await fetch(origin + '/api/snapshot')).json();
      assert.equal(retained.work[0].id, work.id);
      assert.equal(retained.work[0].title, 'Public installation check');
      assert.equal(retained.nativeWorkers.length, 0);
      await stop();
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
