import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('native schedule move stages disabled, reviews timing and permissions, activates once and keeps the original paused', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json(),
    headers = { 'x-forge-csrf': snapshot.csrf };
  const fixture = await (
    await page.request.post('/api/fixture/schedule-transfers', {
      headers,
      data: { label: 'Browser transfer' },
    })
  ).json();
  await page.goto('/#activity');
  await page.getByRole('button', { name: /^Schedules/ }).click();
  const original = page.locator('article.native-schedule').filter({
    has: page.getByRole('heading', { name: 'Browser transfer recurring task', exact: true }),
  });
  await original.getByRole('button', { name: 'Move schedule', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Move native schedule', exact: true });
  await dialog
    .getByRole('combobox', { name: 'Destination scheduler', exact: true })
    .selectOption(fixture.targetSourceId);
  await dialog.getByRole('button', { name: 'Review move', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review schedule move', exact: true });
  await expect(dialog).toContainText('original interval phase is not preserved');
  await expect(dialog.getByRole('button', { name: 'Stage move', exact: true })).toBeDisabled();
  await dialog.getByText('Source and destination definitions', { exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await dialog.locator('.dialog-body').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await dialog.screenshot({ path: `artifacts/forge-schedule-move-${theme}.png` });
  }
  await dialog.getByRole('checkbox', { name: /I reviewed both definitions/ }).check();
  await dialog.getByRole('button', { name: 'Stage move', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Schedule transfers', exact: true });
  const row = panel.locator('article').filter({ hasText: 'Browser transfer recurring task' });
  await expect(row).toContainText('Both schedules are paused');
  const held = await page.request.post('/api/native/controls/prepare', {
    headers,
    data: { sourceId: fixture.sourceId, jobId: 'owned-source', action: 'resume' },
  });
  expect(held.status()).toBe(409);
  await page.reload();
  await page.getByRole('button', { name: /^Schedules/ }).click();
  await row.getByRole('button', { name: 'Review transfer', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review schedule transfer', exact: true });
  await expect(
    dialog.getByRole('button', { name: 'Enable destination', exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText('Disabled');
  const footer = await dialog.locator('.form-footer').boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.screenshot({ path: 'artifacts/forge-schedule-activate-dark.png' });
  await dialog.getByRole('checkbox', { name: /I reviewed native permissions and billing/ }).check();
  await dialog.getByRole('button', { name: 'Enable destination', exact: true }).click();
  await expect(row).toContainText('Destination scheduling is enabled');
  await row.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await dialog.getByRole('checkbox', { name: /I reviewed native permissions and billing/ }).check();
  await dialog.getByRole('button', { name: 'Keep both paused', exact: true }).click();
  await expect(row).toContainText('cancelled');
  const resumed = await page.request.post('/api/native/controls/prepare', {
    headers,
    data: { sourceId: fixture.sourceId, jobId: 'owned-source', action: 'resume' },
  });
  expect(resumed.ok()).toBe(true);
  for (const id of [fixture.sourceId, fixture.targetSourceId]) {
    const removed = await page.request.delete(`/api/native/sources/${id}`, { headers, data: {} });
    expect(removed.ok(), await removed.text()).toBe(true);
  }
});

test('a lost schedule create result opens outcome reconciliation and never silently activates or recreates the target', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json(),
    headers = { 'x-forge-csrf': snapshot.csrf };
  const fixture = await (
    await page.request.post('/api/fixture/schedule-transfers', {
      headers,
      data: { label: 'Uncertain transfer', lost: true },
    })
  ).json();
  await page.goto('/#activity');
  await page.getByRole('button', { name: /^Schedules/ }).click();
  const original = page.locator('article.native-schedule').filter({
    has: page.getByRole('heading', { name: 'Uncertain transfer recurring task', exact: true }),
  });
  await original.getByRole('button', { name: 'Move schedule', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Move native schedule', exact: true });
  await dialog
    .getByRole('combobox', { name: 'Destination scheduler', exact: true })
    .selectOption(fixture.targetSourceId);
  await dialog.getByRole('button', { name: 'Review move', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review schedule move', exact: true });
  await dialog.getByRole('checkbox', { name: /I reviewed both definitions/ }).check();
  await dialog.getByRole('button', { name: 'Stage move', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Schedule transfers', exact: true })
    .locator('article')
    .filter({ hasText: 'Uncertain transfer recurring task' });
  await expect(row).toContainText('uncertain');
  await row.getByRole('button', { name: 'Review transfer', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review schedule transfer', exact: true });
  await expect(dialog.getByRole('button', { name: 'Enable destination', exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByRole('button', { name: 'Record outcome', exact: true })).toBeDisabled();
  await dialog
    .getByLabel('What did you check in native history and pending operations?', { exact: true })
    .fill('Both native stores inspected; no pending operation, run or delivery remains.');
  await dialog.getByRole('checkbox', { name: /I reviewed native permissions and billing/ }).check();
  await dialog.getByRole('button', { name: 'Record outcome', exact: true }).click();
  await expect(row).toContainText('staged');
  await row.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await dialog.getByRole('checkbox', { name: /I reviewed native permissions and billing/ }).check();
  await dialog.getByRole('button', { name: 'Keep both paused', exact: true }).click();
  await expect(row).toContainText('cancelled');
  for (const id of [fixture.sourceId, fixture.targetSourceId]) {
    const removed = await page.request.delete(`/api/native/sources/${id}`, { headers, data: {} });
    expect(removed.ok(), await removed.text()).toBe(true);
  }
});
