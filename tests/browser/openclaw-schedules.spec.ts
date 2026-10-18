import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('OpenClaw schedules start read-only and native administrator access requires a local reviewed choice in an accessible compact form', async ({
  page,
}) => {
  await page.goto('/#activity');
  await page.getByRole('button', { name: 'Add source', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Connect existing activity.', exact: true });
  await form.getByLabel('Source type').selectOption('openclaw-schedules');
  await form.getByLabel('Source label').fill('Owned OpenClaw browser source');
  const controls = form.getByRole('checkbox', {
    name: 'Allow reviewed native schedule changes',
    exact: true,
  });
  await expect(controls).not.toBeChecked();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const footer = await form.locator('.form-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
    expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await form.screenshot({ path: `artifacts/forge-openclaw-source-${theme}.png` });
  }
  await form.getByRole('button', { name: 'Save source reference', exact: true }).click();
  const source = page.locator('.native-source').filter({
    has: page.getByRole('heading', { name: 'Owned OpenClaw browser source', exact: true }),
  });
  await source
    .getByRole('button', { name: 'Read Owned OpenClaw browser source', exact: true })
    .click();
  await page.getByRole('button', { name: /^Schedules \d/ }).click();
  const row = page
    .locator('.native-schedule')
    .filter({ has: page.getByRole('heading', { name: 'Native OpenClaw check', exact: true }) });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Review resume', exact: true })).toHaveCount(0);
  await source.getByRole('button', { name: 'Scheduler access', exact: true }).click();
  const access = page.getByRole('dialog', { name: 'Scheduler access', exact: true });
  await access
    .getByRole('checkbox', { name: 'Allow reviewed native schedule changes', exact: true })
    .check();
  await access.getByRole('button', { name: 'Save scheduler access', exact: true }).click();
  await row.getByRole('button', { name: 'Review resume', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review native resume', exact: true });
  await expect(
    review.getByText(/exact native job revision and paired operator scope/),
  ).toBeVisible();
  await expect(review.getByText(/entire native job store and configuration/)).toHaveCount(0);
  await review.getByText('Complete native job record', { exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const footer = await review.locator('.form-footer').boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
  await review.screenshot({ path: 'artifacts/forge-openclaw-schedule-review-dark.png' });
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Resume native schedule', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Native control receipts', exact: true })
      .getByRole('heading', { name: /Native OpenClaw check · resume · applied/ }),
  ).toBeVisible();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const saved = snapshot.nativeSources.find(
    (item: { label: string }) => item.label === 'Owned OpenClaw browser source',
  );
  const removed = await page.request.delete(`/api/native/sources/${saved.id}`, {
    headers: { 'x-forge-csrf': snapshot.csrf },
    data: {},
  });
  expect(removed.ok()).toBe(true);
});

test('a private phone can review native schedule changes while administrator setup remains on the local host', async ({
  browser,
  request,
}) => {
  const snapshot = await (await request.get('/api/snapshot')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const created = await request.post('/api/native/sources', {
    headers,
    data: {
      kind: 'openclaw-schedules',
      label: 'Owned phone OpenClaw source',
      endpoint: 'http://127.0.0.1:18789',
      scheduleControls: true,
      nativeAdminReviewed: true,
    },
  });
  expect(created.ok()).toBe(true);
  const source = await created.json();
  expect(
    (await request.post(`/api/native/sources/${source.id}/refresh`, { headers, data: {} })).ok(),
  ).toBe(true);
  const phone = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await phone.newPage();
    await page.goto('https://127.0.0.1:4713/#activity');
    const card = page.locator('.native-source').filter({
      has: page.getByRole('heading', { name: 'Owned phone OpenClaw source', exact: true }),
    });
    await expect(
      card.getByRole('button', { name: 'Scheduler access', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: /^Schedules \d/ }).click();
    const row = page
      .locator('.native-schedule')
      .filter({ has: page.getByRole('heading', { name: 'Native OpenClaw check', exact: true }) });
    const action = (await row.getByRole('button', { name: 'Review pause', exact: true }).count())
      ? 'pause'
      : 'resume';
    await row.getByRole('button', { name: `Review ${action}`, exact: true }).click();
    const review = page.getByRole('dialog', { name: `Review native ${action}`, exact: true });
    await review.getByRole('checkbox').check();
    await review
      .getByRole('button', {
        name: `${action === 'pause' ? 'Pause' : 'Resume'} native schedule`,
        exact: true,
      })
      .click();
    await expect(
      page
        .getByRole('region', { name: 'Native control receipts', exact: true })
        .getByRole('heading', { name: `Native OpenClaw check · ${action} · applied`, exact: true }),
    ).toBeVisible();
    const current = await (await request.get('/api/snapshot')).json();
    const receipt = current.nativeControls.receipts.find(
      (item: { sourceId: string; action: string }) =>
        item.sourceId === source.id && item.action === action,
    );
    expect(receipt.actor.kind).not.toBe('local');
  } finally {
    await phone.close();
    expect(
      (await request.delete(`/api/native/sources/${source.id}`, { headers, data: {} })).ok(),
    ).toBe(true);
  }
});
