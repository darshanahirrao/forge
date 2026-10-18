import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('an existing native chat links its account, keeps a setup draft and continues through reviewed history and exact approval on phone and desktop', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json(),
    fixture = await (await page.request.get('/api/fixture/memory')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const sourceResponse = await page.request.post('/api/native/sources', {
    headers,
    data: { kind: 'codex', label: 'Continuation browser source', home: fixture.nativeHome },
  });
  expect(sourceResponse.ok()).toBe(true);
  const source = await sourceResponse.json();
  expect(
    (
      await page.request.post(`/api/native/sources/${source.id}/refresh`, { headers, data: {} })
    ).ok(),
  ).toBe(true);
  await page.goto('/#activity');
  await page.getByRole('button', { name: /^Existing native fixture chat/ }).click();
  await page
    .getByRole('dialog', { name: 'Existing native fixture chat', exact: true })
    .getByRole('button', { name: 'Continue in Forge', exact: true })
    .click();
  let dialog = page.getByRole('dialog', { name: 'Continue native chat', exact: true });
  await dialog.getByLabel('Work title', { exact: true }).fill('Native browser continuation');
  await dialog
    .getByRole('textbox', { name: 'Next goal', exact: true })
    .fill('Retain this setup draft through native account linking.');
  await dialog.getByRole('button', { name: /Link (?:another|a) Codex account/ }).click();
  const account = page.getByRole('dialog', { name: 'Link account', exact: true });
  await expect(account.getByRole('combobox', { name: 'Harness', exact: true })).toHaveValue(
    'codex',
  );
  await expect(account.locator('input[name="nativeHome"]')).toHaveValue(fixture.nativeHome);
  await account
    .getByLabel('Account label', { exact: true })
    .fill('Native browser continuation account');
  await account.getByRole('button', { name: 'Save account slot', exact: true }).click();
  await expect(dialog.getByLabel('Work title', { exact: true })).toHaveValue(
    'Native browser continuation',
  );
  await expect(dialog.getByRole('textbox', { name: 'Next goal', exact: true })).toHaveValue(
    'Retain this setup draft through native account linking.',
  );
  await dialog.getByRole('button', { name: 'Review native history', exact: true }).click();
  await expect(dialog).toContainText('1 complete native turn');
  await expect(dialog.getByRole('button', { name: 'Link work', exact: true })).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(dialog.getByRole('button', { name: 'Link work', exact: true })).toBeInViewport();
    await dialog.screenshot({ path: `artifacts/forge-native-continuation-${theme}.png` });
  }
  await dialog.getByRole('checkbox', { name: /I reviewed the source/ }).check();
  await dialog.getByRole('button', { name: 'Link work', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Native browser continuation', exact: true });
  await expect(detail).toContainText('Native chat ready for a reviewed fork');
  await detail.getByRole('button', { name: 'Run with Codex', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Ready to use the native harness?', exact: true });
  await expect(dialog).toContainText('Continue the reviewed native chat');
  await dialog.getByRole('checkbox', { name: /I settled the source chat/ }).check();
  const context = dialog.getByRole('checkbox', { name: /I reviewed this context/ });
  if (await context.count()) await context.check();
  await dialog.getByRole('button', { name: 'Start native attempt', exact: true }).click();
  await detail.getByRole('button', { name: 'Review', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Review a native command', exact: true })
    .getByRole('button', { name: 'Allow once', exact: true })
    .click();
  await expect(detail).toContainText('Native source history retained');
  await expect
    .poll(async () => {
      const next = await (await page.request.get('/api/snapshot')).json();
      const work = next.work.find(
        (row: { title: string }) => row.title === 'Native browser continuation',
      );
      return work?.status;
    })
    .toBe('completed');
  const after = await (await page.request.get('/api/snapshot')).json(),
    work = after.work.find((row: { title: string }) => row.title === 'Native browser continuation');
  expect(work.nativeOrigin.state).toBe('bound');
  expect(work.nativeSessionId).not.toBe(work.nativeOrigin.threadId);
  expect(after.usage.find((row: { workId: string }) => row.workId === work.id).totalTokens).toBe(
    25,
  );
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/work/${work.id}`)).json()).work.activeRunId,
    )
    .toBe(null);
  const costs = await (await page.request.get(`/api/work/${work.id}/spending`)).json();
  for (const attempt of costs.attempts) {
    const reviewed = await page.request.post(`/api/spending/${attempt.runId}/review`, {
      headers,
      data: {
        expectedRevision: attempt.revision,
        usd: 0,
        note: 'Owned inert protocol fixture. No command or model ran; no provider charge.',
      },
    });
    expect(reviewed.ok(), await reviewed.text()).toBe(true);
  }
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click();
  expect(
    (await page.request.delete(`/api/native/sources/${source.id}`, { headers, data: {} })).ok(),
  ).toBe(true);
  await page.reload();
  await page.goto('/#work');
  await page
    .getByRole('button', { name: /Native browser continuation/ })
    .first()
    .click();
  await expect(detail).toContainText('Native source history retained');
});
