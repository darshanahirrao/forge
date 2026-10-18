import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.afterEach(async ({ page }) => {
  // Finish interception callbacks before Playwright disposes their request context.
  await page.unrouteAll({ behavior: 'wait' });
});

test('T3 Code signs in natively for read-only activity, retains revoked observations and disconnects in both themes and mobile', async ({
  page,
}) => {
  await page.goto('/');
  const fixture = await (await page.request.get('/api/test/t3')).json();
  await page.getByRole('navigation').getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Add source', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect existing activity.' });
  await dialog.getByLabel('Source type').selectOption('t3-code');
  await dialog.getByLabel('Source label').fill('T3 browser workspace');
  await dialog.getByLabel('T3 Code address').fill(fixture.endpoint + '/mcp');
  await expect(dialog.getByLabel('Token environment variable')).toHaveCount(0);
  await expect(dialog.getByText(/native grant covers all projects/)).toBeVisible();
  await dialog.screenshot({ path: 'artifacts/forge-t3-connect-light.png' });
  expect(
    (
      await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    ).violations.map((v) => v.id),
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Sign in to T3 Code' }).click();
  await expect(page.getByRole('heading', { name: 'T3 Code test sign-in' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow read-only activity' }).click();
  const source = page
    .locator('.native-source')
    .filter({ has: page.getByRole('heading', { name: 'T3 browser workspace', exact: true }) });
  await expect(source).toBeVisible();
  await expect(page).not.toHaveURL(/state=|code=|t3=/);
  await source.getByRole('button', { name: 'Read T3 browser workspace', exact: true }).click();
  await expect(page.getByText('Native T3 work', { exact: true })).toBeVisible();
  await page.getByText('Native T3 work', { exact: true }).click();
  const nativeDetails = page.getByRole('dialog', { name: 'Native T3 work', exact: true });
  await expect(nativeDetails.getByText('Native provider instance', { exact: true })).toBeVisible();
  await expect(nativeDetails.getByText('codex-work', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nativeDetails).toHaveCount(0);
  await source.getByText('Source and coverage', { exact: true }).click();
  await expect(source.getByRole('link', { name: 'Open T3 Code' })).toHaveAttribute(
    'href',
    fixture.endpoint,
  );
  await expect(
    source.getByText(/transcripts, schedules and approval controls are not imported/),
  ).toBeVisible();
  const message = page.getByRole('button', { name: 'Dismiss message', exact: true });
  if (await message.isVisible()) await message.click();
  for (const dark of [false, true]) {
    if (dark) await page.getByRole('button', { name: 'Use dark theme' }).click();
    for (const mobile of [false, true]) {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
        ).violations.map((v) => v.id),
      ).toEqual([]);
      await page.screenshot({
        path: `artifacts/forge-t3-activity-${mobile ? 'mobile' : 'desktop'}-${dark ? 'dark' : 'light'}.png`,
        fullPage: true,
      });
    }
  }
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const revoked = await page.request.post('/api/test/t3/revoke', {
    data: {},
    headers: { 'x-forge-csrf': snapshot.csrf },
  });
  expect(revoked.ok()).toBe(true);
  await source.getByRole('button', { name: 'Read T3 browser workspace', exact: true }).click();
  await expect(source.getByText('Refresh failed', { exact: true })).toBeVisible();
  await expect(page.getByText('Native T3 work', { exact: true })).toBeVisible();
  await source.getByRole('button', { name: 'Reconnect' }).click();
  await expect(dialog.getByLabel('T3 Code address')).toHaveValue(fixture.endpoint);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Forget T3 browser workspace', exact: true }).click();
  await expect(source).toHaveCount(0);
  await expect(page.getByText('Native T3 work', { exact: true })).toHaveCount(0);
});

test('memory protection persists and explains a native pressure hold without sending task input', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Resources', exact: true }).click();
  const protection = page.getByRole('switch', { name: 'Memory pressure protection', exact: true });
  await expect(protection).toHaveAttribute('aria-checked', 'true');
  await protection.click();
  await expect(protection).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await page.getByRole('button', { name: 'Resources', exact: true }).click();
  await expect(protection).toHaveAttribute('aria-checked', 'false');
  await protection.click();
  await expect(protection).toHaveAttribute('aria-checked', 'true');
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        machine: {
          ...data.machine,
          memoryPressure: {
            state: 'critical',
            source: 'macos-sysctl',
            nativeValue: 4,
            checkedAt: new Date().toISOString(),
          },
        },
      },
    });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Resources', exact: true }).click();
  const region = page.getByRole('region', { name: 'Memory pressure protection', exact: true });
  await expect(region.getByText(/macOS reports critical memory pressure/)).toBeVisible();
  await region.screenshot({ path: 'artifacts/forge-headroom-light.png' });
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await region.screenshot({ path: 'artifacts/forge-headroom-mobile-dark.png' });
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const post = async (url: string, data: unknown) => {
    const response = await page.request.post('/api' + url, {
      data,
      headers: { 'x-forge-csrf': snapshot.csrf },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const account = await post('/accounts', { label: 'Headroom browser slot', harness: 'codex' });
  const work = await post('/work', {
    title: 'Headroom browser work',
    project: 'Headroom fixture',
    goal: 'Review resource admission without starting native work.',
    harness: 'codex',
    accountId: account.id,
    cwd: process.cwd(),
  });
  let launches = 0;
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/work/${work.id}/launch`)) launches++;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: work.title, exact: true }).click();
  await page.getByRole('button', { name: 'Run with Codex', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ready to use the native harness?' });
  await expect(dialog.getByText('New native work is waiting for memory headroom.')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Start native attempt', exact: true }),
  ).toBeDisabled();
  expect(launches).toBe(0);
  await dialog.getByRole('button', { name: 'Review Resources', exact: true }).click();
  await expect(region).toBeVisible();
});

test('background availability explains setup and shows native service mode on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const availability = page.getByRole('region', { name: 'Workspace availability' });
  await expect(
    availability.getByRole('heading', { name: 'Keep your workspace available.' }),
  ).toBeVisible();
  await availability.getByText('Native service commands', { exact: true }).click();
  await expect(availability.getByText(/node bin\/forge.mjs service install/)).toBeVisible();
  for (const narrow of [false, true]) {
    if (narrow) {
      await page.getByRole('button', { name: 'Use dark theme' }).click();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => v.id),
      JSON.stringify(
        result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      ),
    ).toEqual([]);
    await page.screenshot({
      path: `artifacts/forge-service-${narrow ? 'mobile-dark' : 'light'}.png`,
      fullPage: true,
    });
  }
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, service: { mode: 'launchd', scope: 'user-login' } },
    });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Connections', exact: true })
    .click();
  await expect(
    availability.getByRole('heading', { name: 'Forge is running in the background.' }),
  ).toBeVisible();
  await expect(availability.getByText(/Mac is awake/)).toBeVisible();
  await expect(
    availability.getByText('Set up the macOS user service', { exact: true }),
  ).toHaveCount(0);
});

test('create an account slot, save work and a checkpoint, and retain them after reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Workspace', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account label').fill('Browser fixture slot');
  await page.getByRole('button', { name: 'Save account slot' }).click();
  await expect(page.getByRole('heading', { name: 'Browser fixture slot' })).toBeVisible();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title').fill('A durable browser fixture');
  await page
    .getByLabel('Goal', { exact: true })
    .fill('Retain the same recorded context after reload.');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Browser fixture slot' });
  await page.getByRole('dialog').getByRole('button', { name: 'Create work', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'A durable browser fixture' });
  await expect(detail).toBeVisible();
  await detail
    .getByLabel('Leave a checkpoint')
    .fill('Verified fixture checkpoint with no native execution.');
  await detail.getByRole('button', { name: 'Save checkpoint' }).click();
  await expect(
    detail.getByText('Verified fixture checkpoint with no native execution.'),
  ).toBeVisible();
  const exported = page.waitForEvent('download');
  await detail.getByRole('button', { name: 'Export context' }).click();
  expect((await exported).suggestedFilename()).toMatch(/^forge-work-/);
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'A durable browser fixture', exact: true }).click();
  await expect(
    page.getByText('Verified fixture checkpoint with no native execution.'),
  ).toBeVisible();
});

test('fictional approvals resolve in the demo and cannot touch native work', async ({ page }) => {
  const before = (await (await page.request.get('/api/snapshot')).json()).approvals;
  await page.goto('/');
  await page.getByTitle('Explore the isolated demo workspace').click();
  await expect(
    page.getByText('Fictional work, accounts, and approvals. Machine telemetry is live.'),
  ).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Approvals/ })
    .click();
  await page.getByRole('button', { name: 'Review request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review the accessibility check' });
  await expect(dialog.getByText('npm run test:a11y')).toBeVisible();
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('heading', { name: 'Your attention is clear.' })).toBeVisible();
  const local = await page.request.get('/api/snapshot');
  expect((await local.json()).approvals).toEqual(before);
});

test('quiet mode persists, search is keyboard accessible, and both themes meet accessibility gates', async ({
  page,
}) => {
  await page.goto('/');
  const quiet = page.getByRole('switch', { name: 'Quiet mode' });
  await quiet.click();
  await expect(quiet).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(quiet).toHaveAttribute('aria-checked', 'true');
  await quiet.click();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Commands' });
  await expect(search).toBeVisible();
  await search.getByLabel('Search commands and work').fill('Accounts');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  for (const dark of [false, true]) {
    if (dark) await page.getByRole('button', { name: 'Use dark theme' }).click();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }
});

test('all views remain usable on a narrow screen without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (const label of [
    'Workspace',
    'Work',
    'Activity',
    'Memory',
    'Approvals',
    'Accounts',
    'Resources',
    'Connections',
  ]) {
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('main h1')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByTitle('Explore the isolated demo workspace').click();
  await expect(page.getByRole('heading', { name: 'Recent work' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
});

test('Claude API slots expose the credential reference and native launch choice without starting execution', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account label').fill('Claude browser API fixture');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('claude');
  await page.getByLabel('Billing preference').selectOption('api');
  await page.getByLabel('API credential environment variable').fill('FORGE_BROWSER_CLAUDE_KEY');
  await page.getByRole('button', { name: 'Save account slot' }).click();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title').fill('Claude native launch review');
  await page
    .getByLabel('Goal', { exact: true })
    .fill('Review the supported native route without launching.');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('claude');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Claude browser API fixture' });
  await page.getByLabel('Project directory').fill(process.cwd());
  await page.getByRole('dialog').getByRole('button', { name: 'Create work', exact: true }).click();
  await page.getByRole('button', { name: 'Run with Claude', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ready to use the native harness?' });
  const launch = dialog.getByRole('button', { name: 'Start native attempt' });
  await expect(launch).toBeDisabled();
  await expect(dialog.getByText(/This route uses API authentication/)).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Allow metered/ }).check();
  await expect(launch).toBeEnabled();
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
  await dialog.getByRole('button', { name: 'Keep as ready' }).click();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(
    snapshot.work.find((work: { title: string }) => work.title === 'Claude native launch review')
      .status,
  ).toBe('ready');
});

test('a native approval and verified handoff retain the same work and expose the new binding', async ({
  page,
}) => {
  await page.goto('/');
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const post = async (path: string, data: unknown) => {
    const result = await page.request.post(`/api${path}`, {
      data,
      headers: { 'x-forge-csrf': snapshot.csrf, 'x-forge-workspace': 'local' },
    });
    expect(result.ok(), await result.text()).toBe(true);
    return result.json();
  };
  const source = await post('/accounts', { label: 'Handoff native source', harness: 'codex' });
  const target = await post('/accounts', {
    label: 'Handoff API target',
    harness: 'claude',
    billingMode: 'api',
    credentialEnv: 'FORGE_HANDOFF_BROWSER_KEY',
  });
  const work = await post('/work', {
    title: 'One work across native harnesses',
    project: 'Browser fixture',
    cwd: process.cwd(),
    goal: 'Keep this goal and its verified files with the same work.',
    harness: 'codex',
    accountId: source.id,
  });
  await post(`/work/${work.id}/launch`, { expectedRevision: work.revision });
  await page.reload();
  await page.getByRole('button', { name: 'Resources', exact: true }).click();
  const ownership = page.getByRole('region', { name: 'Native worker ownership' });
  await expect(ownership.getByText(work.title, { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(ownership.getByText(/PID \d+/)).toBeVisible();
  await expect(ownership.getByText(/\d+ observed process/)).toBeVisible({ timeout: 12000 });
  await page.screenshot({ path: 'artifacts/forge-owned-resources-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const resourcesAxe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(resourcesAxe.violations.map((v) => v.id)).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/forge-owned-resources-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await ownership.getByRole('button', { name: `Review native work: ${work.title}` }).click();
  const detail = page.getByRole('dialog', { name: work.title });
  await detail.getByRole('button', { name: 'Review', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Review a native command' })
    .getByRole('button', { name: 'Allow once' })
    .click();
  await detail.getByRole('button', { name: 'Change harness or account' }).click();
  const handoff = page.getByRole('dialog', { name: 'Keep the work. Change the harness.' });
  await handoff.getByLabel('Continue with').selectOption(target.id);
  await handoff.getByLabel('Files to verify').fill('package.json');
  await handoff.getByRole('button', { name: 'Prepare checkpoint' }).click();
  await expect(handoff.getByText('1 file state verified.')).toBeVisible();
  const exported = page.waitForEvent('download');
  await handoff.getByRole('button', { name: 'Download this work checkpoint' }).click();
  expect((await exported).suggestedFilename()).toMatch(/^forge-checkpoint-/);
  await handoff.getByRole('checkbox', { name: /I reviewed native activity/ }).check();
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: 'artifacts/forge-handoff-light.png' });
  await handoff.getByRole('button', { name: 'Switch at this checkpoint' }).click();
  await expect(handoff).not.toBeVisible();
  await expect(detail.getByText('Handoff API target', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Run with Claude', exact: true })).toBeVisible();
  const after = await (await page.request.get('/api/snapshot')).json();
  const retained = after.work.find((entry: { id: string }) => entry.id === work.id);
  expect(retained.accountId).toBe(target.id);
  expect(retained.nativeSessionId).toBe(null);
  expect(after.usage.find((entry: { workId: string }) => entry.workId === work.id).accountId).toBe(
    source.id,
  );
});

test('native activity discovers profiles, preserves observations after reload and shows native schedules in both themes and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Discover profiles' }).click();
  const sources = page.locator('.native-source');
  await expect(sources).toHaveCount(3);
  for (const label of [
    'Codex native chats',
    'Codex desktop schedules',
    'Hermes profile schedules',
  ]) {
    await page.getByRole('button', { name: `Read ${label}`, exact: true }).click();
    await expect(
      sources
        .filter({ has: page.getByRole('heading', { name: label, exact: true }) })
        .getByText('Observed', { exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByText('Existing native fixture chat', { exact: true })).toBeVisible();
  await expect(
    page.getByText('More available in the native client', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Existing native fixture chat/ }).click();
  const detail = page.getByRole('dialog', { name: 'Existing native fixture chat' });
  await expect(detail.getByText('fixture-observed-thread', { exact: true })).toBeVisible();
  await expect(detail.getByText('Stored session; live state unknown')).toBeVisible();
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await expect(page.locator('main h1')).toHaveText('Activity');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Workspace', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Existing native fixture chat', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Existing native fixture chat', exact: true }).click();
  await expect(detail.getByText('fixture-observed-thread', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Commands', exact: true });
  await palette.getByLabel('Search commands and work').fill('Existing native fixture chat');
  await page.keyboard.press('Enter');
  await expect(detail.getByText('fixture-observed-thread', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: '2 schedules', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Schedules / })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Native morning review' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Native Hermes check', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('excluded native instructions')).not.toBeVisible();
  await page.getByLabel('Search native activity').fill('Hermes check');
  await expect(page.getByRole('heading', { name: 'Native morning review' })).not.toBeVisible();
  await page.getByLabel('Search native activity').clear();
  for (const dark of [false, true]) {
    if (dark) await page.getByRole('button', { name: 'Use dark theme' }).click();
    expect(
      (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      ).violations.map((v) => v.id),
    ).toEqual([]);
    await page.screenshot({
      path: `artifacts/forge-activity-${dark ? 'dark' : 'light'}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/forge-activity-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Add source', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Connect existing activity.' });
  await add.getByLabel('Source type').selectOption('openclaw');
  await expect(add.getByLabel('Local API address')).toHaveValue('http://127.0.0.1:18789');
  await add.getByLabel('Source label').fill('Gateway browser fixture');
  expect(
    (
      await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    ).violations.map((v) => v.id),
  ).toEqual([]);
  await add.getByRole('button', { name: 'Save source reference' }).click();
  await expect(
    page.getByRole('heading', { name: 'Gateway browser fixture', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Forget Gateway browser fixture', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Gateway browser fixture', exact: true }),
  ).not.toBeVisible();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(snapshot.nativeSchedules).toHaveLength(2);
  expect(JSON.stringify(snapshot.nativeSchedules)).not.toContain('excluded native instructions');
});

