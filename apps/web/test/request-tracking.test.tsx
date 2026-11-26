import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { RequestDetail } from '@/components/RequestDetail';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { findViolations } from './banned';
import { problem, renderApp } from './helpers';

const ID = 'req_00000000000000000000000001';
const T = '2026-11-20T09:00:00.000Z';
const SENT = '2026-11-21T09:00:00.000Z';
const draft = (hash: string, over: Record<string, unknown> = {}) => ({
  version: 1,
  to: 'privacy@examplo.example',
  subject: 'Re: Request to erase my personal data',
  body: `Follow-up text ${hash}`,
  hash,
  createdBy: 'template',
  createdAt: T,
  ...over,
});
const followup = (over: Record<string, unknown> = {}) => ({
  state: 'none',
  dueAt: null,
  remaining: 1,
  sequence: null,
  sentAt: null,
  draft: null,
  approved: false,
  canCreate: false,
  canSend: false,
  canMarkSubmitted: false,
  blockers: [],
  ...over,
});
interface Over {
  request?: Record<string, unknown>;
  [key: string]: unknown;
}
const view = (status: string, over: Over = {}) => {
  const { request, ...rest } = over;
  const unsent = status === 'drafted' || status === 'approved';
  return {
    request: { id: ID, status, channel: 'email', createdAt: T, updatedAt: T, sentAt: unsent ? null : SENT, dueAt: unsent ? null : '2026-12-21T09:00:00.000Z', ...request },
    company: { id: 'cmp_1', name: 'Examplo', mustKeep: false, kept: false, selfServeUrl: null },
    contact: { channel: 'email', formUrl: null },
    useForm: false,
    draft: draft('first-v1', { subject: 'Request to erase my personal data', body: 'First message' }),
    approved: !unsent,
    events: [],
    canSend: false,
    blockers: [],
    replies: { count: 0, automaticCount: 0, firstAt: null, lastAt: null, senderMatch: null },
    outcome: unsent ? null : { value: 'no_answer_yet', setByUser: false, at: null },
    canSetOutcome: !unsent,
    canMarkSubmitted: false,
    followup: followup(),
    ...rest,
  };
};
const get = (v: ReturnType<typeof view>) => ({ [`GET /v1/requests/${ID}`]: { body: v } });
const path = (p: string) => `/v1/requests/${ID}${p}`;
const show = (routes: Parameters<typeof renderApp>[1]) => renderApp(<RequestDetail id={ID} />, routes);
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const noClose = () => expect(screen.queryByRole('button', { name: copy.requests.markClosed })).toBeNull();

describe('waiting for an answer', () => {
  it('shows when a follow-up is offered, no reply yet, and no way to close a sent request', async () => {
    const { container } = show(get(view('sent', { followup: followup({ state: 'not_due', dueAt: '2026-12-21T09:00:00.000Z' }) })));
    expect(await screen.findByText(copy.followup.notDue('21 Dec 2026'))).toBeTruthy();
    expect(screen.getByText(copy.replies.none)).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.followup.create })).toBeNull();
    noClose();
    expect(findViolations(container.textContent ?? '')).toEqual([]);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('labels an automatic reply and says the wait goes on', async () => {
    show(get(view('sent', { replies: { count: 0, automaticCount: 2, firstAt: null, lastAt: null, senderMatch: null } })));
    expect(await screen.findByText(copy.replies.automatic)).toBeTruthy();
    expect(screen.getByText(copy.replies.automaticNote(2))).toBeTruthy();
    expect(screen.getByText(copy.replies.none)).toBeTruthy();
  });
});

describe('a reply and the person’s report', () => {
  const replied = view('reply_received', { replies: { count: 2, automaticCount: 0, firstAt: SENT, lastAt: '2026-11-24T09:00:00.000Z', senderMatch: 'other' } });

  it('shows the count and time, points to Gmail, warns about another domain, and offers no Close', async () => {
    show(get(replied));
    expect(await screen.findByText(copy.replies.found(2, '24 Nov 2026'))).toBeTruthy();
    expect(screen.getByText(copy.replies.headersOnly)).toBeTruthy();
    expect(screen.getByText(copy.replies.otherDomain)).toBeTruthy();
    noClose();
  });

  it('records the answer the person chooses, and shows it as their report', async () => {
    const after = view('replied_deleted', { outcome: { value: 'confirmed_erased', setByUser: true, at: '2026-11-25T09:00:00.000Z' } });
    const { api } = show({ ...get(replied), [`PUT ${path('/outcome')}`]: { body: after } });
    const save = await screen.findByRole('button', { name: copy.common.save });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: copy.outcome.options.confirmed_erased }));
    api.set(`GET /v1/requests/${ID}`, { body: after });
    await userEvent.click(button(copy.common.save));
    expect(await screen.findByText(copy.outcome.reported(copy.outcome.options.confirmed_erased))).toBeTruthy();
    expect(api.calls(`PUT ${path('/outcome')}`)[0]?.body).toEqual({ outcome: 'confirmed_erased' });
    expect(screen.getByText(copy.outcome.saved)).toBeTruthy();
    // An answered request can be closed.
    expect(screen.getByRole('button', { name: copy.requests.markClosed })).toBeTruthy();
  });

  it('shows a refusal by the API as a message, never the server’s sentence', async () => {
    show({ ...get(replied), [`PUT ${path('/outcome')}`]: problem(409, 'invalid_transition') });
    await userEvent.click(await screen.findByRole('radio', { name: copy.outcome.options.refused }));
    await userEvent.click(button(copy.common.save));
    expect(await screen.findByText(ERROR_MESSAGES.invalid_transition)).toBeTruthy();
    expect(screen.queryByText(/server sentence/)).toBeNull();
  });
});

