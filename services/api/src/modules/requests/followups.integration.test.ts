import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, pgError, type TestDb } from '../../../test/db-helper.js';
import { actorFactory, type Actor, type SeedOptions } from '../../../test/actors.js';
import { newId } from '../../common/ids.js';
import { BANNED_WORDS } from '../../../test/wording.js';
import { authed, buildHarness, type Harness, type Session } from '../../../test/harness.js';
import { FakeGmailSender, SenderOutcomeUnknownError, SenderRejectedError, type OutgoingMessage, type RequestSender, type SentMessage } from './sender.js';

const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date('2026-11-22T10:00:00Z');

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
  h.clock.now = new Date(BASE);
  sender.calls = 0;
  sender.messages.length = 0;
  sender.beforeSend = undefined;
});

const actor = actorFactory(() => t);
const key = () => `key-${randomBytes(8).toString('hex')}`;
/**
 * Moves the app's clock. Sessions slide for 30 days from last use, so a jump of 31 days would sign the person out; a real
 * person who keeps using the app stays signed in, so the sessions are kept alive too.
 */
const setNow = async (when: Date, hh: Harness = h): Promise<void> => {
  hh.clock.now = when;
  await t.owner.query(`UPDATE sessions SET expires_at = '2100-01-01T00:00:00Z' WHERE revoked_at IS NULL`);
};
const advance = (days: number, hh: Harness = h): Promise<void> => setNow(new Date(BASE.getTime() + days * DAY), hh);

interface FollowupView {
  state: string;
  dueAt: string | null;
  remaining: number;
  sequence: number | null;
  sentAt: string | null;
  draft: { version: number; to: string; subject: string; body: string; hash: string; createdBy: string } | null;
  approved: boolean;
  canCreate: boolean;
  canSend: boolean;
  canMarkSubmitted: boolean;
  blockers: Array<{ code: string; message: string; findings?: string[]; formUrl?: string }>;
}
interface View {
  request: { id: string; status: string; channel: string; sentAt: string | null };
  draft: { version: number; hash: string; subject: string; body: string; to: string };
  events: Array<{ type: string; actor: string; at: string; payload: Record<string, unknown> }>;
  replies: { count: number; automaticCount: number };
  outcome: { value: string } | null;
  followup: FollowupView;
}

