import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('native execution setup clears pairing codes, imports dynamic providers and changes models accessibly', async ({
  page,
}) => {
  let connected = false,
    model = 'native-model',
    attempts = 0;
  const backend = {
    contractVersion: 1,
    id: 'test-native-backend',
    kind: 't3',
    label: 'Native execution',
    endpoint: 'http://127.0.0.1:3773',
    environmentId: 'native-environment',
    state: 'connected',
    checkedAt: new Date().toISOString(),
    error: null,
    providerCount: 1,
  };
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const original = await response.json();
    await route.fulfill({
      response,
      json: {
        ...original,
        backends: connected ? [backend] : [],
        accounts: connected
          ? [
              {
                id: 'native-account',
                label: 'Native ACP',
                harness: 'customAcp',
                nativeHome: '',
                billingMode: 'native',
                state: 'configured',
                identity: null,
                identityKey: null,
                plan: null,
                checkedAt: null,
                error: null,
                quotas: [],
                createdAt: new Date().toISOString(),
                backend: { id: backend.id, instanceId: 'native-acp', model },
                models: ['native-model', 'second-model'],
                providerReady: true,
              },
            ]
          : [],
      },
    });
  });
  await page.route('**/api/backends/t3', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.endpoint).toBe(backend.endpoint);
    expect(route.request().headers()['x-forge-csrf']).toBeTruthy();
    attempts++;
    if (attempts === 1)
      return route.fulfill({ status: 401, json: { error: 'Create a new native pairing code.' } });
    connected = true;
    await route.fulfill({ status: 201, json: backend });
  });
  await page.route('**/api/accounts/native-account/backend', async (route) => {
    expect(route.request().method()).toBe('PATCH');
    model = route.request().postDataJSON().model;
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.goto('/#connections');
  const panel = page.getByRole('region', { name: 'Execution backends' });
  await panel.getByRole('button', { name: 'Connect T3', exact: true }).click();
  const code = panel.getByLabel('One-time native pairing code');
  await code.fill('synthetic-expired-code');
  await panel.getByLabel('Connection name').fill(backend.label);
  await panel.getByRole('button', { name: 'Connect native backend', exact: true }).click();
  await expect(panel.getByText('Create a new native pairing code.')).toBeVisible();
  await expect(code).toHaveValue('');
  await code.fill('synthetic-new-code');
  await panel.getByRole('button', { name: 'Connect native backend', exact: true }).click();
  const select = panel.getByLabel('Model for Native ACP');
  await expect(select).toBeVisible();
  await expect(code).toHaveCount(0);
  await select.selectOption('second-model');
  await expect(select).toHaveValue('second-model');
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search commands and work' }).fill('> new work');
  await page.keyboard.press('Enter');
  const form = page.getByRole('dialog', { name: 'New work', exact: true });
  await expect(form).toBeVisible();
  await form.getByRole('combobox', { name: 'Harness', exact: true }).selectOption('customAcp');
  await expect(
    form
      .getByRole('combobox', { name: 'Account', exact: true })
      .getByRole('option', { name: 'Native ACP' }),
  ).toHaveCount(1);
  await form.getByRole('button', { name: 'Close dialog', exact: true }).click();
  for (const dark of [false, true]) {
    if (dark) await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
    await page.setViewportSize({ width: dark ? 390 : 1280, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      ).violations.map((violation) => violation.id),
    ).toEqual([]);
    await panel.screenshot({
      path: `artifacts/forge-execution-backend-${dark ? 'dark-mobile' : 'light'}.png`,
    });
  }
});
