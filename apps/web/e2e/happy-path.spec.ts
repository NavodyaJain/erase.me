import { copy, draftFor, expect, firstRequestId, test, toOverview } from './helpers';

test('sign in, connect, scan, draft, edit the open line out, approve the exact draft, send (test send), see it as Sent', async ({ page }) => {
  await toOverview(page);

  // The scan found the fictional companies, with hedged labels and a hint, and the must-keep one cannot be chosen.
  await expect(page.getByText('E2E Bank', { exact: true })).toBeVisible();
  await expect(page.getByText(copy.labels.confidence.high).first()).toBeVisible();
  await expect(page.getByText(copy.labels.activity.looks_in_use).first()).toBeVisible();
  await expect(page.getByRole('link', { name: copy.overview.company.selfServe('E2E Bank') })).toHaveAttribute('href', 'https://example.com/e2e-bank/delete-account');
  await expect(page.getByLabel(copy.overview.cards.control)).toContainText('0');

  // Draft one request.
  await draftFor(page, 'E2E Bank');
  await expect(page.getByText(copy.overview.draft.created)).toBeVisible();
  const id = await firstRequestId(page);
  expect(id).toMatch(/^req_/);

  // The draft still has the [OPEN] line, so it cannot be approved yet. Edit it out.
  await page.goto(`/requests/${id}`);
  await expect(page.getByText(copy.requests.placeholderBody)).toBeVisible();
  const message = page.getByLabel(copy.requests.message);
  const withOpenLine = await message.inputValue();
  expect(withOpenLine).toContain('[OPEN');
  await message.fill(withOpenLine.replace(/\[OPEN[\s\S]*?(\n\n|$)/, ''));
  await page.getByRole('button', { name: copy.requests.save }).click();
  await expect(page.getByText(copy.requests.saved)).toBeVisible();
  await expect(page.getByText(copy.requests.placeholderBody)).toHaveCount(0);

  // Review: approval stays locked until the draft is opened, then approves exactly what was opened.
  await page.goto('/requests/review');
  await page.getByRole('checkbox', { name: copy.requests.choose('E2E Bank') }).check();
  const approve = page.getByRole('button', { name: copy.requests.approveAndSend(1) });
  await expect(approve).toBeDisabled();
  await page.getByRole('button', { name: copy.requests.open }).click();
  await expect(page.getByText(copy.requests.opened, { exact: true })).toBeVisible();
  await expect(approve).toBeEnabled();

  const approveBody = page.waitForRequest((r) => r.url().endsWith(`/v1/requests/${id}/approve`));
  const sendCall = page.waitForRequest((r) => r.url().endsWith(`/v1/requests/${id}/send`));
  await approve.click();
  expect(JSON.parse((await approveBody).postData() ?? '{}')).toHaveProperty('draftHash');
  expect((await sendCall).headers()['idempotency-key']).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);

  // The send is a labelled test send: nothing left the machine.
  await expect(page.getByText(copy.requests.resultSent)).toBeVisible();
  await expect(page.getByText(copy.requests.fakeNotice)).toBeVisible();

  // It shows as Sent in Requests and counts on the Overview.
  await page.goto('/requests');
  const row = page.getByRole('listitem').filter({ hasText: 'E2E Bank' });
  await expect(row.getByText(copy.labels.requestStatus.sent, { exact: true })).toBeVisible();
  await page.goto('/overview');
  await expect(page.getByLabel(copy.overview.cards.control)).toContainText('1');
});