const api = (harness: Harness) => ({
  create: (s: Session, ids: string[]) => harness.app.inject({ method: 'POST', url: '/v1/requests/drafts', headers: authed(s), payload: { userCompanyIds: ids } }),
  get: (s: Session, id: string) => harness.app.inject({ method: 'GET', url: `/v1/requests/${id}`, headers: { cookie: s.cookie } }),
  edit: (s: Session, id: string, baseHash: string, subject: string, body: string) =>
    harness.app.inject({ method: 'PATCH', url: `/v1/requests/${id}/draft`, headers: authed(s), payload: { baseHash, subject, body } }),
  approve: (s: Session, id: string, draftHash: string) => harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/approve`, headers: authed(s), payload: { draftHash } }),
  send: (s: Session, id: string, k = key()) => harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/send`, headers: { ...authed(s), 'idempotency-key': k } }),
  submitted: (s: Session, id: string, draftHash: string) => harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/submitted`, headers: authed(s), payload: { draftHash } }),
  fCreate: (s: Session, id: string) => harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/followup`, headers: authed(s) }),
  fEdit: (s: Session, id: string, baseHash: string, subject: string, body: string) =>
    harness.app.inject({ method: 'PATCH', url: `/v1/requests/${id}/followup/draft`, headers: authed(s), payload: { baseHash, subject, body } }),
  fApprove: (s: Session, id: string, draftHash: string) => harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/followup/approve`, headers: authed(s), payload: { draftHash } }),
  fSend: (s: Session, id: string, k = key()) => harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/followup/send`, headers: { ...authed(s), 'idempotency-key': k } }),
  fSubmitted: (s: Session, id: string, draftHash: string) => harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/followup/submitted`, headers: authed(s), payload: { draftHash } }),
});
// The shared harness is built in beforeAll, so the helpers for it are looked up when they are used.
const A = new Proxy({} as ReturnType<typeof api>, { get: (_target, prop) => (api(h) as Record<string | symbol, unknown>)[prop] });

async function created(a: Actor, o: SeedOptions = {}, harness = h) {
  const c = await a.seed(o);
  const res = await api(harness).create(a.s, [c.ucId]);
  const r = res.json<{ results: Array<{ outcome: string; requestId?: string }> }>().results[0];
  if (!r?.requestId) throw new Error(`no request created: ${JSON.stringify(r)}`);
  return { ...c, id: r.requestId };
}
const resolveOpen = (text: string): string => text.split('\n').filter((l) => !l.startsWith('[OPEN')).join('\n');

/** A request sent by email through the API with the fake sender, on the base date. */
async function sentRequest(a: Actor, o: SeedOptions = {}, harness = h, who = A) {
  const r = await created(a, o, harness);
  const v = (await who.get(a.s, r.id)).json<View>();
  const edited = (await who.edit(a.s, r.id, v.draft.hash, v.draft.subject, resolveOpen(v.draft.body))).json<View>();
  expect((await who.approve(a.s, r.id, edited.draft.hash)).statusCode).toBe(200);
  expect((await who.send(a.s, r.id)).statusCode).toBe(200);
  return r;
}

/** A web-form request marked as submitted on the base date. */
async function submittedForm(a: Actor, o: SeedOptions = {}) {
  const r = await created(a, { contact: 'form', ...o });
  const v = (await A.get(a.s, r.id)).json<View>();
  const edited = (await A.edit(a.s, r.id, v.draft.hash, v.draft.subject, resolveOpen(v.draft.body))).json<View>();
  expect((await A.submitted(a.s, r.id, edited.draft.hash)).statusCode).toBe(200);
  return r;
}

/** A sent request, made due, with its follow-up drafted and the [OPEN] line resolved. */
async function followupDraft(a: Actor, o: SeedOptions = {}) {
  const r = await sentRequest(a, o);
  await setNow(new Date(h.clock.now.getTime() + 31 * DAY)); // from now, so several follow-ups in one test each become due
  expect((await A.fCreate(a.s, r.id)).statusCode).toBe(200);
  const v = (await A.get(a.s, r.id)).json<View>();
  const f = v.followup.draft;
  if (!f) throw new Error('no follow-up draft');
  const edited = await A.fEdit(a.s, r.id, f.hash, f.subject, resolveOpen(f.body));
  expect(edited.statusCode).toBe(200);
  const fresh = edited.json<View>();
  return { ...r, hash: fresh.followup.draft?.hash as string, view: fresh };
}

const followups = async (id: string) =>
  (await t.owner.query<{ id: string; sequence: number; status: string; approved_hash: string | null; sent_at: Date | null; gmail_message_id: string | null }>('SELECT id, sequence, status, approved_hash, sent_at, gmail_message_id FROM request_followups WHERE request_id = $1 ORDER BY sequence', [id])).rows;
const events = async (id: string, type: string) =>
  (await t.owner.query<{ type: string; actor_type: string; draft_hash: string | null; payload: Record<string, unknown> }>('SELECT type, actor_type, draft_hash, payload FROM request_events WHERE request_id = $1 AND type = $2 ORDER BY created_at, id', [id, type])).rows;
const reqRow = async (id: string) =>
  (await t.owner.query<{ status: string; thread_id: string | null; sent_rfc_message_id: string | null }>('SELECT status, thread_id, sent_rfc_message_id FROM requests WHERE id = $1', [id])).rows[0];
const audits = async (action: string, id: string) => Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit_log WHERE action = $1 AND target_id = $2', [action, id])).rows[0]?.n);
const setStatus = (id: string, status: string) => t.owner.query('UPDATE requests SET status = $2 WHERE id = $1', [id, status]);

// ---------- when a follow-up is offered ----------

describe('when a follow-up is offered', () => {
  it('is not offered before the follow-up day, and says when it will be', async () => {
    const a = await actor(h, 'fu-early');
    const r = await sentRequest(a);
    await advance(29);
    const v = (await A.get(a.s, r.id)).json<View>();
    expect(v.followup).toMatchObject({ state: 'not_due', canCreate: false, remaining: 1, sequence: null, draft: null });
    expect(new Date(v.followup.dueAt ?? '').getTime()).toBe(BASE.getTime() + 30 * DAY);
    const res = await A.fCreate(a.s, r.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'followup_not_due', detail: expect.stringContaining('2026-12-22') });
    expect((await reqRow(r.id))?.status).toBe('sent');
    expect(await followups(r.id)).toEqual([]);
  });

  it('is offered from the exact follow-up moment, and not a moment before', async () => {
    const a = await actor(h, 'fu-edge');
    const r = await sentRequest(a);
    await setNow(new Date(BASE.getTime() + 30 * DAY - 1));
    expect((await A.fCreate(a.s, r.id)).json()).toMatchObject({ code: 'followup_not_due' });
    await setNow(new Date(BASE.getTime() + 30 * DAY));
    expect((await A.get(a.s, r.id)).json<View>().followup).toMatchObject({ state: 'due', canCreate: true });
    expect((await A.fCreate(a.s, r.id)).statusCode).toBe(200);
  });

  it('prepares a polite, hedged draft to the same place, moves the request to no_reply, and records who did it', async () => {
    const a = await actor(h, 'fu-create');
    const r = await sentRequest(a);
    const first = (await A.get(a.s, r.id)).json<View>();
    await advance(31);
    const res = await A.fCreate(a.s, r.id);
    expect(res.statusCode).toBe(200);
    const v = res.json<View>();
    expect(v.request.status).toBe('no_reply');
    expect(v.followup).toMatchObject({ state: 'drafted', sequence: 1, remaining: 0, approved: false, canSend: false, canCreate: false });
    const draft = v.followup.draft;
    expect(draft?.to).toBe(first.draft.to); // the same place as the first message
    expect(draft?.subject).toBe(`Re: ${first.draft.subject}`);
    expect(draft?.body).toContain('I am following up on my email of 22 November 2026');
    expect(draft?.body).toContain('I have not seen a reply yet. Messages can go astray');
    expect(draft?.body).toMatch(/likely holds|may hold/);
    expect(draft?.body).not.toMatch(BANNED_WORDS);
    expect(draft?.body).not.toMatch(/deadline|overdue|you must/i);
    expect(draft?.createdBy).toBe('template');
    // The statute paragraph is behind the same gate as the first request: the [OPEN] line stops approval until resolved.
    expect(v.followup.blockers).toEqual([expect.objectContaining({ code: 'draft_unsafe', findings: ['open_placeholder'] })]);

    expect(await events(r.id, 'reply_label')).toEqual([expect.objectContaining({ actor_type: 'user', payload: expect.objectContaining({ from: 'sent', to: 'no_reply', reason: 'followup_day' }) })]);
    expect(await events(r.id, 'followup_drafted')).toEqual([expect.objectContaining({ actor_type: 'user', draft_hash: draft?.hash, payload: { sequence: 1, version: 1 } })]);
    expect(await audits('request.followup_drafted', r.id)).toBe(1);
    expect(await followups(r.id)).toEqual([expect.objectContaining({ sequence: 1, status: 'drafted', approved_hash: null })]);
  });

  it('answers the same draft when asked again, without a second follow-up or a second event', async () => {
    const a = await actor(h, 'fu-twice');
    const r = await sentRequest(a);
    await advance(31);
    const first = (await A.fCreate(a.s, r.id)).json<View>();
    const again = await A.fCreate(a.s, r.id);
    expect(again.statusCode).toBe(200);
    expect(again.json<View>().followup.draft?.hash).toBe(first.followup.draft?.hash);
    expect(await followups(r.id)).toHaveLength(1);
    expect(await events(r.id, 'followup_drafted')).toHaveLength(1);
  });

  it('does not stop the clock for an automatic reply, which is recorded and shown but changes no status', async () => {
    const a = await actor(h, 'fu-auto');
    const r = await sentRequest(a);
    await t.owner.query(`INSERT INTO request_replies (id, request_id, gmail_message_id, received_at, sender_domain, sender_match, automatic) VALUES ('rpl_00000000000000000000000AA1', $1, 'auto-2', now(), 'shop.example', 'company', true)`, [r.id]);
    await advance(31);
    const v = (await A.get(a.s, r.id)).json<View>();
    expect(v.replies.automaticCount).toBe(1);
    expect(v.request.status).toBe('sent');
    expect(v.followup.state).toBe('due');
    expect((await A.fCreate(a.s, r.id)).statusCode).toBe(200);
  });

  it.each([
    ['a reply from a person', 'reply_received'],
    ['an outcome the person reported', 'replied_refused'],
    ['a closed request', 'closed'],
  ])('is not offered after %s', async (_name, status) => {
    const a = await actor(h, `fu-over-${status}`);
    const r = await sentRequest(a);
    await advance(31);
    await setStatus(r.id, status);
    expect((await A.get(a.s, r.id)).json<View>().followup).toMatchObject({ state: 'none', canCreate: false });
    const res = await A.fCreate(a.s, r.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'invalid_transition' });
    expect(await followups(r.id)).toEqual([]);
  });

  it('is not offered for a request that was never sent', async () => {
    const a = await actor(h, 'fu-unsent');
    const r = await created(a);
    await advance(60);
    expect((await A.get(a.s, r.id)).json<View>().followup.state).toBe('none');
    expect((await A.fCreate(a.s, r.id)).json()).toMatchObject({ code: 'invalid_transition' });
  });
});

// ---------- how many ----------

describe('how many follow-ups', () => {
  it('is one by default: after it, no more (followup_limit_reached)', async () => {
    const a = await actor(h, 'fu-limit');
    const r = await followupDraft(a);
    expect((await A.fApprove(a.s, r.id, r.hash)).statusCode).toBe(200);
    expect((await A.fSend(a.s, r.id)).statusCode).toBe(200);
    await advance(90);
    const v = (await A.get(a.s, r.id)).json<View>();
    expect(v.followup).toMatchObject({ state: 'sent', remaining: 0, canCreate: false });
    const res = await A.fCreate(a.s, r.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'followup_limit_reached' });
    expect(await followups(r.id)).toHaveLength(1);
  });

  describe('when FOLLOWUP_MAX is 0, follow-ups are switched off', () => {
    let off: Harness;
    beforeAll(async () => {
      off = await buildHarness(t, { sender: { kind: 'ready', sender }, envOverrides: { FOLLOWUP_MAX: '0' } });
    });
    afterAll(async () => {
      await off.app.close();
    });
    it('never offers one', async () => {
      const a = await actor(off, 'fu-off');
      const who = api(off);
      const r = await sentRequest(a, {}, off, who);
      await advance(90, off);
      expect((await who.get(a.s, r.id)).json<View>().followup).toMatchObject({ state: 'none', remaining: 0, dueAt: null, canCreate: false });
      const res = await who.fCreate(a.s, r.id);
      expect(res.json()).toMatchObject({ code: 'followup_limit_reached' });
      expect(await off.app.services?.followups.sweep()).toEqual({ considered: 0, drafted: 0, blocked: 0, failed: 0 });
    });
  });

  describe('when FOLLOWUP_MAX is 2, the second comes a follow-up period after the first was sent', () => {
    let two: Harness;
    beforeAll(async () => {
      two = await buildHarness(t, { sender: { kind: 'ready', sender }, envOverrides: { FOLLOWUP_MAX: '2' } });
    });
    afterAll(async () => {
      await two.app.close();
    });
    it('is not due until then, then is numbered 2, and a third is refused', async () => {
      const a = await actor(two, 'fu-two');
      const who = api(two);
      const r = await sentRequest(a, {}, two, who);
      await advance(31, two);
      expect((await who.fCreate(a.s, r.id)).statusCode).toBe(200);
      const v1 = (await who.get(a.s, r.id)).json<View>();
      await who.fEdit(a.s, r.id, v1.followup.draft?.hash as string, v1.followup.draft?.subject as string, resolveOpen(v1.followup.draft?.body as string));
      const hash1 = (await who.get(a.s, r.id)).json<View>().followup.draft?.hash as string;
      await who.fApprove(a.s, r.id, hash1);
      expect((await who.fSend(a.s, r.id)).statusCode).toBe(200);
      // Right after the first follow-up: one more is allowed, but not yet.
      expect((await who.get(a.s, r.id)).json<View>().followup).toMatchObject({ state: 'not_due', remaining: 1 });
      expect((await who.fCreate(a.s, r.id)).json()).toMatchObject({ code: 'followup_not_due' });
      await advance(62, two);
      expect((await who.get(a.s, r.id)).json<View>().followup.state).toBe('due');
      const second = await who.fCreate(a.s, r.id);
      expect(second.statusCode).toBe(200);
      expect(second.json<View>().followup).toMatchObject({ state: 'drafted', sequence: 2, remaining: 0 });
      expect((await followups(r.id)).map((f) => [f.sequence, f.status])).toEqual([[1, 'sent'], [2, 'drafted']]);
    });
  });
});

// ---------- the guards, at create ----------

describe('the guards run when the follow-up is prepared', () => {
  it.each([
    ['kept', `UPDATE user_companies SET kept_at = now() WHERE id = $1`, 'ucId', 'kept'],
    ['must_keep', `UPDATE companies SET must_keep = true WHERE id = $1`, 'companyId', 'must_keep'],
    ['company_excluded', `UPDATE user_companies SET status = 'not_mine' WHERE id = $1`, 'ucId', 'company_excluded'],
    ['no_contact', `UPDATE companies SET grievance_status = 'unknown' WHERE id = $1`, 'companyId', 'no_contact'],
    ['contact_bounced', `UPDATE companies SET grievance_status = 'bounced' WHERE id = $1`, 'companyId', 'contact_bounced'],
    ['contact_changed', `UPDATE companies SET grievance_email = 'privacy2@example.com' WHERE id = $1`, 'companyId', 'contact_changed'],
  ] as const)('%s: refused with that code, and nothing is created or changed', async (name, sql, idField, code) => {
    const a = await actor(h, `fu-guard-${name}`);
    const r = await sentRequest(a);
    await advance(31);
    await t.owner.query(sql, [r[idField]]);
    const view = (await A.get(a.s, r.id)).json<View>();
    expect(view.followup).toMatchObject({ state: 'due', canCreate: false });
    expect(view.followup.blockers.map((b) => b.code)).toContain(code);
    const res = await A.fCreate(a.s, r.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code });
    expect((await reqRow(r.id))?.status).toBe('sent');
    expect(await followups(r.id)).toEqual([]);
  });
});

// ---------- edit and approve ----------

describe('editing and approving the follow-up', () => {
  it('cannot be approved while the [OPEN] line is in it (422 draft_unsafe), and can once it is resolved', async () => {
    const a = await actor(h, 'fu-open');
    const r = await sentRequest(a);
    await advance(31);
    const v = (await A.fCreate(a.s, r.id)).json<View>();
    const draft = v.followup.draft;
    const blocked = await A.fApprove(a.s, r.id, draft?.hash as string);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ code: 'draft_unsafe', findings: ['open_placeholder'] });
    expect(await events(r.id, 'followup_approved')).toEqual([]);
    const edited = (await A.fEdit(a.s, r.id, draft?.hash as string, draft?.subject as string, resolveOpen(draft?.body as string))).json<View>();
    expect(edited.followup).toMatchObject({ state: 'drafted', blockers: [] });
    expect(edited.followup.draft).toMatchObject({ version: 2, createdBy: 'user' });
    const ok = await A.fApprove(a.s, r.id, edited.followup.draft?.hash as string);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<View>().followup).toMatchObject({ state: 'approved', approved: true, canSend: true });
    expect(await events(r.id, 'followup_approved')).toEqual([expect.objectContaining({ actor_type: 'user', draft_hash: edited.followup.draft?.hash, payload: { sequence: 1, version: 2 } })]);
    expect((await followups(r.id))[0]).toMatchObject({ status: 'approved', approved_hash: edited.followup.draft?.hash });
  });

  it('approves only the exact version shown: an older hash answers 409 draft_changed, and nothing is retried', async () => {
    const a = await actor(h, 'fu-stale');
    const r = await followupDraft(a);
    const stale = (await A.get(a.s, r.id)).json<View>().followup.draft;
    await A.fEdit(a.s, r.id, r.hash, stale?.subject as string, `${resolveOpen(stale?.body as string)}\n\nOne more line.`);
    const res = await A.fApprove(a.s, r.id, r.hash);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'draft_changed' });
    expect(await events(r.id, 'followup_approved')).toEqual([]);
    expect((await followups(r.id))[0]?.status).toBe('drafted');
    expect((await A.fApprove(a.s, r.id, 'not-a-hash')).json()).toMatchObject({ code: 'validation_failed' });
  });

  it('an edit after approval takes the approval back: it must be approved again before it can be sent', async () => {
    const a = await actor(h, 'fu-reapprove');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    const draft = (await A.get(a.s, r.id)).json<View>().followup.draft;
    const edited = (await A.fEdit(a.s, r.id, r.hash, draft?.subject as string, `${draft?.body}\n\nAdded after approval.`)).json<View>();
    expect(edited.followup).toMatchObject({ state: 'drafted', approved: false, canSend: false });
    const send = await A.fSend(a.s, r.id);
    expect(send.statusCode).toBe(409);
    expect(send.json()).toMatchObject({ code: 'approval_required' });
    expect(sender.calls).toBe(1); // only the first message
  });

  it('edits keep the recipient fixed, and refuse an ID or card number before it is stored', async () => {
    const a = await actor(h, 'fu-id');
    const r = await followupDraft(a);
    const draft = (await A.get(a.s, r.id)).json<View>().followup.draft;
    const res = await A.fEdit(a.s, r.id, r.hash, draft?.subject as string, `${draft?.body}\n\nMy card is 4111 1111 1111 1111.`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'draft_unsafe', findings: ['card'] });
    expect((await A.get(a.s, r.id)).json<View>().followup.draft?.hash).toBe(r.hash);
    const stale = await A.fEdit(a.s, r.id, 'ab'.repeat(32), 'S', 'B');
    expect(stale.json()).toMatchObject({ code: 'draft_changed' });
  });

  it.each([
    ['kept', `UPDATE user_companies SET kept_at = now() WHERE id = $1`, 'ucId', 'kept'],
    ['must_keep', `UPDATE companies SET must_keep = true WHERE id = $1`, 'companyId', 'must_keep'],
    ['no_contact', `UPDATE companies SET grievance_status = 'unknown' WHERE id = $1`, 'companyId', 'no_contact'],
    ['contact_bounced', `UPDATE companies SET grievance_status = 'bounced' WHERE id = $1`, 'companyId', 'contact_bounced'],
  ] as const)('%s: checked again at approve', async (name, sql, idField, code) => {
    const a = await actor(h, `fu-appr-${name}`);
    const r = await followupDraft(a);
    await t.owner.query(sql, [r[idField]]);
    const res = await A.fApprove(a.s, r.id, r.hash);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code });
    expect(await events(r.id, 'followup_approved')).toEqual([]);
  });
});

// ---------- send ----------

describe('sending the follow-up', () => {
  it('sends exactly the approved draft in the first message’s Gmail conversation, labelled as a test send, and records it', async () => {
    const a = await actor(h, 'fu-send');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    const approvedDraft = (await A.get(a.s, r.id)).json<View>().followup.draft;
    const k = key();
    const res = await A.fSend(a.s, r.id, k);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ followup: { sequence: 1, status: 'sent' }, delivery: 'fake', notice: expect.stringContaining('No email was sent') });

    const row = await reqRow(r.id);
    expect(sender.calls).toBe(2); // the first message and the follow-up
    const sentMessage = sender.messages.at(-1) as OutgoingMessage;
    expect(sentMessage).toMatchObject({ to: approvedDraft?.to, subject: approvedDraft?.subject, body: approvedDraft?.body, threadId: row?.thread_id, inReplyTo: row?.sent_rfc_message_id });

    const view = (await A.get(a.s, r.id)).json<View>();
    expect(view.request.status).toBe('no_reply'); // a follow-up does not change the request's status
    expect(view.followup).toMatchObject({ state: 'sent', canSend: false, canCreate: false });
    expect(view.followup.sentAt).not.toBeNull();
    expect(await followups(r.id)).toEqual([expect.objectContaining({ status: 'sent', gmail_message_id: expect.stringMatching(/^fake-message-/) })]);
    expect(await events(r.id, 'followup_sent')).toEqual([expect.objectContaining({ actor_type: 'user', draft_hash: r.hash, payload: { sequence: 1, version: 2, delivery: 'fake' } })]);
    expect(await audits('request.followup_sent', r.id)).toBe(1);
  });

  it('is idempotent: the same key replays the first answer and sends once; another key finds it already sent', async () => {
    const a = await actor(h, 'fu-idem');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    const k = key();
    const first = await A.fSend(a.s, r.id, k);
    const replay = await A.fSend(a.s, r.id, k);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(sender.calls).toBe(2);
    const other = await A.fSend(a.s, r.id, key());
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: 'already_sent' });
    expect(sender.calls).toBe(2);
    expect(await events(r.id, 'followup_sent')).toHaveLength(1);
  });

  it('needs an Idempotency-Key, a well-formed one, and one that was not used for another request', async () => {
    const a = await actor(h, 'fu-key');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    const none = await h.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/followup/send`, headers: authed(a.s) });
    expect(none.json()).toMatchObject({ code: 'idempotency_key_required' });
    const bad = await h.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/followup/send`, headers: { ...authed(a.s), 'idempotency-key': 'short' } });
    expect(bad.json()).toMatchObject({ code: 'idempotency_key_invalid' });
    const second = await followupDraft(a);
    await A.fApprove(a.s, second.id, second.hash);
    const k = key();
    expect((await A.fSend(a.s, r.id, k)).statusCode).toBe(200);
    const reuse = await A.fSend(a.s, second.id, k);
    expect(reuse.statusCode).toBe(422);
    expect(reuse.json()).toMatchObject({ code: 'idempotency_key_reuse' });
  });

  it('is refused until the person approves: nothing is sent', async () => {
    const a = await actor(h, 'fu-noappr');
    const r = await followupDraft(a);
    const res = await A.fSend(a.s, r.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'approval_required' });
    expect(sender.calls).toBe(1); // only the first message
  });

  it('is refused by the database too: an unapproved follow-up cannot be marked sent, even by a direct update', async () => {
    const a = await actor(h, 'fu-db');
    const r = await followupDraft(a);
    const err = await pgError(t.app.query(`UPDATE request_followups SET status = 'sent', sent_at = now() WHERE request_id = $1`, [r.id]));
    expect(err.code).toBe('23514');
    expect((await followups(r.id))[0]?.status).toBe('drafted');
  });

  it.each([
    ['kept', `UPDATE user_companies SET kept_at = now() WHERE id = $1`, 'ucId', 'kept'],
    ['must_keep', `UPDATE companies SET must_keep = true WHERE id = $1`, 'companyId', 'must_keep'],
    ['company_excluded', `UPDATE user_companies SET status = 'not_mine' WHERE id = $1`, 'ucId', 'company_excluded'],
    ['no_contact', `UPDATE companies SET grievance_status = 'unknown' WHERE id = $1`, 'companyId', 'no_contact'],
    ['contact_bounced', `UPDATE companies SET grievance_status = 'bounced' WHERE id = $1`, 'companyId', 'contact_bounced'],
    ['contact_changed', `UPDATE companies SET grievance_email = 'privacy3@example.com' WHERE id = $1`, 'companyId', 'contact_changed'],
  ] as const)('%s: checked again at send, after approval, and nothing is sent', async (name, sql, idField, code) => {
    const a = await actor(h, `fu-send-${name}`);
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    await t.owner.query(sql, [r[idField]]);
    const res = await A.fSend(a.s, r.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code });
    expect(sender.calls).toBe(1);
    expect((await followups(r.id))[0]?.status).toBe('approved');
  });

  it.each([
    ['a reply from a person arrived', 'reply_received'],
    ['an outcome was reported', 'replied_deleted'],
  ])('is stopped when %s after it was approved', async (_name, status) => {
    const a = await actor(h, `fu-late-${status}`);
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    await setStatus(r.id, status);
    const res = await A.fSend(a.s, r.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'invalid_transition' });
    expect(sender.calls).toBe(1);
    expect((await A.get(a.s, r.id)).json<View>().followup.state).toBe('none');
  });

  it('is refused when the inbox is no longer connected', async () => {
    const a = await actor(h, 'fu-inbox');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    await t.owner.query(`UPDATE inboxes SET status = 'error' WHERE id = $1`, [a.inboxId]);
    expect((await A.fSend(a.s, r.id)).json()).toMatchObject({ code: 'inbox_not_connected' });
    expect(sender.calls).toBe(1);
  });

  it('after the sender refuses, nothing is sent and the same key can try again; after an unknown outcome it is not retried', async () => {
    const a = await actor(h, 'fu-fail');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    const k = key();
    sender.beforeSend = () => Promise.reject(new SenderRejectedError());
    const refused = await A.fSend(a.s, r.id, k);
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toMatchObject({ code: 'send_failed' });
    expect((await followups(r.id))[0]?.status).toBe('approved');
    sender.beforeSend = undefined;
    expect((await A.fSend(a.s, r.id, k)).statusCode).toBe(200);

    const b = await actor(h, 'fu-unknown');
    const r2 = await followupDraft(b);
    await A.fApprove(b.s, r2.id, r2.hash);
    const k2 = key();
    sender.beforeSend = () => Promise.reject(new SenderOutcomeUnknownError());
    const unknown = await A.fSend(b.s, r2.id, k2);
    expect(unknown.statusCode).toBe(502);
    expect(unknown.json()).toMatchObject({ code: 'send_outcome_unknown' });
    sender.beforeSend = undefined;
    const callsBefore = sender.calls;
    expect((await A.fSend(b.s, r2.id, k2)).json()).toMatchObject({ code: 'send_in_progress' });
    expect((await A.fSend(b.s, r2.id, key())).json()).toMatchObject({ code: 'send_in_progress' });
    expect(sender.calls).toBe(callsBefore);
    expect((await followups(r2.id))[0]?.status).toBe('approved');
  });

  it('sends once when two sends race, whichever keys they use', async () => {
    const a = await actor(h, 'fu-race');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    sender.beforeSend = () => gate;
    let answered = 0;
    const answer = <T,>(p: Promise<T>): Promise<T> =>
      p.then((v) => {
        answered += 1;
        if (answered === 2) open();
        return v;
      });
    const safety = setTimeout(open, 5000);
    const k = key();
    const calls = sender.calls;
    const results = await Promise.all([answer(A.fSend(a.s, r.id, k)), answer(A.fSend(a.s, r.id, k)), answer(A.fSend(a.s, r.id, key()))]);
    clearTimeout(safety);
    expect(results.filter((x) => x.statusCode === 200)).toHaveLength(1);
    expect(sender.calls - calls).toBe(1);
    expect(await events(r.id, 'followup_sent')).toHaveLength(1);
  });

  it('cannot be edited while it is being sent, or after it was sent', async () => {
    const a = await actor(h, 'fu-noedit');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    await A.fSend(a.s, r.id);
    const res = await A.fEdit(a.s, r.id, r.hash, 'S', 'B');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'request_not_editable' });
    expect((await A.fApprove(a.s, r.id, r.hash)).json()).toMatchObject({ code: 'already_sent' });
  });
});

// ---------- real sending ----------

class RealLikeSender implements RequestSender {
  readonly mode = 'real' as const;
  calls = 0;
  readonly messages: OutgoingMessage[] = [];
  send(message: OutgoingMessage): Promise<SentMessage> {
    this.calls += 1;
    this.messages.push(message);
    return Promise.resolve({ threadId: message.threadId ?? `real-thread-${this.calls}`, messageId: `real-message-${this.calls}`, rfcMessageId: `real-${this.calls}@mail.example.com`, delivery: 'real' });
  }
}

describe('real sending stays behind the same gates as the first request, and behind the wording sign-off', () => {
  let real: Harness;
  let signedOff: Harness;
  const realSender = new RealLikeSender();
  const signedOffSender = new RealLikeSender();
  let unavailable: Harness;
  let capped: Harness;
  const cappedSender = new RealLikeSender();
  beforeAll(async () => {
    real = await buildHarness(t, { sender: { kind: 'ready', sender: realSender } });
    signedOff = await buildHarness(t, { sender: { kind: 'ready', sender: signedOffSender }, followupWordingSignedOff: true });
    capped = await buildHarness(t, { sender: { kind: 'ready', sender: cappedSender }, followupWordingSignedOff: true, envOverrides: { REAL_SEND_DAILY_CAP: '3' } });
    unavailable = await buildHarness(t, { sender: { kind: 'unavailable', code: 'real_send_blocked', detail: 'Real sending stays off until the statute citation in the draft template has been verified.' } });
  });
  afterAll(async () => {
    await real.app.close();
    await signedOff.app.close();
    await unavailable.app.close();
    await capped.app.close();
  });

  /** A real-looking company (not a sample one), sent and made due through the given harness. */
  async function dueFollowup(hh: Harness, label: string, o: SeedOptions = {}) {
    const a = await actor(hh, label);
    const who = api(hh);
    const r = await sentRequest(a, { contact: 'real', ...o }, hh, who);
    await setNow(new Date(hh.clock.now.getTime() + 31 * DAY), hh);
    expect((await who.fCreate(a.s, r.id)).statusCode).toBe(200);
    const f = (await who.get(a.s, r.id)).json<View>().followup.draft;
    const edited = (await who.fEdit(a.s, r.id, f?.hash as string, f?.subject as string, resolveOpen(f?.body as string))).json<View>();
    const hash = edited.followup.draft?.hash as string;
    expect((await who.fApprove(a.s, r.id, hash)).statusCode).toBe(200);
    return { a, who, r, hash };
  }

  it('refuses a real follow-up until the wording is signed off (503 real_send_blocked), and says so in the view, with nothing sent', async () => {
    const { a, who, r } = await dueFollowup(real, 'fu-real-off');
    const view = (await who.get(a.s, r.id)).json<View>();
    expect(view.followup).toMatchObject({ state: 'approved', canSend: false });
    expect(view.followup.blockers).toEqual([expect.objectContaining({ code: 'real_send_blocked', message: expect.stringContaining('signed off') })]);
    const res = await who.fSend(a.s, r.id);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'real_send_blocked' });
    expect(realSender.calls).toBe(1); // only the first message went through the sender
  });

  it('sends a real follow-up once the wording is signed off, labelled real, and in the same conversation', async () => {
    const one = await dueFollowup(signedOff, 'fu-real-on-1');
    const before = signedOffSender.calls;
    const res = await one.who.fSend(one.a.s, one.r.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivery: 'real' });
    expect(res.json()).not.toHaveProperty('notice');
    expect(signedOffSender.calls).toBe(before + 1);
    expect(signedOffSender.messages.at(-1)).toMatchObject({ threadId: expect.any(String), inReplyTo: expect.stringMatching(/@mail\.example\.com$/) });
    expect(await events(one.r.id, 'followup_sent')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ delivery: 'real' }) })]);

  });

  it('stops at the daily limit of real sends, which counts follow-ups too', async () => {
    // A limit of 3 a day. Two first messages use two of them; the first follow-up takes the third; the second follow-up is over.
    const a = await actor(capped, 'fu-real-cap');
    const who = api(capped);
    const first = await sentRequest(a, { contact: 'real' }, capped, who);
    const second = await sentRequest(a, { contact: 'real' }, capped, who);
    // Make both due without moving the clock (the limit compares with the day on the clock): they were sent long ago.
    await t.owner.query(`UPDATE requests SET sent_at = $2, due_at = $2 WHERE id IN ($1, $3)`, [first.id, new Date(BASE.getTime() - 40 * DAY), second.id]);
    const ready = async (id: string) => {
      expect((await who.fCreate(a.s, id)).statusCode).toBe(200);
      const f = (await who.get(a.s, id)).json<View>().followup.draft;
      const edited = (await who.fEdit(a.s, id, f?.hash as string, f?.subject as string, resolveOpen(f?.body as string))).json<View>();
      expect((await who.fApprove(a.s, id, edited.followup.draft?.hash as string)).statusCode).toBe(200);
    };
    await ready(first.id);
    await ready(second.id);
    expect((await who.fSend(a.s, first.id)).statusCode).toBe(200);
    const over = await who.fSend(a.s, second.id);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: 'daily_cap_reached' });
    expect((await followups(second.id))[0]?.status).toBe('approved'); // nothing was sent, and it can be sent tomorrow
  });

  it('never sends a real follow-up for a sample company', async () => {
    const a = await actor(signedOff, 'fu-real-sample');
    const who = api(signedOff);
    // A sample (fictional) company: the first message goes through, then the follow-up is refused for real.
    const r = await created(a, { contact: 'fictional' }, signedOff);
    const v = (await who.get(a.s, r.id)).json<View>();
    const edited = (await who.edit(a.s, r.id, v.draft.hash, v.draft.subject, resolveOpen(v.draft.body))).json<View>();
    await who.approve(a.s, r.id, edited.draft.hash);
    // The real-like sender cannot send a sample company's first message either, so make it sent directly.
    await t.owner.query(`UPDATE requests SET status = 'sent', sent_at = $2, due_at = $2, thread_id = 'thread-sample', sent_rfc_message_id = 'sample@mail.example.com' WHERE id = $1`, [r.id, BASE]);
    await advance(31, signedOff);
    expect((await who.fCreate(a.s, r.id)).statusCode).toBe(200);
    const f = (await who.get(a.s, r.id)).json<View>().followup.draft;
    const e2 = (await who.fEdit(a.s, r.id, f?.hash as string, f?.subject as string, resolveOpen(f?.body as string))).json<View>();
    await who.fApprove(a.s, r.id, e2.followup.draft?.hash as string);
    expect((await who.fSend(a.s, r.id)).json()).toMatchObject({ code: 'fictional_company' });
  });

  it('answers 503 and shows the reason when sending is switched off here, whatever the wording says', async () => {
    const a = await actor(unavailable, 'fu-unavail');
    const who = api(unavailable);
    const r = await created(a, { contact: 'real' }, unavailable);
    const v = (await who.get(a.s, r.id)).json<View>();
    const edited = (await who.edit(a.s, r.id, v.draft.hash, v.draft.subject, resolveOpen(v.draft.body))).json<View>();
    expect((await who.approve(a.s, r.id, edited.draft.hash)).statusCode).toBe(200); // approving does not send
    // The first message was sent before sending was switched off: record that directly.
    await t.owner.query(`UPDATE requests SET status = 'sent', sent_at = $2, due_at = $2, thread_id = 'thread-x', sent_rfc_message_id = 'x@mail.example.com' WHERE id = $1`, [r.id, BASE]);
    await advance(31, unavailable);
    expect((await who.fCreate(a.s, r.id)).statusCode).toBe(200);
    const f = (await who.get(a.s, r.id)).json<View>().followup.draft;
    const e2 = (await who.fEdit(a.s, r.id, f?.hash as string, f?.subject as string, resolveOpen(f?.body as string))).json<View>();
    expect((await who.fApprove(a.s, r.id, e2.followup.draft?.hash as string)).statusCode).toBe(200);
    const view = (await who.get(a.s, r.id)).json<View>();
    expect(view.followup).toMatchObject({ state: 'approved', canSend: false });
    expect(view.followup.blockers.map((b) => b.code)).toContain('real_send_blocked');
    const res = await who.fSend(a.s, r.id);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'real_send_blocked' });
  });
});

// ---------- web-form requests: copy-only ----------

describe('a web-form request has a copy-only follow-up', () => {
  it('is drafted for the form, and never sent: sending and approving point to the form, and "submitted" records it', async () => {
    const a = await actor(h, 'fu-form');
    const r = await submittedForm(a);
    await advance(31);
    const created = await A.fCreate(a.s, r.id);
    expect(created.statusCode).toBe(200);
    const v = created.json<View>();
    expect(v.request.channel).toBe('web_form');
    expect(v.followup).toMatchObject({ state: 'drafted', canSend: false, canMarkSubmitted: false }); // the [OPEN] line is still in it
    expect(v.followup.draft?.body).toContain('I am following up on my request through your web form on 22 November 2026');
    expect(v.followup.draft?.body).toContain('I am submitting this through your web form.');

    const draft = v.followup.draft;
    const edited = (await A.fEdit(a.s, r.id, draft?.hash as string, draft?.subject as string, resolveOpen(draft?.body as string))).json<View>();
    expect(edited.followup).toMatchObject({ canMarkSubmitted: true, canSend: false, blockers: [] });
    const hash = edited.followup.draft?.hash as string;

    const approve = await A.fApprove(a.s, r.id, hash);
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ code: 'use_form', formUrl: 'https://example.com/privacy/request' });
    const send = await A.fSend(a.s, r.id);
    expect(send.statusCode).toBe(409);
    expect(send.json()).toMatchObject({ code: 'use_form' });

    const done = await A.fSubmitted(a.s, r.id, hash);
    expect(done.statusCode).toBe(200);
    expect(done.json<View>().followup).toMatchObject({ state: 'submitted', canMarkSubmitted: false });
    expect(done.json<View>().followup.sentAt).not.toBeNull();
    expect(await events(r.id, 'followup_approved')).toEqual([expect.objectContaining({ actor_type: 'user', draft_hash: hash, payload: expect.objectContaining({ forForm: true }) })]);
    // The first request was marked submitted at its version 2 (the [OPEN] line resolved); the follow-up at its version 2 too.
    expect((await events(r.id, 'submitted')).map((e) => e.payload)).toEqual([{ version: 2 }, { followup: 1, version: 2 }]);
    expect(sender.calls).toBe(0); // nothing was sent from here, ever
    expect(await audits('request.followup_submitted', r.id)).toBe(1);

    const again = await A.fSubmitted(a.s, r.id, hash);
    expect(again.statusCode).toBe(200); // saying it again changes nothing
    expect(await events(r.id, 'followup_approved')).toHaveLength(1);
  });

  it('refuses a draft that is not the one copied (draft_changed), an email request (not_a_form_request) and the guards', async () => {
    const a = await actor(h, 'fu-form-guards');
    const r = await submittedForm(a);
    await advance(31);
    await A.fCreate(a.s, r.id);
    const draft = (await A.get(a.s, r.id)).json<View>().followup.draft;
    const edited = (await A.fEdit(a.s, r.id, draft?.hash as string, draft?.subject as string, resolveOpen(draft?.body as string))).json<View>();
    const hash = edited.followup.draft?.hash as string;
    expect((await A.fSubmitted(a.s, r.id, draft?.hash as string)).json()).toMatchObject({ code: 'draft_changed' });
    await t.owner.query(`UPDATE user_companies SET kept_at = now() WHERE id = $1`, [r.ucId]);
    expect((await A.fSubmitted(a.s, r.id, hash)).json()).toMatchObject({ code: 'kept' });
    expect((await followups(r.id))[0]?.status).toBe('drafted');

    const b = await actor(h, 'fu-form-email');
    const e = await followupDraft(b);
    expect((await A.fSubmitted(b.s, e.id, e.hash)).json()).toMatchObject({ code: 'not_a_form_request' });
    expect((await A.fSubmitted(a.s, r.id, 'nope')).json()).toMatchObject({ code: 'validation_failed' });
  });
});

// ---------- the sweep ----------

describe('the follow-up sweep', () => {
  beforeEach(async () => {
    // Every test shares one database, so earlier requests are put out of the way (a closed request is never a candidate).
    await t.owner.query(`UPDATE requests SET status = 'closed'`);
  });
  const sweep = () => {
    const service = h.app.services?.followups;
    if (!service) throw new Error('follow-ups are not wired');
    return service.sweep();
  };

  it('prepares the follow-up for every request that is due, as the system, and is idempotent', async () => {
    const a = await actor(h, 'sw-a');
    const b = await actor(h, 'sw-b');
    const one = await sentRequest(a);
    const two = await sentRequest(b);
    await advance(29);
    expect(await sweep()).toEqual({ considered: 0, drafted: 0, blocked: 0, failed: 0 }); // not due yet
    await advance(31);
    expect(await sweep()).toEqual({ considered: 2, drafted: 2, blocked: 0, failed: 0 });
    for (const r of [one, two]) {
      expect(await followups(r.id)).toEqual([expect.objectContaining({ sequence: 1, status: 'drafted' })]);
      expect((await reqRow(r.id))?.status).toBe('no_reply');
      expect((await events(r.id, 'followup_drafted'))[0]).toMatchObject({ actor_type: 'system' });
      expect((await events(r.id, 'reply_label'))[0]).toMatchObject({ actor_type: 'system' });
      expect(await audits('request.followup_drafted', r.id)).toBe(1);
    }
    expect(await sweep()).toEqual({ considered: 0, drafted: 0, blocked: 0, failed: 0 }); // a second run changes nothing
    expect(await followups(one.id)).toHaveLength(1);
    expect(sender.calls).toBe(2); // the sweep never sends
  });

  it('skips a person who asked to delete their data, until they are active again', async () => {
    const a = await actor(h, 'sw-del');
    const r = await sentRequest(a);
    await advance(31);
    await t.owner.query(`UPDATE users SET status = 'deleting', deleted_at = now() WHERE id = $1`, [a.s.userId]);
    expect(await sweep()).toMatchObject({ considered: 0, drafted: 0 });
    expect(await followups(r.id)).toEqual([]);
    expect((await reqRow(r.id))?.status).toBe('sent');
    await t.owner.query(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = $1`, [a.s.userId]);
    expect(await sweep()).toMatchObject({ drafted: 1 });
  });

  it.each([
    ['a company the person keeps', `UPDATE user_companies SET kept_at = now() WHERE id = $1`, 'ucId'],
    ['a must-keep company', `UPDATE companies SET must_keep = true WHERE id = $1`, 'companyId'],
    ['a must-keep risk level', `UPDATE user_companies SET risk_level = 'must_keep' WHERE id = $1`, 'ucId'],
    ['a company marked as not theirs', `UPDATE user_companies SET status = 'not_mine' WHERE id = $1`, 'ucId'],
  ] as const)('skips %s, and leaves its status as it was', async (name, sql, idField) => {
    const a = await actor(h, `sw-skip-${name.length}`);
    const r = await sentRequest(a);
    await advance(31);
    await t.owner.query(sql, [r[idField]]);
    expect(await sweep()).toMatchObject({ considered: 0, drafted: 0 });
    expect(await followups(r.id)).toEqual([]);
    expect((await reqRow(r.id))?.status).toBe('sent');
  });

  it.each(['reply_received', 'replied_refused', 'replied_deleted', 'replied_info_requested', 'closed', 'bounced'])('skips a request that is %s', async (status) => {
    const a = await actor(h, `sw-status-${status}`);
    const r = await sentRequest(a);
    await advance(31);
    await setStatus(r.id, status);
    expect(await sweep()).toMatchObject({ considered: 0 });
    expect(await followups(r.id)).toEqual([]);
  });

  it('does not let an automatic reply stop it, and includes a web-form request', async () => {
    const a = await actor(h, 'sw-auto');
    const r = await sentRequest(a);
    await t.owner.query(`INSERT INTO request_replies (id, request_id, gmail_message_id, received_at, sender_domain, sender_match, automatic) VALUES ('rpl_00000000000000000000000SW1', $1, 'auto-sw', now(), 'shop.example', 'company', true)`, [r.id]);
    const f = await actor(h, 'sw-form');
    const form = await submittedForm(f);
    await advance(31);
    expect(await sweep()).toEqual({ considered: 2, drafted: 2, blocked: 0, failed: 0 });
    expect((await A.get(f.s, form.id)).json<View>().followup).toMatchObject({ state: 'drafted' });
    expect((await A.get(a.s, r.id)).json<View>().followup).toMatchObject({ state: 'drafted' });
  });

  it('reports a request it could not prepare (a missing contact) as blocked, and leaves it as it was', async () => {
    const a = await actor(h, 'sw-blocked');
    const r = await sentRequest(a);
    await advance(31);
    await t.owner.query(`UPDATE companies SET grievance_status = 'unknown' WHERE id = $1`, [r.companyId]);
    expect(await sweep()).toEqual({ considered: 1, drafted: 0, blocked: 1, failed: 0 });
    expect((await reqRow(r.id))?.status).toBe('sent');
    expect(await followups(r.id)).toEqual([]);
  });

  it('handles the oldest first, and at most the number it is given', async () => {
    const a = await actor(h, 'sw-limit');
    const first = await sentRequest(a);
    await setNow(new Date(BASE.getTime() + 1000));
    const second = await sentRequest(a);
    await advance(40);
    const service = h.app.services?.followups;
    if (!service) throw new Error('not wired');
    expect(await service.sweep(1)).toMatchObject({ considered: 1, drafted: 1 });
    expect((await followups(first.id)).length).toBe(1);
    expect((await followups(second.id)).length).toBe(0);
    expect(await service.sweep(5)).toMatchObject({ considered: 1, drafted: 1 });
  });

  it('never touches a follow-up that already exists or has been sent', async () => {
    const a = await actor(h, 'sw-done');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    await A.fSend(a.s, r.id);
    await advance(120);
    expect(await sweep()).toMatchObject({ considered: 0 });
    expect(await followups(r.id)).toHaveLength(1);
  });
});

