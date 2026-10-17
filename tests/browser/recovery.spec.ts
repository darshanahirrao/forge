import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('native exit review is reachable, preserves uncertain holds and handles stale evidence in both themes and mobile', async ({
  page,
}) => {
  await page.goto('/');
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const created = await page.request.post('/api/work', {
    headers: { 'x-forge-csrf': snapshot.csrf },
    data: {
      title: 'Native recovery browser fixture',
      project: 'Recovery',
      goal: 'Inspect native evidence without launching.',
      harness: 'codex',
      cwd: process.cwd(),
    },
  });
  expect(created.ok()).toBe(true);
  const work = await created.json();
  let reviewed = false;
  let attempts = 0;
  const requests: unknown[] = [];
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    const rows = [
      ...(!reviewed
        ? [
            {
              runId: 'browser-ready',
              workId: work.id,
              harness: 'codex',
              revision: work.revision,
              state: 'ready',
              method: 'signed-native-close',
              digest: 'a'.repeat(64),
              detail:
                'The original child owner verified native process and inherited stdio closure. External effects and unknown spending still need review.',
            },
          ]
        : []),
      {
        runId: 'browser-waiting',
        workId: work.id,
        harness: 'codex',
        revision: work.revision,
        state: 'waiting',
        detail: 'Verified closure is unavailable. The reservation stays held.',
      },
      {
        runId: 'browser-legacy',
        workId: work.id,
        harness: 'codex',
        revision: work.revision,
        state: 'unsupported',
        detail: 'This attempt has no durable native exit evidence.',
      },
    ];
    await route.fulfill({
      response,
      json: { ...data, recovery: { needsReview: rows.length, rows } },
    });
  });
  await page.route('**/api/recovery/browser-ready/reconcile', async (route) => {
    requests.push(route.request().postDataJSON());
    attempts++;
    if (attempts === 1)
      await route.fulfill({
        status: 409,
        json: { error: 'Native exit evidence changed. Review its current state.' },
      });
    else {
      reviewed = true;
      await route.fulfill({ status: 200, json: { digest: 'a'.repeat(64) } });
    }
  });
  await page.reload();
  await page.getByRole('button', { name: /Review recovery/ }).click();
  const panel = page.getByRole('region', { name: 'Interrupted worker recovery' });
  await expect(panel.getByRole('button', { name: 'Reconcile native exit' })).toHaveCount(1);
  await expect(panel.getByText('Native exit remains uncertain', { exact: true })).toBeVisible();
  await expect(panel.getByText('Waiting for native closure', { exact: true })).toBeVisible();
  for (const dark of [false, true]) {
    if (dark) await page.getByRole('button', { name: 'Use dark theme' }).click();
    await page.setViewportSize(dark ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await panel.scrollIntoViewIfNeeded();
    expect(
      await panel.evaluate((element) =>
        Array.from(element.querySelectorAll('*')).every(
          (child) => child.scrollWidth <= child.clientWidth + 1,
        ),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      ).violations.map((v) => v.id),
    ).toEqual([]);
    await panel.screenshot({
      path: `artifacts/forge-recovery-${dark ? 'mobile-dark' : 'desktop-light'}.png`,
    });
  }
  await panel.getByRole('button', { name: 'Reconcile native exit' }).click();
  await expect(
    page.getByText('Native exit evidence changed. Review its current state.', { exact: true }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Reconcile native exit' }).click();
  await expect(panel.getByRole('button', { name: 'Reconcile native exit' })).toHaveCount(0);
  await expect(panel.getByText('Native exit remains uncertain', { exact: true })).toBeVisible();
  expect(requests).toEqual(
    Array.from({ length: 2 }, () => ({ expectedRevision: work.revision, digest: 'a'.repeat(64) })),
  );
  expect((await (await page.request.get(`/api/work/${work.id}`)).json()).work.generation).toBe(0);
  await page.unrouteAll({ behavior: 'wait' });
});
