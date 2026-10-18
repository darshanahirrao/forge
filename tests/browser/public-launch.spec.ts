import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

test('the handoff example and reviewed public receipt stay fictional, private and usable in both themes and phone widths', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.getByRole('button', { name: /Local workspace Switch to demo/ }).click();
  await page.getByRole('button', { name: 'See a handoff example' }).click();
  const work = page.getByRole('dialog', { name: 'One task. Codex to Hermes.' });
  await expect(work.getByText('Fictional work record', { exact: true })).toBeVisible();
  await expect(
    work.getByRole('list', { name: 'Recorded native attempts' }).getByRole('listitem'),
  ).toHaveCount(2);
  await expect(work.getByText('Fictional Codex to Hermes handoff', { exact: true })).toBeVisible();
  await work.getByRole('button', { name: 'Share receipt', exact: true }).click();
  const receipt = page.getByRole('dialog', { name: 'Share work receipt' });
  await expect(receipt.getByLabel('Public receipt preview')).toContainText('Codex -> Hermes');
  await expect(receipt.getByLabel('Public receipt preview')).toContainText('FICTIONAL DEMO');
  await expect(receipt.getByLabel('Public receipt preview')).toContainText('3000 reported tokens');
  await expect(receipt.getByLabel('Public receipt preview')).not.toContainText('demo-continuity');
  for (const dark of [false, true]) {
    if (dark) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('button', { name: 'Use dark theme' }).click();
      await page.getByRole('button', { name: 'See a handoff example' }).click();
      await work.getByRole('button', { name: 'Share receipt', exact: true }).click();
    }
    for (const mobile of [false, true]) {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      await expect(receipt.getByRole('button', { name: 'Download Markdown' })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
        ).violations.map((violation) => violation.id),
      ).toEqual([]);
      await page.screenshot({
        path:
          'artifacts/forge-v040-receipt-' +
          (dark ? 'dark' : 'light') +
          '-' +
          (mobile ? 'phone' : 'desktop') +
          '.png',
      });
    }
  }
  const downloading = page.waitForEvent('download');
  await receipt.getByRole('button', { name: 'Download JSON' }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe('forge-demo-receipt.json');
  const contents = await readFile((await downloaded.path())!, 'utf8');
  expect(JSON.parse(contents).evidence).toBe('fictional-demo');
  expect(contents).not.toContain('demo-continuity');
  expect(contents).not.toContain('example.invalid');
  await page.keyboard.press('Escape');
  await expect(work).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Return to my workspace', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByText('Personal workspace', { exact: true })).toBeVisible();
});
