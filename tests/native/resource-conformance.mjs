// Compiled host and an owned browser, on an empty private fixture. No provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { captureWorker, attributeWorkers, processTable } from '../../dist/server/processes.js';

assert(
  ['darwin', 'linux'].includes(process.platform),
  'This native OS observation check needs macOS or Linux.',
);
const directory = await mkdtemp(join(tmpdir(), 'forge-resource-native-'));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const host = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('../../bin/forge.mjs', import.meta.url)),
    'start',
    '--port',
    String(port),
    '--data-dir',
    directory,
  ],
  {
    env: { PATH: process.env.PATH, LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
for (const pipe of [host.stdout, host.stderr])
  pipe.on('data', (chunk) => {
    output = (output + chunk).slice(-8000);
  });
const exited = new Promise((resolve) => host.once('exit', (code) => resolve(code)));
const origin = `http://127.0.0.1:${port}`;
let browserServer, browser;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let health;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, output);
    try {
      const response = await fetch(origin + '/api/health');
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await sleep(50);
  }
  assert.equal(health?.processId, host.pid, output);
  const hostIdentity = await captureWorker(host.pid);
  browserServer = await chromium.launchServer({
    headless: true,
    ...(process.env.CI ? {} : { channel: 'chrome' }),
  });
  const uiPid = browserServer.process().pid;
  const uiIdentity = await captureWorker(uiPid);
  browser = await chromium.connect(browserServer.wsEndpoint());
  const page = await browser.newPage();
  const attempts = [
    ['compiled-host', host.pid, hostIdentity],
    ['owned-browser', uiPid, uiIdentity],
  ].map(([id, pid, identity]) => ({
    id,
    workId: 'native-resource-observation',
    accountId: id,
    harness: id,
    status: 'running',
    nativeWorker: {
      version: 1,
      pid,
      ownerPid: process.pid,
      ...identity,
      capturedAt: new Date().toISOString(),
    },
  }));
  const samples = [];
  let machine;
  const started = Date.now();
  // A blank-browser control precedes the real UI. All startup samples remain in
  // the trace; no warmup values or high measurements are silently discarded.
  for (const phase of ['blank-browser', 'resources-ui']) {
    if (phase === 'resources-ui') {
      await page.goto(origin);
      await page
        .getByRole('navigation')
        .getByRole('button', { name: 'Resources', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Where resources are going' }).waitFor();
    }
    for (let index = 0; index < (phase === 'blank-browser' ? 3 : 6); index++) {
      if (index) await sleep(5100);
      const response = await fetch(origin + '/api/snapshot');
      assert(response.ok);
      const snapshot = await response.json();
      machine = {
        os: snapshot.machine.platform,
        cores: snapshot.machine.cores,
        totalMemory: snapshot.machine.totalMemory,
      };
      assert.equal(snapshot.mode, 'local');
      assert.equal(snapshot.accounts.length, 0);
      assert.equal(snapshot.work.length, 0);
      assert.equal(snapshot.nativeWorkers.length, 0);
      assert.equal(snapshot.resources.coverage, 'observed');
      assert.equal(snapshot.resources.sampledAt, snapshot.machine.sampledAt);
      assert.equal(
        snapshot.resources.groups.reduce((sum, group) => sum + group.processCount, 0),
        snapshot.resources.processCount,
      );
      assert.equal(
        snapshot.resources.groups.find((group) => group.kind === 'host').rootPids[0],
        host.pid,
      );
      const workers = attributeWorkers(
        attempts,
        new Map(),
        await processTable(),
        new Date().toISOString(),
      );
      assert.equal(workers.length, 2);
      for (const worker of workers) {
        assert.equal(worker.state, 'live');
        assert(worker.rss > 0);
        assert(worker.cpuPercent !== null);
      }
      assert(workers[1].pids.length > 1, 'The native browser descendant tree was not observed.');
      assert(workers[0].pids.every((pid) => !workers[1].pids.includes(pid)));
      // Export only fixture-owned aggregates, never other local processes or paths.
      samples.push({
        phase,
        elapsedMs: Date.now() - started,
        host: {
          rss: workers[0].rss,
          cpuPercent: workers[0].cpuPercent,
          processCount: workers[0].pids.length,
        },
        browser: {
          rss: workers[1].rss,
          cpuPercent: workers[1].cpuPercent,
          processCount: workers[1].pids.length,
        },
        mapCoverage: snapshot.resources.coverage,
      });
    }
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      contract: 'forge.resource-idle-trace/1',
      platform: process.platform,
      forge: health.version,
      machine,
      node: process.version,
      browser: browser.version(),
      withinPhaseIntervalMs: 5100,
      workload:
        'Empty compiled local workspace; three blank-browser control samples, then six Resources UI samples with normal polling',
      nativeQueries:
        'ps identity, observed ancestry, RSS and native reported CPU; samples 5100ms apart within each phase',
      limitations:
        'OS-visible trees only; RSS includes shared pages; ps CPU is platform-defined, not a controlled interval or normalized whole-machine measure. Test machinery and browser startup influence this idle trace.',
      modelCalls: 0,
      paidModelCalls: 0,
      personalWorkspaceChanged: false,
      samples,
    }),
  );
} finally {
  await browser?.close();
  await browserServer?.close();
  if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
  let timer;
  const code = await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 10000);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(code, 0, `The owned compiled fixture did not close cleanly: ${output}`);
  // Only this script's own temporary, closed fixture is removed.
  await rm(directory, { recursive: true, force: true });
}
