import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { MemoryPressure } from '../../shared/types.js';

test('Linux admission explains native host and cgroup stalls on desktop and phone without submitting a held launch', async ({
  page,
}) => {
  let pressure: MemoryPressure = {
    source: 'linux-psi',
    state: 'critical',
    nativeValue: null,
    checkedAt: new Date().toISOString(),
    linux: {
      interpretation: 'forge-linux-psi/1',
      host: { someAvg10: 0.12, fullAvg10: 0.01 },
      cgroup: { someAvg10: 33.33, fullAvg10: 11.25 },
      cgroupCoverage: 'complete',
      observedCgroups: 3,
    },
  };
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        settings: { ...data.settings, memoryPressurePolicy: 'protect' },
        machine: { ...data.machine, memoryPressure: pressure },
      },
    });
  });
  await page.goto('/#resources');
  const region = page.getByRole('region', { name: 'Memory pressure protection', exact: true });
  await expect(region).toContainText(
    "Linux memory stalls meet Forge's critical admission threshold.",
  );
  await region.getByText('Linux pressure measurements', { exact: true }).click();
  await expect(region).toContainText('0.12% partial · 0.01% full');
  await expect(region).toContainText('33.33% partial · 11.25% full');
  await expect(region).toContainText('3 visible scopes checked');
  for (const narrow of [false, true]) {
    await page.evaluate(
      (theme) => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('forge.theme', theme);
      },
      narrow ? 'dark' : 'light',
    );
    await page.setViewportSize(narrow ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    expect(
      (
        await new AxeBuilder({ page })
          .include('[aria-label="Memory pressure protection"]')
          .analyze()
      ).violations,
    ).toEqual([]);
    await region.screenshot({
      path: `artifacts/forge-linux-pressure-${narrow ? 'mobile-dark' : 'desktop-light'}.png`,
    });
  }
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const accountResponse = await page.request.post('/api/accounts', {
    headers,
    data: { label: 'Linux headroom preview', harness: 'codex' },
  });
  expect(accountResponse.ok()).toBeTruthy();
  const account = await accountResponse.json();
  const workResponse = await page.request.post('/api/work', {
    headers,
    data: {
      title: 'Linux memory admission preview',
      project: 'Linux pressure fixture',
      goal: 'Inspect headroom without starting native input.',
      harness: 'codex',
      accountId: account.id,
      cwd: process.cwd(),
    },
  });
  expect(workResponse.ok()).toBeTruthy();
  const work = await workResponse.json();
  let launches = 0;
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/work/${work.id}/launch`)) launches++;
  });
  await page.goto('/#work');
  await page.getByRole('button', { name: work.title, exact: true }).click();
  await page.getByRole('button', { name: 'Run with Codex', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Ready to use the native harness?',
    exact: true,
  });
  await expect(dialog).toContainText(
    "Linux memory stalls meet Forge's critical admission threshold.",
  );
  await expect(
    dialog.getByRole('button', { name: 'Start native attempt', exact: true }),
  ).toBeDisabled();
  expect(launches).toBe(0);
  await dialog.getByRole('button', { name: 'Review Resources', exact: true }).click();
  pressure = {
    ...pressure,
    state: 'unknown',
    linux: { ...pressure.linux!, cgroup: null, cgroupCoverage: 'unavailable', observedCgroups: 0 },
  };
  await page.reload();
  await expect(region).toContainText('Linux memory pressure coverage is incomplete.');
  await region.getByText('Linux pressure measurements', { exact: true }).click();
  await expect(region).toContainText(
    'Incomplete; low measurements do not establish normal pressure',
  );
  expect(launches).toBe(0);
});
