import type { Page } from '@playwright/test';
import { API, chooseAndOpen, copy, draftFor, expect, firstRequestId, resolveOpenLine, test, toOverview } from './helpers';
import { ERROR_MESSAGES } from '../src/copy/errors';

const WEB = 'http://localhost:3100';

test.describe('companies that are not offered', () => {
  test('a must-keep company has no usable checkbox, no Keep switch and no deletion promise', async ({ page }) => {
    await toOverview(page);
    const box = page.getByRole('checkbox', { name: copy.overview.company.select('E2E Login') });
    await expect(box).toBeDisabled();
    await expect(box).toHaveAccessibleDescription(copy.overview.company.reasonMustKeep);
    await expect(page.getByText(copy.overview.company.mustKeep)).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: 'E2E Login' }).last();
    await expect(row.getByRole('switch')).toHaveCount(0);
  });

  test('turning Keep on removes the company from what can be asked', async ({ page }) => {
    await toOverview(page);
    const box = page.getByRole('checkbox', { name: copy.overview.company.select('E2E Bank') });
    await expect(box).toBeEnabled();
    const row = page.getByRole('listitem').filter({ hasText: 'E2E Bank' }).last();
    await row.getByRole('switch').click();
    await expect(box).toBeDisabled();
    await expect(box).toHaveAccessibleDescription(copy.overview.company.reasonKept);
    await expect(page.getByText(copy.overview.company.kept)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Draft \d/ })).toHaveCount(0);
    await page.reload(); // it is saved, not just shown
    await expect(page.getByRole('checkbox', { name: copy.overview.company.select('E2E Bank') })).toBeDisabled();
  });

  test('a company with no verified contact is reported as such, with no request made', async ({ page }) => {
    await toOverview(page);
    await draftFor2(page, 'E2eorphan');
    await expect(page.getByText(ERROR_MESSAGES.no_contact)).toBeVisible();
    await expect(page.getByRole('link', { name: copy.overview.draft.review })).toHaveCount(0);
  });
});

async function draftFor2(page: Page, company: string): Promise<void> {
  await page.getByRole('checkbox', { name: copy.overview.company.select(company) }).check();
  await page.getByRole('button', { name: copy.overview.draft.action(1) }).click();
  await expect(page.getByText(copy.overview.draft.resultsTitle)).toBeVisible();
}

test('a web-form company shows the form link and a copy button, cannot be sent by email, and can be closed', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await toOverview(page);
  await draftFor(page, 'E2E Forms');
  await expect(page.getByText(copy.overview.draft.useForm('E2E Forms'))).toBeVisible();
  const id = await firstRequestId(page);

  await page.goto('/requests/review');
  await expect(page.getByText(copy.requests.useFormBody)).toBeVisible();
  await expect(page.getByRole('link', { name: copy.requests.useFormOpen }).first()).toHaveAttribute('href', 'https://example.com/e2e-forms/privacy-form');
  await expect(page.getByRole('checkbox')).toHaveCount(0); // nothing here can be sent by email
  await page.getByRole('button', { name: copy.requests.copyDraft }).click();
  await expect(page.getByRole('button', { name: copy.requests.copied })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Request to erase my personal data');

  await page.goto(`/requests/${id}`);
  await page.getByRole('button', { name: copy.requests.markClosed }).click();
  await page.getByRole('button', { name: copy.requests.closeConfirm }).click();
  await expect(page.getByText(copy.requests.closed)).toBeVisible();
});

test('a draft that changed after it was opened is refused with the draft_changed message, and nothing is retried', async ({ page }) => {
  await toOverview(page);
  await draftFor(page, 'E2E Bank');
  const id = await firstRequestId(page);
  await resolveOpenLine(page, id);
  const approve = await chooseAndOpen(page, 'E2E Bank');

  // Someone edits the draft after this page opened it.
  const me = (await (await page.request.get(`${API}/v1/me`)).json()) as { csrfToken: string };
  const current = (await (await page.request.get(`${API}/v1/requests/${id}`)).json()) as { draft: { hash: string; subject: string; body: string } };
  const edit = await page.request.patch(`${API}/v1/requests/${id}/draft`, {
    headers: { 'x-csrf-token': me.csrfToken, origin: WEB },
    data: { baseHash: current.draft.hash, subject: current.draft.subject, body: `${current.draft.body}\n\nOne more line.` },
  });
  expect(edit.status()).toBe(200);

  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/v1\/requests\/[^/]+\/(approve|send)$/.test(r.url())) calls.push(r.url().split('/').pop() ?? '');
  });
  await approve.click();
  await expect(page.getByText(ERROR_MESSAGES.draft_changed)).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(calls).toEqual(['approve']); // one refused approval, no retry, nothing sent
  await expect(page.getByText(copy.requests.resultSent)).toHaveCount(0);
});

test('a draft with an ID or card number is refused before it is saved', async ({ page }) => {
  await toOverview(page);
  await draftFor(page, 'E2E Bank');
  const id = await firstRequestId(page);
  await page.goto(`/requests/${id}`);
  const message = page.getByLabel(copy.requests.message);
  await message.fill(`${await message.inputValue()}\n\nMy card is 4111 1111 1111 1111.`);
  await page.getByRole('button', { name: copy.requests.save }).click();
  await expect(page.getByText(ERROR_MESSAGES.draft_unsafe)).toBeVisible();
  await expect(page.getByText(copy.requests.saved)).toHaveCount(0);
  await page.reload();
  expect(await page.getByLabel(copy.requests.message).inputValue()).not.toContain('4111');
});

test('when real sending is not available, send says so and the request stays unsent', async ({ page }) => {
  await toOverview(page);
  await draftFor(page, 'E2E Bank');
  const id = await firstRequestId(page);
  await resolveOpenLine(page, id);
  // The e2e stack always uses the test sender, so the refusal the real configuration gives is staged at the network.
  await page.route('**/v1/requests/*/send', async (route) => {
    const headers = { 'access-control-allow-origin': WEB, 'access-control-allow-credentials': 'true', 'content-type': 'application/problem+json' };
    if (route.request().method() === 'OPTIONS') return route.continue();
    return route.fulfill({ status: 503, headers, body: JSON.stringify({ type: 'urn:erase:problem:real_send_blocked', title: 'Problem', status: 503, code: 'real_send_blocked', requestId: 'req-e2e', instance: '/v1/requests/x/send' }) });
  });
  const approve = await chooseAndOpen(page, 'E2E Bank');
  await approve.click();
  await expect(page.getByText(ERROR_MESSAGES.real_send_blocked)).toBeVisible();
  await expect(page.getByText(copy.requests.resultSent)).toHaveCount(0);
  await page.goto('/requests');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Bank' }).getByText(copy.labels.requestStatus.approved, { exact: true })).toBeVisible();
});

test('signing out leaves no cached data or stored keys on the device', async ({ page }) => {
  await toOverview(page);
  await expect(page.getByText('E2E Bank', { exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('erase.test', 'x'));
  await page.getByRole('button', { name: copy.common.signOut }).click();
  await page.waitForURL(`${WEB}/`);
  await expect.poll(() => page.evaluate(async () => ({ caches: await caches.keys(), keys: Object.keys(localStorage).filter((k) => k.startsWith('erase.')), session: Object.keys(sessionStorage) }))).toEqual({ caches: [], keys: [], session: [] });
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(databases).toEqual([]);
  // The signed-in screens are no longer reachable.
  await page.goto('/overview');
  await expect(page.getByRole('link', { name: copy.signIn.button })).toBeVisible();
  expect(await page.content()).not.toContain('E2E Bank');
});
