import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('account setup references a private file without displaying its value, keeps its footer reachable and checks it locally', async ({
  page,
}) => {
  const fixture = await (await page.request.get('/api/fixture/credentials')).json();
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Link account', exact: true });
  await dialog.getByLabel('Account label', { exact: true }).fill('Background file fixture');
  await dialog.getByLabel(/^Harness/).selectOption('claude');
  await dialog.getByLabel('Billing preference').selectOption('api');
  await dialog.getByText('Background credential reference', { exact: true }).click();
  await dialog.getByLabel(/^Credential source/).selectOption('private-json');
  await dialog.getByLabel(/^Private JSON path/).fill(fixture.path);
  await dialog.getByLabel('JSON field name', { exact: true }).fill(fixture.key);
  await dialog.locator('input[name="nativeHome"]').fill(fixture.nativeHome);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const footer = await dialog.locator('.form-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.screenshot({ path: `artifacts/forge-credentials-${theme}.png` });
  }
  await dialog.getByRole('button', { name: 'Save account slot', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.locator('.account-panel').filter({ hasText: 'Background file fixture' });
  await row.getByText('Private credential reference', { exact: true }).click();
  await row.getByRole('button', { name: 'Check private reference', exact: true }).click();
  await expect(row.getByRole('status')).toContainText('Private reference available');
  const snapshot = await (await page.request.get('/api/snapshot')).text();
  expect(snapshot).not.toContain('public-owned-browser-synthetic-key');
  expect(await page.content()).not.toContain('public-owned-browser-synthetic-key');
  const blueprint = await (await page.request.get('/api/blueprint')).text();
  expect(blueprint).not.toContain('public-owned-browser-synthetic-key');
  const current = JSON.parse(snapshot);
  const account = current.accounts.find(
    (item: { label: string }) => item.label === 'Background file fixture',
  );
  expect(
    (
      await page.request.delete(`/api/accounts/${account.id}`, {
        data: {},
        headers: { 'x-forge-csrf': current.csrf },
      })
    ).ok(),
  ).toBe(true);
});
