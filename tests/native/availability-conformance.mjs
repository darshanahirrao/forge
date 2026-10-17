import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import {
  serviceContext,
  serviceStatus,
  controlService,
} from '../../dist/server/background-service.js';
import { activationLease, readActivation } from '../../dist/server/service-activation.js';

assert.equal(process.platform, 'darwin', 'This opt-in check needs an actual macOS login session.');
const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-native-availability-')));
const dataDirectory = join(root, 'Owned state & workspace');
const definitions = join(root, 'Owned temporary definitions');
const context = serviceContext({ agentDirectory: definitions });
// Intentionally outside the real login directory. Nothing in this fixture can become a login item.
assert.notEqual(definitions, join(homedir(), 'Library', 'LaunchAgents'));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const phonePort = reservation.address().port;
assert.notEqual(phonePort, port);
await new Promise((resolve) => reservation.close(resolve));
const phoneOrigin = 'https://availability.fixture.ts.net';
const phoneUser = 'owner@fixture.example';
const origin = `http://127.0.0.1:${port}`;
let foreground,
  exited,
  canRemove = true;
const environment = {
  HOME: homedir(),
  PATH: process.env.PATH,
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  FORGE_SERVICE_AGENT_DIR: definitions,
};
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await pause();
  }
  throw new Error(message);
}
async function snapshot() {
  return (await fetch(origin + '/api/snapshot')).json();
}
async function post(path, body) {
  const current = await snapshot();
  const response = await fetch(origin + '/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-forge-csrf': current.csrf },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function start(fault = false) {
  let output = '';
  foreground = spawn(
    process.execPath,
    fault
      ? [
          fileURLToPath(new URL('../fixtures/availability-host.mjs', import.meta.url)),
          dataDirectory,
          String(port),
          definitions,
        ]
      : [
          fileURLToPath(new URL('../../bin/forge.mjs', import.meta.url)),
          '--data-dir',
          dataDirectory,
          '--port',
          String(port),
          '--phone-origin',
          phoneOrigin,
          '--phone-user',
          phoneUser,
          '--phone-port',
          String(phonePort),
        ],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  for (const stream of [foreground.stdout, foreground.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-6000);
    });
  const child = foreground;
  exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  await wait(async () => {
    assert.equal(child.exitCode, null, output);
    const response = await fetch(origin + '/api/health');
    const health = await response.json();
    return health.service.mode === 'foreground' && health.processId === child.pid;
  }, 'Owned foreground host did not become available.');
}
async function review(phone = true) {
  const result = await post('/availability/prepare', {});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.startsAtLogin, false);
  assert.equal(result.body.dataDirectory, dataDirectory);
  assert.equal(result.body.port, port);
  assert.equal(result.body.phonePort, phone ? phonePort : null);
  assert.deepEqual(result.body.phoneUsers, phone ? [phoneUser] : []);
  return result.body;
}
async function activate(plan) {
  const result = await post('/availability/activate', {
    planId: plan.id,
    digest: plan.digest,
    reviewed: true,
  });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  return result;
}
try {
  // Actual helper commits, then dies while its original parent still owns the workspace.
  await start(true);
  const idle = await post('/work', {
    title: 'Native handoff continuity',
    project: 'Owned availability fixture',
    goal: 'Retain idle work through a reviewed native service handoff.',
    harness: 'codex',
  });
  assert.equal(idle.status, 201);
  const failedReview = await review(false);
  const intentPath = join(dataDirectory, `.forge-activation-${failedReview.id}.json`);
  await assert.rejects(stat(intentPath));
  await activate(failedReview);
  await wait(
    async () => (await readActivation(intentPath)).state === 'waiting',
    'Owned helper did not reach its committed wait.',
  );
  assert.equal(await activationLease(dataDirectory), null);
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const helper = stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter(
      (m) =>
        m &&
        Number(m[2]) === foreground.pid &&
        m[3].includes('/bin/service-activate.mjs ') &&
        m[3].endsWith(intentPath),
    );
  assert.equal(helper.length, 1, 'Expected exactly one owned direct-child handoff helper.');
  // Fault injection only: this PID was just observed as this fixture's direct child and exact private intent.
  process.kill(Number(helper[0][1]), 'SIGKILL');
  await wait(
    async () => !!(await activationLease(dataDirectory)),
    'Killed owned helper did not release its native lease.',
  );
  assert.equal((await serviceStatus(dataDirectory, context)).state, 'not-installed');
  foreground.kill('SIGTERM');
  assert.equal(await exited, 0);
  foreground = null;
  await start();
  assert((await snapshot()).work.some((w) => w.id === idle.body.id));
  assert.equal((await post('/availability/prepare', {})).status, 409);
  const retained = (await snapshot()).availability.receipt;
  assert.equal(retained.id, failedReview.id);
  assert.equal(retained.state, 'waiting');
  assert.equal((await activationLease(dataDirectory)) !== null, true);
  const outcome = await post('/availability/review', {
    id: retained.id,
    digest: retained.digest,
    reviewed: true,
    note: 'Owned test helper was killed after commit; no native service was installed or started.',
  });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  assert.equal(outcome.body.state, 'waiting');
  assert.equal(outcome.body.review.native, 'not-loaded');
  console.log(
    'Actual committed-helper SIGKILL retains evidence, starts no service and never replays.',
  );

  const credentialPath = join(root, 'owned-provider-reference.json');
  const synthetic = 'public-synthetic-availability-only';
  await writeFile(credentialPath, JSON.stringify({ selected: synthetic }), { mode: 0o600 });
  const account = await post('/accounts', {
    label: 'Owned availability reference',
    harness: 'claude',
    billingMode: 'api',
    credentialEnv: 'ANTHROPIC_API_KEY',
    credentialReference: { kind: 'private-json', path: credentialPath, key: 'selected' },
  });
  assert.equal(account.status, 201);
  const plan = await review();
  assert.equal(plan.action, 'install-and-start');
  await activate(plan);
  assert.equal(await exited, 0);
  foreground = null;
  await wait(
    async () => {
      const value = await snapshot();
      return (
        value.service.mode === 'launchd' &&
        value.service.installationId === plan.installationId &&
        value.availability.receipt?.state === 'running' &&
        value
      );
    },
    'Native background identity/health was not confirmed.',
    20000,
  );
  const status = await serviceStatus(dataDirectory, context);
  assert.equal(status.state, 'running');
  assert.notEqual(status.pid, process.pid);
  const anonymous = await fetch(`http://127.0.0.1:${phonePort}/api/snapshot`);
  assert.equal(anonymous.status, 401);
  await anonymous.body.cancel();
  const mobile = await fetch(`http://127.0.0.1:${phonePort}/api/snapshot`, {
    headers: { 'tailscale-user-login': phoneUser, origin: phoneOrigin },
  });
  assert.equal(mobile.status, 200);
  const phoneState = await mobile.json();
  assert.equal(phoneState.service.installationId, plan.installationId);
  assert.deepEqual(phoneState.access, { kind: 'tailscale', identity: phoneUser });
  assert((await snapshot()).work.some((w) => w.id === idle.body.id));
  const checked = await post(`/accounts/${account.body.id}/credential/check`, {});
  assert.equal(checked.status, 200);
  assert.equal(checked.body.available, true);
  const raw = await readFile(join(dataDirectory, '.forge-service.json'), 'utf8');
  assert(!raw.includes(synthetic));
  assert.equal(JSON.parse(raw).id, plan.installationId);
  assert.equal((await post('/availability/prepare', {})).status, 409);
  console.log('Actual foreground exit hands the same idle work and private reference to launchd.');

  assert.equal((await controlService('stop', dataDirectory, context)).state, 'installed');
  await start();
  const existing = await review();
  assert.equal(existing.action, 'start-installed');
  assert.equal(existing.installationId, plan.installationId);
  await activate(existing);
  assert.equal(await exited, 0);
  foreground = null;
  await wait(
    async () => (await snapshot()).availability.receipt?.state === 'running',
    'Existing installation handoff did not confirm health.',
    20000,
  );
  assert((await snapshot()).work.some((w) => w.id === idle.body.id));
  const preserved = await readActivation(intentPath);
  assert.equal(preserved.state, 'waiting');
  assert(preserved.outcomeReview);
  assert.equal((await controlService('uninstall', dataDirectory, context)).state, 'not-installed');
  assert((await stat(join(dataDirectory, 'workspace.sqlite'))).isFile());
  console.log(
    JSON.stringify({
      status: 'passed',
      committedHelperCrashNoReplay: true,
      freshInactiveReview: true,
      actualForegroundExit: true,
      dualListenerHandoff: true,
      nativeManager: 'launchd',
      existingInstallationRetained: true,
      sameWorkAndCredentialReference: true,
      temporaryServiceRemoved: true,
      loginItemInstalled: false,
      modelCalls: 0,
    }),
  );
} finally {
  if (foreground?.exitCode === null) {
    foreground.kill('SIGTERM');
    await exited;
  }
  try {
    const status = await serviceStatus(dataDirectory, context);
    if (status.state !== 'not-installed')
      canRemove =
        (await controlService('uninstall', dataDirectory, context)).state === 'not-installed';
    assert(await activationLease(dataDirectory));
  } catch {
    canRemove = false;
  }
  if (canRemove) await rm(root, { recursive: true, force: true });
  else
    console.error(
      'Owned native fixture exit is unconfirmed. Its private state/definition were retained for review.',
    );
}
