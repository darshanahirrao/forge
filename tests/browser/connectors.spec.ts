import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('a reviewed native connector becomes an account option, retains its contract through retirement and can be removed only when unused', async ({
  page,
}) => {
  const fixture = await (await page.request.get('/api/fixture/connectors')).json();
  await page.goto('/#connections');
  const panel = page.getByRole('region', { name: 'Native harness connectors', exact: true });
  await panel.getByRole('button', { name: 'Register connector', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Register native connector', exact: true });
  await form
    .getByLabel('Native connector manifest', { exact: true })
    .fill(JSON.stringify(fixture.manifest, null, 2));
  await form.getByRole('button', { name: 'Prepare review', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review native connector', exact: true });
  await expect(
    review.getByRole('button', { name: 'Register reviewed connector', exact: true }),
  ).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const footer = await review.locator('.form-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await review.screenshot({ path: `artifacts/forge-connector-${theme}.png` });
  }
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Register reviewed connector', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(
    panel.getByRole('heading', { name: 'Owned browser agent', exact: true }),
  ).toBeVisible();
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const accountForm = page.getByRole('dialog', { name: 'Link account', exact: true });
  await accountForm
    .getByLabel('Account label', { exact: true })
    .fill('Owned connector browser slot');
  await accountForm.getByLabel(/^Harness/).selectOption('ext.browser-agent.v1');
  await accountForm.locator('input[name="nativeHome"]').fill(fixture.nativeHome);
  await accountForm.getByRole('button', { name: 'Save account slot', exact: true }).click();
  await expect(accountForm).toHaveCount(0);
  const account = page
    .locator('.account-panel')
    .filter({ hasText: 'Owned connector browser slot' });
  await account.getByRole('button', { name: 'Check native account', exact: true }).click();
  await expect(
    account.getByText(/Native ACP connector; provider identity, limits and billable usage unknown/),
  ).toBeVisible();
  await page.goto('/#connections');
  await panel.getByRole('button', { name: 'Remove unused connector', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('history bindings');
  await panel.getByRole('button', { name: 'Retire connector', exact: true }).click();
  await page.reload();
  await expect(
    panel.getByText('ext.browser-agent.v1 · ACP v1 · Retired', { exact: true }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Enable connector', exact: true }).click();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const saved = snapshot.accounts.find(
    (item: { label: string }) => item.label === 'Owned connector browser slot',
  );
  const headers = { 'x-forge-csrf': snapshot.csrf };
  expect((await page.request.delete(`/api/accounts/${saved.id}`, { headers, data: {} })).ok()).toBe(
    true,
  );
  await panel.getByRole('button', { name: 'Remove unused connector', exact: true }).click();
  await expect(
    panel.getByRole('heading', { name: 'Owned browser agent', exact: true }),
  ).toHaveCount(0);
});
