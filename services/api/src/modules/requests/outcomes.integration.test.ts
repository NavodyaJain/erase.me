import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../test/db-helper.js';
import { actorFactory, type Actor, type SeedOptions } from '../../../test/actors.js';
import { authed, buildHarness, type Harness, type Session } from '../../../test/harness.js';
import { createDb } from '../../db/client.js';
import { createTrackerRepository } from '../tracker/tracker.repository.js';
import { FakeGmailSender } from './sender.js';

let t: TestDb;
let h: Harness;
const sender = new FakeGmailSender(true);

beforeAll(async () => {
  t = await createTestDb();
  h = await buildHarness(t, { sender: { kind: 'ready', sender } });
});
afterAll(async () => {
  await h.app.close();
  await t.drop();
});
beforeEach(() => {
  sender.calls = 0;
  sender.messages.length = 0;
  sender.beforeSend = undefined;
});

const actor = actorFactory(() => t);
const key = () => `key-${randomBytes(8).toString('hex')}`;

interface View {
  request: { id: string; status: string; channel: string; sentAt: string | null; dueAt: string | null };
  company: { name: string };
  contact: { channel: string; formUrl: string | null };
  useForm: boolean;
  draft: { version: number; hash: string; subject: string; body: string; to: string };
  events: Array<{ type: string; actor: string; at: string; payload: Record<string, unknown> }>;
  canSend: boolean;
  blockers: Array<{ code: string; findings?: string[] }>;
  replies: { count: number; automaticCount: number; firstAt: string | null; lastAt: string | null; senderMatch: string | null };
  outcome: { value: string; setByUser: boolean; at: string | null } | null;
  canSetOutcome: boolean;
  canMarkSubmitted: boolean;
}

const A = {
  create: (s: Session, ids: string[]) => h.app.inject({ method: 'POST', url: '/v1/requests/drafts', headers: authed(s), payload: { userCompanyIds: ids } }),
  get: (s: Session, id: string) => h.app.inject({ method: 'GET', url: `/v1/requests/${id}`, headers: { cookie: s.cookie } }),
  list: (s: Session) => h.app.inject({ method: 'GET', url: '/v1/requests', headers: { cookie: s.cookie } }),
  edit: (s: Session, id: string, baseHash: string, subject: string, body: string) =>
    h.app.inject({ method: 'PATCH', url: `/v1/requests/${id}/draft`, headers: authed(s), payload: { baseHash, subject, body } }),
  approve: (s: Session, id: string, draftHash: string) => h.app.inject({ method: 'POST', url: `/v1/requests/${id}/approve`, headers: authed(s), payload: { draftHash } }),
  send: (s: Session, id: string) => h.app.inject({ method: 'POST', url: `/v1/requests/${id}/send`, headers: { ...authed(s), 'idempotency-key': key() } }),
  close: (s: Session, id: string) => h.app.inject({ method: 'POST', url: `/v1/requests/${id}/close`, headers: authed(s) }),
  outcome: (s: Session, id: string, payload: unknown) => h.app.inject({ method: 'PUT', url: `/v1/requests/${id}/outcome`, headers: authed(s), payload: payload as object }),
  submitted: (s: Session, id: string, payload: unknown) => h.app.inject({ method: 'POST', url: `/v1/requests/${id}/submitted`, headers: authed(s), payload: payload as object }),
};

async function created(a: Actor, o: SeedOptions = {}) {
  const c = await a.seed(o);
  const res = await A.create(a.s, [c.ucId]);
  const result = res.json<{ results: Array<{ outcome: string; requestId?: string }> }>().results[0];
  if (!result?.requestId) throw new Error(`no request created: ${JSON.stringify(result)}`);
  return { ...c, id: result.requestId, outcome: result.outcome };
}

/** Removes the unresolved [OPEN] line (the owner's job once the citation is verified) so the draft can be used. */
async function resolved(a: Actor, id: string): Promise<View> {
  const v = (await A.get(a.s, id)).json<View>();
  const body = v.draft.body
    .split('\n')
    .filter((l) => !l.startsWith('[OPEN'))
    .join('\n');
  const res = await A.edit(a.s, id, v.draft.hash, v.draft.subject, body);
  expect(res.statusCode).toBe(200);
  return res.json<View>();
}

