import type { Page } from '@playwright/test';
import { ERROR_MESSAGES } from '../src/copy/errors';
import {
  advanceDays,
  API,
  copy,
  draftFor,
  expect,
  FIRST_EMAIL,
  firstRequestId,
  personData,
  recordPosts,
  removeOpenLine,
  replyArrives,
  resolveOpenLine,
  runJob,
  sendRequest,
  signIn,
  test,
  toOverview,
} from './helpers';

const WEB = 'http://localhost:3100';
/** The status chip beside the company's name, not the same words in the history. */
const status = (page: Page, text: string) => page.locator('.page-head').getByText(text, { exact: true });
const followUpButton = (page: Page) => page.getByRole('button', { name: copy.followup.approveAndSend });

/** A sent request, 31 days later, with the person signed in again and the follow-up drafted. */
async function draftedFollowup(page: Page): Promise<string> {
  await toOverview(page);
  const id = await sendRequest(page);
  await advanceDays(page.request, 31);
  await signIn(page);
  await page.goto(`/requests/${id}`);
  await page.getByRole('button', { name: copy.followup.create }).click();
  await expect(followUpButton(page)).toBeVisible();
  return id;
}

/** Takes the unfinished line out of the follow-up, saves, and opens the saved version. */
async function finishFollowup(page: Page): Promise<void> {
  const message = page.getByLabel(copy.requests.message);
  await message.fill(removeOpenLine(await message.inputValue()));
  await page.getByRole('button', { name: copy.requests.save }).click();
  await expect(page.getByText(copy.followup.saved)).toBeVisible();
  await expect(followUpButton(page)).toBeDisabled(); // the saved version has not been read yet
  await page.getByRole('button', { name: copy.followup.open }).click();
  await expect(followUpButton(page)).toBeEnabled();
}

test('a reply arrives: the person sees "Reply received" and records the answer, shown as their report', async ({ page }) => {
  await toOverview(page);
  const id = await sendRequest(page);
  await replyArrives(page.request, id);
  expect(await runJob(page.request, 'poll-replies')).toMatchObject({ checked: 1, replied: 1, newReplies: 1 });

  await page.goto('/overview');
  await expect(page.getByText(copy.overview.next.replies(1, 'E2E Bank'))).toBeVisible();
  await page.goto(`/requests/${id}`);
  await expect(status(page, copy.labels.requestStatus.reply_received)).toBeVisible();
  await expect(page.getByText(/^1 reply found, the latest on /)).toBeVisible();
  await expect(page.getByText(copy.replies.headersOnly)).toBeVisible();
  await expect(page.getByRole('button', { name: copy.requests.markClosed })).toHaveCount(0);

  const answer = copy.outcome.options.confirmed_erased;
  await page.getByRole('radio', { name: answer }).check();
  await page.getByRole('button', { name: copy.common.save, exact: true }).click();
  await expect(page.getByText(copy.outcome.saved)).toBeVisible();
  await expect(page.getByText(copy.outcome.reported(answer)).first()).toBeVisible();
  await expect(status(page, copy.labels.requestStatus.replied_deleted)).toBeVisible();

  await page.goto('/requests');
  await expect(page.getByLabel(copy.tracker.summaryLabel)).toContainText(copy.tracker.erased);
  await expect(page.getByText(copy.tracker.erasedNote)).toBeVisible();
  await page.goto('/overview');
  await expect(page.getByLabel(copy.overview.cards.control)).toContainText(copy.overview.cards.controlErased(1));
});

test('an automatic reply is labelled, changes no status, and does not stop the follow-up clock', async ({ page }) => {
  await toOverview(page);
  const id = await sendRequest(page);
  await replyArrives(page.request, id, true);
  expect(await runJob(page.request, 'poll-replies')).toMatchObject({ replied: 0, automatic: 1 });

  await page.goto(`/requests/${id}`);
  await expect(page.getByText(copy.replies.automatic, { exact: true })).toBeVisible();
  await expect(page.getByText(copy.replies.automaticNote(1))).toBeVisible();
  await expect(page.getByText(copy.replies.none)).toBeVisible();
  await expect(status(page, copy.labels.requestStatus.sent)).toBeVisible();
  await expect(page.getByText(/If no reply arrives, a follow-up is offered on /)).toBeVisible();

  await advanceDays(page.request, 31);
  await signIn(page);
  await page.goto(`/requests/${id}`);
  await expect(page.getByRole('button', { name: copy.followup.create })).toBeVisible();
  await expect(page.getByText(copy.replies.automatic, { exact: true })).toBeVisible();
});

