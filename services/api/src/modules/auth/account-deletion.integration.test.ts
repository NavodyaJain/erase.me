import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../common/ids.js';
import { Scheduler, PgTaskLock } from '../../jobs/scheduler.js';
import { actorFactory, type Actor } from '../../../test/actors.js';
import { createTestDb, pgError, type TestDb } from '../../../test/db-helper.js';
import { authed, buildHarness, connectInbox, signIn, type Harness, type Session } from '../../../test/harness.js';
import { PURGE_EVERY_MS, purgeTask } from '../purge/purge.service.js';

const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date('2026-11-22T10:00:00Z');

let t: TestDb;
let h: Harness;

beforeAll(async () => {
  t = await createTestDb();
  h = await buildHarness(t);
});
afterAll(async () => {
  await h.app.close();
  await t.drop();
});
beforeEach(() => {
  h.clock.now = new Date(BASE);
  h.google.revokeResult = true;
});

const actor = actorFactory(() => t);
const key = () => `key-${randomBytes(8).toString('hex')}`;
const get = (s: Session, url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
const send = (s: Session, method: 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: { ...authed(s), ...extra }, ...(payload === undefined ? {} : { payload: payload as object }) });

interface Deletion {
  status: string;
  requestedAt: string | null;
  deleteAfter: string | null;
  canUndo: boolean;
  paused: boolean;
  googleAccess: { notRevoked: number; message: string | null };
  gmailCopies: string;
  notice: string;
}
const num = async (sql: string, params: unknown[] = []) => Number((await t.owner.query<{ n: string }>(sql, params)).rows[0]?.n);
const userRow = async (id: string) =>
  (await t.owner.query<{ email: string; name: string; google_sub: string; status: string; deleted_at: Date | null; deletion_due_at: Date | null; token_revoke_failed: number }>(
    'SELECT email, name, google_sub, status, deleted_at, deletion_due_at, token_revoke_failed FROM users WHERE id = $1',
    [id],
  )).rows[0];
/** Makes the undo period end now, as if the days had passed. The purge functions read the database clock. */
const endUndoPeriod = (userId: string) =>
  t.owner.query(`UPDATE users SET deletion_requested_at = now() - interval '8 days', deletion_due_at = now() - interval '1 minute' WHERE id = $1`, [userId]);
/** Keeps sessions valid when a test moves the app clock a long way. */
const setNow = async (when: Date) => {
  h.clock.now = when;
  await t.owner.query(`UPDATE sessions SET expires_at = '2100-01-01T00:00:00Z' WHERE revoked_at IS NULL`);
};

const resolveOpen = (body: string) => body.split('\n').filter((l) => !l.startsWith('[OPEN')).join('\n');
interface View { draft: { hash: string; subject: string; body: string }; request: { id: string; status: string } }

/** A request drafted, edited, approved and (when asked) sent, through the API. */
async function makeRequest(a: Actor, o: { send?: boolean } = {}) {
  const { ucId } = await a.seed({ contact: 'fictional' });
  const made = await send(a.s, 'POST', '/v1/requests/drafts', { userCompanyIds: [ucId] });
  const id = made.json<{ results: Array<{ requestId: string }> }>().results[0]?.requestId as string;
  const v = (await get(a.s, `/v1/requests/${id}`)).json<View>();
  const edited = (await send(a.s, 'PATCH', `/v1/requests/${id}/draft`, { baseHash: v.draft.hash, subject: v.draft.subject, body: resolveOpen(v.draft.body) })).json<View>();
  expect((await send(a.s, 'POST', `/v1/requests/${id}/approve`, { draftHash: edited.draft.hash })).statusCode).toBe(200);
  if (o.send) expect((await send(a.s, 'POST', `/v1/requests/${id}/send`, undefined, { 'idempotency-key': key() })).statusCode).toBe(200);
  return { id, ucId };
}

/** Rows in every table that point at this person: replies, labels, a follow-up, a send claim, a scan, a sign-in attempt. */
async function addExtras(a: Actor, requestId: string) {
  const o = t.owner;
  await o.query(`INSERT INTO request_replies (id, request_id, gmail_message_id, received_at, sender_domain, sender_match, automatic) VALUES ($1, $2, 'msg-1', now(), 'shop.example', 'company', false)`, [newId('reply'), requestId]);
  await o.query(`INSERT INTO reply_labels (id, request_id, label, confidence, signals, source) VALUES ($1, $2, 'other', 0.5, '{}'::text[], 'model')`, [newId('replyLabel'), requestId]);
  await o.query(`INSERT INTO request_followups (id, request_id, sequence, status) VALUES ($1, $2, 1, 'cancelled')`, [newId('followup'), requestId]);
  // (A request that was sent already has its send claim in idempotency_keys.)
  await o.query(`INSERT INTO scans (id, inbox_id, status) VALUES ($1, $2, 'done')`, [newId('scan'), a.inboxId]);
  await o.query(
    `INSERT INTO oauth_states (id, state_hash, purpose, user_id, code_verifier, nonce, expires_at) VALUES ($1, $2, 'connect', $3, 'v', 'n', now() + interval '10 minutes')`,
    [newId('oauthState'), randomBytes(16).toString('hex'), a.s.userId],
  );
}

