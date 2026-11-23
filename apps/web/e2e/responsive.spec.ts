import type { Page } from '@playwright/test';
import { copy, draftFor, expect, resolveOpenLine, firstRequestId, seriousViolations, test, toOverview } from './helpers';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

const SCREENS = [
  { name: 'Overview', path: '/overview', ready: (p: Page) => p.getByRole('heading', { level: 1, name: copy.overview.title }) },
  { name: 'Requests', path: '/requests', ready: (p: Page) => p.getByRole('link', { name: 'E2E Bank' }) },
  { name: 'Review', path: '/requests/review', ready: (p: Page) => p.getByRole('button', { name: copy.requests.open }) },
  { name: 'Inboxes', path: '/connect', ready: (p: Page) => p.getByRole('heading', { level: 1, name: copy.connect.title }) },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} (${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('screens fit the width and have no serious accessibility problems', async ({ page }) => {
      await toOverview(page);
      await draftFor(page, 'E2E Bank');
      await resolveOpenLine(page, await firstRequestId(page));
      for (const screen of SCREENS) {
        await page.goto(screen.path);
        await expect(screen.ready(page)).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${screen.name}: horizontal scroll`).toBeLessThanOrEqual(0);
        expect(await seriousViolations(page), `${screen.name}: axe`).toEqual([]);
      }
    });

    test('the main actions can be reached by keyboard and are large enough to tap', async ({ page }) => {
      await toOverview(page);
      const box = page.getByRole('checkbox', { name: copy.overview.company.select('E2E Bank') });
      await box.focus();
      await page.keyboard.press('Space');
      await expect(box).toBeChecked();
      const action = page.getByRole('button', { name: copy.overview.draft.action(1) });
      await expect(action).toBeVisible();
      const size = await action.boundingBox();
      expect(size?.height ?? 0).toBeGreaterThanOrEqual(44);
      await action.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText(copy.overview.draft.resultsTitle)).toBeVisible();
    });
  });
}

test('reduced motion is respected', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toOverview(page);
  const durations = await page.evaluate(() => [...document.querySelectorAll('*')].map((e) => getComputedStyle(e).animationDuration).filter((d) => d !== '0s' && d !== ''));
  expect(durations.every((d) => parseFloat(d) <= 0.01)).toBe(true);
});
