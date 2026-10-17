import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('native gateway review, owned startup, resources and stop stay usable on desktop and phone', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json(),
    paths = await (await page.request.get('/api/fixture/memory')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const accountResponse = await page.request.post('/api/accounts', {
    headers,
    data: {
      harness: 'hermes',
      label: 'Browser native planner account',
      nativeHome: paths.companionHome,
      billingMode: 'native',
    },
  });
  expect(accountResponse.ok()).toBeTruthy();
  const account = await accountResponse.json();
  const accessResponse = await page.request.post('/api/companions', {
    headers,
    data: {
      label: 'Browser native planner access',
      profileId: snapshot.defaultProfileId,
      root: paths.project,
      scopes: ['work:read', 'context:read', 'work:write'],
    },
  });
  expect(accessResponse.ok()).toBeTruthy();
  const access = await accessResponse.json();
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Connections', exact: true })
    .click();
  const panel = page.getByLabel('Native companion runtimes');
  await panel.getByRole('button', { name: 'Link runtime', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Link native runtime' });
  await dialog.getByLabel('Runtime name').fill('Browser owned planner');
  await dialog
    .getByRole('combobox', { name: 'Native account', exact: true })
    .selectOption(account.id);
  await dialog
    .getByRole('combobox', { name: 'Companion access', exact: true })
    .selectOption(access.grant.id);
  await dialog.getByRole('button', { name: 'Link runtime', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const row = panel
    .locator('.backend-instance')
    .filter({ has: page.getByRole('heading', { name: 'Browser owned planner', exact: true }) });
  await row.getByRole('button', { name: 'Start Browser owned planner' }).click();
  dialog = page.getByRole('dialog', { name: 'Start native gateway' });
  await expect(dialog.getByRole('button', { name: 'Start gateway', exact: true })).toBeDisabled();
  await expect(dialog.getByText(/outside Forge work reservations/)).toBeVisible();
  await dialog.screenshot({ path: 'artifacts/forge-native-runtime-review-desktop-light.png' });
  const light = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(light.violations).toEqual([]);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    localStorage.setItem('forge.theme', 'dark');
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const check = await dialog.evaluate((element) => {
    const body = element.querySelector('.dialog-body'),
      footer = element.querySelector('.form-footer');
    return {
      innerOverflow: body!.scrollWidth <= body!.clientWidth + 1,
      footerBottom: footer!.getBoundingClientRect().bottom,
      windowHeight: window.innerHeight,
    };
  });
  expect(check.innerOverflow).toBeTruthy();
  expect(check.footerBottom).toBeLessThanOrEqual(check.windowHeight);
  await dialog.screenshot({ path: 'artifacts/forge-native-runtime-review-mobile-dark.png' });
  const dark = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(dark.violations).toEqual([]);
  await dialog.getByRole('checkbox', { name: /I reviewed this profile/ }).check();
  await dialog.getByRole('button', { name: 'Start gateway', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row.getByText(/Owned native gateway available/)).toBeVisible();
  const running = await (await page.request.get('/api/snapshot')).json();
  const runtime = running.companionRuntime.runtimes.find(
    (item: { label: string }) => item.label === 'Browser owned planner',
  );
  expect(
    running.companionWorkers.some(
      (worker: { runtimeId: string }) => worker.runtimeId === runtime.id,
    ),
  ).toBeTruthy();
  expect(
    running.resources.groups.some(
      (group: { kind: string; runtimeId: string }) =>
        group.kind === 'companion' && group.runtimeId === runtime.id,
    ),
  ).toBeTruthy();
  await row.getByRole('button', { name: 'Stop Browser owned planner' }).click();
  await expect(row.getByText(/original native child and inherited stdio closed/)).toBeVisible();
  const stopped = await (await page.request.get('/api/snapshot')).json();
  const launch = stopped.companionRuntime.launches.find(
    (item: { id: string }) => item.id === runtime.currentLaunchId,
  );
  expect(launch.exitConfirmed).toBeTruthy();
  expect(launch.exit.method).toBe('signed-native-close');
  expect(stopped.work.filter((work: { createdBy?: unknown }) => work.createdBy).length).toBe(
    running.work.filter((work: { createdBy?: unknown }) => work.createdBy).length,
  );
  await row.getByRole('button', { name: 'Retire Browser owned planner' }).click();
  await expect(row).not.toBeVisible();
  await page.request.delete(`/api/companions/${access.grant.id}`, { headers, data: {} });
});

test('companion access offers scoped finite dispatch, native setup formats and revocation without retaining the bearer', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const paths = await (await page.request.get('/api/fixture/memory')).json();
  const added = await page.request.post('/api/accounts', {
    headers: { 'x-forge-csrf': snapshot.csrf },
    data: { label: 'Companion dispatch slot', harness: 'codex' },
  });
  expect(added.ok()).toBeTruthy();
  await page.goto('/#connections');
  const panel = page.getByRole('region', { name: 'Companion access' });
  await panel.getByRole('button', { name: 'Connect companion', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect companion', exact: true });
  await dialog.getByLabel('Companion name').fill('Hermes browser connection');
  await dialog
    .getByRole('textbox', { name: /Project directory/ })
    .fill('/unavailable/forge-project');
  await dialog.getByRole('combobox', { name: 'Access', exact: true }).selectOption('dispatch');
  await expect(dialog.getByRole('button', { name: 'Create access' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Companion dispatch slot' }).check();
  await dialog.getByLabel('Maximum native runs').fill('2');
  await dialog.getByLabel('Expires in days').fill('7');
  await expect(dialog.getByRole('checkbox', { name: /Allow metered/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Create access' }).click();
  await expect(dialog.getByText('The companion project directory was not found.')).toBeVisible();
  await dialog.getByRole('textbox', { name: /Project directory/ }).fill(paths.project);
  await dialog.getByRole('button', { name: 'Create access' }).click();
  const setup = page.getByRole('dialog', { name: 'Add Forge to your native client' });
  const configuration = setup.getByLabel('MCP connection configuration');
  const config = JSON.parse(await configuration.inputValue());
  expect(config.mcpServers.forge.url).toContain('/mcp/companions');
  expect(config.mcpServers.forge.headers.Authorization.startsWith('Bearer forgec_')).toBeTruthy();
  await setup.getByRole('combobox', { name: 'Configuration format' }).selectOption('hermes');
  expect(await configuration.inputValue()).toContain('mcp_servers:');
  await setup.getByRole('combobox', { name: 'Configuration format' }).selectOption('openclaw');
  expect(JSON.parse(await configuration.inputValue()).mcp.servers.forge.transport).toBe(
    'streamable-http',
  );
  const persisted = await (await page.request.get('/api/snapshot')).json();
  const grant = persisted.companionGrants.find(
    (value: { label: string }) => value.label === 'Hermes browser connection',
  );
  expect(grant.dispatch).toEqual({ maxRuns: 2, allowMetered: false });
  expect(JSON.stringify(persisted).includes('tokenHash')).toBeFalsy();
  expect(JSON.stringify(persisted).includes('Bearer forgec_')).toBeFalsy();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBeFalsy();
  }
  await setup.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(configuration).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('forgec_');
  await panel.getByRole('button', { name: 'Revoke Hermes browser connection' }).click();
  await expect(
    panel.getByRole('button', { name: 'Revoke Hermes browser connection' }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('MCP connection configuration')).toHaveCount(0);
});

test('native companion replacement preserves work, stages read-only access and needs a fresh authenticated readiness acknowledgement', async ({
  page,
}) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const paths = await (await page.request.get('/api/fixture/memory')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const old = await (
    await page.request.post('/api/companions', {
      headers,
      data: {
        label: 'Browser Hermes lifecycle',
        profileId: snapshot.defaultProfileId,
        root: paths.project,
        scopes: ['work:read', 'context:read', 'work:write'],
      },
    })
  ).json();
  const saved = await page.request.post('/api/work', {
    headers,
    data: {
      title: 'Companion lifecycle retained work',
      project: 'Companion handoff',
      goal: 'Keep identity across native client replacement.',
      harness: 'codex',
      cwd: paths.project,
      profileId: snapshot.defaultProfileId,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const work = await saved.json();
  await page.goto('/#connections');
  const panel = page.getByRole('region', { name: 'Companion access' });
  await panel
    .getByRole('button', { name: 'Replace Browser Hermes lifecycle', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Replace companion', exact: true });
  await dialog.getByLabel('Replacement name').fill('Browser OpenClaw lifecycle');
  await dialog.getByRole('button', { name: 'Review replacement', exact: true }).click();
  await expect(
    dialog.getByRole('region', { name: 'Companion replacement boundary' }),
  ).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate(
      (dark) => (document.documentElement.dataset.theme = dark ? 'dark' : 'light'),
      dark,
    );
    await page.setViewportSize(dark ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    expect(
      (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      ).violations.map((v) => v.id),
    ).toEqual([]);
    expect(
      await dialog.evaluate((element) =>
        Array.from(element.querySelectorAll('*')).every(
          (child) => child.scrollWidth <= child.clientWidth + 1,
        ),
      ),
    ).toBe(true);
    const bounds = await dialog
      .getByRole('button', { name: 'Stage replacement', exact: true })
      .boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(dark ? 844 : 1000);
    await dialog.screenshot({
      path: `artifacts/forge-companion-replacement-${dark ? 'mobile-dark' : 'desktop-light'}.png`,
    });
  }
  await dialog.getByRole('button', { name: 'Stage replacement', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Add Forge to your native client' });
  const config = JSON.parse(await setup.getByLabel('MCP connection configuration').inputValue());
  const token = config.mcpServers.forge.headers.Authorization;
  await setup.getByRole('button', { name: 'Done', exact: true }).click();
  const row = panel.getByRole('article', {
    name: 'Handoff to Browser OpenClaw lifecycle',
    exact: true,
  });
  await expect(row.getByText('Waiting for the replacement client', { exact: true })).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Activate replacement', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(row).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('forgec_');
  const client = new Client({ name: 'browser-replacement-native-compatible-client', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.mcpServers.forge.url), {
        requestInit: { headers: { Authorization: token } },
      }),
    );
    const observed = await client.callTool({ name: 'forge_workspace', arguments: {} });
    const native = observed.structuredContent as any;
    expect(native.grant.lifecycle).toBe('staged');
    expect(native.work.some((value: { id: string }) => value.id === work.id)).toBe(true);
    const held = await client.callTool({
      name: 'forge_checkpoint',
      arguments: {
        requestId: 'held-before-human-activation',
        workId: work.id,
        expectedRevision: work.revision,
        note: 'No staged write.',
      },
    });
    expect(held.isError).toBe(true);
    const ready = await client.callTool({
      name: 'forge_companion_ready',
      arguments: { handoffId: native.handoff.id, digest: native.handoff.digest },
    });
    expect(ready.isError).toBeFalsy();
    await expect(
      row.getByText('Replacement acknowledged the context boundary', { exact: true }),
    ).toBeVisible();
    await row
      .getByLabel(
        'I reviewed native planners, schedules and external work before changing the active Forge connection.',
      )
      .check();
    await row.getByRole('button', { name: 'Activate replacement', exact: true }).click();
    await expect(
      row.getByText('Replacement activated; original access revoked', { exact: true }),
    ).toBeVisible();
    const final = await client.callTool({
      name: 'forge_checkpoint',
      arguments: {
        requestId: 'native-after-handoff',
        workId: work.id,
        expectedRevision: work.revision,
        note: 'Same work and profile after replacement.',
      },
    });
    expect(final.isError).toBeFalsy();
    const after = await (await page.request.get('/api/snapshot')).json();
    expect(
      after.companionGrants.find((grant: { id: string }) => grant.id === old.grant.id).revokedAt,
    ).toBeTruthy();
    const retained = await (await page.request.get(`/api/work/${work.id}`)).json();
    expect(retained.work.profileId).toBe(work.profileId);
    expect(
      retained.events.some(
        (event: { detail: string }) => event.detail === 'Same work and profile after replacement.',
      ),
    ).toBe(true);
    expect(JSON.stringify(after)).not.toContain(token);
  } finally {
    await client.close();
  }
});