const userRowCounts = async (userId: string) => {
  const q = (sql: string) => num(sql, [userId]);
  return {
    requests: await q('SELECT count(*) AS n FROM requests WHERE user_id = $1'),
    events: await q('SELECT count(*) AS n FROM request_events e JOIN requests r ON r.id = e.request_id WHERE r.user_id = $1'),
    drafts: await q('SELECT count(*) AS n FROM request_drafts d JOIN requests r ON r.id = d.request_id WHERE r.user_id = $1'),
    replies: await q('SELECT count(*) AS n FROM request_replies d JOIN requests r ON r.id = d.request_id WHERE r.user_id = $1'),
    labels: await q('SELECT count(*) AS n FROM reply_labels d JOIN requests r ON r.id = d.request_id WHERE r.user_id = $1'),
    followups: await q('SELECT count(*) AS n FROM request_followups d JOIN requests r ON r.id = d.request_id WHERE r.user_id = $1'),
    keys: await q('SELECT count(*) AS n FROM idempotency_keys WHERE user_id = $1'),
    companies: await q('SELECT count(*) AS n FROM user_companies WHERE user_id = $1'),
    inboxes: await q('SELECT count(*) AS n FROM inboxes WHERE user_id = $1'),
    scans: await q('SELECT count(*) AS n FROM scans s JOIN inboxes i ON i.id = s.inbox_id WHERE i.user_id = $1'),
    sessions: await q('SELECT count(*) AS n FROM sessions WHERE user_id = $1'),
    states: await q('SELECT count(*) AS n FROM oauth_states WHERE user_id = $1'),
  };
};

// ---------------------------------------------------------------------------------------------------------------------