test('native memory is selected by section, pinned to a persistent profile and reviewed before launch', async ({
  page,
}) => {
  await page.goto('/');
  const fixture = await (await page.request.get('/api/fixture/memory')).json();
  const before = await (await page.request.get('/api/snapshot')).json();
  const accountResponse = await page.request.post('/api/accounts', {
    data: { label: 'Memory browser slot', harness: 'codex' },
    headers: { 'x-forge-csrf': before.csrf },
  });
  expect(accountResponse.ok()).toBe(true);
  await page.getByRole('navigation').getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('button', { name: 'New profile', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'A profile that stays with you.' });
  await create.getByLabel('New profile name').fill('Portable browser profile');
  await create.getByRole('button', { name: 'Create profile' }).click();
  await expect(
    page.getByRole('heading', { name: 'Portable browser profile', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add memory reference', exact: true }).click();
  const source = page.getByRole('dialog', { name: 'Choose native memory.' });
  await source.getByLabel('Memory label').fill('Native project facts');
  await source.getByLabel('Native owner').selectOption('hermes');
  await source.getByLabel('Markdown file').fill(fixture.path);
  await source.getByRole('button', { name: 'Inspect native file' }).click();
  await source.getByLabel('Memory section').selectOption(JSON.stringify(['Public']));
  await expect(source.getByLabel('Selected memory text')).toContainText(
    'Browser shared memory marker.',
  );
  await expect(source.getByLabel('Selected memory text')).not.toContainText(
    'PRIVATE-BROWSER-EXCLUDED',
  );
  await source.getByLabel('Memory project directory').fill(fixture.project);
  await source.getByRole('button', { name: 'Save memory reference' }).click();
  await page.getByRole('checkbox', { name: /^Native project facts/ }).check();
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect
    .poll(async () => {
      const snapshot = await (await page.request.get('/api/snapshot')).json();
      return snapshot.profiles.find(
        (profile: { name: string }) => profile.name === 'Portable browser profile',
      ).memorySourceIds.length;
    })
    .toBe(1);
  await page.getByRole('heading', { name: 'Memory', level: 1 }).click();
  for (const dark of [false, true]) {
    if (dark) await page.getByRole('button', { name: 'Use dark theme' }).click();
    expect(
      (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      ).violations.map((v) => v.id),
    ).toEqual([]);
    await page.screenshot({
      path: `artifacts/forge-memory-${dark ? 'dark' : 'light'}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title').fill('Memory follows this work');
  await page
    .getByLabel('Goal', { exact: true })
    .fill('Review selected native memory before running.');
  await page.getByText('Additional context and options', { exact: true }).click();
  await page.getByLabel('Persistent profile').selectOption({ label: 'Portable browser profile' });
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Memory browser slot' });
  await page.getByLabel('Project directory').fill(fixture.project);
  await page.getByRole('dialog').getByRole('button', { name: 'Create work', exact: true }).click();
  await page.getByRole('button', { name: 'Run with Codex', exact: true }).click();
  const launch = page.getByRole('dialog', { name: 'Ready to use the native harness?' });
  await expect(
    launch.getByRole('heading', { name: 'Profile: Portable browser profile' }),
  ).toBeVisible();
  await expect(launch.getByRole('button', { name: 'Start native attempt' })).toBeDisabled();
  await launch.getByText('Native project facts', { exact: true }).click();
  await expect(launch.getByText('Browser shared memory marker.', { exact: false })).toBeVisible();
  await expect(launch.getByText('PRIVATE-BROWSER-EXCLUDED', { exact: false })).not.toBeVisible();
  await launch
    .getByRole('checkbox', { name: /I reviewed this profile and selected memory/ })
    .check();
  await expect(launch.getByRole('button', { name: 'Start native attempt' })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (
      await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    ).violations.map((v) => v.id),
  ).toEqual([]);
  await page.screenshot({ path: 'artifacts/forge-memory-launch-mobile.png', fullPage: true });
  await launch.getByRole('button', { name: 'Keep as ready' }).click();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(
    snapshot.work.find((work: { title: string }) => work.title === 'Memory follows this work')
      .status,
  ).toBe('ready');
});

test('OpenCode profile slots and launch review explain native authority on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account label').fill('OpenCode browser fixture');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('opencode');
  await expect(page.getByLabel('Native profile root')).toHaveAttribute('required', '');
  await page.getByLabel('Native profile root').fill(process.cwd());
  await page
    .getByLabel('Native credential environment variable')
    .fill('FORGE_BROWSER_OPENCODE_KEY');
  await page.getByRole('button', { name: 'Save account slot' }).click();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title').fill('OpenCode native review');
  await page
    .getByLabel('Goal', { exact: true })
    .fill('Review native profile binding before dispatch.');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('opencode');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'OpenCode browser fixture' });
  await page.getByLabel('Project directory').fill(process.cwd());
  await page.getByRole('dialog').getByRole('button', { name: 'Create work', exact: true }).click();
  await page.getByRole('button', { name: 'Run with OpenCode', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ready to use the native harness?' });
  const launch = dialog.getByRole('button', { name: 'Start native attempt' });
  await expect(launch).toBeDisabled();
  await expect(dialog.getByText(/Provider identity and quotas remain unknown/)).toBeVisible();
  await expect(dialog.getByText(/OpenCode v2 owns tools and native permissions/)).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Allow metered/ }).check();
  await expect(launch).toBeEnabled();
  await page.screenshot({ path: 'artifacts/forge-opencode-launch-light.png', fullPage: true });
  for (const dark of [false, true]) {
    if (dark) {
      await dialog.getByRole('button', { name: 'Keep as ready' }).click();
      await page
        .getByRole('dialog', { name: 'OpenCode native review', exact: true })
        .getByRole('button', { name: 'Close dialog' })
        .click();
      await page.getByRole('button', { name: 'Use dark theme' }).click();
      await page.getByRole('button', { name: 'OpenCode native review', exact: true }).click();
      await page.getByRole('button', { name: 'Run with OpenCode', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }
  await page.screenshot({
    path: 'artifacts/forge-opencode-launch-mobile-dark.png',
    fullPage: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep as ready' }).click();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(
    snapshot.work.find((work: { title: string }) => work.title === 'OpenCode native review').status,
  ).toBe('ready');
});

test('Hermes profile slots and launch review explain native authority on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account label').fill('Hermes browser fixture');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('hermes');
  await expect(page.getByLabel('Native Hermes home')).toHaveAttribute('required', '');
  await page.getByLabel('Native Hermes home').fill(process.cwd());
  await page.getByLabel('Native credential environment variable').fill('FORGE_BROWSER_HERMES_KEY');
  await page.getByRole('button', { name: 'Save account slot' }).click();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title').fill('Hermes native review');
  await page
    .getByLabel('Goal', { exact: true })
    .fill('Review native profile binding before dispatch.');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('hermes');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Hermes browser fixture' });
  await page.getByLabel('Project directory').fill(process.cwd());
  await page.getByRole('dialog').getByRole('button', { name: 'Create work', exact: true }).click();
  await page.getByRole('button', { name: 'Run with Hermes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ready to use the native harness?' });
  const launch = dialog.getByRole('button', { name: 'Start native attempt' });
  await expect(launch).toBeDisabled();
  await expect(dialog.getByText(/Provider identity and quotas remain unknown/)).toBeVisible();
  await expect(dialog.getByText(/Hermes owns its tools, skills, memory/)).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Allow metered/ }).check();
  await expect(launch).toBeEnabled();
  await page.screenshot({ path: 'artifacts/forge-hermes-launch-light.png', fullPage: true });
  for (const dark of [false, true]) {
    if (dark) {
      await dialog.getByRole('button', { name: 'Keep as ready' }).click();
      await page
        .getByRole('dialog', { name: 'Hermes native review', exact: true })
        .getByRole('button', { name: 'Close dialog' })
        .click();
      await page.getByRole('button', { name: 'Use dark theme' }).click();
      await page.getByRole('button', { name: 'Hermes native review', exact: true }).click();
      await page.getByRole('button', { name: 'Run with Hermes', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }
  await page.screenshot({
    path: 'artifacts/forge-hermes-launch-mobile-dark.png',
    fullPage: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep as ready' }).click();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(
    snapshot.work.find((work: { title: string }) => work.title === 'Hermes native review').status,
  ).toBe('ready');
});

test('OpenClaw profile slots and launch review explain native authority on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account label').fill('OpenClaw browser fixture');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('openclaw');
  await expect(page.getByLabel('Native OpenClaw execution profile')).toHaveAttribute(
    'required',
    '',
  );
  await page.getByLabel('Native OpenClaw execution profile').fill(process.cwd());
  await page.getByLabel('Native credential environment variable').fill('STUDIO_OPENCLAW_KEY');
  await page
    .getByRole('dialog', { name: 'Link account', exact: true })
    .getByText('Reviewed native project', { exact: true })
    .click();
  await page.getByLabel('Native project directory').fill(process.cwd());
  await page.getByRole('button', { name: 'Save account slot' }).click();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title').fill('OpenClaw native review');
  await page
    .getByLabel('Goal', { exact: true })
    .fill('Review native profile binding before dispatch.');
  await page.getByRole('combobox', { name: /^Harness/ }).selectOption('openclaw');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'OpenClaw browser fixture' });
  await page.getByLabel('Project directory').fill(process.cwd());
  await page.getByRole('dialog').getByRole('button', { name: 'Create work', exact: true }).click();
  await page.getByRole('button', { name: 'Run with OpenClaw', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ready to use the native harness?' });
  const launch = dialog.getByRole('button', { name: 'Start native attempt' });
  await expect(launch).toBeDisabled();
  await expect(dialog.getByText(/Provider identity and quotas remain unknown/)).toBeVisible();
  await expect(
    dialog.getByText(/This dedicated OpenClaw Gateway uses native administrator API scope/),
  ).toBeVisible();
  await expect(
    dialog.getByText(/OpenClaw owns its native tools, memory and model routing/),
  ).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Allow metered/ }).check();
  await expect(launch).toBeEnabled();
  await page.screenshot({ path: 'artifacts/forge-openclaw-launch-light.png', fullPage: true });
  for (const dark of [false, true]) {
    if (dark) {
      await dialog.getByRole('button', { name: 'Keep as ready' }).click();
      await page
        .getByRole('dialog', { name: 'OpenClaw native review', exact: true })
        .getByRole('button', { name: 'Close dialog' })
        .click();
      await page.getByRole('button', { name: 'Use dark theme' }).click();
      await page.getByRole('button', { name: 'OpenClaw native review', exact: true }).click();
      await page.getByRole('button', { name: 'Run with OpenClaw', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }
  await page.screenshot({
    path: 'artifacts/forge-openclaw-launch-mobile-dark.png',
    fullPage: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep as ready' }).click();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(
    snapshot.accounts.find(
      (account: { label: string }) => account.label === 'OpenClaw browser fixture',
    ).openClawProjectRoot,
  ).toBe(process.cwd());
  expect(
    snapshot.work.find((work: { title: string }) => work.title === 'OpenClaw native review').status,
  ).toBe('ready');
});

test('private HTTPS mobile approval uses the same native request and records its authenticated reviewer', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api${path}`, {
      data,
      headers: { 'x-forge-csrf': snapshot.csrf, 'x-forge-workspace': 'local' },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const account = await post('/accounts', { label: 'Phone native source', harness: 'codex' });
  const work = await post('/work', {
    title: 'Review from a private phone',
    project: 'Browser fixture',
    cwd: process.cwd(),
    goal: 'Answer the same native request from a private HTTPS surface.',
    harness: 'codex',
    accountId: account.id,
  });
  await post(`/work/${work.id}/launch`, { expectedRevision: work.revision });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const phone = await context.newPage();
  try {
    await phone.goto('http://127.0.0.1:4711/');
    await phone.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'https://127.0.0.1:4713/';
      link.textContent = 'Open private Forge';
      document.querySelector('main')!.append(link);
    });
    await phone.getByRole('link', { name: 'Open private Forge', exact: true }).click();
    await expect(phone).toHaveURL('https://127.0.0.1:4713/');
    await expect(phone.getByText('Private access · alice@example.com')).toBeVisible();
    await phone.getByRole('button', { name: /^Approvals/ }).click();
    await phone.getByRole('button', { name: 'Review request', exact: true }).click();
    const dialog = phone.getByRole('dialog', { name: 'Review a native command' });
    await expect(dialog.getByText(/s left/)).toBeVisible();
    await phone.screenshot({ path: 'artifacts/forge-phone-approval-light.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await phone.getByRole('button', { name: 'Use dark theme' }).click();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.getByRole('button', { name: 'Review request', exact: true }).click();
    const axe = await new AxeBuilder({ page: phone })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    await phone.screenshot({
      path: 'artifacts/forge-phone-approval-mobile-dark.png',
      fullPage: true,
    });
    await dialog.getByRole('button', { name: 'Allow once' }).click();
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(async () => {
        const next = await (await page.request.get('/api/snapshot')).json();
        const approval = next.approvals.find((a: { workId: string }) => a.workId === work.id);
        return { status: approval?.status, decidedBy: approval?.decidedBy };
      })
      .toEqual({
        status: 'accepted',
        decidedBy: { kind: 'tailscale', identity: 'alice@example.com' },
      });
    await phone
      .getByRole('button', { name: /Review a native command/ })
      .filter({ hasText: work.title })
      .click();
    await expect(dialog.getByText('alice@example.com', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
    const phoneSnapshot = await (
      await phone.request.get('https://127.0.0.1:4713/api/snapshot')
    ).json();
    const accepted = phoneSnapshot.approvals.find((a: { workId: string }) => a.workId === work.id);
    const replay = await phone.request.post(
      `https://127.0.0.1:4713/api/approvals/${accepted.id}/decision`,
      {
        data: { digest: accepted.digest, decision: 'accept' },
        headers: { origin: 'https://127.0.0.1:4713', 'x-forge-csrf': phoneSnapshot.csrf },
      },
    );
    expect(replay.status()).toBe(409);
  } finally {
    await context.close();
  }
});

test('workspace commands, progressive setup and browser navigation preserve real work', async ({
  page,
}) => {
  await page.goto('/');
  const before = await (await page.request.get('/api/snapshot')).json();
  await page.keyboard.press('Control+k');
  const commands = page.getByRole('dialog', { name: 'Commands', exact: true });
  const query = commands.getByRole('combobox', { name: 'Search commands and work' });
  await expect(query).toBeFocused();
  await page.keyboard.type('> new work');
  await expect(commands.getByRole('option')).toHaveCount(2);
  await expect(commands.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  const create = page.getByRole('dialog', { name: 'New work', exact: true });
  await expect(create).toBeVisible();
  await expect(create.getByLabel('Work title')).toBeFocused();
  await create.screenshot({ path: 'artifacts/forge-new-work-light.png' });
  await expect(create.getByLabel('Goal', { exact: true })).toBeVisible();
  await expect(create.getByLabel('Acceptance criteria')).not.toBeVisible();
  await create.getByLabel('Work title').fill('Keyboard workspace continuity');
  await create
    .getByLabel('Goal', { exact: true })
    .fill('Find this record quickly and retain optional context.');
  await create.getByText('Additional context and options', { exact: true }).click();
  await create
    .getByLabel('Context to carry forward')
    .fill('Keep this optional native continuation context.');
  await create
    .getByLabel('Acceptance criteria')
    .fill('Context survives the folded form and reload.');
  await create.getByText('Additional context and options', { exact: true }).click();
  await create.getByRole('button', { name: 'Create work', exact: true }).click();
  const work = page.getByRole('dialog', { name: 'Keyboard workspace continuity', exact: true });
  await expect(work).toBeVisible();
  await work.getByRole('button', { name: 'Close dialog' }).click();
  const saved = await (await page.request.get('/api/snapshot')).json();
  expect(saved.work).toHaveLength(before.work.length + 1);
  const record = saved.work.find(
    (item: { title: string }) => item.title === 'Keyboard workspace continuity',
  );
  const stored = await (await page.request.get(`/api/work/${record.id}`)).json();
  expect(stored.work.context).toBe('Keep this optional native continuation context.');
  expect(stored.work.acceptance).toBe('Context survives the folded form and reload.');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Resources', exact: true })
    .click();
  await page.getByRole('navigation').getByRole('button', { name: 'Memory', exact: true }).click();
  await page.reload();
  await expect(page.locator('main h1')).toHaveText('Memory');
  await page.goBack();
  await expect(page.locator('main h1')).toHaveText('Resources');
  await page.goForward();
  await expect(page.locator('main h1')).toHaveText('Memory');
  await page.keyboard.press('Control+k');
  await query.fill('Keyboard workspace continuity');
  await expect(commands.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(commands.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(work).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await query.fill('>');
  const options = commands.getByRole('option');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(commands).toHaveCount(0);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Workspace', exact: true })
    .click();
  await page.getByLabel('Filter workspace work').fill('Keyboard workspace continuity');
  await expect(
    page.getByRole('button', { name: 'Keyboard workspace continuity', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Filter workspace work').fill('');
  await page.getByRole('heading', { name: 'Workspace', level: 1 }).click();
  for (const dark of [false, true]) {
    if (dark) await page.getByRole('button', { name: 'Use dark theme' }).click();
    for (const mobile of [false, true]) {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
        ).violations.map((violation) => violation.id),
      ).toEqual([]);
      await page.screenshot({
        path: `artifacts/forge-workspace-${mobile ? 'mobile' : 'desktop'}-${dark ? 'dark' : 'light'}.png`,
        fullPage: true,
      });
    }
  }
});
