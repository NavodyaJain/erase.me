import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { RequestDetail } from '@/components/RequestDetail';
import { RequestsList } from '@/components/RequestsList';
import { ReviewScreen } from '@/components/ReviewScreen';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { findViolations } from './banned';
import { problem, renderApp } from './helpers';

const rid = (n: number) => `req_${String(n).padStart(26, '0')}`;
const view = (n: number, over: Record<string, unknown> = {}, draft: Record<string, unknown> = {}) => ({
  request: { id: rid(n), status: 'drafted', createdAt: '2026-11-20T09:00:00.000Z', updatedAt: '2026-11-20T09:00:00.000Z', sentAt: null, dueAt: null },
  company: { id: `cmp_${n}`, name: `Examplo ${n}`, mustKeep: false, kept: false, selfServeUrl: null },
  contact: { channel: 'email', formUrl: null },
  useForm: false,
  draft: { version: 1, to: `privacy@examplo${n}.example`, subject: 'Request to erase my personal data', body: `Dear Examplo ${n}, please erase my data.`, hash: `hash-${n}-v1`, createdBy: 'template', createdAt: '2026-11-20T09:00:00.000Z', ...draft },
  approved: false,
  events: [{ type: 'drafted', actor: 'system', at: '2026-11-20T09:00:00.000Z', payload: {} }],
  canSend: true,
  blockers: [],
  ...over,
});
const item = (n: number, status = 'drafted') => ({ id: rid(n), status, company: { name: `Examplo ${n}`, mustKeep: false }, createdAt: '2026-11-20T09:00:00.000Z', updatedAt: '2026-11-20T09:00:00.000Z', sentAt: null, dueAt: null });
const sentBody = (n: number) => ({ request: { id: rid(n), status: 'sent', sentAt: '2026-11-22T09:00:00.000Z', dueAt: '2026-12-22T09:00:00.000Z' }, delivery: 'fake', notice: 'server words' });

const routes = (views: ReturnType<typeof view>[]) => ({
  'GET /v1/requests': { body: { requests: views.map((v, i) => item(i + 1, v.request.status)) } },
  ...Object.fromEntries(views.map((v) => [`GET /v1/requests/${v.request.id}`, { body: v }])),
});

