import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('native scheduling requires an explicit review and exposes uncertain effects without replay in both themes and mobile', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  await page.goto('/#activity');
  await page.getByRole('button', { name: 'Discover profiles', exact: true }).click();
  const source = page
    .locator('.native-source')
    .filter({ has: page.getByRole('heading', { name: 'Hermes profile schedules', exact: true }) });
  await source.getByRole('button', { name: 'Read Hermes profile schedules', exact: true }).click();
  await page.getByRole('button', { name: /^Schedules \d/ }).click();
  const row = page
    .locator('.native-schedule')
    .filter({ has: page.getByRole('heading', { name: 'Native Hermes check', exact: true }) });
  await row.getByRole('button', { name: 'Review pause', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review native pause', exact: true });
  await expect(
    dialog.getByRole('button', { name: 'Pause native schedule', exact: true }),
  ).toBeDisabled();
  await dialog.getByText('Complete native job record', { exact: true }).click();
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
    await dialog.screenshot({ path: `artifacts/forge-native-control-${theme}.png` });
  }
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Pause native schedule', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const receipts = page.getByRole('region', { name: 'Native control receipts', exact: true });
  await expect(
    receipts.getByRole('heading', { name: /Native Hermes check · pause · applied/ }),
  ).toBeVisible();
  await page.request.post('/api/fixture/native-controls', { headers, data: { mode: 'lost' } });
  await row.getByRole('button', { name: 'Review resume', exact: true }).click();
  const resume = page.getByRole('dialog', { name: 'Review native resume', exact: true });
  await expect(resume.getByText(/Forge managed-work budgets and quiet mode/)).toBeVisible();
  await resume.getByRole('checkbox').check();
  await resume.getByRole('button', { name: 'Resume native schedule', exact: true }).click();
  await expect(resume).toHaveCount(0);
  await expect(
    receipts.getByRole('heading', { name: /Native Hermes check · resume · uncertain/ }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /^Schedules \d/ }).click();
  await expect(receipts.getByRole('heading', { name: /resume · uncertain/ })).toBeVisible();
  await receipts.getByText('Review uncertain outcome', { exact: true }).click();
  await receipts
    .getByLabel('What did you check in the native runtime?')
    .fill('Checked the owned native state and delivery history; no work was executed.');
  await receipts.getByRole('button', { name: 'Read state and record review', exact: true }).click();
  await expect(receipts.getByText(/Checked the owned native state/)).toBeVisible();
  await page.request.post('/api/fixture/native-controls', { headers, data: { mode: 'normal' } });
});
