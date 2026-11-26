import type { Page } from '@playwright/test';
import { API, connectAndScan, copy, expect, FIRST_EMAIL, googleSignsIn, personData, revokedTokens, SECOND_EMAIL, sendRequest, signIn, test, toOverview } from './helpers';

const y = copy.yourData;

async function askForDeletion(page: Page): Promise<void> {
  await page.goto('/your-data');
  await page.getByRole('button', { name: y.deleteTitle }).click();
  await page.getByRole('button', { name: y.confirmAction }).click();
  await expect(page.getByText(y.paused)).toBeVisible();
}

async function deleteNow(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: y.nowConfirm }).check();
  await page.getByRole('button', { name: y.nowAction }).click();
  await page.waitForURL('**/deleted');
}

/** What this browser still holds for the app. */
const deviceState = (page: Page) =>
  page.evaluate(async () => {
    const cached: string[] = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) cached.push(new URL(r.url).pathname);
    return { stored: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.startsWith('erase.')), cached };
  });

test('delete my data: paused, undo inside the period, then delete now, signed out with the Gmail note', async ({ page }) => {
  await toOverview(page);
  await sendRequest(page);
  const before = await personData(page.request, { email: FIRST_EMAIL });
  expect(before.counts.requests).toBe(1);

  await page.goto('/your-data');
  await expect(page.getByText(y.gmailCopies)).toBeVisible();
  await askForDeletion(page);
  await expect(page.getByText(/Your data is due to be deleted on /)).toBeVisible();
  await expect(page.getByRole('link', { name: copy.nav.requests })).toHaveCount(0);
  expect(await revokedTokens(page.request)).toEqual(['e2e-refresh-token']); // Google was asked at once
  // Every other screen leads back here, and the API refuses.
  await page.goto('/requests');
  await page.waitForURL('**/your-data');
  expect((await page.request.get(`${API}/v1/requests`)).status()).toBe(403);

  // Undo, inside the period: everything is still there, and the inboxes have to be connected again.
  await page.getByRole('button', { name: y.undo }).click();
  await expect(page.getByText(y.undoneBody)).toBeVisible();
  await expect(page.getByRole('link', { name: copy.nav.requests })).toBeVisible();
  await page.goto('/requests');
  await expect(page.getByRole('link', { name: 'E2E Bank' })).toBeVisible();
  const restored = await personData(page.request, { email: FIRST_EMAIL });
  expect(restored.user.status).toBe('active');
  expect(restored.counts.requests).toBe(1);
  await connectAndScan(page);

  // Again, and this time without waiting.
  await askForDeletion(page);
  await deleteNow(page);
  await expect(page.getByRole('heading', { level: 1, name: y.deletedTitle })).toBeVisible();
  await expect(page.getByText(y.signedOut)).toBeVisible();
  await expect(page.getByText(y.gmailCopies)).toBeVisible();
  await expect(page.getByText(y.sentRequests)).toBeVisible();
  await expect(page.getByText(y.googleTitle)).toHaveCount(0); // the fake Google confirmed the revoke
  expect(await revokedTokens(page.request)).toEqual(['e2e-refresh-token', 'e2e-refresh-token']);

  // Signed out: the session is gone, signed-in screens lead to sign-in, and the device holds nothing personal.
  expect((await page.request.get(`${API}/v1/me`)).status()).toBe(401);
  await expect.poll(async () => (await deviceState(page)).stored).toEqual([]);
  for (const path of (await deviceState(page)).cached) expect(path).toMatch(/^\/(offline|manifest\.webmanifest|brand\/|_next\/static\/)/);
  await page.goto('/your-data');
  await expect(page.getByRole('link', { name: copy.signIn.button })).toBeVisible();

  // In the database only a record with no personal data is left.
  const gone = await personData(page.request, { userId: before.user.id });
  expect(gone.user).toMatchObject({ email: '', name: '', googleSub: `deleted:${before.user.id}`, purged: true });
  expect(Object.values(gone.counts).every((n) => n === 0)).toBe(true);

  // The same Google account signing in again starts afresh.
  await signIn(page);
  expect((await personData(page.request, { email: FIRST_EMAIL })).user.id).not.toBe(before.user.id);
});

test('another person’s data is untouched by the first person’s deletion', async ({ page, browser }) => {
  // The second person, in their own browser.
  await googleSignsIn(page.request, 'second');
  const otherContext = await browser.newContext({ baseURL: 'http://localhost:3100', locale: 'en-GB', timezoneId: 'UTC' });
  try {
    const other = await otherContext.newPage();
    await toOverview(other);
    const otherRequest = await sendRequest(other);
    const otherBefore = await personData(page.request, { email: SECOND_EMAIL });
    expect(otherBefore.counts.requests).toBe(1);

    // The first person, who then deletes everything.
    await googleSignsIn(page.request, 'first');
    await toOverview(page);
    await sendRequest(page);
    const mine = await personData(page.request, { email: FIRST_EMAIL });
    expect(mine.user.id).not.toBe(otherBefore.user.id);
    await askForDeletion(page);
    await deleteNow(page);

    expect(Object.values((await personData(page.request, { userId: mine.user.id })).counts).every((n) => n === 0)).toBe(true);
    const otherAfter = await personData(page.request, { email: SECOND_EMAIL });
    expect(otherAfter.user).toEqual(otherBefore.user);
    expect(otherAfter.counts).toEqual(otherBefore.counts);
    expect(otherAfter.content).toBe(otherBefore.content); // every row of theirs, byte for byte
    expect(await revokedTokens(page.request)).toEqual(['e2e-refresh-token']); // only the first person's

    // And they carry on as before.
    await other.goto(`/requests/${otherRequest}`);
    await expect(other.getByRole('heading', { level: 1, name: 'E2E Bank' })).toBeVisible();
    await expect(other.locator('.page-head').getByText(copy.labels.requestStatus.sent, { exact: true })).toBeVisible();
  } finally {
    await otherContext.close();
  }
});