describe('Review and send', () => {
  it('keeps "Approve and send" disabled until each chosen draft has been opened', async () => {
    renderApp(<ReviewScreen />, routes([view(1), view(2)]));
    await userEvent.click(await screen.findByRole('checkbox', { name: copy.requests.choose('Examplo 1') }));
    await userEvent.click(screen.getByRole('checkbox', { name: copy.requests.choose('Examplo 2') }));
    const button = screen.getByRole('button', { name: copy.requests.approveAndSend(2) });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const [first, second] = screen.getAllByRole('button', { name: copy.requests.open });
    await userEvent.click(first as HTMLElement);
    expect(screen.getByText('Dear Examplo 1, please erase my data.')).toBeTruthy();
    expect((screen.getByRole('button', { name: copy.requests.approveAndSend(2) }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(second as HTMLElement);
    expect((screen.getByRole('button', { name: copy.requests.approveAndSend(2) }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('approves the exact hash that was opened, then sends with an Idempotency-Key, and labels a test send', async () => {
    const { api } = renderApp(<ReviewScreen />, {
      ...routes([view(1)]),
      [`POST /v1/requests/${rid(1)}/approve`]: { body: view(1, { approved: true, request: { ...view(1).request, status: 'approved' } }) },
      [`POST /v1/requests/${rid(1)}/send`]: { body: sentBody(1) },
    });
    await userEvent.click(await screen.findByRole('checkbox', { name: copy.requests.choose('Examplo 1') }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.open }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.approveAndSend(1) }));
    expect(await screen.findByText(copy.requests.resultSent)).toBeTruthy();
    expect(screen.getByText(copy.requests.fakeNotice)).toBeTruthy();
    expect(screen.queryByText('server words')).toBeNull();
    expect(api.calls(`POST /v1/requests/${rid(1)}/approve`)[0]?.body).toEqual({ draftHash: 'hash-1-v1' });
    const send = api.calls(`POST /v1/requests/${rid(1)}/send`)[0];
    expect(send?.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(send?.headers.get('x-csrf-token')).toBe('csrf-token-1');
  });

  it('a draft that changed after it was opened shows draft_changed, and nothing is retried or sent', async () => {
    const { api } = renderApp(<ReviewScreen />, {
      ...routes([view(1)]),
      [`POST /v1/requests/${rid(1)}/approve`]: problem(409, 'draft_changed'),
      [`POST /v1/requests/${rid(1)}/send`]: { body: sentBody(1) },
    });
    await userEvent.click(await screen.findByRole('checkbox', { name: copy.requests.choose('Examplo 1') }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.open }));
    // The draft is edited somewhere else after the person opened it.
    api.set(`GET /v1/requests/${rid(1)}`, { body: view(1, {}, { version: 2, hash: 'hash-1-v2', body: 'A different message.' }) });
    await userEvent.click(screen.getByRole('button', { name: copy.requests.approveAndSend(1) }));
    expect(await screen.findByText(ERROR_MESSAGES.draft_changed)).toBeTruthy();
    expect(api.calls(`POST /v1/requests/${rid(1)}/approve`)).toHaveLength(1); // no silent retry
    expect(api.calls(`POST /v1/requests/${rid(1)}/send`)).toHaveLength(0);
    expect((api.calls(`POST /v1/requests/${rid(1)}/approve`)[0]?.body as { draftHash: string }).draftHash).toBe('hash-1-v1');
    // The latest version has not been read yet, so approval is locked again until it is opened.
    expect((screen.getByRole('button', { name: copy.requests.approveAndSend(0) }) as HTMLButtonElement).disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(api.calls(`POST /v1/requests/${rid(1)}/approve`)).toHaveLength(1);
  });

  it('never approves a version the person has not opened, even when the page refreshed to a newer one', async () => {
    const { api, queryClient } = renderApp(<ReviewScreen />, { ...routes([view(1)]), [`POST /v1/requests/${rid(1)}/approve`]: { body: view(1) }, [`POST /v1/requests/${rid(1)}/send`]: { body: sentBody(1) } });
    await userEvent.click(await screen.findByRole('checkbox', { name: copy.requests.choose('Examplo 1') }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.open }));
    api.set(`GET /v1/requests/${rid(1)}`, { body: view(1, {}, { version: 2, hash: 'hash-1-v2', body: 'Changed text.' }) });
    await queryClient.invalidateQueries({ queryKey: ['request', rid(1)] });
    expect(await screen.findByText(copy.requests.changedSince)).toBeTruthy();
    expect((screen.getByRole('button', { name: copy.requests.approveAndSend(1) }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.calls(`POST /v1/requests/${rid(1)}/approve`)).toHaveLength(0);
  });

  it('keeps one Idempotency-Key for a retry after an unknown send outcome', async () => {
    let n = 0;
    const { api } = renderApp(<ReviewScreen />, {
      ...routes([view(1)]),
      [`POST /v1/requests/${rid(1)}/approve`]: { body: view(1, { approved: true, request: { ...view(1).request, status: 'approved' } }) },
      [`POST /v1/requests/${rid(1)}/send`]: () => (n++ === 0 ? problem(502, 'send_outcome_unknown') : { body: sentBody(1) }),
    });
    await userEvent.click(await screen.findByRole('checkbox', { name: copy.requests.choose('Examplo 1') }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.open }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.approveAndSend(1) }));
    expect(await screen.findByText(ERROR_MESSAGES.send_outcome_unknown)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: copy.common.retry }));
    expect(await screen.findByText(copy.requests.resultSent)).toBeTruthy();
    const keys = api.calls(`POST /v1/requests/${rid(1)}/send`).map((c) => c.headers.get('idempotency-key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it.each(['must_keep', 'kept', 'no_contact', 'use_form', 'draft_unsafe', 'send_in_progress', 'real_send_blocked', 'send_disabled', 'contact_bounced', 'rate_limited'])('shows the right message for %s at send', async (code) => {
    renderApp(<ReviewScreen />, {
      ...routes([view(1)]),
      [`POST /v1/requests/${rid(1)}/approve`]: { body: view(1) },
      [`POST /v1/requests/${rid(1)}/send`]: problem(code === 'rate_limited' ? 429 : 409, code),
    });
    await userEvent.click(await screen.findByRole('checkbox', { name: copy.requests.choose('Examplo 1') }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.open }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.approveAndSend(1) }));
    expect(await screen.findByText((ERROR_MESSAGES as Record<string, string>)[code] as string)).toBeTruthy();
    expect(screen.queryByText('A server sentence that the app must not show.')).toBeNull();
  });

  it('shows the web-form flow for use_form: link, copy button, close, and no checkbox to send', async () => {
    const form = view(2, { useForm: true, canSend: false, contact: { channel: 'web_form', formUrl: 'https://examplo2.example/privacy-form' }, blockers: [{ code: 'use_form', message: 'x' }] }, { to: 'https://examplo2.example/privacy-form' });
    renderApp(<ReviewScreen />, routes([view(1), form]));
    expect(await screen.findByText(copy.requests.useFormBody)).toBeTruthy();
    expect(screen.getByRole('link', { name: copy.requests.useFormOpen }).getAttribute('href')).toBe('https://examplo2.example/privacy-form');
    expect(screen.getByRole('button', { name: copy.requests.copyDraft })).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('shows why a draft cannot be sent, and puts an unfinished line in its own words', async () => {
    const blocked = view(1, { canSend: false, blockers: [{ code: 'draft_unsafe', message: 'x', findings: ['open_placeholder'] }, { code: 'kept', message: 'x' }] });
    renderApp(<ReviewScreen />, routes([blocked]));
    expect(await screen.findByText(copy.requests.placeholderBody)).toBeTruthy();
    expect(screen.getByText(ERROR_MESSAGES.kept)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('shows an empty state and an error state', async () => {
    renderApp(<ReviewScreen />, { 'GET /v1/requests': { body: { requests: [] } } });
    expect(await screen.findByText(copy.requests.reviewEmpty)).toBeTruthy();
    const bad = renderApp(<ReviewScreen />, { 'GET /v1/requests': problem(503, 'not_ready') });
    expect((await within(bad.container).findByRole('alert')).textContent).toBe(ERROR_MESSAGES.not_ready);
  });

  it('is accessible and uses rule-abiding wording', async () => {
    const { container } = renderApp(<ReviewScreen />, routes([view(1)]));
    await userEvent.click(await screen.findByRole('button', { name: copy.requests.open }));
    expect(await axe(container)).toHaveNoViolations();
    expect(findViolations(document.body.textContent ?? '')).toEqual([]);
  });
});

describe('Request detail', () => {
  const id = rid(1);
  it('edits the draft with the base hash, keeps the recipient fixed, and locks sending until the new version is opened', async () => {
    const saved = view(1, {}, { version: 2, hash: 'hash-1-v2', subject: 'New subject' });
    const { api } = renderApp(<RequestDetail id={id} />, { [`GET /v1/requests/${id}`]: { body: view(1) }, [`PATCH /v1/requests/${id}/draft`]: { body: saved } });
    const subject = await screen.findByLabelText(copy.requests.subject);
    expect(screen.getByText('privacy@examplo1.example')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: copy.requests.to })).toBeNull();
    await userEvent.clear(subject);
    await userEvent.type(subject, 'New subject');
    await userEvent.click(screen.getByRole('button', { name: copy.requests.save }));
    expect(await screen.findByText(copy.requests.saved)).toBeTruthy();
    expect(api.calls(`PATCH /v1/requests/${id}/draft`)[0]?.body).toMatchObject({ baseHash: 'hash-1-v1', subject: 'New subject' });
    expect((screen.getByRole('button', { name: copy.requests.sendConfirm }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows draft_changed when the draft was edited elsewhere, and does not retry', async () => {
    const { api } = renderApp(<RequestDetail id={id} />, { [`GET /v1/requests/${id}`]: { body: view(1) }, [`PATCH /v1/requests/${id}/draft`]: problem(409, 'draft_changed') });
    const subject = await screen.findByLabelText(copy.requests.subject);
    await userEvent.type(subject, '!');
    await userEvent.click(screen.getByRole('button', { name: copy.requests.save }));
    expect(await screen.findByText(ERROR_MESSAGES.draft_changed)).toBeTruthy();
    expect(api.calls(`PATCH /v1/requests/${id}/draft`)).toHaveLength(1);
  });

  it('approves the opened version and sends, and shows the test-send notice', async () => {
    const { api } = renderApp(<RequestDetail id={id} />, {
      [`GET /v1/requests/${id}`]: { body: view(1) },
      [`POST /v1/requests/${id}/approve`]: { body: view(1) },
      [`POST /v1/requests/${id}/send`]: { body: sentBody(1) },
    });
    await userEvent.click(await screen.findByRole('button', { name: copy.requests.sendConfirm }));
    expect(await screen.findByText(copy.requests.fakeNotice)).toBeTruthy();
    expect(api.calls(`POST /v1/requests/${id}/approve`)[0]?.body).toEqual({ draftHash: 'hash-1-v1' });
  });

  it('shows a test-send notice from the event history of a sent request', async () => {
    const sent = view(1, { request: { ...view(1).request, status: 'sent', sentAt: '2026-11-22T09:00:00.000Z', dueAt: '2026-12-22T09:00:00.000Z' }, events: [{ type: 'sent', actor: 'user', at: '2026-11-22T09:00:00.000Z', payload: { delivery: 'fake' } }] });
    renderApp(<RequestDetail id={id} />, { [`GET /v1/requests/${id}`]: { body: sent } });
    expect(await screen.findByText(copy.requests.fakeNotice)).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.requests.sendConfirm })).toBeNull();
  });

  it('closes a request after asking', async () => {
    const { api } = renderApp(<RequestDetail id={id} />, { [`GET /v1/requests/${id}`]: { body: view(1) }, [`POST /v1/requests/${id}/close`]: { body: view(1, { request: { ...view(1).request, status: 'closed' } }) } });
    await userEvent.click(await screen.findByRole('button', { name: copy.requests.markClosed }));
    await userEvent.click(screen.getByRole('button', { name: copy.requests.closeConfirm }));
    expect(await screen.findByText(copy.requests.closed)).toBeTruthy();
    expect(api.calls(`POST /v1/requests/${id}/close`)).toHaveLength(1);
  });

  it('shows an error if the request cannot be found', async () => {
    renderApp(<RequestDetail id={id} />, { [`GET /v1/requests/${id}`]: problem(404, 'not_found') });
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_MESSAGES.not_found);
  });
});

describe('Requests list', () => {
  it('lists requests with status, and handles empty and error', async () => {
    const { container } = renderApp(<RequestsList />, { 'GET /v1/requests': { body: { requests: [item(1), item(2, 'sent')] } } });
    expect(await screen.findByRole('link', { name: 'Examplo 1' })).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
    const empty = renderApp(<RequestsList />, { 'GET /v1/requests': { body: { requests: [] } } });
    expect(await within(empty.container).findByText(copy.requests.listEmpty)).toBeTruthy();
    const bad = renderApp(<RequestsList />, { 'GET /v1/requests': problem(503, 'not_ready') });
    expect((await within(bad.container).findByRole('alert')).textContent).toBe(ERROR_MESSAGES.not_ready);
  });
});
