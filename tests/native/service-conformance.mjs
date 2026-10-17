import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  installService,
  serviceContext,
  serviceStatus,
  controlService,
} from '../../dist/server/background-service.js';

assert.equal(
  process.platform,
  'darwin',
  'This opt-in check requires an actual macOS user login session.',
);
const root = await mkdtemp(join(tmpdir(), 'forge-native-service-'));
// Outside ~/Library/LaunchAgents: this fixture cannot become a persistent login item.
const context = serviceContext({ agentDirectory: join(root, 'Owned test definitions') });
const dataDirectory = join(root, 'State & data');
const server = createServer();
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
await new Promise((ok) => server.close(ok));
let installed = false;
let canRemove = true;
try {
  const result = await installService(
    { dataDirectory, port, environment: { PATH: process.env.PATH, LANG: process.env.LANG } },
    context,
  );
  installed = true;
  assert.equal(result.state, 'installed');
  assert.equal((await serviceStatus(dataDirectory, context)).state, 'installed');
  console.log('Native definition installed privately without starting a service.');
  let started = await controlService('start', dataDirectory, context);
  assert.equal(started.state, 'running');
  assert(started.pid);
  const url = `http://127.0.0.1:${port}`;
  const snapshot = await (await fetch(url + '/api/snapshot')).json();
  assert.equal(snapshot.service.mode, 'launchd');
  assert.equal(snapshot.work.length, 0);
  const response = await fetch(url + '/api/work', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url, 'x-forge-csrf': snapshot.csrf },
    body: JSON.stringify({
      title: 'Background continuity fixture',
      project: 'Native service fixture',
      goal: 'Retain this idle work across native service restart.',
      harness: 'codex',
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const work = await response.json();
  const firstPid = started.pid;
  started = await controlService('restart', dataDirectory, context);
  assert.equal(started.state, 'running');
  assert.notEqual(started.pid, firstPid);
  assert((await (await fetch(url + '/api/snapshot')).json()).work.some((w) => w.id === work.id));
  console.log('Actual launchd start and graceful restart preserve the same idle work.');
  const previousPid = started.pid;
  // Native target authority, never a saved PID. No worker/model task is started.
  await context.control(['kill', 'SIGKILL', `gui/${context.uid}/${started.label}`]);
  const deadline = Date.now() + 50000;
  let recovered;
  while (Date.now() < deadline) {
    const status = await serviceStatus(dataDirectory, context);
    if (status.state === 'running' && status.pid !== previousPid) {
      recovered = status;
      break;
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  assert(recovered, 'Native crash restart did not restore the workspace.');
  assert((await (await fetch(url + '/api/snapshot')).json()).work.some((w) => w.id === work.id));
  console.log('Native abnormal-exit restart preserves state without a model call.');
  const stopped = await controlService('stop', dataDirectory, context);
  assert.equal(stopped.state, 'installed');
  await assert.rejects(fetch(url + '/api/health'));
  assert.equal((await stat(join(dataDirectory, 'workspace.sqlite'))).mode & 0o777, 0o600);
  const receipt = JSON.parse(await readFile(join(dataDirectory, '.forge-service.json'), 'utf8'));
  const removed = await controlService('uninstall', dataDirectory, context);
  assert.equal(removed.state, 'not-installed');
  installed = false;
  assert.equal((await serviceStatus(dataDirectory, context)).state, 'not-installed');
  assert.equal(await context.control(['print', `gui/${context.uid}/${receipt.label}`]), null);
  assert((await stat(join(dataDirectory, 'workspace.sqlite'))).isFile());
  console.log(
    JSON.stringify({
      status: 'passed',
      nativeManager: 'launchd',
      gracefulRestart: true,
      crashRestart: true,
      idleWorkRetained: true,
      ownedServiceRemoved: true,
      privateStatePreserved: true,
      paidModelCalls: 0,
    }),
  );
} finally {
  if (installed) {
    try {
      canRemove =
        (await controlService('uninstall', dataDirectory, context)).state === 'not-installed';
    } catch {
      canRemove = false;
    }
  }
  if (canRemove) await rm(root, { recursive: true, force: true });
  else
    console.error(
      'Native fixture shutdown is unconfirmed. Its private state and definition were retained for review.',
    );
}
