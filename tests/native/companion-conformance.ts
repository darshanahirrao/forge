import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/app.js';
import { findBinary } from '../../server/adapters/discovery.js';
import { hermesPython } from '../../server/adapters/hermes-install.js';
import { openClawInstallation } from '../../server/adapters/openclaw-worker.js';
import { Profiles, inspectMemory } from '../../server/memory.js';
import { unknownPressure } from '../../server/memory-pressure.js';
import type { Work } from '../../shared/types.js';

const binary = await findBinary('hermes');
assert(binary, 'Install Hermes with its native MCP client before this opt-in check.');
const python = await hermesPython(binary);
const portable = process.argv.includes('--portable-memory');
const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-native-companion-')));
const project = join(root, 'project'),
  home = join(root, 'home');
await mkdir(project);
await mkdir(home);
const filename = join(root, 'memory.md');
const bytes = '# Shared\nnative-selected-copper\n# Private\nnative-excluded-violet\n';
await writeFile(filename, bytes);
const app = await createApp({
  filename: join(root, 'workspace.sqlite'),
  port: 0,
  memoryPressureReader: unknownPressure,
  test: true,
});
const replacement = new Client({ name: 'replacement-native-compatible-client', version: '1' });
let child: ReturnType<typeof spawn> | undefined;
let success = false;
try {
  await app.app.listen({ host: '127.0.0.1', port: 0 });
  const endpoint = `http://127.0.0.1:${(app.app.server.address() as { port: number }).port}/mcp/companions`;
  const profiles = new Profiles(app.local);
  const selection = await inspectMemory(filename, ['Shared']);
  const source = await profiles.addSource(
    {
      label: 'Native selected memory',
      owner: 'markdown',
      path: filename,
      section: ['Shared'],
      scope: { kind: 'global' },
    },
    selection.sha256,
    selection.selectionSha256,
  );
  const profile = profiles.profile();
  profiles.update(profile.id, profile.revision, { ...profile, memorySourceIds: [source.id] });
  let selectedSourceId = source.id;
  const retainedOriginal = portable ? join(root, 'Removed original native memory.md') : filename;
  if (portable) {
    const current = profiles.profile(),
      plan = await app.memoryPacks.prepareCopy(current.id, current.revision);
    const copied = await app.memoryPacks.apply(plan.id, plan.digest);
    assert.equal(copied.state, 'applied');
    selectedSourceId = copied.sourceIds[0];
    await rename(filename, retainedOriginal);
    assert.equal(profiles.profile().id, profile.id);
  }
  const settings = {
    root: project,
    profileId: profile.id,
    scopes: ['work:read', 'context:read', 'work:write'],
  };
  const grant = await app.companions.create({ ...settings, label: 'Native Hermes' });
  const work = await app.companions.createWork(grant.grant.id, {
    requestId: 'fixture-work',
    title: 'Persistent companion work',
    goal: 'Keep selected memory and work with the profile.',
  });
  child = spawn(python, [fileURLToPath(new URL('./hermes-companion.py', import.meta.url))], {
    cwd: project,
    env: {
      HOME: home,
      HERMES_HOME: home,
      PATH: dirname(python) + ':/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: root,
      LANG: 'en_US.UTF-8',
      PYTHONUNBUFFERED: '1',
      DO_NOT_TRACK: '1',
      HERMES_TELEMETRY_ENABLED: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    errorBytes = 0;
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    assert(output.length < 65536);
  });
  // Native diagnostics are deliberately not printed: headers and curated content stay private.
  child.stderr!.on('data', (chunk: Buffer) => {
    errorBytes += chunk.length;
  });
  child.stdin!.end(
    JSON.stringify({ token: grant.token, endpoint, workId: work.id, profileId: profile.id }),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child!.kill('SIGKILL');
      reject(new Error('Native Hermes MCP conformance timed out.'));
    }, 45000);
    child!.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child!.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(
    code,
    0,
    `Native Hermes MCP exited unsuccessfully (${errorBytes} diagnostic bytes retained only in memory).`,
  );
  const native = JSON.parse(output.trim().split('\n').at(-1)!);
  assert.equal(native.tools, 5);
  assert.equal(app.local.checkpoints(work.id).length, 1);
  assert.equal(app.local.all('work').length, 2);
  const second = await app.companions.create({ ...settings, label: 'Replacement MCP client' });
  app.companions.revoke(grant.grant.id);
  let openclaw: Record<string, unknown> | null = null;
  if (process.env.FORGE_OPENCLAW_BINARY) {
    const native = await openClawInstallation({ PATH: process.env.PATH });
    const openclawHome = join(root, 'openclaw');
    await mkdir(openclawHome);
    child = spawn(
      native.node,
      [fileURLToPath(new URL('./openclaw-companion.mjs', import.meta.url))],
      {
        cwd: project,
        env: {
          HOME: openclawHome,
          OPENCLAW_HOME: openclawHome,
          OPENCLAW_STATE_DIR: openclawHome,
          OPENCLAW_CONFIG_PATH: join(openclawHome, 'openclaw.json'),
          PATH: dirname(native.node) + ':/usr/bin:/bin',
          TMPDIR: root,
          LANG: 'en_US.UTF-8',
          DO_NOT_TRACK: '1',
          OPENCLAW_NO_RESPAWN: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '',
      error = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      assert(output.length < 65536);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-16384);
    });
    child.stdin!.end(
      JSON.stringify({
        token: second.token,
        endpoint,
        workId: work.id,
        profileId: profile.id,
        project,
        home: openclawHome,
        packageRoot: dirname(native.binary),
      }),
    );
    const status = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child!.kill('SIGKILL');
        reject(new Error('Native OpenClaw MCP conformance timed out.'));
      }, 45000);
      child!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (status !== 0) await writeFile(join(root, 'openclaw.log'), error, { mode: 0o600 });
    assert.equal(
      status,
      0,
      'Native OpenClaw MCP failed; its isolated diagnostic file was retained.',
    );
    openclaw = JSON.parse(output.trim().split('\n').at(-1)!);
    assert.equal(app.local.checkpoints(work.id).length, 2);
  }
  await replacement.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${second.token}` } },
    }),
  );
  const retained = await replacement.callTool({
    name: 'forge_work',
    arguments: { workId: work.id },
  });
  assert(!retained.isError);
  assert.equal((retained.structuredContent as { work: Work }).work.profileId, profile.id);
  const context = await replacement.callTool({
    name: 'forge_context',
    arguments: { workId: work.id },
  });
  assert(JSON.stringify(context).includes('native-selected-copper'));
  assert(!JSON.stringify(context).includes('native-excluded-violet'));
  assert.equal(await readFile(retainedOriginal, 'utf8'), bytes);
  assert.equal(profiles.profile().memorySourceIds[0], selectedSourceId);
  assert.equal(app.controller.activeCount, 0);
  assert.throws(() => app.companions.authenticate(`Bearer ${grant.token}`), /revoked/);
  success = true;
  console.log(
    JSON.stringify({
      ...native,
      replacement: 'official MCP SDK',
      openclaw: openclaw ?? 'not requested',
      sameWorkAndProfile: true,
      memoryBytesUnchanged: true,
      oldAccessRevoked: true,
      extraAgentLoop: false,
      portableSelectedMemory: portable,
      originalPathRemoved: portable,
    }),
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child!.once('exit', resolve));
  }
  await replacement.close();
  await app.app.close();
  if (success) await rm(root, { recursive: true, force: true });
  else console.error('Isolated native companion fixture retained at', root);
}