/** A request sent by email through the API, with the fake sender. */
async function sentRequest(a: Actor, o: SeedOptions = {}) {
  const r = await created(a, o);
  const v = await resolved(a, r.id);
  expect((await A.approve(a.s, r.id, v.draft.hash)).statusCode).toBe(200);
  expect((await A.send(a.s, r.id)).statusCode).toBe(200);
  return r;
}

/** A drafted request for a company that takes a web form, with the [OPEN] line resolved. */
async function formRequest(a: Actor, o: SeedOptions = {}) {
  const r = await created(a, { contact: 'form', ...o });
  expect(r.outcome).toBe('use_form');
  const v = await resolved(a, r.id);
  return { ...r, hash: v.draft.hash };
}

const row = async (id: string) =>
  (await t.owner.query<{ status: string; channel: string; thread_id: string | null; sent_at: Date | null; due_at: Date | null }>('SELECT status, channel, thread_id, sent_at, due_at FROM requests WHERE id = $1', [id])).rows[0];
const eventsOf = async (id: string, type: string) =>
  (await t.owner.query<{ type: string; actor_type: string; draft_hash: string | null; payload: Record<string, unknown> }>('SELECT type, actor_type, draft_hash, payload FROM request_events WHERE request_id = $1 AND type = $2 ORDER BY created_at, id', [id, type])).rows;
const auditCount = async (action: string, id: string) =>
  Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit_log WHERE action = $1 AND target_id = $2', [action, id])).rows[0]?.n);
const setStatus = (id: string, status: string) => t.owner.query('UPDATE requests SET status = $2 WHERE id = $1', [id, status]);

// ---------- outcome ----------

