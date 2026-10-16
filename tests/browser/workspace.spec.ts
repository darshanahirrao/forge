import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('create an account slot, save work and a checkpoint, and retain them after reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your workspace, in focus.' })).toBeVisible();
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
  expect((await local.json()).approvals).toHaveLength(0);
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
  const search = page.getByRole('dialog', { name: 'Find your next step.' });
  await expect(search).toBeVisible();
  await search.getByLabel('Search views and work').fill('Accounts');
  await search.getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Many accounts. One workspace.' })).toBeVisible();
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
    'Overview',
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
  await expect(page.getByRole('heading', { name: 'Work in motion' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: work.title, exact: true }).click();
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
  await expect(
    page.getByRole('heading', { name: '1 native chat · 2 schedule records' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'View native activity', exact: true }).click();
  await expect(page.getByText('Existing native fixture chat', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Schedules / }).click();
  await expect(page.getByRole('heading', { name: 'Native morning review' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Native Hermes check' })).toBeVisible();
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
  await page.getByRole('heading', { name: 'Same identity. Persistent memory.' }).click();
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
