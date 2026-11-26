import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
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

// ---------- controls of the e2e stack only (services/api/e2e/controls.ts) ----------

const control = async (request: APIRequestContext, path: string, data?: object) => {
  const res = await request.post(`${API}${path}`, data ? { data } : {});
  expect(res.ok(), `${path} answered ${res.status()}`).toBe(true);
  return res;
};

/** Moves the app's clock on. A session unused for more than 30 days ends, as it would for a person, so sign in again. */
export const advanceDays = (request: APIRequestContext, days: number) => control(request, '/e2e/clock', { advanceDays: days });

/** A reply arrives from the company on the request's Gmail thread. */
export const replyArrives = (request: APIRequestContext, requestId: string, automatic = false) => control(request, '/e2e/replies', { requestId, automatic });

/** Runs a background task now and returns its counts. */
export async function runJob(request: APIRequestContext, name: 'poll-replies' | 'followup-sweep' | 'purge'): Promise<Record<string, number>> {
  return ((await (await control(request, `/e2e/jobs/${name}`)).json()) as { counts: Record<string, number> }).counts;
}

/** Who the fake Google signs in and connects next. */
export const googleSignsIn = (request: APIRequestContext, who: 'first' | 'second') => control(request, '/e2e/google/identity', { who });

export async function revokedTokens(request: APIRequestContext): Promise<string[]> {
  return ((await (await request.get(`${API}/e2e/google/revoked`)).json()) as { tokens: string[] }).tokens;
}

export interface PersonData {
  user: { id: string; email: string; name: string; googleSub: string; status: string; purged: boolean };
  counts: Record<string, number>;
  deliveries: string[];
  content: string;
}

export async function personData(request: APIRequestContext, by: { email: string } | { userId: string }): Promise<PersonData> {
  const res = await request.get(`${API}/e2e/data`, { params: by });
  expect(res.ok()).toBe(true);
  return (await res.json()) as PersonData;
}

export const FIRST_EMAIL = 'e2e.user@example.com';
export const SECOND_EMAIL = 'e2e.other@example.com';

/** Drafts, edits the unfinished line out, approves and sends one email request (a test send). Returns its id. */
export async function sendRequest(page: Page, company = 'E2E Bank'): Promise<string> {
  await draftFor(page, company);
  const id = await firstRequestId(page);
  await resolveOpenLine(page, id);
  await (await chooseAndOpen(page, company)).click();
  await expect(page.getByText(copy.requests.resultSent)).toBeVisible();
  return id;
}

/** Records the POSTs the page makes to the API that match, by their last path segments. */
export function recordPosts(page: Page, match: RegExp): string[] {
  const calls: string[] = [];
  page.on('request', (r) => {
    const m = r.method() === 'POST' ? match.exec(new URL(r.url()).pathname) : null;
    if (m) calls.push(m[1] ?? m[0]);
  });
  return calls;
}