describe('PUT /v1/requests/:id/outcome: report what the company answered', () => {
  it.each([
    ['confirmed_erased', 'replied_deleted'],
    ['refused', 'replied_refused'],
    ['needs_more_info', 'replied_info_requested'],
  ])('%s puts a sent request in %s, as reported by the person, with an event and an audit entry', async (outcome, status) => {
    const a = await actor(h, `out-${outcome}`);
    const r = await sentRequest(a);
    const before = (await A.get(a.s, r.id)).json<View>();
    expect(before.outcome).toEqual({ value: 'no_answer_yet', setByUser: false, at: null });
    expect(before.canSetOutcome).toBe(true);
    expect(before.replies.count).toBe(0); // no reply was detected: the person can still report an answer

    const res = await A.outcome(a.s, r.id, { outcome });
    expect(res.statusCode).toBe(200);
    const view = res.json<View>();
    expect(view.request.status).toBe(status);
    expect(view.outcome).toMatchObject({ value: outcome, setByUser: true });
    expect(view.outcome?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await eventsOf(r.id, 'outcome_set')).toEqual([{ type: 'outcome_set', actor_type: 'user', draft_hash: null, payload: { from: 'sent', to: status, outcome } }]);
    expect(await auditCount('request.outcome_set', r.id)).toBe(1);
  });

  it('can be changed, and taken back to "no answer yet", which returns the request to sent', async () => {
    const a = await actor(h, 'out-change');
    const r = await sentRequest(a);
    expect((await A.outcome(a.s, r.id, { outcome: 'refused' })).json<View>().request.status).toBe('replied_refused');
    expect((await A.outcome(a.s, r.id, { outcome: 'confirmed_erased' })).json<View>().request.status).toBe('replied_deleted');
    const back = (await A.outcome(a.s, r.id, { outcome: 'no_answer_yet' })).json<View>();
    expect(back.request.status).toBe('sent');
    expect(back.outcome).toEqual({ value: 'no_answer_yet', setByUser: false, at: null });
    expect((await eventsOf(r.id, 'outcome_set')).map((e) => e.payload.outcome)).toEqual(['refused', 'confirmed_erased', 'no_answer_yet']);
  });

  it('takes "no answer yet" back to no_reply once the follow-up day has passed', async () => {
    const a = await actor(h, 'out-overdue');
    const r = await sentRequest(a);
    await A.outcome(a.s, r.id, { outcome: 'refused' });
    await t.owner.query(`UPDATE requests SET sent_at = now() - interval '40 days' WHERE id = $1`, [r.id]);
    expect((await A.outcome(a.s, r.id, { outcome: 'no_answer_yet' })).json<View>().request.status).toBe('no_reply');
  });

  it('says the same thing twice without recording it twice, and "no answer yet" while already waiting changes nothing', async () => {
    const a = await actor(h, 'out-same');
    const r = await sentRequest(a);
    expect((await A.outcome(a.s, r.id, { outcome: 'no_answer_yet' })).statusCode).toBe(200);
    expect(await eventsOf(r.id, 'outcome_set')).toHaveLength(0);
    await A.outcome(a.s, r.id, { outcome: 'refused' });
    const again = await A.outcome(a.s, r.id, { outcome: 'refused' });
    expect(again.statusCode).toBe(200);
    expect(again.json<View>().request.status).toBe('replied_refused');
    expect(await eventsOf(r.id, 'outcome_set')).toHaveLength(1);
    expect(await auditCount('request.outcome_set', r.id)).toBe(1);
    await setStatus(r.id, 'no_reply');
    expect((await A.outcome(a.s, r.id, { outcome: 'no_answer_yet' })).json<View>().request.status).toBe('no_reply');
    expect(await eventsOf(r.id, 'outcome_set')).toHaveLength(1);
  });

  it('works from reply_received, and a reply alone never sets an outcome', async () => {
    const a = await actor(h, 'out-reply');
    const r = await sentRequest(a);
    await t.owner.query(
      `INSERT INTO request_replies (id, request_id, gmail_message_id, received_at, sender_domain, sender_match, automatic) VALUES
         ('rpl_00000000000000000000000001', $1, 'm1', now() - interval '2 days', 'shop.example', 'company', false),
         ('rpl_00000000000000000000000002', $1, 'm2', now() - interval '3 days', 'shop.example', 'company', true)`,
      [r.id],
    );
    await setStatus(r.id, 'reply_received');
    const seen = (await A.get(a.s, r.id)).json<View>();
    expect(seen.replies).toMatchObject({ count: 1, automaticCount: 1, senderMatch: 'company' });
    expect(seen.replies.firstAt).toMatch(/^\d{4}-/);
    expect(seen.outcome).toEqual({ value: 'no_answer_yet', setByUser: false, at: null }); // not inferred from the reply

    expect((await A.outcome(a.s, r.id, { outcome: 'needs_more_info' })).json<View>().request.status).toBe('replied_info_requested');
    await setStatus(r.id, 'reply_received');
    expect((await A.outcome(a.s, r.id, { outcome: 'no_answer_yet' })).json<View>().request.status).toBe('sent');
  });

  it('keeps the reported outcome on a closed request, and refuses to change a closed one', async () => {
    const a = await actor(h, 'out-closed');
    const r = await sentRequest(a);
    expect((await A.get(a.s, r.id)).json<View>().outcome?.value).toBe('no_answer_yet');
    await A.outcome(a.s, r.id, { outcome: 'confirmed_erased' });
    await setStatus(r.id, 'closed');
    const closed = (await A.get(a.s, r.id)).json<View>();
    expect(closed.outcome).toMatchObject({ value: 'confirmed_erased', setByUser: true });
    expect(closed.canSetOutcome).toBe(false);
    const res = await A.outcome(a.s, r.id, { outcome: 'refused' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'invalid_transition' });

    const unreported = await sentRequest(a);
    await setStatus(unreported.id, 'closed');
    expect((await A.get(a.s, unreported.id)).json<View>().outcome).toBeNull();
  });

  it.each([
    ['drafted', 'a draft'],
    ['approved', 'an approved draft'],
  ])('refuses %s: nothing has been sent, so there is nothing to report (409 invalid_transition)', async (status, _what) => {
    const a = await actor(h, `out-pre-${status}`);
    const r = await created(a);
    if (status === 'approved') {
      const v = await resolved(a, r.id);
      expect((await A.approve(a.s, r.id, v.draft.hash)).statusCode).toBe(200);
    }
    const res = await A.outcome(a.s, r.id, { outcome: 'refused' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'invalid_transition' });
    expect((await row(r.id))?.status).toBe(status);
    expect(await eventsOf(r.id, 'outcome_set')).toHaveLength(0);
    expect((await A.get(a.s, r.id)).json<View>()).toMatchObject({ outcome: null, canSetOutcome: false });
  });

  it('refuses a bounced request', async () => {
    const a = await actor(h, 'out-bounced');
    const r = await sentRequest(a);
    await setStatus(r.id, 'bounced');
    expect((await A.outcome(a.s, r.id, { outcome: 'refused' })).json()).toMatchObject({ code: 'invalid_transition' });
  });

  it('is record-keeping, so keeping the company or marking it as must-keep later does not stop it', async () => {
    const a = await actor(h, 'out-kept');
    const r = await sentRequest(a);
    await t.owner.query(`UPDATE user_companies SET kept_at = now() WHERE id = $1`, [r.ucId]);
    await t.owner.query(`UPDATE companies SET must_keep = true WHERE id = $1`, [r.companyId]);
    expect((await A.outcome(a.s, r.id, { outcome: 'confirmed_erased' })).statusCode).toBe(200);
  });

  it.each([
    ['an unknown outcome', { outcome: 'deleted' }],
    ['a status instead of an outcome', { outcome: 'replied_deleted' }],
    ['no outcome', {}],
    ['an extra field', { outcome: 'refused', note: 'free text is not accepted' }],
    ['a number', { outcome: 1 }],
  ])('answers 400 validation_failed for %s, and changes nothing', async (_name, payload) => {
    const a = await actor(h, `out-bad-${_name.length}`);
    const r = await sentRequest(a);
    const res = await A.outcome(a.s, r.id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
    expect((await row(r.id))?.status).toBe('sent');
  });

  it('stores nothing but codes: the event holds the statuses and the outcome, never text', async () => {
    const a = await actor(h, 'out-codes');
    const r = await sentRequest(a);
    await A.outcome(a.s, r.id, { outcome: 'refused' });
    const stored = JSON.stringify((await t.owner.query('SELECT * FROM request_events WHERE request_id = $1 AND type = $2', [r.id, 'outcome_set'])).rows);
    expect(stored).not.toMatch(/@|erase my|Dear /i);
  });

  describe('who may call it', () => {
    it("another user's request looks like a missing one (404), and nothing changes", async () => {
      const owner = await actor(h, 'out-owner');
      const other = await actor(h, 'out-other');
      const r = await sentRequest(owner);
      const res = await A.outcome(other.s, r.id, { outcome: 'refused' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
      expect((await row(r.id))?.status).toBe('sent');
      expect(await eventsOf(r.id, 'outcome_set')).toHaveLength(0);
    });

    it('answers 404 for a request that does not exist', async () => {
      const a = await actor(h, 'out-missing');
      expect((await A.outcome(a.s, 'req_00000000000000000000000000', { outcome: 'refused' })).statusCode).toBe(404);
    });

    it('needs a session (401) and the CSRF token (403)', async () => {
      const a = await actor(h, 'out-auth');
      const r = await sentRequest(a);
      expect((await h.app.inject({ method: 'PUT', url: `/v1/requests/${r.id}/outcome`, payload: { outcome: 'refused' } })).statusCode).toBe(401);
      const noCsrf = await h.app.inject({ method: 'PUT', url: `/v1/requests/${r.id}/outcome`, headers: { cookie: a.s.cookie, origin: 'http://localhost:3000' }, payload: { outcome: 'refused' } });
      expect(noCsrf.statusCode).toBe(403);
      expect((await row(r.id))?.status).toBe('sent');
    });

    it('is refused for a person who asked to delete their data, and works again if they are active again', async () => {
      const a = await actor(h, 'out-deleting');
      const r = await sentRequest(a);
      await t.owner.query(`UPDATE users SET status = 'deleting', deleted_at = now() WHERE id = $1`, [a.s.userId]);
      expect((await A.outcome(a.s, r.id, { outcome: 'refused' })).statusCode).toBe(401);
      expect((await row(r.id))?.status).toBe('sent');
      await t.owner.query(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = $1`, [a.s.userId]);
      expect((await A.outcome(a.s, r.id, { outcome: 'refused' })).statusCode).toBe(200);
    });
  });
});

// ---------- the list and the view ----------

describe('requests list and view show the channel and the outcome', () => {
  it('lists the channel and what the person reported, null before sending', async () => {
    const a = await actor(h, 'list-out');
    const draft = await created(a);
    const sent = await sentRequest(a);
    const form = await formRequest(a);
    await A.outcome(a.s, sent.id, { outcome: 'refused' });
    const items = (await A.list(a.s)).json<{ requests: Array<{ id: string; channel: string; outcome: string | null; status: string }> }>().requests;
    const by = (id: string) => items.find((i) => i.id === id);
    expect(by(draft.id)).toMatchObject({ channel: 'email', outcome: null, status: 'drafted' });
    expect(by(sent.id)).toMatchObject({ channel: 'email', outcome: 'refused', status: 'replied_refused' });
    expect(by(form.id)).toMatchObject({ channel: 'web_form', outcome: null, status: 'drafted' });
  });
});

// ---------- mark as submitted ----------

describe('POST /v1/requests/:id/submitted: the draft was pasted into the web form', () => {
  it('records it like a send of the exact draft that was copied: approval, status sent, channel web_form, no thread, nothing emailed', async () => {
    const a = await actor(h, 'sub-happy');
    const r = await formRequest(a);
    const ready = (await A.get(a.s, r.id)).json<View>();
    expect(ready).toMatchObject({ useForm: true, canMarkSubmitted: true, canSend: false, canSetOutcome: false, outcome: null });
    expect(ready.request.channel).toBe('web_form');

    const res = await A.submitted(a.s, r.id, { draftHash: r.hash });
    expect(res.statusCode).toBe(200);
    const view = res.json<View>();
    expect(view.request.status).toBe('sent');
    expect(view.request.channel).toBe('web_form');
    expect(view.request.sentAt).not.toBeNull();
    expect(new Date(view.request.dueAt ?? '').getTime() - new Date(view.request.sentAt ?? '').getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(view).toMatchObject({ canMarkSubmitted: false, canSetOutcome: true, outcome: { value: 'no_answer_yet', setByUser: false } });
    expect(view.replies).toEqual({ count: 0, automaticCount: 0, firstAt: null, lastAt: null, senderMatch: null });

    const stored = await row(r.id);
    expect(stored).toMatchObject({ status: 'sent', channel: 'web_form', thread_id: null });
    expect((await eventsOf(r.id, 'approved')).map((e) => [e.actor_type, e.draft_hash])).toEqual([['user', r.hash]]);
    expect((await eventsOf(r.id, 'submitted')).map((e) => [e.actor_type, e.draft_hash])).toEqual([['user', r.hash]]);
    expect(await auditCount('request.submitted', r.id)).toBe(1);
    expect(sender.calls).toBe(0); // nothing was sent from here
  });

  it('is saying it twice: the second call answers 200 and records nothing more', async () => {
    const a = await actor(h, 'sub-twice');
    const r = await formRequest(a);
    await A.submitted(a.s, r.id, { draftHash: r.hash });
    const again = await A.submitted(a.s, r.id, { draftHash: r.hash });
    expect(again.statusCode).toBe(200);
    expect(again.json<View>().request.status).toBe('sent');
    expect(await eventsOf(r.id, 'submitted')).toHaveLength(1);
    expect(await eventsOf(r.id, 'approved')).toHaveLength(1);
    expect(await auditCount('request.submitted', r.id)).toBe(1);
  });

  it('then lets the person report the outcome, and is never checked for replies (it has no thread)', async () => {
    const a = await actor(h, 'sub-outcome');
    const r = await formRequest(a);
    await A.submitted(a.s, r.id, { draftHash: r.hash });
    // Other requests in this database are checked, but a web-form request has no thread and is never listed.
    const handle = createDb(t.appUrl, () => undefined);
    try {
      const listed = await createTrackerRepository(handle.db).listPollable(new Date(), 120, 1000);
      expect(listed.map((x) => x.requestId)).not.toContain(r.id);
    } finally {
      await handle.close();
    }
    expect((await A.outcome(a.s, r.id, { outcome: 'needs_more_info' })).json<View>().request.status).toBe('replied_info_requested');
  });

  it('refuses while the unresolved [OPEN] line is still in the draft (422 draft_unsafe), and says so in canMarkSubmitted', async () => {
    const a = await actor(h, 'sub-open');
    const r = await created(a, { contact: 'form' });
    const v = (await A.get(a.s, r.id)).json<View>();
    expect(v.canMarkSubmitted).toBe(false);
    expect(v.blockers.map((b) => b.code)).toContain('draft_unsafe');
    const res = await A.submitted(a.s, r.id, { draftHash: v.draft.hash });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'draft_unsafe', findings: ['open_placeholder'] });
    expect((await row(r.id))?.status).toBe('drafted');
    expect(await eventsOf(r.id, 'submitted')).toHaveLength(0);
  });

  it('refuses a draft that is not the one copied: the hash must be the latest (409 draft_changed), and a malformed hash is a 400', async () => {
    const a = await actor(h, 'sub-stale');
    const r = await formRequest(a);
    const edited = await A.edit(a.s, r.id, r.hash, 'Request to erase my personal data', 'A different message from the one that was copied.');
    expect(edited.statusCode).toBe(200);
    const stale = await A.submitted(a.s, r.id, { draftHash: r.hash });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'draft_changed' });
    expect((await row(r.id))?.status).toBe('drafted');
    for (const bad of [{ draftHash: 'not-a-hash' }, {}, { draftHash: r.hash, extra: 1 }]) {
      const res = await A.submitted(a.s, r.id, bad);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'validation_failed' });
    }
    const latest = (await A.get(a.s, r.id)).json<View>().draft.hash;
    expect((await A.submitted(a.s, r.id, { draftHash: latest })).statusCode).toBe(200);
  });

  it('is only for web-form companies: an email request answers 409 not_a_form_request and stays as it was', async () => {
    const a = await actor(h, 'sub-email');
    const r = await created(a);
    const v = await resolved(a, r.id);
    const res = await A.submitted(a.s, r.id, { draftHash: v.draft.hash });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_a_form_request' });
    expect((await row(r.id))?.status).toBe('drafted');
  });

  it('refuses a request already sent by email (409 already_sent)', async () => {
    const a = await actor(h, 'sub-already');
    const r = await sentRequest(a);
    const res = await A.submitted(a.s, r.id, { draftHash: (await A.get(a.s, r.id)).json<View>().draft.hash });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'already_sent' });
  });

  it('refuses a closed request (409 invalid_transition)', async () => {
    const a = await actor(h, 'sub-closed');
    const r = await formRequest(a);
    expect((await A.close(a.s, r.id)).statusCode).toBe(200);
    const res = await A.submitted(a.s, r.id, { draftHash: r.hash });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'invalid_transition' });
  });

  describe('the guards run again, as they do at approve and send', () => {
    it.each([
      ['kept', `UPDATE user_companies SET kept_at = now() WHERE id = $1`, 'ucId', 'kept'],
      ['must_keep', `UPDATE companies SET must_keep = true WHERE id = $1`, 'companyId', 'must_keep'],
      ['company_excluded', `UPDATE user_companies SET status = 'not_mine' WHERE id = $1`, 'ucId', 'company_excluded'],
      ['no_contact', `UPDATE companies SET grievance_status = 'unknown' WHERE id = $1`, 'companyId', 'no_contact'],
      ['contact_bounced', `UPDATE companies SET grievance_status = 'bounced' WHERE id = $1`, 'companyId', 'contact_bounced'],
      ['contact_changed', `UPDATE companies SET grievance_form_url = 'https://example.com/privacy/other-form' WHERE id = $1`, 'companyId', 'contact_changed'],
    ] as const)('%s: refused with that code, and the request stays drafted', async (name, sql, idField, code) => {
      const a = await actor(h, `sub-${name}`);
      const r = await formRequest(a);
      await t.owner.query(sql, [r[idField]]);
      const res = await A.submitted(a.s, r.id, { draftHash: r.hash });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code });
      expect((await row(r.id))?.status).toBe('drafted');
      expect(await eventsOf(r.id, 'submitted')).toHaveLength(0);
      expect(await eventsOf(r.id, 'approved')).toHaveLength(0);
    });

    it('draft_unsafe: a draft with an ID-like number is refused even if it reached the database', async () => {
      const a = await actor(h, 'sub-unsafe');
      const r = await formRequest(a);
      const view = (await A.get(a.s, r.id)).json<View>();
      // Put an ID-like number straight into the stored draft with its hash recomputed, as if it had slipped past the editor.
      const { hashDraft } = await import('./draft-hash.js');
      const body = `${view.draft.body}\n\nMy card is 4111 1111 1111 1111.`;
      const hash = hashDraft({ to: view.draft.to, subject: view.draft.subject, body });
      await t.owner.query(`INSERT INTO request_drafts (id, request_id, version, to_email, subject, body, draft_hash, created_by) VALUES ($1, $2, $7, $3, $4, $5, $6, 'user')`, [
        `drf_${'0'.repeat(25)}1`,
        r.id,
        view.draft.to,
        view.draft.subject,
        body,
        hash,
        view.draft.version + 1,
      ]);
      const res = await A.submitted(a.s, r.id, { draftHash: hash });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'draft_unsafe', findings: ['card'] });
    });
  });

  it('is not affected by what changes after it was marked: keep or must-keep later leaves it sent', async () => {
    const a = await actor(h, 'sub-later');
    const r = await formRequest(a);
    await A.submitted(a.s, r.id, { draftHash: r.hash });
    await t.owner.query(`UPDATE user_companies SET kept_at = now() WHERE id = $1`, [r.ucId]);
    expect((await A.submitted(a.s, r.id, { draftHash: r.hash })).statusCode).toBe(200);
    expect((await A.get(a.s, r.id)).json<View>().request.status).toBe('sent');
  });

  it('works whether or not real sending is available, since nothing is sent', async () => {
    const a = await actor(h, 'sub-nosend');
    const r = await formRequest(a);
    const view = (await A.get(a.s, r.id)).json<View>();
    expect(view.blockers.map((b) => b.code)).not.toContain('send_disabled');
    expect((await A.submitted(a.s, r.id, { draftHash: r.hash })).statusCode).toBe(200);
  });

  describe('who may call it', () => {
    it("another user's request looks like a missing one (404), and nothing changes", async () => {
      const owner = await actor(h, 'sub-owner');
      const other = await actor(h, 'sub-other');
      const r = await formRequest(owner);
      const res = await A.submitted(other.s, r.id, { draftHash: r.hash });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
      expect((await row(r.id))?.status).toBe('drafted');
      expect(await eventsOf(r.id, 'submitted')).toHaveLength(0);
    });

    it('answers 404 for a request that does not exist', async () => {
      const a = await actor(h, 'sub-missing');
      expect((await A.submitted(a.s, 'req_00000000000000000000000000', { draftHash: 'a'.repeat(64) })).statusCode).toBe(404);
    });

    it('needs a session (401) and the CSRF token (403)', async () => {
      const a = await actor(h, 'sub-auth');
      const r = await formRequest(a);
      expect((await h.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/submitted`, payload: { draftHash: r.hash } })).statusCode).toBe(401);
      const noCsrf = await h.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/submitted`, headers: { cookie: a.s.cookie, origin: 'http://localhost:3000' }, payload: { draftHash: r.hash } });
      expect(noCsrf.statusCode).toBe(403);
      expect((await row(r.id))?.status).toBe('drafted');
    });

    it('is refused for a person who asked to delete their data, and works again if they are active again', async () => {
      const a = await actor(h, 'sub-deleting');
      const r = await formRequest(a);
      await t.owner.query(`UPDATE users SET status = 'deleting', deleted_at = now() WHERE id = $1`, [a.s.userId]);
      expect((await A.submitted(a.s, r.id, { draftHash: r.hash })).statusCode).toBe(401);
      expect((await row(r.id))?.status).toBe('drafted');
      await t.owner.query(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = $1`, [a.s.userId]);
      expect((await A.submitted(a.s, r.id, { draftHash: r.hash })).statusCode).toBe(200);
    });
  });
});