describe('asking to delete: the undo period', () => {
  it('starts a 7-day undo period, asks Google to remove access, and says what is paused and what is untouched', async () => {
    const a = await actor(h, 'del-start');
    const r = await makeRequest(a);
    const res = await send(a.s, 'DELETE', '/v1/me');
    expect(res.statusCode).toBe(202);
    const body = res.json<Deletion>();
    expect(body).toMatchObject({ status: 'deleting', canUndo: true, paused: true, googleAccess: { notRevoked: 0, message: null } });
    expect(new Date(body.deleteAfter as string).getTime() - new Date(body.requestedAt as string).getTime()).toBe(7 * DAY);
    expect(new Date(body.requestedAt as string).toISOString()).toBe(BASE.toISOString());
    // Gmail copies of the sent requests are not touched, and the response says so.
    expect(body.gmailCopies).toMatch(/stay in your own Gmail/);
    expect(body.gmailCopies).toMatch(/does not delete them/);
    // Google was asked to remove access for the inbox, and the inbox is disconnected with its token dropped.
    expect(h.google.revoked.size).toBeGreaterThan(0);
    const inbox = (await t.owner.query<{ status: string; token_ciphertext: string | null }>('SELECT status, token_ciphertext FROM inboxes WHERE user_id = $1', [a.s.userId])).rows;
    expect(inbox.every((i) => i.status === 'disconnected' && i.token_ciphertext === null)).toBe(true);
    // Nothing is deleted yet.
    expect(await num('SELECT count(*) AS n FROM requests WHERE id = $1', [r.id])).toBe(1);
    const row = await userRow(a.s.userId);
    expect(row?.email).toBe(`${'del-start'}@example.test`);
    expect(row?.deleted_at).toBeNull();
  });

  it('asking again keeps the first end date', async () => {
    const a = await actor(h, 'del-twice');
    const first = (await send(a.s, 'DELETE', '/v1/me')).json<Deletion>();
    h.clock.now = new Date(BASE.getTime() + 2 * DAY);
    await setNow(h.clock.now);
    const second = (await send(a.s, 'DELETE', '/v1/me')).json<Deletion>();
    expect(second.deleteAfter).toBe(first.deleteAfter);
    expect(second.requestedAt).toBe(first.requestedAt);
  });

  it('keeps the session, but only the account routes work: everything else, including sending, answers deletion_pending', async () => {
    const a = await actor(h, 'del-pause');
    const r = await makeRequest(a);
    await send(a.s, 'DELETE', '/v1/me');
    expect((await get(a.s, '/v1/me')).statusCode).toBe(200);
    expect((await get(a.s, '/v1/me/deletion')).json<Deletion>().status).toBe('deleting');
    for (const [method, url] of [
      ['GET', '/v1/requests'],
      ['GET', `/v1/requests/${r.id}`],
      ['GET', '/v1/companies'],
      ['GET', '/v1/inboxes'],
      ['POST', `/v1/requests/${r.id}/send`],
      ['POST', `/v1/requests/${r.id}/followup`],
      ['POST', '/v1/inboxes/connect/start'],
    ] as const) {
      const res = method === 'GET' ? await get(a.s, url) : await send(a.s, 'POST', url, undefined, { 'idempotency-key': key() });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toMatchObject({ code: 'deletion_pending' });
    }
    // The inbox cannot be connected again during the undo period, even through a Google callback.
    expect(await num(`SELECT count(*) AS n FROM inboxes WHERE user_id = $1 AND status = 'connected'`, [a.s.userId])).toBe(0);
  });

  it('a person signing in again during the undo period gets the same account, limited in the same way', async () => {
    const a = await actor(h, 'del-signin');
    await send(a.s, 'DELETE', '/v1/me');
    const again = await signIn(h, { email: 'del-signin@example.test', sub: 'g-del-signin' }, 'code-del-signin-2');
    expect(again.userId).toBe(a.s.userId);
    expect((await get(again, '/v1/requests')).json()).toMatchObject({ code: 'deletion_pending' });
    expect((await get(again, '/v1/me/deletion')).json<Deletion>()).toMatchObject({ status: 'deleting', canUndo: true });
  });

  it('is private to the person: another person cannot see or undo it', async () => {
    const a = await actor(h, 'del-priv-a');
    const b = await actor(h, 'del-priv-b');
    await send(a.s, 'DELETE', '/v1/me');
    expect((await get(b.s, '/v1/me/deletion')).json<Deletion>()).toMatchObject({ status: 'active', paused: false });
    const undo = await send(b.s, 'POST', '/v1/me/deletion/undo');
    expect(undo.json()).toMatchObject({ code: 'not_pending_deletion' });
    expect((await userRow(a.s.userId))?.status).toBe('deleting');
    expect((await get(b.s, '/v1/requests')).statusCode).toBe(200);
  });

  it('needs the CSRF header like any other change, and a session', async () => {
    const a = await actor(h, 'del-csrf');
    expect((await h.app.inject({ method: 'DELETE', url: '/v1/me', headers: { cookie: a.s.cookie } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: '/v1/me' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me/deletion' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/v1/me/deletion/undo' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/v1/me/deletion/now' })).statusCode).toBe(401);
    expect((await userRow(a.s.userId))?.status).toBe('active');
  });
});

describe('undo', () => {
  it('works inside the undo period: the data is all still there and the account works again', async () => {
    const a = await actor(h, 'undo-in');
    const r = await makeRequest(a);
    await send(a.s, 'DELETE', '/v1/me');
    await setNow(new Date(BASE.getTime() + 6 * DAY + 23 * 60 * 60 * 1000));
    const res = await send(a.s, 'POST', '/v1/me/deletion/undo');
    expect(res.statusCode).toBe(200);
    expect(res.json<Deletion>()).toMatchObject({ status: 'active', canUndo: false, paused: false, requestedAt: null, deleteAfter: null });
    const row = await userRow(a.s.userId);
    expect(row).toMatchObject({ status: 'active', deletion_due_at: null, token_revoke_failed: 0 });
    expect((await get(a.s, `/v1/requests/${r.id}`)).statusCode).toBe(200);
    expect(await num('SELECT count(*) AS n FROM audit_log WHERE action = $1 AND target_id = $2', ['account.deletion_undone', a.s.userId])).toBe(1);
  });

  it('fails after the undo period, with undo_window_closed, even before the purge has run', async () => {
    const a = await actor(h, 'undo-late');
    await send(a.s, 'DELETE', '/v1/me');
    await setNow(new Date(BASE.getTime() + 7 * DAY + 1000));
    const res = await send(a.s, 'POST', '/v1/me/deletion/undo');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'undo_window_closed' });
    expect((await get(a.s, '/v1/me/deletion')).json<Deletion>()).toMatchObject({ status: 'deleting', canUndo: false, paused: true });
    expect((await userRow(a.s.userId))?.status).toBe('deleting');
  });

  it('fails when nothing is pending: not_pending_deletion', async () => {
    const a = await actor(h, 'undo-none');
    const res = await send(a.s, 'POST', '/v1/me/deletion/undo');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_pending_deletion' });
  });
});

describe('Google access when deleting', () => {
  it('records a revoke that Google did not confirm as a count, and tells the person to remove access in their Google account', async () => {
    const a = await actor(h, 'revoke-fail');
    h.google.revokeResult = false;
    const res = await send(a.s, 'DELETE', '/v1/me');
    const body = res.json<Deletion>();
    expect(body.googleAccess.notRevoked).toBe(1);
    expect(body.googleAccess.message).toMatch(/Google account settings/);
    expect(body.googleAccess.message).toMatch(/remove it/);
    expect((await userRow(a.s.userId))?.token_revoke_failed).toBe(1);
    expect((await get(a.s, '/v1/me/deletion')).json<Deletion>().googleAccess.notRevoked).toBe(1);
    // The inbox is disconnected here whatever Google answered, so nothing more is called.
    expect(await num(`SELECT count(*) AS n FROM inboxes WHERE user_id = $1 AND status = 'connected'`, [a.s.userId])).toBe(0);
    // Counts only: no address and no token in the logs or in the stored count.
    expect(h.logs.text()).not.toMatch(/revoke-fail/);
    expect(h.logs.text()).not.toMatch(/refresh-/);
  });

  it('counts a revoke that throws, and still disconnects and carries on', async () => {
    const a = await actor(h, 'revoke-throw');
    const original = h.google.revoke.bind(h.google);
    h.google.revoke = () => Promise.reject(new Error('network down'));
    try {
      const body = (await send(a.s, 'DELETE', '/v1/me')).json<Deletion>();
      expect(body).toMatchObject({ status: 'deleting', googleAccess: { notRevoked: 1 } });
    } finally {
      h.google.revoke = original;
    }
  });

  it('says nothing about Google when every revoke was confirmed', async () => {
    const a = await actor(h, 'revoke-ok');
    const body = (await send(a.s, 'DELETE', '/v1/me')).json<Deletion>();
    expect(body.googleAccess).toEqual({ notRevoked: 0, message: null });
  });
});

describe('paused while deletion is pending', () => {
  it('reply checks, follow-up sweeps and sends skip the person, and carry on for everyone else', async () => {
    const a = await actor(h, 'pause-a');
    const b = await actor(h, 'pause-b');
    const ra = await makeRequest(a, { send: true });
    const rb = await makeRequest(b, { send: true });
    const services = h.app.services;
    if (!services) throw new Error('no services');
    expect((await services.replies.runOnce()).checked).toBe(2);
    await setNow(new Date(BASE.getTime() + 31 * DAY));
    // Pending for A only. The inbox is left connected, to show the pause is the rule and not a side effect of the revoke.
    await t.owner.query(`UPDATE users SET status = 'deleting', deletion_requested_at = now(), deletion_due_at = now() + interval '7 days' WHERE id = $1`, [a.s.userId]);
    expect((await services.replies.runOnce()).checked).toBe(1);
    const swept = await services.followups.sweep();
    expect(swept.drafted).toBe(1);
    expect(await num('SELECT count(*) AS n FROM request_followups WHERE request_id = $1', [ra.id])).toBe(0);
    expect(await num('SELECT count(*) AS n FROM request_followups WHERE request_id = $1', [rb.id])).toBe(1);
  });

  it('a send is refused even when it was already on its way: the service checks again', async () => {
    const a = await actor(h, 'pause-send');
    const r = await makeRequest(a);
    await t.owner.query(`UPDATE users SET status = 'deleting', deletion_requested_at = now(), deletion_due_at = now() + interval '7 days' WHERE id = $1`, [a.s.userId]);
    const services = h.app.services;
    if (!services) throw new Error('no services');
    await expect(services.requests.send(a.s.userId, r.id, key())).rejects.toMatchObject({ code: 'deletion_pending' });
    expect(await num(`SELECT count(*) AS n FROM request_events WHERE request_id = $1 AND type = 'sent'`, [r.id])).toBe(0);
  });

  it('a follow-up send is refused too', async () => {
    const a = await actor(h, 'pause-fsend');
    const r = await makeRequest(a, { send: true });
    await setNow(new Date(BASE.getTime() + 31 * DAY));
    const created = await send(a.s, 'POST', `/v1/requests/${r.id}/followup`);
    expect(created.statusCode).toBe(200);
    await t.owner.query(`UPDATE users SET status = 'deleting', deletion_requested_at = now(), deletion_due_at = now() + interval '7 days' WHERE id = $1`, [a.s.userId]);
    const services = h.app.services;
    if (!services) throw new Error('no services');
    await expect(services.followups.send(a.s.userId, r.id, key())).rejects.toMatchObject({ code: 'deletion_pending' });
  });
});

describe('the purge', () => {
  it('removes only that person’s data, and leaves another person’s rows untouched', async () => {
    const b = await actor(h, 'iso-b');
    const rb = await makeRequest(b, { send: true });
    await addExtras(b, rb.id);
    const a = await actor(h, 'iso-a');
    const ra = await makeRequest(a, { send: true });
    await addExtras(a, ra.id);

    // A hash of the content of every row that belongs to the person, found through their own id.
    const content = async (userId: string): Promise<string> => {
      const queries = [
        'SELECT to_jsonb(x)::text AS r FROM requests x WHERE x.user_id = $1',
        'SELECT to_jsonb(x)::text FROM request_events x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
        'SELECT to_jsonb(x)::text FROM request_drafts x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
        'SELECT to_jsonb(x)::text FROM request_replies x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
        'SELECT to_jsonb(x)::text FROM reply_labels x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
        'SELECT to_jsonb(x)::text FROM request_followups x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
        'SELECT to_jsonb(x)::text FROM idempotency_keys x WHERE x.user_id = $1',
        'SELECT to_jsonb(x)::text FROM user_companies x WHERE x.user_id = $1',
        'SELECT to_jsonb(x)::text FROM inboxes x WHERE x.user_id = $1',
        'SELECT to_jsonb(x)::text FROM scans x JOIN inboxes i ON i.id = x.inbox_id WHERE i.user_id = $1',
        'SELECT to_jsonb(x)::text FROM sessions x WHERE x.user_id = $1',
        'SELECT to_jsonb(x)::text FROM oauth_states x WHERE x.user_id = $1',
      ];
      let all = '';
      for (const q of queries) all += (await t.owner.query<{ r: string }>(q, [userId])).rows.map((r) => r.r).sort().join('|') + '#';
      return createHash('sha256').update(all).digest('hex');
    };
    // The catalogue is shared: only per-person rows are checked.
    const bBefore = await userRowCounts(b.s.userId);
    expect(bBefore.requests).toBe(1);
    expect(bBefore.replies + bBefore.labels + bBefore.followups + bBefore.keys + bBefore.scans + bBefore.states).toBeGreaterThanOrEqual(6);
    const aBefore = await userRowCounts(a.s.userId);
    expect(aBefore.requests).toBe(1);
    expect(aBefore.replies + aBefore.labels + aBefore.followups + aBefore.keys + aBefore.scans + aBefore.states).toBeGreaterThanOrEqual(6);
    const bRows = async () => (await t.owner.query<{ r: string }>(`SELECT to_jsonb(u)::text AS r FROM users u WHERE id = $1`, [b.s.userId])).rows[0]?.r;
    const bUser = await bRows();
    const bContentBefore = await content(b.s.userId);
    const aContentBefore = await content(a.s.userId);
    expect(aContentBefore).not.toBe(await content('usr_none'));

    await send(a.s, 'DELETE', '/v1/me');
    await endUndoPeriod(a.s.userId);
    // Only the account purge runs here (called as the app role, like the job does), so any difference in B's rows is its doing.
    const purged = (await t.app.query<{ r: Record<string, number> }>('SELECT public.purge_users(25, false) AS r')).rows[0]?.r;
    expect(purged).toMatchObject({ accounts_purged: 1, users_tombstoned: 1 });

    expect(await userRowCounts(a.s.userId)).toEqual({ requests: 0, events: 0, drafts: 0, replies: 0, labels: 0, followups: 0, keys: 0, companies: 0, inboxes: 0, scans: 0, sessions: 0, states: 0 });
    expect(await userRowCounts(b.s.userId)).toEqual(bBefore);
    expect(await bRows()).toBe(bUser);
    // B's rows are the same, byte for byte, in every table.
    expect(await content(b.s.userId)).toBe(bContentBefore);
    // B can still use the account.
    expect((await get(b.s, `/v1/requests/${rb.id}`)).statusCode).toBe(200);
    // The shared company catalogue is not a person's data and stays.
    expect(await num('SELECT count(*) AS n FROM companies WHERE id = (SELECT company_id FROM user_companies WHERE user_id = $1 LIMIT 1)', [b.s.userId])).toBe(1);
  });

  it('leaves a tombstone with no personal data: no email, no name, no Google id and no hash of any of them', async () => {
    const a = await actor(h, 'tomb.stone.person');
    const r = await makeRequest(a, { send: true });
    await addExtras(a, r.id);
    const sub = 'g-tomb.stone.person';
    const email = 'tomb.stone.person@example.test';
    const inboxEmail = 'tomb.stone.person-mail@example.test';
    await send(a.s, 'DELETE', '/v1/me');
    await endUndoPeriod(a.s.userId);
    await h.app.services?.purge.runOnce();

    const row = await userRow(a.s.userId);
    expect(row).toMatchObject({ email: '', name: '', google_sub: `deleted:${a.s.userId}`, status: 'deleting' });
    expect(row?.deleted_at).not.toBeNull();

    // Scan every column of every table, as text, for anything that identifies the person, or a hash or encoding of it.
    const needles = new Set<string>([email, inboxEmail, 'tomb.stone.person', sub, 'Person tomb.stone.person']);
    for (const text of [email, inboxEmail, sub]) {
      needles.add(createHash('sha256').update(text).digest('hex'));
      needles.add(createHash('md5').update(text).digest('hex'));
      needles.add(createHash('sha1').update(text).digest('hex'));
      needles.add(Buffer.from(text).toString('base64'));
      needles.add(Buffer.from(text).toString('hex'));
    }
    const tables = (await t.owner.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((x) => x.table_name);
    for (const table of tables) {
      const { rows } = await t.owner.query(`SELECT 1 FROM "${table}" x WHERE to_jsonb(x)::text ILIKE ANY ($1::text[]) LIMIT 1`, [[...needles].map((n) => `%${n}%`)]);
      expect(rows, `personal data found in ${table}`).toHaveLength(0);
    }
    // Nor does the tombstone's own row carry anything but the id, status and dates.
    const columns = (await t.owner.query<Record<string, unknown>>('SELECT * FROM users WHERE id = $1', [a.s.userId])).rows[0] ?? {};
    for (const [k, v] of Object.entries(columns)) {
      if (['id', 'google_sub', 'email', 'name', 'status'].includes(k)) continue;
      expect(typeof v === 'string' ? v : '', k).not.toMatch(/@|tomb/i);
    }
    // The same Google account signing in again is a new account, not the old one.
    const again = await signIn(h, { email, sub, name: 'Person tomb.stone.person' }, 'code-tomb-again');
    expect(again.userId).not.toBe(a.s.userId);
    expect((await userRow(a.s.userId))?.email).toBe('');
  });

  it('does nothing before the undo period ends, and nothing for an active person', async () => {
    const a = await actor(h, 'early');
    const b = await actor(h, 'early-active');
    await makeRequest(a);
    await send(a.s, 'DELETE', '/v1/me');
    const counts = await h.app.services?.purge.runOnce();
    expect(counts?.users).toMatchObject({ accounts_purged: 0 });
    expect(await num('SELECT count(*) AS n FROM requests WHERE user_id = $1', [a.s.userId])).toBe(1);
    expect((await userRow(b.s.userId))?.status).toBe('active');
    // The function itself refuses, too: it will not delete an active person or one still inside the undo period.
    expect(await pgError(t.app.query('SELECT public.purge_user($1)', [b.s.userId]))).toMatchObject({ code: 'P0001' });
    expect(await pgError(t.app.query('SELECT public.purge_user($1)', [a.s.userId]))).toMatchObject({ code: 'P0001' });
  });

  it('a dry run counts what it would remove and removes nothing', async () => {
    const a = await actor(h, 'dry');
    const r = await makeRequest(a, { send: true });
    await addExtras(a, r.id);
    await send(a.s, 'DELETE', '/v1/me');
    await endUndoPeriod(a.s.userId);
    const dry = await h.app.services?.purge.runOnce({ dryRun: true });
    expect(dry?.users['requests']).toBe(1);
    expect(dry?.users['accounts_purged']).toBe(0);
    expect(await num('SELECT count(*) AS n FROM requests WHERE user_id = $1', [a.s.userId])).toBe(1);
    expect((await userRow(a.s.userId))?.email).toBe('dry@example.test');
    const one = (await t.app.query<{ r: Record<string, number> }>('SELECT public.purge_user($1, 100, true) AS r', [a.s.userId])).rows[0]?.r;
    expect(one).toMatchObject({ requests: 1, done: 0 });
    expect(await num(`SELECT count(*) AS n FROM job_runs WHERE dry_run AND task = 'purge_user'`)).toBeGreaterThanOrEqual(1);
  });

  it('works in batches: a small limit needs several calls, and the tombstone is written only on the last', async () => {
    const a = await actor(h, 'batch');
    for (let i = 0; i < 3; i += 1) await makeRequest(a);
    await send(a.s, 'DELETE', '/v1/me');
    await endUndoPeriod(a.s.userId);
    expect(await pgError(t.app.query('SELECT public.purge_user($1, 0)', [a.s.userId]))).toMatchObject({ code: '22023' });
    expect(await pgError(t.app.query('SELECT public.purge_user($1, 5001)', [a.s.userId]))).toMatchObject({ code: '22023' });
    let calls = 0;
    let done = 0;
    while (done !== 1 && calls < 30) {
      const r = (await t.app.query<{ r: Record<string, number> }>('SELECT public.purge_user($1, 1) AS r', [a.s.userId])).rows[0]?.r;
      calls += 1;
      done = r?.['done'] ?? 0;
      if (done !== 1) expect((await userRow(a.s.userId))?.deleted_at).toBeNull();
    }
    expect(calls).toBeGreaterThan(3);
    expect(done).toBe(1);
    expect((await userRow(a.s.userId))?.deleted_at).not.toBeNull();
    expect(await num('SELECT count(*) AS n FROM requests WHERE user_id = $1', [a.s.userId])).toBe(0);
  });

  it('running it again changes nothing', async () => {
    const a = await actor(h, 'again');
    await makeRequest(a);
    await send(a.s, 'DELETE', '/v1/me');
    await endUndoPeriod(a.s.userId);
    await h.app.services?.purge.runOnce();
    const second = await h.app.services?.purge.runOnce();
    expect(second?.users).toMatchObject({ accounts_purged: 0, accounts_unfinished: 0 });
    expect((await userRow(a.s.userId))?.email).toBe('');
  });
});

describe('delete now', () => {
  it('skips the undo period: deletes the data, ends every session and clears the cookie', async () => {
    const a = await actor(h, 'now-a');
    const second = await signIn(h, { email: 'now-a@example.test', sub: 'g-now-a' }, 'code-now-a-2');
    const r = await makeRequest(a, { send: true });
    await addExtras(a, r.id);
    await send(a.s, 'DELETE', '/v1/me');
    const res = await send(a.s, 'POST', '/v1/me/deletion/now');
    expect(res.statusCode).toBe(200);
    expect(res.json<Deletion>()).toMatchObject({ status: 'deleted', canUndo: false, gmailCopies: expect.stringMatching(/stay in your own Gmail/) });
    expect(String(res.headers['set-cookie'])).toMatch(/erase_session=; .*Max-Age=0/);
    expect(await userRowCounts(a.s.userId)).toEqual({ requests: 0, events: 0, drafts: 0, replies: 0, labels: 0, followups: 0, keys: 0, companies: 0, inboxes: 0, scans: 0, sessions: 0, states: 0 });
    expect(await userRow(a.s.userId)).toMatchObject({ email: '', name: '', google_sub: `deleted:${a.s.userId}` });
    expect((await get(second, '/v1/me')).statusCode).toBe(401);
    expect((await get(a.s, '/v1/me')).statusCode).toBe(401);
    expect(await num('SELECT count(*) AS n FROM audit_log WHERE action = $1 AND target_id = $2', ['account.deleted_now', a.s.userId])).toBe(1);
  });

  it('works for someone who had not asked yet: Google is asked to remove access first', async () => {
    const a = await actor(h, 'now-direct');
    const res = await send(a.s, 'POST', '/v1/me/deletion/now');
    expect(res.json<Deletion>().status).toBe('deleted');
    expect(h.google.revoked.size).toBeGreaterThan(0);
    expect((await userRow(a.s.userId))?.deleted_at).not.toBeNull();
  });

  it('reports a revoke Google did not confirm even though the account is gone', async () => {
    const a = await actor(h, 'now-revoke');
    h.google.revokeResult = false;
    const body = (await send(a.s, 'POST', '/v1/me/deletion/now')).json<Deletion>();
    expect(body.status).toBe('deleted');
    expect(body.googleAccess.notRevoked).toBe(1);
    expect(body.googleAccess.message).toMatch(/Google account settings/);
    expect((await userRow(a.s.userId))?.token_revoke_failed).toBe(1);
  });

  it('cannot be undone afterwards', async () => {
    const a = await actor(h, 'now-undo');
    await send(a.s, 'POST', '/v1/me/deletion/now');
    expect((await send(a.s, 'POST', '/v1/me/deletion/undo')).statusCode).toBe(401);
    expect((await userRow(a.s.userId))?.deleted_at).not.toBeNull();
  });
});

describe('inboxes past their retention, sessions and sign-in attempts, and old requests', () => {
  it('disconnecting starts a retention clock of INBOX_RETENTION_DAYS', async () => {
    const short = await buildHarness(t, { envOverrides: { INBOX_RETENTION_DAYS: '5' } });
    try {
      const a = await (async () => {
        const s = await signIn(short, { email: 'ret@example.test', sub: 'g-ret' });
        const { inboxId } = await connectInbox(short, s, { email: 'ret-mail@example.test', sub: 'g-ret-mail' });
        return { s, inboxId };
      })();
      const res = await short.app.inject({ method: 'DELETE', url: `/v1/inboxes/${a.inboxId}`, headers: authed(a.s) });
      expect(res.statusCode).toBeLessThan(300);
      const { rows } = await t.owner.query<{ purge_after: Date; disconnected_at: Date }>('SELECT purge_after, disconnected_at FROM inboxes WHERE id = $1', [a.inboxId]);
      expect(rows[0]?.purge_after.getTime()).toBe(short.clock.now.getTime() + 5 * DAY);
    } finally {
      await short.app.close();
    }
  });

  it('purges a disconnected inbox once its retention has passed: its scans and detected companies go, an inbox still in retention stays', async () => {
    const a = await actor(h, 'inbox-purge');
    const { ucId: withRequest } = await a.seed();
    const { ucId: without } = await a.seed();
    await t.owner.query('INSERT INTO scans (id, inbox_id, status) VALUES ($1, $2, $3)', [newId('scan'), a.inboxId, 'done']);
    const made = await send(a.s, 'POST', '/v1/requests/drafts', { userCompanyIds: [withRequest] });
    expect(made.statusCode).toBe(200);
    // A second inbox, still inside its retention.
    const keep = await actor(h, 'inbox-keep');
    await keep.seed();

    const disconnect = (inboxId: string, purgeAfter: string) =>
      t.owner.query(`UPDATE inboxes SET status = 'disconnected', token_ciphertext = NULL, token_key_id = NULL, disconnected_at = now() - interval '40 days', purge_after = ${purgeAfter} WHERE id = $1`, [inboxId]);
    await disconnect(a.inboxId, `now() - interval '1 day'`);
    await disconnect(keep.inboxId, `now() + interval '10 days'`);

    const counts = (await h.app.services?.purge.runOnce())?.inboxes;
    expect(counts).toMatchObject({ inboxes_scrubbed: 1 });
    expect(counts?.['scans']).toBeGreaterThanOrEqual(1);
    // The detected company a request was made about stays (it is that request's record); the other one is deleted.
    expect(await num('SELECT count(*) AS n FROM user_companies WHERE id = $1', [withRequest])).toBe(1);
    expect(await num('SELECT count(*) AS n FROM user_companies WHERE id = $1', [without])).toBe(0);
    const scrubbed = (await t.owner.query<{ email: string }>('SELECT email FROM inboxes WHERE id = $1', [a.inboxId])).rows[0];
    expect(scrubbed?.email).toBe(`purged:${a.inboxId}`);
    expect(await num('SELECT count(*) AS n FROM scans WHERE inbox_id = $1', [a.inboxId])).toBe(0);
    // The one still in retention is untouched.
    expect((await t.owner.query<{ email: string }>('SELECT email FROM inboxes WHERE id = $1', [keep.inboxId])).rows[0]?.email).toBe('inbox-keep-mail@example.test');
    expect(await num('SELECT count(*) AS n FROM user_companies WHERE inbox_id = $1', [keep.inboxId])).toBe(1);
    // A second run has nothing left to do.
    expect((await h.app.services?.purge.runOnce())?.inboxes).toMatchObject({ inboxes_scrubbed: 0, inboxes_deleted: 0 });
  });

  it('deletes a disconnected inbox that has no request-linked companies', async () => {
    const a = await actor(h, 'inbox-del');
    await a.seed();
    await t.owner.query(`UPDATE inboxes SET status = 'disconnected', token_ciphertext = NULL, token_key_id = NULL, disconnected_at = now() - interval '40 days', purge_after = now() - interval '1 day' WHERE id = $1`, [a.inboxId]);
    const counts = (await h.app.services?.purge.runOnce())?.inboxes;
    expect(counts?.['inboxes_deleted']).toBeGreaterThanOrEqual(1);
    expect(await num('SELECT count(*) AS n FROM inboxes WHERE id = $1', [a.inboxId])).toBe(0);
    expect(await num('SELECT count(*) AS n FROM user_companies WHERE user_id = $1', [a.s.userId])).toBe(0);
  });

  it('removes sessions and sign-in attempts that ended more than a day ago, and only those', async () => {
    const a = await actor(h, 'sess');
    const o = t.owner;
    const idOld = newId('session');
    const idRevoked = newId('session');
    const idFresh = newId('session');
    const idExpiredRecent = newId('session');
    const mk = (id: string, expires: string, revoked: string | null) =>
      o.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at) VALUES ($1, $2, $3, ${expires}, ${revoked ?? 'NULL'})`, [id, a.s.userId, randomBytes(16).toString('hex')]);
    await mk(idOld, `now() - interval '3 days'`, null);
    await mk(idRevoked, `now() + interval '10 days'`, `now() - interval '3 days'`);
    await mk(idFresh, `now() + interval '10 days'`, null);
    await mk(idExpiredRecent, `now() - interval '1 hour'`, null);
    const staleState = randomBytes(16).toString('hex');
    const liveState = randomBytes(16).toString('hex');
    const state = (hash: string, expires: string) => o.query(`INSERT INTO oauth_states (id, state_hash, purpose, code_verifier, nonce, expires_at) VALUES ($1, $2, 'signin', 'v', 'n', ${expires})`, [newId('oauthState'), hash]);
    await state(staleState, `now() - interval '3 days'`);
    await state(liveState, `now() + interval '5 minutes'`);
    const counts = (await h.app.services?.purge.runOnce())?.sessions;
    expect(counts?.['sessions']).toBeGreaterThanOrEqual(2);
    expect(counts?.['oauth_states']).toBeGreaterThanOrEqual(1);
    const left = (await o.query<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1', [a.s.userId])).rows.map((r) => r.id);
    expect(left).toContain(idFresh);
    expect(left).toContain(idExpiredRecent);
    expect(left).not.toContain(idOld);
    expect(left).not.toContain(idRevoked);
    expect(await num('SELECT count(*) AS n FROM oauth_states WHERE state_hash = $1', [staleState])).toBe(0);
    expect(await num('SELECT count(*) AS n FROM oauth_states WHERE state_hash = $1', [liveState])).toBe(1);
    expect((await get(a.s, '/v1/me')).statusCode).toBe(200);
  });

  it('keeps closed requests unless REQUEST_RETENTION_DAYS is set: off by default', async () => {
    const a = await actor(h, 'retention');
    const r = await makeRequest(a);
    await t.owner.query(`UPDATE requests SET status = 'closed', updated_at = now() - interval '400 days' WHERE id = $1`, [r.id]);
    expect(h.env.REQUEST_RETENTION_DAYS).toBe(0);
    expect((await h.app.services?.purge.runOnce())?.requests).toEqual({ disabled: 1 });
    expect(await num('SELECT count(*) AS n FROM requests WHERE id = $1', [r.id])).toBe(1);

    const on = await buildHarness(t, { envOverrides: { REQUEST_RETENTION_DAYS: '90' } });
    try {
      const open = await makeRequest(a);
      const recent = await makeRequest(a);
      await t.owner.query(`UPDATE requests SET status = 'closed', updated_at = now() - interval '10 days' WHERE id = $1`, [recent.id]);
      const counts = (await on.app.services?.purge.runOnce())?.requests;
      expect(counts?.['requests']).toBeGreaterThanOrEqual(1);
      expect(await num('SELECT count(*) AS n FROM requests WHERE id = $1', [r.id])).toBe(0);
      expect(await num('SELECT count(*) AS n FROM requests WHERE id = ANY ($1)', [[open.id, recent.id]])).toBe(2);
    } finally {
      await on.app.close();
    }
  });
});

describe('what the app role can do', () => {
  it('cannot delete from any table, or truncate one: the only way to remove anything is through the purge functions', async () => {
    const tables = (await t.owner.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((x) => x.table_name);
    expect(tables.length).toBeGreaterThanOrEqual(16);
    for (const table of tables) {
      expect(await pgError(t.app.query(`DELETE FROM "${table}" WHERE false`)), `DELETE ${table}`).toMatchObject({ code: '42501' });
      expect(await pgError(t.app.query(`TRUNCATE "${table}"`)), `TRUNCATE ${table}`).toMatchObject({ code: '42501' });
    }
  });

  it('can run the purge functions, and not the helpers behind them', async () => {
    expect((await t.app.query('SELECT public.purge_sessions(10, true)')).rowCount).toBe(1);
    expect((await t.app.query('SELECT public.purge_inboxes(10, true)')).rowCount).toBe(1);
    expect((await t.app.query('SELECT public.purge_users(10, true)')).rowCount).toBe(1);
    expect((await t.app.query('SELECT public.purge_requests(0, 10, true)')).rowCount).toBe(1);
    for (const call of ['public._purge_user_rows($1, 10, true)', 'public._add_counts(\'{}\'::jsonb, \'{}\'::jsonb)', 'public._new_job_id()']) {
      expect(await pgError(t.app.query(`SELECT ${call}`.replace('$1', `'x'`))), call).toMatchObject({ code: '42501' });
    }
  });

  it('has the functions set up as asked: security definer, fixed search_path, revoked from PUBLIC, executable by erase_app only', async () => {
    const { rows } = await t.owner.query<{ name: string; definer: boolean; config: string[] | null; public_exec: boolean; app_exec: boolean }>(
      `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
              has_function_privilege('erase_app', p.oid, 'EXECUTE') AS app_exec
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'purge\\_%' OR p.proname LIKE '\\_purge\\_%' OR p.proname IN ('_add_counts', '_new_job_id'))
        ORDER BY p.proname`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toEqual(['_add_counts', '_new_job_id', '_purge_user_rows', 'purge_inboxes', 'purge_requests', 'purge_sessions', 'purge_user', 'purge_users']);
    for (const r of rows) {
      expect(r.public_exec, `${r.name} must not be executable by PUBLIC`).toBe(false);
      if (r.name.startsWith('purge_') || r.name === '_purge_user_rows') {
        expect(r.definer, r.name).toBe(true);
        expect(r.config?.join(' '), r.name).toContain('search_path=pg_catalog, pg_temp');
      }
    }
    expect(rows.filter((r) => r.app_exec).map((r) => r.name)).toEqual(['purge_inboxes', 'purge_requests', 'purge_sessions', 'purge_user', 'purge_users']);
  });
});

describe('the run log holds counts only', () => {
  it('refuses anything in job_runs that is not a whole number, and the app role cannot write it at all', async () => {
    const insert = (counts: string) => t.owner.query(`INSERT INTO job_runs (id, task, dry_run, counts) VALUES ($1, 'purge_users', false, $2::jsonb)`, [`job_${'0'.repeat(25)}${Math.floor(Math.random() * 8)}`, counts]);
    for (const bad of ['{"user":"usr_abc"}', '{"a":1.5}', '{"a":{"b":1}}', '{"a":-1}', '["a"]', '{"a":null}', '{"a":true}']) {
      expect(await pgError(insert(bad)), bad).toMatchObject({ code: '23514' });
    }
    expect(await pgError(t.app.query(`INSERT INTO job_runs (id, task, dry_run, counts) VALUES ('job_00000000000000000000000000', 'purge_users', false, '{}')`))).toMatchObject({ code: '42501' });
    expect(await pgError(t.app.query(`UPDATE job_runs SET counts = '{}'`))).toMatchObject({ code: '42501' });
    expect((await t.app.query('SELECT count(*) FROM job_runs')).rowCount).toBe(1);
  });

  it('every row the purge wrote is numbers only, with no id, address or text', async () => {
    const { rows } = await t.owner.query<{ id: string; task: string; counts: Record<string, unknown> }>('SELECT id, task, counts FROM job_runs');
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      expect(r.id).toMatch(/^job_[0-9A-HJKMNP-TV-Z]{26}$/);
      for (const v of Object.values(r.counts)) expect(Number.isInteger(v)).toBe(true);
      expect(JSON.stringify(r.counts)).not.toMatch(/usr_|req_|inb_|@|example/);
    }
    const text = h.logs.text();
    expect(text).not.toMatch(/tomb\.stone|@example\.test/);
  });
});

describe('the scheduler runs the purge', () => {
  it('hourly, under the same Postgres advisory lock as the other tasks, and logs counts only', async () => {
    const purge = h.app.services?.purge;
    if (!purge) throw new Error('no purge service');
    const task = purgeTask(purge);
    expect(task).toMatchObject({ name: 'purge', everyMs: 60 * 60 * 1000 });
    expect(PURGE_EVERY_MS).toBe(3_600_000);

    const logs: Array<Record<string, unknown>> = [];
    const c = t.owner;
    const p = new pg.Pool({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, max: 3 });
    try {
      const scheduler = new Scheduler({ lock: new PgTaskLock(p), log: { info: (o) => logs.push(o), warn: (o) => logs.push(o) } });
      scheduler.add(task);
      const a = await actor(h, 'sched');
      await send(a.s, 'DELETE', '/v1/me');
      await endUndoPeriod(a.s.userId);

      // Another process holds this task's lock: the run is skipped and nothing is purged.
      const holder = await p.connect();
      try {
        const got = await holder.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok`, ['erase:purge']);
        expect(got.rows[0]?.ok).toBe(true);
        expect(await scheduler.runNow('purge')).toEqual({ status: 'busy' });
        expect((await userRow(a.s.userId))?.deleted_at).toBeNull();
      } finally {
        await holder.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, ['erase:purge']);
        holder.release();
      }

      // Free again: it runs, purges the account whose undo period ended, and logs numbers only.
      const ran = await scheduler.runNow('purge');
      expect(ran.status).toBe('ran');
      expect((await userRow(a.s.userId))?.deleted_at).not.toBeNull();
      const line = JSON.stringify(logs);
      expect(line).toMatch(/purge/);
      expect(line).not.toMatch(/usr_|@|sched/);
    } finally {
      await p.end();
    }
  });
});
