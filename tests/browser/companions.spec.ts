import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('companion access offers scoped finite dispatch, native setup formats and revocation without retaining the bearer', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const paths = await (await page.request.get('/api/fixture/memory')).json();
  const added = await page.request.post('/api/accounts', {
    headers: { 'x-forge-csrf': snapshot.csrf },
    data: { label: 'Companion dispatch slot', harness: 'codex' },
  });
  expect(added.ok()).toBeTruthy();
  await page.goto('/#connections');
  const panel = page.getByRole('region', { name: 'Companion access' });
  await panel.getByRole('button', { name: 'Connect companion', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect companion', exact: true });
  await dialog.getByLabel('Companion name').fill('Hermes browser connection');
  await dialog
    .getByRole('textbox', { name: /Project directory/ })
    .fill('/unavailable/forge-project');
  await dialog.getByRole('combobox', { name: 'Access', exact: true }).selectOption('dispatch');
  await expect(dialog.getByRole('button', { name: 'Create access' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Companion dispatch slot' }).check();
  await dialog.getByLabel('Maximum native runs').fill('2');
  await dialog.getByLabel('Expires in days').fill('7');
  await expect(dialog.getByRole('checkbox', { name: /Allow metered/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Create access' }).click();
  await expect(dialog.getByText('The companion project directory was not found.')).toBeVisible();
  await dialog.getByRole('textbox', { name: /Project directory/ }).fill(paths.project);
  await dialog.getByRole('button', { name: 'Create access' }).click();
  const setup = page.getByRole('dialog', { name: 'Add Forge to your native client' });
  const configuration = setup.getByLabel('MCP connection configuration');
  const config = JSON.parse(await configuration.inputValue());
  expect(config.mcpServers.forge.url).toContain('/mcp/companions');
  expect(config.mcpServers.forge.headers.Authorization.startsWith('Bearer forgec_')).toBeTruthy();
  await setup.getByRole('combobox', { name: 'Configuration format' }).selectOption('hermes');
  expect(await configuration.inputValue()).toContain('mcp_servers:');
  await setup.getByRole('combobox', { name: 'Configuration format' }).selectOption('openclaw');
  expect(JSON.parse(await configuration.inputValue()).mcp.servers.forge.transport).toBe(
    'streamable-http',
  );
  const persisted = await (await page.request.get('/api/snapshot')).json();
  const grant = persisted.companionGrants.find(
    (value: { label: string }) => value.label === 'Hermes browser connection',
  );
  expect(grant.dispatch).toEqual({ maxRuns: 2, allowMetered: false });
  expect(JSON.stringify(persisted).includes('tokenHash')).toBeFalsy();
  expect(JSON.stringify(persisted).includes('Bearer forgec_')).toBeFalsy();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBeFalsy();
  }
  await setup.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(configuration).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('forgec_');
  await panel.getByRole('button', { name: 'Revoke Hermes browser connection' }).click();
  await expect(
    panel.getByRole('button', { name: 'Revoke Hermes browser connection' }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('MCP connection configuration')).toHaveCount(0);
});
