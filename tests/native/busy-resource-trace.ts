import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type BrowserServer, type Page } from '@playwright/test';
import type { Snapshot, NativeWorkerIdentity } from '../../shared/types.js';
import type { createApp } from '../../server/app.js';
const { processTable, captureWorker, attributeNativeRoots } = (await import(
  new URL('../../dist/server/processes.js', import.meta.url).href
)) as typeof import('../../server/processes.js');
const { readMemoryPressure } = (await import(
  new URL('../../dist/server/memory-pressure.js', import.meta.url).href
)) as typeof import('../../server/memory-pressure.js');

type Host = Awaited<ReturnType<typeof createApp>>;
export class BusyResourceTrace {
  private browserServer?: BrowserServer;
  private browser?: Browser;
  private page?: Page;
  private browserRoot?: NativeWorkerIdentity;
  private origin = '';
  private last = 0;
  private started = performance.now();
  private samples: {
    phase: string;
    elapsedMs: number;
    sampledAt: string;
    healthResponseMs: number;
    pressure: Snapshot['machine']['memoryPressure'];
    groups: { role: string; rss: number | null; cpuPercent: number | null; processCount: number }[];
  }[] = [];

  async start(host: Host) {
    this.origin = await host.app.listen({ host: '127.0.0.1', port: 0 });
    try {
      this.browserServer = await chromium.launchServer({
        headless: true,
        ...(process.env.CI ? {} : { channel: 'chrome' }),
      });
      const pid = this.browserServer.process().pid;
      assert(pid);
      this.browserRoot = {
        version: 1,
        pid,
        ownerPid: process.pid,
        ...(await captureWorker(pid)),
        capturedAt: new Date().toISOString(),
      };
      this.browser = await chromium.connect(this.browserServer.wsEndpoint());
      this.page = await this.browser.newPage();
      await this.page.goto(this.origin + '/#resources');
      await this.page
        .getByRole('heading', { name: 'Where resources are going', exact: true })
        .waitFor();
      await this.sample(host, 'idle-ui');
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async activeSample(host: Host) {
    if (performance.now() - this.last >= 5100) await this.sample(host, 'controlled-native-tool');
  }
  async sample(host: Host, phase: string) {
    assert(this.page && this.browserRoot);
    const requestStarted = performance.now();
    const response = await this.page.request.get(this.origin + '/api/health');
    assert(response.ok());
    const healthResponseMs = performance.now() - requestStarted;
    const layout = await this.page.evaluate(() => ({
      ready: document.readyState,
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    assert.equal(layout.ready, 'complete');
    assert(layout.width <= layout.viewport, 'The resource screen overflowed during native work.');
    const snapshotResponse = await this.page.request.get(this.origin + '/api/snapshot', {
      headers: { 'x-forge-workspace': 'local' },
    });
    assert(snapshotResponse.ok(), 'The resource trace could not read its own local workspace.');
    const snapshot = (await snapshotResponse.json()) as Snapshot;
    assert.equal(snapshot.mode, 'local');
    assert.equal(snapshot.work.length, host.local.all('work').length);
    const table = await processTable();
    assert(table);
    const current = table.find((row) => row.pid === process.pid);
    assert(current && current.uid === process.getuid?.());
    const sampledAt = new Date().toISOString();
    const roots = [
      {
        role: 'compiled-host-and-fixture',
        harness: 'forge',
        root: {
          version: 1 as const,
          pid: process.pid,
          ownerPid: process.ppid,
          uid: current.uid,
          startedAt: current.startedAt,
          capturedAt: sampledAt,
        },
      },
      { role: 'owned-browser', harness: 'browser', root: this.browserRoot },
      ...(snapshot.nativeWorkers ?? []).map((worker) => ({
        role: 'native-' + worker.harness,
        harness: worker.harness,
        root: worker.root,
      })),
    ];
    const observed = attributeNativeRoots(roots, table, sampledAt);
    const assigned = new Set<number>();
    for (const group of observed) {
      assert.equal(group.state, 'live', `${phase}: ${group.role} could not be observed.`);
      assert(group.rss && group.rss > 0);
      for (const pid of group.pids) {
        assert(!assigned.has(pid), 'A process was charged to more than one trace group.');
        assigned.add(pid);
      }
    }
    this.samples.push({
      phase,
      elapsedMs: Math.round(performance.now() - this.started),
      sampledAt,
      healthResponseMs: Math.round(healthResponseMs),
      pressure: await readMemoryPressure(),
      groups: observed.map((group) => ({
        role: group.role,
        rss: group.rss,
        cpuPercent: group.cpuPercent,
        processCount: group.pids.length,
      })),
    });
    this.last = performance.now();
  }
  report() {
    const active = this.samples.filter((sample) => sample.phase === 'controlled-native-tool');
    assert(
      active.length >= 2,
      'The native tool did not stay active for two independent trace samples.',
    );
    assert(
      active.every((sample) =>
        sample.groups.some((group) => group.role === 'native-codex' && group.processCount >= 2),
      ),
      'The bounded native tool descendant was not observed: ' + JSON.stringify(active),
    );
    return {
      contract: 'forge.resource-busy-trace/1',
      browser: this.browser?.version(),
      withinActivePhaseIntervalMs: 5100,
      workload:
        'Actual Codex continuation and approved native Node tool; 32 MiB retained, approximately 4 ms computation per 100 ms for 16 seconds, then a verified artifact. Resources UI uses normal polling.',
      limitations:
        'A bounded conformance workload, not an arbitrary load benchmark or a memory cap. Compiled app shares its host with synthetic inference/test machinery. RSS includes shared pages; ps CPU uses its native averaging. Host/browser/native aggregates use one fresh OS table per trace sample, independent of cached UI measurement timestamps. No cross-product performance claim.',
      samples: this.samples,
    };
  }
  async close() {
    const browser = this.browser,
      server = this.browserServer;
    this.browser = undefined;
    this.browserServer = undefined;
    try {
      await browser?.close();
    } finally {
      await server?.close();
    }
  }
}
