import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('workspace blueprint import previews local bindings, preserves preferences, rolls back unused setup and retains later work', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const project = await (await page.request.get('/api/fixture/memory')).json();
  const account = await page.request.post('/api/accounts', {
    headers: { 'x-forge-csrf': snapshot.csrf },
    data: { label: 'Blueprint native slot', harness: 'codex' },
  });
  expect(account.ok()).toBeTruthy();
  const definition = {
    format: 'forge.workspace-blueprint',
    version: 1,
    name: 'Browser blueprint',
    harnesses: ['codex'],
    accounts: [{ role: 'coding', harness: 'codex', billingMode: 'native' }],
    settings: { maxConcurrent: 1, memoryPressurePolicy: 'observe' },
    profiles: [
      {
        role: 'developer',
        name: 'Imported browser profile',
        instructions: 'Keep validation visible.',
        memoryOwners: [],
        preferredCompanion: null,
      },
    ],
    requirements: [],
    workTemplates: [
      {
        role: 'review',
        title: 'Imported browser work',
        goal: 'Review the project using native tools.',
        profileRole: 'developer',
        accountRole: 'coding',
        projectRole: 'project',
      },
    ],
  };
  await page.goto('/#connections');
  const panel = page.getByRole('region', { name: 'Workspace blueprints' });
  async function upload() {
    await panel.getByLabel('Choose blueprint JSON').setInputFiles({
      name: 'workspace.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(definition)),
    });
    const bind = page.getByRole('dialog', { name: 'Bind blueprint roles' });
    await bind
      .getByRole('combobox', { name: /Account: coding/ })
      .selectOption({ label: 'Blueprint native slot' });
    await bind.getByRole('textbox', { name: 'Project: project' }).fill(project.project);
    await expect(
      bind.getByRole('checkbox', { name: /Apply blueprint workspace preferences/ }),
    ).not.toBeChecked();
    await bind.getByRole('button', { name: 'Review import' }).click();
    return page.getByRole('dialog', { name: 'Review blueprint import' });
  }
  const preview = await upload();
  await expect(preview.getByText('Imported browser profile', { exact: true })).toBeVisible();
  await expect(preview.getByText('Keep validation visible.')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await preview.getByRole('button', { name: 'Import setup', exact: true }).click();
  await panel.getByText(/Recent imports/).click();
  await panel.getByRole('button', { name: 'Roll back unused import Browser blueprint' }).click();
  await expect(panel.getByText(/Rolled back/)).toBeVisible();
  let current = await (await page.request.get('/api/snapshot')).json();
  expect(
    current.work.some(
      (work: { title: string }) => work.title === definition.workTemplates[0].title,
    ),
  ).toBeFalsy();
  expect(current.settings.memoryPressurePolicy ?? 'protect').toBe(
    snapshot.settings.memoryPressurePolicy ?? 'protect',
  );
  definition.name = 'Keep imported progress';
  const second = await upload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBeFalsy();
  await second.getByRole('button', { name: 'Import setup', exact: true }).click();
  current = await (await page.request.get('/api/snapshot')).json();
  const work = current.work.find(
    (work: { title: string }) => work.title === definition.workTemplates[0].title,
  );
  expect(work).toBeTruthy();
  await page.request.post(`/api/work/${work.id}/checkpoint`, {
    headers: { 'x-forge-csrf': snapshot.csrf },
    data: { note: 'Keep this user progress after import.' },
  });
  await panel
    .getByRole('button', { name: 'Roll back unused import Keep imported progress' })
    .click();
  await expect(
    panel.getByText('Imported work has changed or executed. Its history must be preserved.'),
  ).toBeVisible();
  await page.reload();
  current = await (await page.request.get('/api/snapshot')).json();
  expect(current.work.some((value: { id: string }) => value.id === work.id)).toBeTruthy();
});
