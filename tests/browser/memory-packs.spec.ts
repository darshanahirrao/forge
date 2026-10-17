import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

test('selected memory exports privately, activates on the same profile and imports with explicit local scope while retaining instructions', async ({
  page,
}) => {
  const fixture = await (await page.request.get('/api/fixture/memory-packs')).json();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const headers = { 'x-forge-csrf': snapshot.csrf };
  const originalInstructions = 'Keep portable profile instructions.';
  const created = await page.request.post('/api/profiles', {
    headers,
    data: {
      name: 'Native portable pack profile',
      instructions: originalInstructions,
      companionSourceId: null,
      memorySourceIds: [],
    },
  });
  expect(created.ok()).toBe(true);
  const profile = await created.json();
  const inspected = await (
    await page.request.post('/api/memory/inspect', {
      headers,
      data: { path: fixture.path, section: ['Shared'] },
    })
  ).json();
  const registered = await page.request.post('/api/memory/sources', {
    headers,
    data: {
      label: 'Portable pack selected memory',
      owner: 'hermes',
      path: fixture.path,
      section: ['Shared'],
      scope: { kind: 'project', root: fixture.project },
      expectedSha256: inspected.sha256,
      expectedSelectionSha256: inspected.selectionSha256,
    },
  });
  expect(registered.ok()).toBe(true);
  const source = await registered.json();
  expect(
    (
      await page.request.patch(`/api/profiles/${profile.id}`, {
        headers,
        data: {
          name: profile.name,
          instructions: profile.instructions,
          companionSourceId: null,
          memorySourceIds: [source.id],
          expectedRevision: profile.revision,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/#memory');
  await page.getByRole('combobox', { name: 'Profile', exact: true }).selectOption(profile.id);
  const panel = page.getByRole('region', { name: 'Portable memory', exact: true });
  const prepare = panel.getByRole('button', { name: 'Prepare portable copy', exact: true });
  const instructions = page.getByLabel(/^Profile instructions/);
  await instructions.fill('Unsaved profile draft');
  await expect(prepare).toBeDisabled();
  await instructions.fill(originalInstructions);
  await expect(prepare).toBeEnabled();
  await prepare.click();
  const review = page.getByRole('dialog', { name: 'Review portable memory', exact: true });
  await expect(review).toContainText('Portable browser selected marker.');
  await expect(review).not.toContainText('PORTABLE-EXCLUDED-PRIVATE');
  await expect(review).toContainText(originalInstructions);
  await expect(
    review.getByRole('button', { name: 'Use portable files', exact: true }),
  ).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const footer = await review.locator('.form-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
    expect(
      await review
        .locator('.dialog-body')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await review.screenshot({ path: `artifacts/forge-memory-pack-${theme}.png` });
  }
  await review.getByRole('checkbox').check();
  const downloadEvent = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download private pack', exact: true }).click();
  const downloaded = await downloadEvent;
  const path = await downloaded.path();
  expect(path).toBeTruthy();
  const raw = await readFile(path!, 'utf8'),
    pack = JSON.parse(raw);
  expect(raw).toContain('Portable browser selected marker.');
  expect(raw).not.toContain('PORTABLE-EXCLUDED-PRIVATE');
  expect(pack.format).toBe('forge.private-memory-pack');
  await review.getByRole('button', { name: 'Use portable files', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(panel).toContainText('Last copy: applied.');
  let current = await (await page.request.get('/api/snapshot')).json();
  const copied = current.profiles.find((p: { id: string }) => p.id === profile.id);
  expect(copied.id).toBe(profile.id);
  expect(copied.memorySourceIds[0]).not.toBe(source.id);
  await expect(instructions).toHaveValue(originalInstructions);

  // A private pack can propose different instructions, but the import defaults to keeping the target's.
  pack.profile.instructions = 'Imported instructions require an explicit choice.';
  await panel.getByRole('button', { name: 'Import private pack', exact: true }).click();
  const load = page.getByRole('dialog', { name: 'Import private memory pack', exact: true });
  await load.getByLabel('Memory pack JSON', { exact: true }).fill(JSON.stringify(pack));
  await load.getByRole('button', { name: 'Read private pack', exact: true }).click();
  const bind = page.getByRole('dialog', { name: 'Bind imported memory', exact: true });
  await expect(bind.getByRole('checkbox')).not.toBeChecked();
  const localProject = bind.getByLabel(
    'Local project directory for Portable pack selected memory',
    { exact: true },
  );
  await expect(localProject).toHaveValue('');
  await localProject.fill(fixture.project);
  await bind.getByRole('button', { name: 'Prepare memory review', exact: true }).click();
  await expect(review).toContainText(originalInstructions);
  await expect(review).not.toContainText('Imported instructions require an explicit choice.');
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Use portable files', exact: true }).click();
  await expect(review).toHaveCount(0);
  await page.reload();
  current = await (await page.request.get('/api/snapshot')).json();
  const retained = current.profiles.find((p: { id: string }) => p.id === profile.id);
  expect(retained.instructions).toBe(originalInstructions);
  expect(retained.id).toBe(profile.id);
  expect(
    current.memoryPacks.filter(
      (p: { profileId: string; state: string }) =>
        p.profileId === profile.id && p.state === 'applied',
    ),
  ).toHaveLength(2);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
