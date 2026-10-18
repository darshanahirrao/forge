import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function openDemo(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('forge.workspace', 'demo');
    localStorage.setItem('forge.theme', 'light');
  });
  await page.reload();
  await expect(page.locator('main h1')).toHaveText('Workspace');
}

test('display preferences and keyboard navigation persist without mutating work or intercepting reviews', async ({
  page,
}) => {
  await openDemo(page);
  const before = await (await page.request.get('/api/snapshot')).json();
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      mutations.push(request.method() + ' ' + new URL(request.url()).pathname);
  });
  const shell = page.locator('.app-shell');
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  expect((await page.locator('.sidebar').boundingBox())?.width).toBe(60);
  const resources = page
    .getByRole('navigation')
    .getByRole('button', { name: 'Resources', exact: true });
  await resources.focus();
  await expect(resources.locator('.nav-tooltip')).toBeVisible();
  await page.keyboard.press('Control+Backslash');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Alt+2');
  await expect(page.locator('main h1')).toHaveText('Work');
  await page.keyboard.press('/');
  const commands = page.getByRole('dialog', { name: 'Commands', exact: true });
  const query = commands.getByRole('combobox');
  await expect(query).toBeFocused();
  await page.keyboard.type('n? /');
  await expect(query).toHaveValue('n? /');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Control+k');
  await expect(commands).toHaveCount(0);
  await page.keyboard.press('n');
  const draft = page.getByRole('dialog', { name: 'New work', exact: true });
  await expect(draft.getByLabel('Work title')).toBeFocused();
  await page.keyboard.type('n? /');
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('Control+k');
  await expect(draft.getByLabel('Work title')).toHaveValue('n? /');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page).toHaveURL(/#work$/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await expect(
    page
      .getByRole('dialog', { name: 'Using Forge' })
      .getByRole('region', { name: 'Keyboard shortcuts' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+1');
  await expect(page.locator('main h1')).toHaveText('Workspace');
  const compactHeight = (await page.locator('.workspace-entry').first().boundingBox())!.height;
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'View options', exact: true });
  await options.getByRole('radio', { name: /Comfortable/ }).check();
  await options.getByRole('checkbox', { name: /Single-key shortcuts/ }).uncheck();
  await options.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(page.locator('main h1')).toHaveText('Workspace');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  expect((await page.locator('.workspace-entry').first().boundingBox())!.height).toBeGreaterThan(
    compactHeight + 10,
  );
  await page.keyboard.press('n');
  await page.keyboard.press('/');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await expect(commands).toBeVisible();
  await query.fill('> view options');
  await page.keyboard.press('Enter');
  await expect(options).toBeVisible();
  await options.getByRole('button', { name: 'Reset view' }).click();
  await expect(options.getByRole('radio', { name: /Compact/ })).toBeChecked();
  await expect(options.getByRole('checkbox', { name: /Collapse desktop sidebar/ })).toBeChecked();
  await expect(options.getByRole('checkbox', { name: /Single-key shortcuts/ })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  await page.getByLabel('Filter workspace work').focus();
  await page.keyboard.type('n? /');
  await page.keyboard.press('Alt+2');
  await expect(page.getByLabel('Filter workspace work')).toHaveValue('n? /');
  await expect(page).toHaveURL(/#overview$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await (await page.request.get('/api/snapshot')).json();
  for (const key of ['work', 'accounts', 'approvals', 'settings'])
    expect(after[key]).toEqual(before[key]);
  expect(mutations).toEqual([]);
});

test('the workbench and mobile navigation retain accessible controls across all views and both themes', async ({
  page,
}) => {
  test.setTimeout(120000);
  await openDemo(page);
  const views = [
    ['overview', 'Workspace'],
    ['work', 'Work'],
    ['approvals', 'Approvals'],
    ['activity', 'Activity'],
    ['resources', 'Resources'],
    ['memory', 'Memory'],
    ['accounts', 'Accounts'],
    ['connections', 'Connections'],
  ];
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Use dark theme' }).click();
    for (const mobile of [false, true]) {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      for (const [view, label] of views) {
        await page.goto('/#' + view);
        await expect(page.locator('main h1')).toHaveText(label);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const result = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        expect(
          result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
        ).toEqual([]);
        await page.screenshot({
          path: `artifacts/ui-v041/after-${view}-${theme}-${mobile ? 'phone' : 'desktop'}.png`,
          fullPage: true,
        });
      }
      await page.getByRole('button', { name: 'View options', exact: true }).click();
      const options = page.getByRole('dialog', { name: 'View options', exact: true });
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await options.screenshot({
        path: `artifacts/ui-v041/view-options-${theme}-${mobile ? 'phone' : 'desktop'}.png`,
      });
      await page.keyboard.press('Escape');
      if (mobile) {
        await page.getByRole('button', { name: 'Toggle navigation' }).click();
        const drawer = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
        const home = drawer.getByRole('link', { name: 'Forge workspace' });
        await expect(home).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(drawer.getByRole('button', { name: 'Help', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(home).toBeFocused();
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeFocused();
        await page.getByRole('button', { name: 'Toggle navigation' }).click();
        await drawer.getByRole('button', { name: 'Work', exact: true }).click();
        await expect(drawer).toHaveCount(0);
        await expect(page.locator('main h1')).toHaveText('Work');
      }
    }
    // Desktop theme controls are reachable after the final mobile navigation check.
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
});
