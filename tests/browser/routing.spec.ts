import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('an authorized account route selects a native binding through launch review, survives reload and remains keyboard usable on mobile', async ({
  page,
}) => {
  const s = await (await page.request.get('/api/snapshot')).json(),
    project = await (await page.request.get('/api/fixture/memory')).json();
  const headers = { 'x-forge-csrf': s.csrf };
  async function account(label: string) {
    const account = await (
      await page.request.post('/api/accounts', {
        headers,
        data: { label, harness: 'codex', billingMode: 'subscription' },
      })
    ).json();
    expect(
      (await page.request.post(`/api/accounts/${account.id}/probe`, { headers, data: {} })).ok(),
    ).toBeTruthy();
    return account;
  }
  const first = await account('Routing first slot'),
    second = await account('Routing preferred slot');
  const work = await (
    await page.request.post('/api/work', {
      headers,
      data: {
        title: 'Browser routed work',
        project: 'Fixture',
        goal: 'Keep one work record through the authorized route.',
        cwd: project.project,
        harness: 'codex',
        accountId: first.id,
      },
    })
  ).json();
  await page.goto('/#work');
  await page.getByRole('button', { name: work.title, exact: true }).click();
  let detail = page.getByRole('dialog', { name: work.title });
  await detail.getByRole('button', { name: 'Set account route', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Authorize account routing' });
  await dialog.getByLabel('Add native account').selectOption(second.id);
  await dialog
    .getByRole('button', { name: 'Move Routing preferred slot earlier', exact: true })
    .click();
  await expect(dialog.getByRole('checkbox', { name: /Allow accounts with API/ })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Allow unreported quota/ })).not.toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Authorize route', exact: true }).click();
  await expect(
    detail.getByText('Recommended: Routing preferred slot.', { exact: false }),
  ).toBeVisible();
  await detail.getByRole('button', { name: 'Run with Codex', exact: true }).click();
  const launch = page.getByRole('dialog', { name: 'Ready to use the native harness?' });
  await expect(
    launch.getByRole('button', { name: 'Start native attempt', exact: true }),
  ).toBeDisabled();
  await launch.getByRole('button', { name: 'Prepare recommended account' }).click();
  await expect(
    launch.locator('.binding-box').getByText('Routing preferred slot', { exact: true }),
  ).toBeVisible();
  await expect(
    launch.getByRole('button', { name: 'Start native attempt', exact: true }),
  ).toBeEnabled();
  await expect(
    launch.getByRole('button', { name: 'Start native attempt', exact: true }),
  ).toBeInViewport();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'artifacts/forge-routed-launch-light.png' });
  await launch.getByRole('button', { name: 'Keep as ready' }).click();
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await page.getByRole('button', { name: work.title, exact: true }).click();
  detail = page.getByRole('dialog', { name: work.title });
  const routing = detail.getByRole('region', { name: 'Account routing' });
  await expect(routing.getByText('2 authorized slots, in preference order.')).toBeVisible();
  await detail.getByRole('button', { name: 'Edit route', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await expect(
    dialog.getByRole('button', { name: 'Authorize route', exact: true }),
  ).toBeInViewport();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBeFalsy();
  await page.screenshot({ path: 'artifacts/forge-routing-mobile-dark.png' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const final = await (await page.request.get(`/api/work/${work.id}`)).json();
  expect(final.work.id).toBe(work.id);
  expect(final.work.goal).toBe(work.goal);
  expect(final.work.accountId).toBe(second.id);
  expect(final.runs).toHaveLength(0);
});