// ---------- who may call it ----------

describe('who may use the follow-up routes', () => {
  it("another user's request looks like a missing one on every follow-up route (404), and nothing changes", async () => {
    const owner = await actor(h, 'fu-owner');
    const other = await actor(h, 'fu-other');
    const r = await followupDraft(owner);
    const hash = r.hash;
    const calls = [
      A.fCreate(other.s, r.id),
      A.fEdit(other.s, r.id, hash, 'S', 'B'),
      A.fApprove(other.s, r.id, hash),
      A.fSend(other.s, r.id),
      A.fSubmitted(other.s, r.id, hash),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    }
    expect((await followups(r.id))[0]?.status).toBe('drafted');
  });

  it('answers 404 when there is no follow-up yet, on every route that works on an existing one', async () => {
    const a = await actor(h, 'fu-none');
    const r = await sentRequest(a);
    await advance(31);
    for (const res of [await A.fEdit(a.s, r.id, 'ab'.repeat(32), 'S', 'B'), await A.fApprove(a.s, r.id, 'ab'.repeat(32)), await A.fSend(a.s, r.id), await A.fSubmitted(a.s, r.id, 'ab'.repeat(32))]) {
      expect(res.statusCode).toBe(404);
    }
  });

  it('needs a session (401) and the CSRF token (403)', async () => {
    const a = await actor(h, 'fu-auth');
    const r = await sentRequest(a);
    await advance(31);
    for (const url of ['followup', 'followup/approve', 'followup/submitted', 'followup/send']) {
      expect((await h.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/${url}`, payload: {} })).statusCode, url).toBe(401);
      const noCsrf = await h.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/${url}`, headers: { cookie: a.s.cookie, origin: 'http://localhost:3000', 'idempotency-key': key() }, payload: {} });
      expect(noCsrf.statusCode, url).toBe(403);
    }
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/requests/${r.id}/followup/draft`, payload: {} })).statusCode).toBe(401);
    expect(await followups(r.id)).toEqual([]);
  });

  it('is refused for a person who asked to delete their data, on every route, and works again when they are active again', async () => {
    const a = await actor(h, 'fu-deleting');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    await t.owner.query(`UPDATE users SET status = 'deleting', deleted_at = now() WHERE id = $1`, [a.s.userId]);
    for (const res of [await A.fCreate(a.s, r.id), await A.fEdit(a.s, r.id, r.hash, 'S', 'B'), await A.fApprove(a.s, r.id, r.hash), await A.fSend(a.s, r.id), await A.fSubmitted(a.s, r.id, r.hash)]) {
      expect(res.statusCode).toBe(401);
    }
    expect(sender.calls).toBe(1); // only the first message
    expect((await followups(r.id))[0]?.status).toBe('approved');
    await t.owner.query(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = $1`, [a.s.userId]);
    expect((await A.fSend(a.s, r.id)).statusCode).toBe(200);
  });

  it('validates the bodies: an unknown field or a malformed hash is a 400', async () => {
    const a = await actor(h, 'fu-body');
    const r = await followupDraft(a);
    for (const payload of [{}, { draftHash: 'nope' }, { draftHash: r.hash, extra: 1 }]) {
      const res = await h.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/followup/approve`, headers: authed(a.s), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'validation_failed' });
    }
  });
});

// ---------- what the view and list show ----------

describe('the request view shows the follow-up without any text from a reply', () => {
  it('stores and shows only ids, hashes, times and our own draft text', async () => {
    const a = await actor(h, 'fu-privacy');
    const r = await followupDraft(a);
    await A.fApprove(a.s, r.id, r.hash);
    await A.fSend(a.s, r.id);
    const stored = JSON.stringify([
      (await t.owner.query('SELECT * FROM request_followups WHERE request_id = $1', [r.id])).rows,
      (await t.owner.query(`SELECT * FROM request_events WHERE request_id = $1 AND type IN ('followup_drafted','followup_approved','followup_sent')`, [r.id])).rows,
    ]);
    expect(stored).not.toMatch(/@|erase my|Dear |I am following up/i);
  });
});

// ---------- the list carries the same follow-up facts, and reply counts ----------

describe('the request list', () => {
  interface Item { id: string; status: string; replies: { count: number; automaticCount: number }; followup: { state: string; canCreate: boolean } }
  const listFor = async (a: Actor) =>
    (await h.app.inject({ method: 'GET', url: '/v1/requests', headers: { cookie: a.s.cookie } })).json<{ requests: Item[] }>().requests;
  const item = async (a: Actor, id: string) => (await listFor(a)).find((r) => r.id === id);

  it('says where each follow-up stands, through the whole flow, and always agrees with the request view', async () => {
    const a = await actor(h, 'list-flow');
    const unsent = await created(a);
    const r = await sentRequest(a);
    expect(await item(a, unsent.id)).toMatchObject({ followup: { state: 'none', canCreate: false }, replies: { count: 0, automaticCount: 0 } });
    expect((await item(a, r.id))?.followup).toEqual({ state: 'not_due', canCreate: false });
    await advance(31);
    const agrees = async (expected: { state: string; canCreate: boolean }) => {
      expect((await item(a, r.id))?.followup).toEqual(expected);
      const view = (await A.get(a.s, r.id)).json<View>().followup;
      expect({ state: view.state, canCreate: view.canCreate }).toEqual(expected);
    };
    await agrees({ state: 'due', canCreate: true });
    expect((await A.fCreate(a.s, r.id)).statusCode).toBe(200);
    await agrees({ state: 'drafted', canCreate: false });
    const f = (await A.get(a.s, r.id)).json<View>().followup.draft;
    const edited = (await A.fEdit(a.s, r.id, f?.hash as string, f?.subject as string, resolveOpen(f?.body as string))).json<View>();
    expect((await A.fApprove(a.s, r.id, edited.followup.draft?.hash as string)).statusCode).toBe(200);
    await agrees({ state: 'approved', canCreate: false });
    expect((await A.fSend(a.s, r.id)).statusCode).toBe(200);
    await agrees({ state: 'sent', canCreate: false });
  });

  it('counts replies from a person and automatic ones apart, per request, and only the person’s own', async () => {
    const a = await actor(h, 'list-replies-a');
    const b = await actor(h, 'list-replies-b');
    const ra = await sentRequest(a);
    const other = await sentRequest(a);
    const rb = await sentRequest(b);
    const add = (requestId: string, n: string, automatic: boolean) =>
      t.owner.query(`INSERT INTO request_replies (id, request_id, gmail_message_id, received_at, sender_domain, sender_match, automatic) VALUES ($1, $2, $3, now(), 'shop.example', 'company', $4)`, [newId('reply'), requestId, n, automatic]);
    await add(ra.id, 'm1', false);
    await add(ra.id, 'm2', true);
    await add(ra.id, 'm3', true);
    await add(rb.id, 'm4', false);
    expect((await item(a, ra.id))?.replies).toEqual({ count: 1, automaticCount: 2 });
    expect((await item(a, other.id))?.replies).toEqual({ count: 0, automaticCount: 0 });
    expect((await listFor(a)).map((r) => r.id)).not.toContain(rb.id);
    expect((await item(b, rb.id))?.replies).toEqual({ count: 1, automaticCount: 0 });
  });

  it('does not offer a follow-up that a guard would refuse, or one after a reply', async () => {
    const a = await actor(h, 'list-guard');
    const kept = await sentRequest(a);
    const replied = await sentRequest(a);
    await advance(31);
    await t.owner.query('UPDATE user_companies SET kept_at = now() WHERE id = $1', [kept.ucId]);
    await setStatus(replied.id, 'reply_received');
    expect((await item(a, kept.id))?.followup).toEqual({ state: 'due', canCreate: false });
    expect((await item(a, replied.id))?.followup).toEqual({ state: 'none', canCreate: false });
  });
});

