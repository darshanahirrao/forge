import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('notification setup keeps credentials private, reports actual acceptance and exposes uncertain deliveries without retrying', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const fixture = await (await page.request.get('/api/fixture/notifications')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  await page.goto('/#connections');
  const panel = page.getByRole('region', { name: 'Notifications', exact: true });
  await expect(panel.getByText('Off.', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: 'Configure notifications', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Configure notifications', exact: true });
  await expect(dialog.getByLabel('ntfy server origin', { exact: false })).toBeFocused();
  await expect(dialog.getByRole('checkbox', { name: 'Native approvals' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Completed attempts' })).not.toBeChecked();
  await dialog.getByLabel('ntfy server origin', { exact: false }).fill(fixture.origin);
  await dialog.getByLabel('Private topic', { exact: false }).fill('browser-owned-private-topic');
  await dialog.getByLabel('Access token', { exact: false }).fill('browser-owned-private-token');
  // Keep this shared fixture independent of approvals from earlier browser flows.
  await dialog.getByRole('checkbox', { name: 'Native approvals' }).uncheck();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    await expect(dialog.getByRole('button', { name: 'Connect notifications' })).toBeInViewport();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBeFalsy();
    await dialog.screenshot({ path: `artifacts/forge-notifications-setup-${theme}.png` });
  }
  await dialog.getByRole('button', { name: 'Connect notifications' }).click();
  await expect(dialog).toHaveCount(0);
  const before = (await (await page.request.get('/api/fixture/notifications')).json()).delivered
    .length;
  await panel.getByRole('button', { name: 'Send test alert' }).click();
  await panel.getByText('Delivery receipts', { exact: false }).click();
  await expect(panel.getByText('Accepted by ntfy', { exact: false }).first()).toBeVisible();
  await expect(
    panel
      .getByText('Accepted by ntfy. Delivery to a device is not confirmed.', { exact: true })
      .first(),
  ).toBeVisible();
  const persisted = await (await page.request.get('/api/snapshot')).json();
  for (const secret of ['browser-owned-private-topic', 'browser-owned-private-token']) {
    expect(JSON.stringify(persisted)).not.toContain(secret);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret);
    expect(await page.locator('body').innerText()).not.toContain(secret);
  }
  const delivered = (await (await page.request.get('/api/fixture/notifications')).json()).delivered;
  expect(delivered.length).toBe(before + 1);
  expect(delivered.at(-1).click).toBe('https://127.0.0.1:4713/#work');
  expect(delivered.at(-1).actions).toBeUndefined();
  expect(
    (await page.request.post('/api/fixture/notifications', { headers, data: { fail: true } })).ok(),
  ).toBeTruthy();
  await panel.getByRole('button', { name: 'Send test alert' }).click();
  await expect(panel.getByText('Delivery uncertain', { exact: false })).toBeVisible();
  await page.goto('/#overview');
  const attention = page.getByRole('region', { name: 'Needs your attention' });
  await attention.getByRole('button', { name: /Notification delivery needs review/ }).click();
  await expect(panel).toBeVisible();
  await panel.getByText('Delivery receipts', { exact: false }).click();
  await expect(panel.getByRole('button', { name: 'Acknowledge delivery issue' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBeFalsy();
    await panel.screenshot({ path: `artifacts/forge-notifications-delivery-${theme}.png` });
  }
  await panel.getByRole('button', { name: 'Acknowledge delivery issue' }).click();
  await expect(panel.getByRole('button', { name: 'Acknowledge delivery issue' })).toHaveCount(0);
  await expect(panel.getByText('Delivery uncertain', { exact: false })).toBeVisible();
  const count = (await (await page.request.get('/api/fixture/notifications')).json()).delivered
    .length;
  await page.reload();
  await expect(panel.getByText('Connected to', { exact: false })).toBeVisible();
  expect(
    (await (await page.request.get('/api/fixture/notifications')).json()).delivered.length,
  ).toBe(count);
  await panel.getByRole('button', { name: 'Replace destination' }).click();
  dialog = page.getByRole('dialog', { name: 'Configure notifications', exact: true });
  await expect(dialog.getByLabel('Private topic', { exact: false })).toHaveValue('');
  await expect(dialog.getByLabel('Access token', { exact: false })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await panel.getByRole('button', { name: 'Disable notifications' }).click();
  await expect(panel.getByText('Off.', { exact: false })).toBeVisible();
  expect(
    (
      await page.request.post('/api/fixture/notifications', { headers, data: { fail: false } })
    ).ok(),
  ).toBeTruthy();
});
