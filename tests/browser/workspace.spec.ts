import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('create an account slot, save work and a checkpoint, and retain them after reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your workspace, in focus.' })).toBeVisible();
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account label').fill('Browser fixture slot');
  await page.getByRole('button', { name: 'Save account slot' }).click();
  await expect(page.getByRole('heading', { name: 'Browser fixture slot' })).toBeVisible();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title').fill('A durable browser fixture');
  await page
    .getByLabel('Goal', { exact: true })
    .fill('Retain the same recorded context after reload.');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Browser fixture slot' });
  await page.getByRole('dialog').getByRole('button', { name: 'Create work', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'A durable browser fixture' });
  await expect(detail).toBeVisible();
  await detail
    .getByLabel('Leave a checkpoint')
    .fill('Verified fixture checkpoint with no native execution.');
  await detail.getByRole('button', { name: 'Save checkpoint' }).click();
  await expect(
    detail.getByText('Verified fixture checkpoint with no native execution.'),
  ).toBeVisible();
  const exported = page.waitForEvent('download');
  await detail.getByRole('button', { name: 'Export context' }).click();
  expect((await exported).suggestedFilename()).toMatch(/^forge-work-/);
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'A durable browser fixture', exact: true }).click();
  await expect(
    page.getByText('Verified fixture checkpoint with no native execution.'),
  ).toBeVisible();
});

test('fictional approvals resolve in the demo and cannot touch native work', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Explore the isolated demo workspace').click();
  await expect(
    page.getByText('Fictional work, accounts, and approvals. Machine telemetry is live.'),
  ).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Approvals/ })
    .click();
  await page.getByRole('button', { name: 'Review request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review the accessibility check' });
  await expect(dialog.getByText('npm run test:a11y')).toBeVisible();
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('heading', { name: 'Your attention is clear.' })).toBeVisible();
  const local = await page.request.get('/api/snapshot');
  expect((await local.json()).approvals).toHaveLength(0);
});

test('quiet mode persists, search is keyboard accessible, and both themes meet accessibility gates', async ({
  page,
}) => {
  await page.goto('/');
  const quiet = page.getByRole('switch', { name: 'Quiet mode' });
  await quiet.click();
  await expect(quiet).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(quiet).toHaveAttribute('aria-checked', 'true');
  await quiet.click();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Find your next step.' });
  await expect(search).toBeVisible();
  await search.getByLabel('Search views and work').fill('Accounts');
  await search.getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Many accounts. One workspace.' })).toBeVisible();
  for (const dark of [false, true]) {
    if (dark) await page.getByRole('button', { name: 'Use dark theme' }).click();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }
});

test('all views remain usable on a narrow screen without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (const label of ['Overview', 'Work', 'Approvals', 'Accounts', 'Resources', 'Connections']) {
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('main h1')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByTitle('Explore the isolated demo workspace').click();
  await expect(page.getByRole('heading', { name: 'Work in motion' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
});

test('Claude API slots expose the credential reference and native launch choice without starting execution', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account label').fill('Claude browser API fixture');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('claude');
  await page.getByLabel('Billing preference').selectOption('api');
  await page.getByLabel('API credential environment variable').fill('FORGE_BROWSER_CLAUDE_KEY');
  await page.getByRole('button', { name: 'Save account slot' }).click();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title').fill('Claude native launch review');
  await page
    .getByLabel('Goal', { exact: true })
    .fill('Review the supported native route without launching.');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('claude');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Claude browser API fixture' });
  await page.getByLabel('Project directory').fill(process.cwd());
  await page.getByRole('dialog').getByRole('button', { name: 'Create work', exact: true }).click();
  await page.getByRole('button', { name: 'Run with Claude', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ready to use the native harness?' });
  const launch = dialog.getByRole('button', { name: 'Start native attempt' });
  await expect(launch).toBeDisabled();
  await expect(dialog.getByText(/This route uses API authentication/)).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Allow metered/ }).check();
  await expect(launch).toBeEnabled();
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
  await dialog.getByRole('button', { name: 'Keep as ready' }).click();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(
    snapshot.work.find((work: { title: string }) => work.title === 'Claude native launch review')
      .status,
  ).toBe('ready');
});