describe('a web-form request', () => {
  const form = (over: Over = {}) =>
    view('drafted', { useForm: true, contact: { channel: 'web_form', formUrl: 'https://examplo.example/form' }, canMarkSubmitted: true, blockers: [{ code: 'use_form', message: 'm' }], ...over });

  it('lets the person edit and copy the draft, and marks the version shown as submitted. Nothing is sent', async () => {
    const done = view('sent', { useForm: true, request: { channel: 'web_form' } });
    const { api, container } = show({ ...get(form()), [`POST ${path('/submitted')}`]: { body: done } });
    expect(await screen.findByLabelText(copy.requests.message)).toBeTruthy();
    // The form is the way to send, so it is not shown as something blocking.
    expect(screen.queryByText(ERROR_MESSAGES.use_form)).toBeNull();
    expect(screen.queryByRole('button', { name: copy.requests.sendConfirm })).toBeNull();
    api.set(`GET /v1/requests/${ID}`, { body: done });
    await userEvent.click(button(copy.requests.submitAction));
    expect(await screen.findByText(copy.replies.webForm)).toBeTruthy();
    expect(api.calls(`POST ${path('/submitted')}`)[0]?.body).toEqual({ draftHash: 'first-v1' });
    expect(screen.getByText(new RegExp(copy.requests.submittedOn('21 Nov 2026')))).toBeTruthy();
    expect(api.requests.some((r) => r.path.endsWith('/send'))).toBe(false);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps "Mark as submitted" off while the draft has unsaved edits or the API says it is not ready', async () => {
    show(get(form({ canMarkSubmitted: false, blockers: [{ code: 'draft_unsafe', message: 'm', findings: ['open_placeholder'] }] })));
    expect((await screen.findByRole('button', { name: copy.requests.submitAction }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(copy.requests.placeholderBody)).toBeTruthy();
  });
});

describe('the follow-up', () => {
  const due = view('sent', { followup: followup({ state: 'due', canCreate: true, dueAt: SENT }) });
  const drafted = (over: Record<string, unknown> = {}, top: Over = {}) =>
    view('no_reply', { followup: followup({ state: 'drafted', sequence: 1, draft: draft('f-v1'), ...over }), ...top });

  it('"Follow up?" prepares the draft and sends nothing', async () => {
    const { api } = show({ ...get(due), [`POST ${path('/followup')}`]: { body: drafted() } });
    const create = await screen.findByRole('button', { name: copy.followup.create });
    expect(screen.getByText(copy.followup.createHelp)).toBeTruthy();
    api.set(`GET /v1/requests/${ID}`, { body: drafted() });
    await userEvent.click(create);
    expect(await screen.findByRole('button', { name: copy.followup.approveAndSend })).toBeTruthy();
    expect(api.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([path('/followup')]);
  });

  it('explains why a due follow-up cannot be prepared', async () => {
    show(get(view('sent', { followup: followup({ state: 'due', canCreate: false, blockers: [{ code: 'kept', message: 'm' }] }) })));
    expect(await screen.findByText(copy.followup.dueBlocked)).toBeTruthy();
    expect(screen.getByText(ERROR_MESSAGES.kept)).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.followup.create })).toBeNull();
  });

  it('approves exactly the version shown, then sends with one Idempotency-Key, and labels a test send', async () => {
    const sent = view('no_reply', { followup: followup({ state: 'sent', sequence: 1, remaining: 0, sentAt: '2026-12-22T09:00:00.000Z', draft: draft('f-v1') }), events: [{ type: 'followup_sent', actor: 'user', at: T, payload: { delivery: 'fake' } }] });
    const { api, container } = show({
      ...get(drafted()),
      [`POST ${path('/followup/approve')}`]: { body: drafted({ state: 'approved', approved: true }) },
      [`POST ${path('/followup/send')}`]: () => {
        api.set(`GET /v1/requests/${ID}`, { body: sent });
        return { body: { followup: { sequence: 1, status: 'sent', sentAt: '2026-12-22T09:00:00.000Z' }, delivery: 'fake', notice: 'server words' } };
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: copy.followup.approveAndSend }));
    expect(await screen.findByText(copy.followup.resultSent)).toBeTruthy();
    expect(screen.getAllByText(copy.requests.fakeNotice).length).toBeGreaterThan(0);
    expect(screen.queryByText('server words')).toBeNull();
    expect(api.calls(`POST ${path('/followup/approve')}`)[0]?.body).toEqual({ draftHash: 'f-v1' });
    expect(api.calls(`POST ${path('/followup/send')}`)[0]?.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(await screen.findByText(copy.followup.sentOn('22 Dec 2026'))).toBeTruthy();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('reuses the same key when sending is tried again', async () => {
    const approved = drafted({ state: 'approved', approved: true });
    const { api } = show({ ...get(approved), [`POST ${path('/followup/send')}`]: problem(502, 'send_failed') });
    await userEvent.click(await screen.findByRole('button', { name: copy.followup.approveAndSend }));
    await screen.findByText(ERROR_MESSAGES.send_failed);
    await userEvent.click(screen.getByRole('button', { name: copy.common.retry }));
    await waitFor(() => expect(api.calls(`POST ${path('/followup/send')}`)).toHaveLength(2));
    const keys = api.calls(`POST ${path('/followup/send')}`).map((r) => r.headers.get('idempotency-key'));
    expect(keys[0]).toBe(keys[1]);
    // Already approved, so it is not approved again.
    expect(api.calls(`POST ${path('/followup/approve')}`)).toHaveLength(0);
  });

  it('stops at draft_changed: nothing is retried or sent, and the new version must be read first', async () => {
    const changed = drafted({ draft: draft('f-v2', { version: 2 }) });
    const { api } = show({
      ...get(drafted()),
      [`POST ${path('/followup/approve')}`]: () => {
        api.set(`GET /v1/requests/${ID}`, { body: changed });
        return problem(409, 'draft_changed');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: copy.followup.approveAndSend }));
    expect((await screen.findAllByText(ERROR_MESSAGES.draft_changed)).length).toBeGreaterThan(0);
    expect(await screen.findByText(copy.followup.changed)).toBeTruthy();
    expect(button(copy.followup.approveAndSend).disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(api.calls(`POST ${path('/followup/approve')}`)).toHaveLength(1);
    expect(api.calls(`POST ${path('/followup/send')}`)).toHaveLength(0);
    await userEvent.click(button(copy.followup.open));
    expect(button(copy.followup.approveAndSend).disabled).toBe(false);
  });

  it('after an edit, locks approving until the saved version is read, and approves that version', async () => {
    const saved = drafted({ draft: draft('f-v2', { body: 'My own words', version: 2 }) });
    const { api } = show({
      ...get(drafted()),
      [`PATCH ${path('/followup/draft')}`]: () => {
        api.set(`GET /v1/requests/${ID}`, { body: saved });
        return { body: saved };
      },
      [`POST ${path('/followup/approve')}`]: problem(409, 'draft_changed'),
    });
    const message = (await screen.findAllByLabelText(copy.requests.message))[0] as HTMLTextAreaElement;
    await userEvent.clear(message);
    await userEvent.type(message, 'My own words');
    expect(button(copy.followup.approveAndSend).disabled).toBe(true);
    await userEvent.click(button(copy.requests.save));
    expect(await screen.findByText(copy.followup.saved)).toBeTruthy();
    expect(api.calls(`PATCH ${path('/followup/draft')}`)[0]?.body).toMatchObject({ baseHash: 'f-v1', body: 'My own words' });
    expect(button(copy.followup.approveAndSend).disabled).toBe(true);
    await userEvent.click(button(copy.followup.open));
    await userEvent.click(button(copy.followup.approveAndSend));
    await waitFor(() => expect(api.calls(`POST ${path('/followup/approve')}`)[0]?.body).toEqual({ draftHash: 'f-v2' }));
  });

  it('after saving and reading, a change made elsewhere is still announced', async () => {
    const saved = drafted({ draft: draft('f-v2', { body: 'My own words', version: 2 }) });
    const elsewhere = drafted({ draft: draft('f-v3', { body: 'Changed elsewhere', version: 3 }) });
    const { api } = show({
      ...get(drafted()),
      [`PATCH ${path('/followup/draft')}`]: () => {
        api.set(`GET /v1/requests/${ID}`, { body: saved });
        return { body: saved };
      },
      [`POST ${path('/followup/approve')}`]: () => {
        api.set(`GET /v1/requests/${ID}`, { body: elsewhere });
        return problem(409, 'draft_changed');
      },
    });
    const message = (await screen.findAllByLabelText(copy.requests.message))[0] as HTMLTextAreaElement;
    await userEvent.type(message, ' more');
    await userEvent.click(button(copy.requests.save));
    await screen.findByText(copy.followup.saved);
    await userEvent.click(button(copy.followup.open));
    await userEvent.click(button(copy.followup.approveAndSend));
    expect(await screen.findByText(copy.followup.changed)).toBeTruthy();
    expect(screen.queryByText(copy.followup.saved)).toBeNull();
    expect(button(copy.followup.approveAndSend).disabled).toBe(true);
  });

  it('shows why it cannot be sent (real sending off) and keeps sending disabled', async () => {
    show(get(drafted({ blockers: [{ code: 'real_send_blocked', message: 'm' }] })));
    expect((await screen.findByRole('button', { name: copy.followup.approveAndSend }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(ERROR_MESSAGES.real_send_blocked)).toBeTruthy();
  });

  it('for a web form is copy only: the version shown is marked as submitted, and there is no send', async () => {
    const formDraft = view('no_reply', {
      useForm: true,
      contact: { channel: 'web_form', formUrl: 'https://examplo.example/form' },
      request: { channel: 'web_form' },
      followup: followup({ state: 'drafted', sequence: 1, draft: draft('f-v1'), canMarkSubmitted: true }),
    });
    const done = view('no_reply', { request: { channel: 'web_form' }, followup: followup({ state: 'submitted', sequence: 1, remaining: 0, sentAt: '2026-12-22T09:00:00.000Z', draft: draft('f-v1') }) });
    const { api } = show({ ...get(formDraft), [`POST ${path('/followup/submitted')}`]: { body: done } });
    expect(await screen.findByText(copy.followup.formBody)).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.followup.approveAndSend })).toBeNull();
    api.set(`GET /v1/requests/${ID}`, { body: done });
    await userEvent.click(button(copy.requests.submitAction));
    expect(await screen.findByText(copy.followup.submittedOn('22 Dec 2026'))).toBeTruthy();
    expect(api.calls(`POST ${path('/followup/submitted')}`)[0]?.body).toEqual({ draftHash: 'f-v1' });
    expect(api.requests.some((r) => r.path.endsWith('/send') || r.path.endsWith('/approve'))).toBe(false);
  });

  it('shows nothing about a follow-up when none applies', async () => {
    show(get(view('replied_refused', { outcome: { value: 'refused', setByUser: true, at: T } })));
    await screen.findByText(copy.outcome.reported(copy.outcome.options.refused));
    expect(screen.queryByRole('heading', { name: copy.followup.title })).toBeNull();
  });
});

describe('the first draft', () => {
  it('after saving and reading, a change made elsewhere is still announced', async () => {
    const unsent = view('drafted');
    const saved = view('drafted', { draft: draft('first-v2', { body: 'My own words', version: 2 }) });
    const elsewhere = view('drafted', { draft: draft('first-v3', { body: 'Changed elsewhere', version: 3 }) });
    const { api } = show({
      ...get(unsent),
      [`PATCH ${path('/draft')}`]: () => {
        api.set(`GET /v1/requests/${ID}`, { body: saved });
        return { body: saved };
      },
      [`POST ${path('/approve')}`]: () => {
        api.set(`GET /v1/requests/${ID}`, { body: elsewhere });
        return problem(409, 'draft_changed');
      },
    });
    await userEvent.type(await screen.findByLabelText(copy.requests.message), ' more');
    await userEvent.click(button(copy.requests.save));
    await screen.findByText(copy.requests.saved);
    await userEvent.click(button(copy.requests.open));
    await userEvent.click(button(copy.requests.sendConfirm));
    expect(await screen.findByText(copy.requests.changedSince)).toBeTruthy();
    expect(screen.queryByText(copy.requests.saved)).toBeNull();
    expect(button(copy.requests.sendConfirm).disabled).toBe(true);
  });
});

describe('the history', () => {
  it('words each entry by what it means', async () => {
    show(
      get(
        view('replied_refused', {
          events: [
            { type: 'reply_label', actor: 'system', at: '2026-11-21T09:00:00.000Z', payload: { to: 'no_reply' } },
            { type: 'outcome_set', actor: 'user', at: '2026-11-22T09:00:00.000Z', payload: { outcome: 'refused' } },
            { type: 'submitted', actor: 'user', at: '2026-11-23T09:00:00.000Z', payload: { followup: 1 } },
          ],
        }),
      ),
    );
    expect(await screen.findByText(copy.labels.eventNoReply)).toBeTruthy();
    expect(screen.getAllByText(copy.outcome.reported(copy.outcome.options.refused)).length).toBeGreaterThan(0);
    expect(screen.getByText(copy.labels.eventFollowupSubmitted)).toBeTruthy();
    expect(screen.queryByText(copy.labels.event.reply_label)).toBeNull();
  });
});
