import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('native profile review leads to the same work handoff with the imported account selected', async ({
  page,
}) => {
  const fixture = await (await page.request.get('/api/fixture/native-migrations')).json();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const sourceResponse = await page.request.post('/api/accounts', {
    headers,
    data: {
      label: 'Migration Hermes source',
      harness: 'hermes',
      nativeHome: fixture.nativeHome,
      billingMode: 'api',
      credentialEnv: 'OPENAI_API_KEY',
      credentialReference: { kind: 'private-json', path: fixture.credentialPath, key: 'selected' },
    },
  });
  expect(sourceResponse.ok()).toBe(true);
  const source = await sourceResponse.json();
  const workResponse = await page.request.post('/api/work', {
    headers,
    data: {
      title: 'One work through native migration',
      project: 'Owned',
      cwd: fixture.project,
      goal: 'Keep native memory and work history.',
      harness: 'hermes',
      accountId: source.id,
    },
  });
  expect(workResponse.ok()).toBe(true);
  const work = await workResponse.json();
  await page.goto('/#accounts');
  const panel = page.getByRole('region', { name: 'Native profile imports', exact: true });
  await panel.getByRole('button', { name: 'Import native profile', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Import native profile', exact: true });
  await dialog
    .getByRole('combobox', { name: 'Source native account', exact: true })
    .selectOption(source.id);
  await dialog
    .getByLabel('New account label', { exact: true })
    .fill('Imported OpenClaw destination');
  await dialog.getByRole('button', { name: 'Prepare native profile', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review native profile import', exact: true });
  await expect(dialog).toContainText(
    '1 imported · 1 archived · 1 skipped · 1 memory entries overflowed',
  );
  await expect(dialog).toContainText('not active native memory');
  await expect(dialog.getByRole('button', { name: 'Add account', exact: true })).toBeDisabled();
  await expect(
    dialog.getByRole('checkbox', {
      name: 'Reuse the source provider credential reference',
      exact: true,
    }),
  ).not.toBeChecked();
  await dialog.getByText('Native items and private paths', { exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const footer = await dialog.locator('.form-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
    expect(
      await dialog
        .locator('.dialog-body')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.screenshot({ path: `artifacts/forge-native-import-${theme}.png` });
  }
  await dialog.getByRole('checkbox', { name: /I reviewed imported permissions/ }).check();
  await dialog.getByLabel('Native project directory').fill(fixture.project);
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toContainText('The reviewed native profile is registered.');
  const after = await (await page.request.get('/api/snapshot')).json();
  const target = after.accounts.find(
    (account: { label: string }) => account.label === 'Imported OpenClaw destination',
  );
  expect(target.credentialReference).toBeUndefined();
  expect(after.work.find((item: { id: string }) => item.id === work.id).accountId).toBe(source.id);
  await page.reload();
  await panel
    .locator('.native-entry')
    .filter({ hasText: 'Imported OpenClaw destination' })
    .getByRole('button', { name: 'Review import', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Continue existing work', exact: true }).click();
  const handoff = page.getByRole('dialog', {
    name: 'Keep the work. Change the harness.',
    exact: true,
  });
  await expect(handoff.getByRole('combobox', { name: 'Continue with', exact: true })).toHaveValue(
    target.id,
  );
  await handoff.getByLabel('Files to verify').fill('native-migration-proof.txt');
  await handoff.getByRole('button', { name: 'Prepare checkpoint', exact: true }).click();
  await handoff.getByRole('checkbox', { name: /I reviewed native activity/ }).check();
  await handoff.getByRole('button', { name: 'Switch at this checkpoint', exact: true }).click();
  await expect(handoff).toHaveCount(0);
  const moved = await (await page.request.get(`/api/work/${work.id}`)).json();
  expect(moved.work.id).toBe(work.id);
  expect(moved.work.profileId).toBe(work.profileId);
  expect(moved.work.accountId).toBe(target.id);
  expect(moved.runs).toHaveLength(0);
});

test('changed staged native memory remains held and can be dismissed without activating an account', async ({
  page,
}) => {
  const fixture = await (await page.request.get('/api/fixture/native-migrations')).json();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const source = await (
    await page.request.post('/api/accounts', {
      headers,
      data: { label: 'Changed import source', harness: 'hermes', nativeHome: fixture.nativeHome },
    })
  ).json();
  const planResponse = await page.request.post('/api/native/migrations/prepare', {
    headers,
    data: { sourceAccountId: source.id, label: 'Changed native stage' },
  });
  expect(planResponse.ok()).toBe(true);
  const plan = await planResponse.json();
  expect(plan.state).toBe('ready');
  await writeFile(join(plan.nativeHome, 'MEMORY.md'), 'Owned changed native content.');
  await page.goto('/#accounts');
  const row = page
    .getByRole('region', { name: 'Native profile imports', exact: true })
    .locator('.native-entry')
    .filter({ hasText: 'Changed native stage' });
  await row.getByRole('button', { name: 'Review import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review native profile import', exact: true });
  await dialog.getByRole('checkbox', { name: /I reviewed imported permissions/ }).check();
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed after preparation');
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = await (await page.request.get('/api/snapshot')).json();
  expect(
    after.accounts.some((account: { label: string }) => account.label === 'Changed native stage'),
  ).toBe(false);
});

test('phone views show native import status and keep local setup disabled', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto('https://127.0.0.1:4713/#accounts');
    const panel = page.getByRole('region', { name: 'Native profile imports', exact: true });
    await expect(
      panel.getByRole('button', { name: 'Import native profile', exact: true }),
    ).toBeDisabled();
    await expect(panel).toContainText('local Forge host');
  } finally {
    await context.close();
  }
});
