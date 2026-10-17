import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('resource map separates native ownership, sorts CPU, exports private diagnostics and handles missing coverage', async ({
  page,
}) => {
  await page.goto('/');
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const created = await page.request.post('/api/work', {
    headers: { 'x-forge-csrf': snapshot.csrf },
    data: {
      title: 'Resource map owned browser work',
      project: 'Resource fixture',
      goal: 'Review the resource map without creating a native worker.',
      harness: 'codex',
      cwd: process.cwd(),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const work = await created.json();
  let unavailable = false;
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const sampledAt = new Date().toISOString();
    await route.fulfill({
      response,
      json: {
        ...data,
        machine: {
          ...data.machine,
          sampledAt,
          processes: [
            {
              pid: 70001,
              parentPid: 1,
              name: 'Large memory fixture',
              rss: 1024 ** 3,
              cpuPercent: 0.2,
            },
          ],
          busiestProcesses: [
            {
              pid: 70002,
              parentPid: 1,
              name: 'Small CPU fixture',
              rss: 10 * 1024 ** 2,
              cpuPercent: 140,
            },
          ],
        },
        resources: {
          contract: 'forge.resource-observation/1',
          sampledAt,
          coverage: unavailable ? 'unavailable' : 'observed',
          processCount: unavailable ? 0 : 5,
          rss: unavailable ? null : 320 * 1024 ** 2,
          cpuPercent: unavailable ? null : 142,
          unresolvedWorkers: 0,
          groups: unavailable
            ? []
            : [
                {
                  id: 'forge-host',
                  kind: 'host',
                  label: 'Forge host and helpers',
                  state: 'observed',
                  rootPids: [70003],
                  rootCount: 1,
                  processCount: 2,
                  rss: 20 * 1024 ** 2,
                  cpuPercent: 140,
                },
                {
                  id: `run:browser-fixture`,
                  kind: 'managed',
                  label: 'Managed native work',
                  state: 'observed',
                  rootPids: [70004],
                  rootCount: 1,
                  processCount: 1,
                  rss: 100 * 1024 ** 2,
                  cpuPercent: 1,
                  workId: work.id,
                  runId: 'browser-fixture',
                  harness: 'codex',
                },
                {
                  id: 'native-app:codex',
                  kind: 'native-app',
                  label: 'Codex',
                  state: 'observed',
                  rootPids: [70005],
                  rootCount: 1,
                  processCount: 2,
                  rss: 200 * 1024 ** 2,
                  cpuPercent: 1,
                },
              ],
        },
      },
    });
  });
  await page.reload();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Resources', exact: true })
    .click();
  const map = page.getByRole('region', { name: 'Workspace resource map' });
  const table = map.getByRole('region', { name: 'Grouped resource use' });
  await expect(table.getByRole('row').nth(1)).toContainText('Codex');
  await expect(map.getByText('Name match; native controls')).toBeVisible();
  await expect(map.getByRole('button', { name: /kill|stop|pause/i })).toHaveCount(0);
  await map.getByLabel('Sort resource use').selectOption('cpu');
  await expect(table.getByRole('row').nth(1)).toContainText('Forge host and helpers');
  await expect(table.getByRole('row').nth(1)).toContainText('140.0%');
  await expect(
    page.getByRole('heading', { name: 'Processes using CPU', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Small CPU fixture', { exact: true })).toBeVisible();
  await expect(page.getByText('Large memory fixture', { exact: true })).toHaveCount(0);
  await map.getByText('Measurement coverage and diagnostics', { exact: true }).click();
  const downloading = page.waitForEvent('download');
  await map.getByRole('button', { name: 'Download resource snapshot' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('forge-resource-observation.json');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(exported.contract).toBe('forge.resource-observation/1');
  expect(exported.groups.find((item: { kind: string }) => item.kind === 'managed').workId).toBe(
    work.id,
  );
  expect(exported).not.toHaveProperty('work');
  expect(exported).not.toHaveProperty('accounts');
  expect(exported).not.toHaveProperty('csrf');
  expect(exported).not.toHaveProperty('processes');
  for (const mobile of [false, true]) {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    if (mobile) await page.getByRole('button', { name: 'Use dark theme' }).click();
    if (mobile) {
      expect(await table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(axe.violations.map((violation) => violation.id)).toEqual([]);
    await map.getByRole('heading', { name: 'Where resources are going' }).click();
    await map.screenshot({
      path: `artifacts/forge-resource-map-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
    });
  }
  await map.getByRole('button', { name: `Open resource work: ${work.title}`, exact: true }).click();
  const detail = page.getByRole('dialog', { name: work.title, exact: true });
  await expect(detail).toBeVisible();
  await page.keyboard.press('Escape');
  unavailable = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Resources', exact: true })
    .click();
  await expect(map.getByText('Resource grouping is unavailable.', { exact: true })).toBeVisible();
  await expect(table).toHaveCount(0);
  await expect(
    page.getByRole('switch', { name: 'Memory pressure protection', exact: true }),
  ).toBeVisible();
});