test('31 days later: "Follow up?", read the draft, approve and send it as a labelled test send', async ({ page }) => {
  await toOverview(page);
  const id = await sendRequest(page);
  await page.goto(`/requests/${id}`);
  await expect(page.getByRole('button', { name: copy.followup.create })).toHaveCount(0); // not due yet

  await advanceDays(page.request, 31);
  await signIn(page);
  await page.goto('/requests');
  await expect(page.getByText(copy.tracker.followupBanner('E2E Bank'))).toBeVisible();
  await page.getByRole('link', { name: copy.tracker.followupBannerAction, exact: true }).click();
  await expect(page.getByText(copy.followup.createHelp)).toBeVisible();
  await page.getByRole('button', { name: copy.followup.create }).click();

  // The draft is there to be read. Nothing has been sent, and the unfinished line keeps it from being approved.
  await expect(page.getByLabel(copy.requests.message)).toHaveValue(/I am following up on my email of /);
  await expect(page.getByLabel(copy.requests.message)).toHaveValue(/\[OPEN/);
  await expect(followUpButton(page)).toBeDisabled();
  expect((await personData(page.request, { email: FIRST_EMAIL })).deliveries).toEqual(['sent']);
  await finishFollowup(page);

  const approveBody = page.waitForRequest((r) => r.url().endsWith(`/v1/requests/${id}/followup/approve`));
  const sendCall = page.waitForRequest((r) => r.url().endsWith(`/v1/requests/${id}/followup/send`));
  await followUpButton(page).click();
  expect(JSON.parse((await approveBody).postData() ?? '{}')).toHaveProperty('draftHash');
  expect((await sendCall).headers()['idempotency-key']).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  await expect(page.getByText(copy.followup.resultSent)).toBeVisible();
  await expect(page.getByText(copy.requests.fakeNotice).first()).toBeVisible();
  await expect(followUpButton(page)).toHaveCount(0);
  expect((await personData(page.request, { email: FIRST_EMAIL })).deliveries).toEqual(['sent', 'followup_sent']);
});

test('a follow-up edited after it was read is refused with draft_changed, and nothing is retried or sent', async ({ page }) => {
  const id = await draftedFollowup(page);
  await finishFollowup(page);

  // Someone edits the follow-up after this page showed it.
  const me = (await (await page.request.get(`${API}/v1/me`)).json()) as { csrfToken: string };
  const current = (await (await page.request.get(`${API}/v1/requests/${id}`)).json()) as { followup: { draft: { hash: string; subject: string; body: string } } };
  const edit = await page.request.patch(`${API}/v1/requests/${id}/followup/draft`, {
    headers: { 'x-csrf-token': me.csrfToken, origin: WEB },
    data: { baseHash: current.followup.draft.hash, subject: current.followup.draft.subject, body: `${current.followup.draft.body}\n\nOne more line.` },
  });
  expect(edit.status()).toBe(200);

  const calls = recordPosts(page, /\/followup\/(approve|send)$/);
  await followUpButton(page).click();
  await expect(page.getByText(ERROR_MESSAGES.draft_changed).first()).toBeVisible();
  await expect(page.getByText(copy.followup.changed)).toBeVisible();
  await expect(followUpButton(page)).toBeDisabled(); // the new version has to be read first
  await expect(page.getByLabel(copy.requests.message)).toHaveValue(/One more line\./);
  await page.waitForLoadState('networkidle');
  expect(calls).toEqual(['approve']); // one refused approval, no retry, no send
  expect((await personData(page.request, { email: FIRST_EMAIL })).deliveries).toEqual(['sent']);
});

test('a web-form request: copy the draft, mark it as submitted, and nothing is sent', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await toOverview(page);
  await draftFor(page, 'E2E Forms');
  const id = await firstRequestId(page);
  const calls = recordPosts(page, /\/(approve|send|submitted)$/);
  await resolveOpenLine(page, id);

  const submit = page.getByRole('button', { name: copy.requests.submitAction });
  await expect(submit).toBeDisabled(); // the saved version has not been opened yet
  await page.getByRole('button', { name: copy.requests.open }).first().click();
  await expect(submit).toBeEnabled();
  await expect(page.getByRole('button', { name: copy.requests.sendConfirm })).toHaveCount(0);

  await page.getByRole('button', { name: copy.requests.copyDraft }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Request to erase my personal data');
  expect(copied).not.toContain('[OPEN');

  await submit.click();
  await expect(page.getByText(/You marked it as submitted /)).toBeVisible();
  await expect(page.getByText(copy.replies.webForm)).toBeVisible();
  await expect(status(page, copy.labels.requestStatus.sent)).toBeVisible();
  await expect(page.getByText(copy.requests.fakeNotice)).toHaveCount(0);
  expect(calls).toEqual(['submitted']);
  // The API recorded a submission and no send, and there is no Gmail thread to check.
  expect((await personData(page.request, { email: FIRST_EMAIL })).deliveries).toEqual(['submitted']);
  expect(await runJob(page.request, 'poll-replies')).toMatchObject({ checked: 0 });
});
