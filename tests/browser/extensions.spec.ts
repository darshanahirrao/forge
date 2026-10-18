import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('a loaded native extension links an ordinary account and uses the existing reviewed runtime and resource controls', async ({
  page,
}) => {
  const fixture = await (await page.request.get('/api/fixture/extensions')).json();
  const snapshot = await (await page.request.get('/api/snapshot')).json(),
    headers = { 'x-forge-csrf': snapshot.csrf };
  await page.goto('/#connections');
  const extensions = page.getByRole('region', { name: 'Native runtime extensions', exact: true });
  await expect(extensions).toContainText('Browser native runtime');
  await extensions.getByRole('button', { name: 'Link an account', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Link account', exact: true });
  await expect(dialog.getByRole('combobox', { name: 'Harness', exact: true })).toHaveValue(
    fixture.provider.id,
  );
  await dialog.getByLabel('Account label', { exact: true }).fill('Extension native account');
  await dialog.getByRole('textbox', { name: /^Native profile root/ }).fill(fixture.nativeHome);
  await expect(dialog).toContainText('Use the reviewed native runtime controls in Connections');
  await dialog.getByRole('button', { name: 'Save account slot', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const linked = await (await page.request.get('/api/snapshot')).json();
  const account = linked.accounts.find(
    (value: { label: string }) => value.label === 'Extension native account',
  );
  expect(account.nativeProvider.digest).toBe(fixture.provider.digest);
  const grant = await page.request.post('/api/companions', {
    headers,
    data: {
      label: 'Extension reviewed context',
      profileId: snapshot.defaultProfileId,
      root: fixture.project,
      scopes: ['work:read', 'context:read'],
      accountIds: [],
    },
  });
  expect(grant.ok()).toBe(true);
  const access = await grant.json();
  await page.reload();
  const runtimes = page.getByRole('region', { name: 'Native companion runtimes', exact: true });
  await runtimes.getByRole('button', { name: 'Link runtime', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Link native runtime', exact: true });
  await dialog.getByLabel('Runtime name', { exact: true }).fill('Extension owned gateway');
  await dialog
    .getByRole('combobox', { name: 'Native account', exact: true })
    .selectOption(account.id);
  await dialog
    .getByRole('combobox', { name: 'Companion access', exact: true })
    .selectOption(access.grant.id);
  await dialog.getByRole('button', { name: 'Link runtime', exact: true }).click();
  const runtime = runtimes.getByRole('group', { name: 'Extension owned gateway', exact: true });
  await runtime.getByRole('button', { name: 'Start Extension owned gateway', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Start native gateway', exact: true });
  await expect(dialog).toContainText('installed Browser native runtime gateway');
  await expect(dialog.getByRole('button', { name: 'Start gateway', exact: true })).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.screenshot({ path: `artifacts/forge-runtime-extension-${theme}.png` });
  }
  await dialog.getByRole('checkbox', { name: /I reviewed this profile/ }).check();
  await dialog.getByRole('button', { name: 'Start gateway', exact: true }).click();
  await expect(runtime).toContainText('Owned native gateway available');
  await page.goto('/#resources');
  await expect(
    page.getByRole('button', { name: 'Open native runtime: Extension owned gateway', exact: true }),
  ).toBeVisible();
  await page.goto('/#connections');
  await runtime.getByRole('button', { name: 'Stop Extension owned gateway', exact: true }).click();
  await expect(runtime).toContainText('The original native child and inherited stdio closed');
  await page.goto('/#accounts');
  const card = page
    .locator('.account-panel')
    .filter({ has: page.getByRole('heading', { name: 'Extension native account', exact: true }) });
  await expect(card).toContainText('Native runtime extension');
  await card.getByRole('button', { name: 'Check runtime binding', exact: true }).click();
  await expect(card).toContainText('Allowance not reported');
});
