import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('a native harness extension links through ordinary setup and keeps managed approvals, usage and recovery', async ({
  page,
}) => {
  const fixture = await (await page.request.get('/api/fixture/extensions')).json();
  await page.goto('/#connections');
  const region = page.getByRole('region', { name: 'Native harness extensions', exact: true });
  await expect(region).toContainText(fixture.harness.name);
  await region.getByRole('button', { name: 'Link an account', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Link account', exact: true });
  await expect(setup.getByRole('combobox', { name: 'Harness', exact: true })).toHaveValue(
    fixture.harness.id,
  );
  await setup.getByLabel('Account label', { exact: true }).fill('Native harness browser account');
  await setup.getByRole('textbox', { name: /^Native profile root/ }).fill(fixture.nativeHome);
  await expect(setup).toContainText('Linking starts no worker.');
  for (const narrow of [false, true]) {
    await page.evaluate(
      (theme) => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('forge.theme', theme);
      },
      narrow ? 'dark' : 'light',
    );
    await page.setViewportSize(narrow ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await setup.screenshot({
      path: `artifacts/forge-harness-extension-${narrow ? 'mobile-dark' : 'desktop-light'}.png`,
    });
  }
  await setup.getByRole('button', { name: 'Save account slot', exact: true }).click();
  await expect(setup).not.toBeVisible();
  const snapshot = await (await page.request.get('/api/snapshot')).json(),
    headers = { 'x-forge-csrf': snapshot.csrf };
  const account = snapshot.accounts.find(
    (a: { label: string }) => a.label === 'Native harness browser account',
  );
  expect(account.nativeExecutor.digest).toBe(fixture.harness.digest);
  expect(account.nativeExecutorReady).toBeTruthy();
  const created = await page.request.post('/api/work', {
    headers,
    data: {
      title: 'Native harness extension work',
      project: 'Extension browser fixture',
      goal: 'Keep the standard native execution contract.',
      cwd: fixture.project,
      harness: account.harness,
      accountId: account.id,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const work = await created.json();
  await page.goto('/#work');
  await page.getByRole('button', { name: work.title, exact: true }).click();
  await page.getByRole('button', { name: 'Run with ' + fixture.harness.name, exact: true }).click();
  const launch = page.getByRole('dialog', {
    name: 'Ready to use the native harness?',
    exact: true,
  });
  await expect(launch).toContainText(fixture.harness.name);
  await launch
    .getByRole('checkbox', { name: /Allow metered API, external-provider billing/ })
    .check();
  await launch.getByRole('button', { name: 'Start native attempt', exact: true }).click();
  await expect
    .poll(async () => {
      const current = await (await page.request.get('/api/snapshot')).json();
      return current.approvals.some(
        (a: { workId: string; status: string }) => a.workId === work.id && a.status === 'pending',
      );
    })
    .toBeTruthy();
  const pending = await (await page.request.get('/api/snapshot')).json();
  const approval = pending.approvals.find(
    (a: { workId: string; status: string }) => a.workId === work.id && a.status === 'pending',
  );
  const decided = await page.request.post(`/api/approvals/${approval.id}/decision`, {
    headers,
    data: { digest: approval.digest, decision: 'accept' },
  });
  expect(decided.ok(), await decided.text()).toBeTruthy();
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/work/${work.id}`)).json()).work.activeRunId,
    )
    .toBe(null);
  const after = await (await page.request.get('/api/snapshot')).json();
  expect(after.work.find((w: { id: string }) => w.id === work.id).status).toBe('completed');
  expect(after.usage.find((u: { workId: string }) => u.workId === work.id).harness).toBe(
    account.harness,
  );
  const costs = await (await page.request.get(`/api/work/${work.id}/spending`)).json();
  for (const attempt of costs.attempts) {
    const reviewed = await page.request.post(`/api/spending/${attempt.runId}/review`, {
      headers,
      data: {
        expectedRevision: attempt.revision,
        usd: 0,
        note: 'Owned inert extension protocol fixture. No native command or model ran; no provider charge.',
      },
    });
    expect(reviewed.ok(), await reviewed.text()).toBeTruthy();
  }
  await page.reload();
  await page.goto('/#work');
  await page.getByRole('button', { name: work.title, exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Continue with ' + fixture.harness.name, exact: true }),
  ).toBeVisible();
});
