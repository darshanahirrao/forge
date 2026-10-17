import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('native scheduler evidence remains explicit, ages independently of definitions and retains prior evidence when a check is unavailable', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  await page.goto('/#activity');
  await page.getByRole('button', { name: 'Discover profiles', exact: true }).click();
  const source = page
    .locator('article.native-source')
    .filter({ has: page.getByRole('heading', { name: 'Hermes profile schedules', exact: true }) });
  await expect(source.getByText('Scheduler health unknown', { exact: true })).toBeVisible();
  await source.getByRole('button', { name: 'Check native scheduler', exact: true }).click();
  await expect(
    source.getByText('Recent ticker loop; successful tick is stale', { exact: false }),
  ).toBeVisible();
  await source.getByText('Source and coverage', { exact: true }).click();
  await expect(source.getByText('Native loop age at check:', { exact: false })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBeFalsy();
    await source.screenshot({ path: `artifacts/forge-native-scheduler-${theme}.png` });
  }
  for (const [state, label] of [
    ['recent', 'Recent successful native tick observed'],
    ['unavailable', 'Latest scheduler check unavailable'],
    ['external', 'External scheduler configured; health unknown'],
  ]) {
    expect(
      (await page.request.post('/api/fixture/scheduler', { headers, data: { state } })).ok(),
    ).toBeTruthy();
    await source.getByRole('button', { name: 'Check native scheduler', exact: true }).click();
    await expect(source.getByText(label, { exact: false })).toBeVisible();
    if (state === 'unavailable') {
      const retained = (await (await page.request.get('/api/snapshot')).json()).nativeSources.find(
        (s: { kind: string }) => s.kind === 'hermes-schedules',
      );
      expect(retained.scheduler.provider).toBe('builtin');
      expect(retained.scheduler.successAgeSeconds).toBe(10);
      expect(retained.schedulerCheck.available).toBe(false);
    }
  }
  await page.reload();
  await expect(
    source.getByText('External scheduler configured; health unknown', { exact: false }),
  ).toBeVisible();
  expect(
    (
      await page.request.post('/api/fixture/scheduler', {
        headers,
        data: { state: 'success-stale' },
      })
    ).ok(),
  ).toBeTruthy();
});
