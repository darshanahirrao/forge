import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('native resource policy reviews exact scope on desktop and phone and reaches native launch context', async ({
  page,
}) => {
  const before = await (await page.request.get('/api/snapshot')).json();
  const headers = { 'x-forge-csrf': before.csrf };
  await page.goto('/#resources');
  const panel = page.getByRole('region', { name: 'Native process resource policy' });
  await expect(panel).toBeVisible();
  const reviewButton = panel.getByRole('button', { name: 'Review policy', exact: true });
  if (!before.nativeGovernance.supported) {
    await expect(reviewButton).toBeDisabled();
    return;
  }
  try {
    await reviewButton.click();
    const dialog = page.getByRole('dialog', { name: 'Native process policy', exact: true });
    await dialog.getByLabel('Favor foreground apps').check();
    await dialog.getByLabel('Original native process memory limit (MiB)').fill('512');
    await expect(dialog.getByRole('button', { name: 'Apply policy', exact: true })).toBeDisabled();
    await dialog.screenshot({ path: 'artifacts/forge-native-resource-policy-desktop-light.png' });
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      localStorage.setItem('forge.theme', 'dark');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await dialog.evaluate((element) => ({
      fits:
        element.querySelector('.dialog-body')!.scrollWidth <=
        element.querySelector('.dialog-body')!.clientWidth + 1,
      footer: element.querySelector('.form-footer')!.getBoundingClientRect().bottom,
      height: window.innerHeight,
    }));
    expect(layout.fits).toBeTruthy();
    expect(layout.footer).toBeLessThanOrEqual(layout.height);
    await dialog.screenshot({ path: 'artifacts/forge-native-resource-policy-mobile-dark.png' });
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await dialog
      .getByRole('checkbox', { name: 'I reviewed the scope and effect on future native launches.' })
      .check();
    await dialog.getByRole('button', { name: 'Apply policy', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      panel.getByText('Lower priority · 512 MiB per original native process', { exact: true }),
    ).toBeVisible();
    const paths = await (await page.request.get('/api/fixture/memory')).json();
    const accountResponse = await page.request.post('/api/accounts', {
      headers,
      data: { harness: 'codex', label: 'Resource preview account', nativeHome: paths.project },
    });
    expect(accountResponse.ok()).toBeTruthy();
    const account = await accountResponse.json();
    const workResponse = await page.request.post('/api/work', {
      headers,
      data: {
        title: 'Native resource launch preview',
        project: 'Owned policy browser fixture',
        goal: 'Review native resource policy without starting a turn.',
        harness: 'codex',
        accountId: account.id,
        cwd: paths.project,
      },
    });
    expect(workResponse.ok()).toBeTruthy();
    const work = await workResponse.json();
    const contextResponse = await page.request.post(`/api/work/${work.id}/context-review`, {
      headers,
      data: {},
    });
    expect(contextResponse.ok()).toBeTruthy();
    const context = await contextResponse.json();
    expect(context.nativeResources.rootMemoryMiB).toBe(512);
    expect(context.requiresReview).toBeTruthy();
    await page.goto('/#work');
    await page.getByText('Native resource launch preview', { exact: true }).click();
    await page.getByRole('button', { name: 'Run with Codex', exact: true }).click();
    const launch = page.getByRole('dialog', {
      name: 'Ready to use the native harness?',
      exact: true,
    });
    await expect(launch.getByLabel('Native launch resource policy')).toContainText(
      '512 MiB limit on the original native process',
    );
    await expect(
      launch.getByRole('checkbox', {
        name: 'I reviewed this context and native resource policy for the launch.',
      }),
    ).not.toBeChecked();
    await expect(launch.getByRole('button', { name: 'Start native attempt' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goto('/#resources');
    await reviewButton.click();
    await dialog.getByRole('button', { name: 'Use native defaults', exact: true }).click();
    await dialog
      .getByRole('checkbox', { name: 'I reviewed the scope and effect on future native launches.' })
      .check();
    await dialog.getByRole('button', { name: 'Apply policy', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      panel.getByText('Native scheduling and memory defaults', { exact: true }),
    ).toBeVisible();
  } finally {
    const current = await (await page.request.get('/api/snapshot')).json();
    if (
      current.nativeGovernance.policy.lowPriority ||
      current.nativeGovernance.policy.rootMemoryMiB !== null
    ) {
      const reset = await page.request.patch('/api/resources/policy', {
        headers,
        data: {
          expectedRevision: current.nativeGovernance.policy.revision,
          lowPriority: false,
          rootMemoryMiB: null,
          effectsReviewed: true,
        },
      });
      expect(reset.ok()).toBeTruthy();
    }
  }
});
