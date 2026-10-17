import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('spending reservations, native usage coverage and accepted work remain reviewable on desktop and mobile', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const project = await (await page.request.get('/api/fixture/memory')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const account = await (
    await page.request.post('/api/accounts', {
      headers,
      data: { label: 'Spending browser slot', harness: 'codex' },
    })
  ).json();
  const work = await (
    await page.request.post('/api/work', {
      headers,
      data: {
        title: 'Spending browser work',
        project: 'Fixture',
        goal: 'Review reported counters.',
        cwd: project.project,
        harness: 'codex',
        accountId: account.id,
      },
    })
  ).json();
  await page.goto('/#accounts');
  const panel = page.getByRole('region', { name: 'Spending and outcomes' });
  await panel.getByRole('button', { name: 'Set budgets' }).click();
  const budget = page.getByRole('dialog', { name: 'Set spending budgets' });
  await budget.getByLabel('Monthly budget, USD (optional)').fill('5');
  await budget.getByLabel('Budget per work, USD (optional)').fill('2');
  await budget.getByLabel('Reservation per attempt, USD (required with a budget)').fill('1');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'artifacts/forge-spending-budget-light.png' });
  await budget.getByRole('button', { name: 'Save budgets' }).click();
  await expect(budget).not.toBeVisible();
  const launch = await page.request.post(`/api/work/${work.id}/launch`, {
    headers,
    data: { expectedRevision: work.revision },
  });
  expect(launch.status()).toBe(202);
  await expect
    .poll(async () => (await (await page.request.get(`/api/work/${work.id}`)).json()).work.status)
    .toBe('waiting');
  let current = await (await page.request.get('/api/snapshot')).json();
  for (const approval of current.approvals.filter(
    (row: { workId: string; status: string }) => row.workId === work.id && row.status === 'pending',
  )) {
    expect(
      (
        await page.request.post(`/api/approvals/${approval.id}/decision`, {
          headers,
          data: { digest: approval.digest, decision: 'decline' },
        })
      ).ok(),
    ).toBeTruthy();
  }
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/work/${work.id}`)).json()).work.activeRunId,
    )
    .toBe(null);
  await page.reload();
  await panel.getByText(/Recent attempt receipts/).click();
  const row = panel.getByRole('row').filter({ hasText: 'Spending browser work' });
  await row.getByRole('button', { name: 'Review cost' }).click();
  const review = page.getByRole('dialog', { name: 'Review native spending' });
  await review.getByLabel('Verified amount, USD').fill('0');
  await review.getByLabel('Evidence and scope').fill('Synthetic local provider only. No charge.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBeFalsy();
  await page.screenshot({ path: 'artifacts/forge-spending-review-mobile-dark.png' });
  await review.getByRole('button', { name: 'Record cost review' }).click();
  await expect(review).not.toBeVisible();
  current = await (await page.request.get(`/api/work/${work.id}`)).json();
  expect(
    (
      await page.request.post(`/api/work/${work.id}/outcome`, {
        headers,
        data: {
          expectedRevision: current.work.revision,
          decision: 'needs-work',
          note: 'Command was declined. No acceptance claimed.',
        },
      })
    ).ok(),
  ).toBeTruthy();
  await row.getByRole('button', { name: 'Spending browser work' }).click();
  const detail = page.getByRole('dialog', { name: 'Spending browser work' });
  await expect(detail.getByText('You marked this work for another pass.')).toBeVisible();
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  // Keep the shared browser fixture's later tests independent of this opt-in policy.
  const spending = await (await page.request.get('/api/spending')).json();
  expect(
    (
      await page.request.patch('/api/spending/policy', {
        headers,
        data: {
          expectedRevision: spending.policy.revision,
          monthlyUsd: null,
          workUsd: null,
          attemptUsd: null,
        },
      })
    ).ok(),
  ).toBeTruthy();
});
