import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('background setup reviews the exact native installation and retains the minimal workspace after an owned simulated handoff', async ({
  page,
}) => {
  let simulated: Record<string, unknown> | null = null;
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: simulated
        ? {
            ...data,
            service: { ...data.service, mode: 'launchd' },
            availability: { ...data.availability, runtime: 'launchd', receipt: simulated },
          }
        : data,
    });
  });
  await page.goto('/#connections');
  const panel = page.getByRole('region', { name: 'Workspace availability', exact: true });
  await panel.getByRole('button', { name: 'Review background setup', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review background setup', exact: true });
  const activate = review.getByRole('button', { name: 'Activate background service', exact: true });
  await review.getByRole('checkbox').check();
  await activate.click();
  await expect(panel.getByRole('alert')).toContainText('not committed');
  await panel.getByRole('button', { name: 'Review background setup', exact: true }).click();
  await expect(activate).toBeDisabled();
  await expect(review).toContainText('Workspace directory');
  await expect(review).toContainText(
    'custom definition directory does not start automatically at login',
  );
  await expect(review).toContainText('Local port: 4711');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const footer = await review.locator('.form-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await review.screenshot({ path: `artifacts/forge-availability-${theme}.png` });
  }
  await page.route('**/api/availability/activate', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.reviewed).toBe(true);
    expect(body.planId).toMatch(/^[a-f0-9-]{36}$/);
    expect(body.digest).toMatch(/^[a-f0-9]{64}$/);
    simulated = {
      id: body.planId,
      digest: body.digest,
      installationId: body.planId,
      state: 'running',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      detail: 'Owned per-page simulation. No native service was started.',
    };
    await route.fulfill({ status: 202, json: simulated });
  });
  await review.getByRole('checkbox').check();
  await activate.click();
  await expect(review).toHaveCount(0);
  await expect(
    panel.getByRole('heading', { name: 'Forge is running in the background.', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(panel).toContainText('Last handoff: running.');
  await expect(panel).toContainText(
    'custom service definition does not start automatically at login',
  );
  const actualFixture = await (await page.request.get('/api/snapshot')).json();
  expect(actualFixture.service.mode).toBe('foreground');
  expect(actualFixture.availability.receipt.state).toBe('aborted');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
