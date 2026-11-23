import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';
import { copy } from '../src/copy/en';

export const API = 'http://localhost:4100';
export { copy, expect };

/** Every test starts from an empty database: no people, inboxes, scans or requests. */
export const test = base.extend<{ fresh: void }>({
  fresh: [
    async ({ request }, use) => {
      expect((await request.post(`${API}/e2e/reset`)).status()).toBe(204);
      await use();
    },
    { auto: true },
  ],
});

/** Signs in through the real flow: the app, the API and a fake Google that approves at once. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: copy.signIn.button }).click();
  await page.waitForURL('**/overview');
}

/** Connects the fake inbox and waits for its first scan (four fictional companies). */
export async function connectAndScan(page: Page): Promise<void> {
  await page.goto('/connect');
  await page.getByRole('button', { name: copy.connect.add }).click();
  await page.waitForURL('**/connect?inbox=connected');
  await expect(page.getByText('Scan finished · 4 companies')).toBeVisible();
}

export async function toOverview(page: Page): Promise<void> {
  await signIn(page);
  await connectAndScan(page);
  await page.goto('/overview');
  await expect(page.getByRole('checkbox', { name: copy.overview.company.select('E2E Bank') })).toBeVisible();
}

/** Drafts one company from the Overview and opens the review screen. */
export async function draftFor(page: Page, company: string): Promise<void> {
  await page.getByRole('checkbox', { name: copy.overview.company.select(company) }).check();
  await page.getByRole('button', { name: copy.overview.draft.action(1) }).click();
  await expect(page.getByText(copy.overview.draft.resultsTitle)).toBeVisible();
}

/** The id of the one request on screen, read from its link. */
export async function firstRequestId(page: Page): Promise<string> {
  const href = await page.getByRole('link', { name: copy.overview.draft.open }).first().getAttribute('href');
  return (href ?? '').split('/').pop() ?? '';
}

/** The draft text without its unfinished [OPEN] paragraph. */
export const removeOpenLine = (text: string): string => text.replace(/\[OPEN[\s\S]*?(\n\n|$)/, '');

/** Opens a request's edit page and removes the unfinished [OPEN] paragraph, saving the draft. */
export async function resolveOpenLine(page: Page, id: string): Promise<void> {
  await page.goto(`/requests/${id}`);
  const message = page.getByLabel(copy.requests.message);
  const text = await message.inputValue();
  await message.fill(removeOpenLine(text));
  await page.getByRole('button', { name: copy.requests.save }).click();
  await expect(page.getByText(copy.requests.saved)).toBeVisible();
}

/** Chooses one drafted request on the review screen and opens its draft. Returns the approve button. */
export async function chooseAndOpen(page: Page, company: string) {
  await page.goto('/requests/review');
  await page.getByRole('checkbox', { name: copy.requests.choose(company) }).check();
  await page.getByRole('button', { name: copy.requests.open }).click();
  const approve = page.getByRole('button', { name: copy.requests.approveAndSend(1) });
  await expect(approve).toBeEnabled();
  return approve;
}

/** Runs axe-core in the page and returns the serious and critical problems. */
export async function seriousViolations(page: Page): Promise<string[]> {
  const axeSource = readFileSync(fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run: (c?: unknown, o?: unknown) => Promise<{ violations: Array<{ id: string; impact: string | null; nodes: unknown[] }> }> } }).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    });
    return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
  });
}
