import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authed,
  buildHarness,
  connectInbox,
  signIn,
  WEB_ORIGIN,
  type FakeMessage,
  type Harness,
  type Session,
} from '../../../test/harness.js';
import { createTestDb, type TestDb } from '../../../test/db-helper.js';
import { newId } from '../../common/ids.js';
import { GmailApiError } from './gmail.client.js';
import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from '../auth/google-oauth.js';

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

const SUBJECTS = ['Welcome to the app', 'Your receipt', 'Please verify your email address', 'Your invoice'];

/** `count` companies (fictional domains), `perCompany` mails each, spread over several years. */
function mailbox(count: number, perCompany: number): FakeMessage[] {
  const out: FakeMessage[] = [];
  for (let c = 0; c < count; c++) {
    for (let k = 0; k < perCompany; k++) {
      out.push({
        id: `m-${c}-${k}`,
        receivedAt: new Date(Date.UTC(2016 + k, c % 12, 1 + (c % 27))),
        from: `"Brand ${c}" <no-reply@mail.brand${c}.example>`,
        subject: `${SUBJECTS[k % SUBJECTS.length]} #${c}`,
        listUnsubscribe: k === 0,
      });
    }
  }
  return out;
}

const post = (s: Session, url: string) => h.app.inject({ method: 'POST', url, headers: authed(s) });
const scanStatus = async (s: Session, inboxId: string) =>
  (await h.app.inject({ method: 'GET', url: `/v1/inboxes/${inboxId}/scan`, headers: { cookie: s.cookie } })).json<{
    scan: { status: string; progressPct: number; foundCount: number; errorCode: string | null };
  }>().scan;

async function detected(userId: string) {
  const { rows } = await t.owner.query<{ domain: string; first_seen: Date; last_seen: Date; signal_types: string[]; status: string }>(
    `SELECT c.domains[1] AS domain, uc.first_seen, uc.last_seen, uc.signal_types, uc.status
       FROM user_companies uc JOIN companies c ON c.id = uc.company_id
      WHERE uc.user_id = $1 ORDER BY 1`,
    [userId],
  );
  return rows;
}

describe('connect an inbox', () => {
  it('stores an encrypted refresh token and records the granted scopes (F1)', async () => {
    const s = await signIn(h, { email: 'owner1@example.test', sub: 'g-owner1' });
    const { inboxId, refreshToken } = await connectInbox(h, s, { email: 'mail1@example.test', sub: 'g-mail1', refreshToken: '1//plain-refresh-token-1' });
    const { rows } = await t.owner.query<{ token_ciphertext: string; token_key_id: string; status: string; scopes: string[] }>(
      'SELECT token_ciphertext, token_key_id, status, scopes FROM inboxes WHERE id = $1',
      [inboxId],
    );
    expect(rows[0]?.status).toBe('connected');
    expect(rows[0]?.scopes).toEqual(['gmail.readonly', 'gmail.send']);
    expect(rows[0]?.token_key_id).toMatch(/^local-/);
    expect(rows[0]?.token_ciphertext).not.toContain(refreshToken);
    expect(rows[0]?.token_ciphertext).toMatch(/^v1\./);
    // The sign-in session is not an inbox: connecting is a separate step with its own scopes.
    expect(h.google.lastAuthorization?.purpose).toBe('connect');
  });

  it('refuses a grant without both Gmail scopes and revokes it at Google', async () => {
    const s = await signIn(h, { email: 'owner2@example.test', sub: 'g-owner2' });
    h.google.grant('narrow', { email: 'narrow@example.test', sub: 'g-narrow', refreshToken: 'rt-narrow', scopes: ['openid', 'email', GMAIL_READONLY_SCOPE] });
    const start = await post(s, '/v1/inboxes/connect/start');
    const state = h.google.lastAuthorization?.state ?? '';
    const stateCookie = String(start.headers['set-cookie']).split(';')[0] ?? '';
    const cb = await h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=narrow&state=${state}`, headers: { cookie: `${s.cookie}; ${stateCookie}` } });
    expect(cb.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=scopes_missing`);
    expect(h.google.revoked.has('rt-narrow')).toBe(true);
    expect((await h.app.inject({ method: 'GET', url: '/v1/inboxes', headers: { cookie: s.cookie } })).json<{ inboxes: unknown[] }>().inboxes).toHaveLength(0);
  });

  it('refuses a grant that came without a refresh token', async () => {
    const s = await signIn(h, { email: 'owner3@example.test', sub: 'g-owner3' });
    h.google.grant('norefresh', { email: 'nr@example.test', sub: 'g-nr', refreshToken: null });
    const start = await post(s, '/v1/inboxes/connect/start');
    const state = h.google.lastAuthorization?.state ?? '';
    const cb = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=norefresh&state=${state}`,
      headers: { cookie: `${s.cookie}; ${String(start.headers['set-cookie']).split(';')[0]}` },
    });
    expect(cb.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=no_refresh_token`);
  });

  it('requires the signed-in user to be the one who started the connection', async () => {
    const a = await signIn(h, { email: 'ownerA@example.test', sub: 'g-ownerA' });
    const b = await signIn(h, { email: 'ownerB@example.test', sub: 'g-ownerB' });
    h.google.grant('hijack', { email: 'victim@example.test', sub: 'g-victim' });
    const start = await post(a, '/v1/inboxes/connect/start');
    const state = h.google.lastAuthorization?.state ?? '';
    const cb = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=hijack&state=${state}`,
      headers: { cookie: `${b.cookie}; ${String(start.headers['set-cookie']).split(';')[0]}` },
    });
    expect(cb.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=invalid_state`);
  });

  it('allows up to 5 inboxes per user (F1-AC4)', async () => {
    const s = await signIn(h, { email: 'many@example.test', sub: 'g-many' });
    for (let i = 1; i <= 5; i++) await connectInbox(h, s, { email: `box${i}@example.test`, sub: `g-box${i}` });
    const sixth = await post(s, '/v1/inboxes/connect/start');
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json()).toMatchObject({ code: 'inbox_limit' });
  });

  it('reconnecting the same address reuses the inbox row and clears the retention clock', async () => {
    const s = await signIn(h, { email: 'again@example.test', sub: 'g-again' });
    const first = await connectInbox(h, s, { email: 'same@example.test', sub: 'g-same' }, 'same-1');
    await h.app.inject({ method: 'DELETE', url: `/v1/inboxes/${first.inboxId}`, headers: authed(s) });
    const second = await connectInbox(h, s, { email: 'same@example.test', sub: 'g-same' }, 'same-2');
    expect(second.inboxId).toBe(first.inboxId);
    const { rows } = await t.owner.query<{ status: string; purge_after: Date | null }>('SELECT status, purge_after FROM inboxes WHERE id = $1', [first.inboxId]);
    expect(rows[0]).toEqual({ status: 'connected', purge_after: null });
  });

  it('answers 503 encryption_not_configured when TOKEN_MASTER_KEY is missing', async () => {
    const nokeys = await buildHarness(t, { withKeys: false });
    try {
      const s = await signIn(nokeys, { email: 'nokey@example.test', sub: 'g-nokey' });
      nokeys.google.grant('nk', { email: 'nk@example.test', sub: 'g-nk' });
      const start = await nokeys.app.inject({ method: 'POST', url: '/v1/inboxes/connect/start', headers: authed(s) });
      const state = nokeys.google.lastAuthorization?.state ?? '';
      const cb = await nokeys.app.inject({
        method: 'GET',
        url: `/v1/auth/google/callback?code=nk&state=${state}`,
        headers: { cookie: `${s.cookie}; ${String(start.headers['set-cookie']).split(';')[0]}` },
      });
      expect(cb.statusCode).toBe(503);
      expect(cb.json()).toMatchObject({ code: 'encryption_not_configured' });
    } finally {
      await nokeys.app.close();
    }
  });
});

describe('disconnect', () => {
  it('revokes at Google, drops the token, starts retention and stops scans (F1-AC3)', async () => {
    const s = await signIn(h, { email: 'disc@example.test', sub: 'g-disc' });
    const { inboxId, refreshToken } = await connectInbox(h, s, { email: 'disc-mail@example.test', sub: 'g-disc-mail' });
    const res = await h.app.inject({ method: 'DELETE', url: `/v1/inboxes/${inboxId}`, headers: authed(s) });
    expect(res.json()).toEqual({ status: 'disconnected', revokedAtGoogle: true });
    expect(h.google.revoked.has(refreshToken)).toBe(true);
    const { rows } = await t.owner.query<{ status: string; token_ciphertext: string | null; token_key_id: string | null; purge_after: Date | null; disconnected_at: Date | null }>(
      'SELECT status, token_ciphertext, token_key_id, purge_after, disconnected_at FROM inboxes WHERE id = $1',
      [inboxId],
    );
    expect(rows[0]).toMatchObject({ status: 'disconnected', token_ciphertext: null, token_key_id: null });
    const days = ((rows[0]?.purge_after?.getTime() ?? 0) - (rows[0]?.disconnected_at?.getTime() ?? 0)) / 86_400_000;
    expect(days).toBeCloseTo(30, 3);
    const scan = await post(s, `/v1/inboxes/${inboxId}/scan`);
    expect(scan.statusCode).toBe(409);
    expect(scan.json()).toMatchObject({ code: 'inbox_not_connected' });
  });

  it('still disconnects locally when Google cannot be reached, and says the revoke did not confirm', async () => {
    const s = await signIn(h, { email: 'disc2@example.test', sub: 'g-disc2' });
    const { inboxId } = await connectInbox(h, s, { email: 'disc2-mail@example.test', sub: 'g-disc2-mail' });
    h.google.revokeResult = false;
    try {
      const res = await h.app.inject({ method: 'DELETE', url: `/v1/inboxes/${inboxId}`, headers: authed(s) });
      expect(res.json()).toEqual({ status: 'disconnected', revokedAtGoogle: false });
    } finally {
      h.google.revokeResult = true;
    }
  });

  it("treats another user's inbox as not found, for every inbox route", async () => {
    const a = await signIn(h, { email: 'iso-a@example.test', sub: 'g-iso-a' });
    const b = await signIn(h, { email: 'iso-b@example.test', sub: 'g-iso-b' });
    const { inboxId } = await connectInbox(h, a, { email: 'iso-a-mail@example.test', sub: 'g-iso-a-mail' });
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/inboxes/${inboxId}`, headers: authed(b) })).statusCode).toBe(404);
    expect((await post(b, `/v1/inboxes/${inboxId}/scan`)).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/v1/inboxes/${inboxId}/scan`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/v1/inboxes', headers: { cookie: b.cookie } })).json<{ inboxes: unknown[] }>().inboxes).toHaveLength(0);
    expect((await h.app.inject({ method: 'DELETE', url: '/v1/inboxes/not-an-id', headers: authed(a) })).statusCode).toBe(400);
  });
});

describe('scan', () => {
  it('finds companies from metadata, with progress, in the background (F2)', async () => {
    const s = await signIn(h, { email: 'scan1@example.test', sub: 'g-scan1' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan1-mail@example.test', sub: 'g-scan1-mail' });
    h.gmail.messages = [...mailbox(30, 8), { id: 'friend', receivedAt: new Date('2020-01-01'), from: 'pal@gmail.com', subject: 'Welcome home' }, { id: 'otp', receivedAt: new Date('2020-01-01'), from: 'x@otpbank.example', subject: 'Your OTP is 123456', listUnsubscribe: true }];

    const started = await post(s, `/v1/inboxes/${inboxId}/scan`);
    expect(started.statusCode).toBe(202); // returns at once; the scan runs in the background
    expect(started.json<{ scan: { status: string } }>().scan.status).toBe('queued');
    await h.queue.drain();

    const scan = await scanStatus(s, inboxId);
    expect(scan).toMatchObject({ status: 'done', progressPct: 100, foundCount: 30, errorCode: null });
    const rows = await detected(s.userId);
    expect(rows).toHaveLength(30);
    expect(rows.map((r) => r.domain)).toContain('brand7.example');
    expect(rows.map((r) => r.domain)).not.toContain('gmail.com');
    expect(rows.map((r) => r.domain)).not.toContain('otpbank.example');
    const brand0 = rows.find((r) => r.domain === 'brand0.example');
    expect(brand0?.first_seen.toISOString()).toBe('2016-01-01T00:00:00.000Z');
    expect(brand0?.last_seen.toISOString()).toBe('2023-01-01T00:00:00.000Z');
    expect(brand0?.signal_types).toEqual(['list_unsubscribe', 'receipt', 'verify', 'welcome']);
    const { rows: inbox } = await t.owner.query<{ last_scan_at: Date | null }>('SELECT last_scan_at FROM inboxes WHERE id = $1', [inboxId]);
    expect(inbox[0]?.last_scan_at).not.toBeNull();
  });

  it('pages through Gmail with a saved cursor and never asks for more than metadata', async () => {
    const s = await signIn(h, { email: 'scan2@example.test', sub: 'g-scan2' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan2-mail@example.test', sub: 'g-scan2-mail' });
    h.gmail.messages = mailbox(130, 2); // 260 messages: three pages of 100
    h.gmail.calls.length = 0;
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    const lists = h.gmail.calls.filter((c) => c.startsWith('list:'));
    expect(lists).toHaveLength(3);
    expect(lists.map((c) => c.split(':')[2])).toEqual(['', '100', '200']);
    expect(h.gmail.calls.filter((c) => c.startsWith('meta:'))).toHaveLength(260);
    expect(h.gmail.calls.every((c) => /^(list|meta):/.test(c))).toBe(true);
    expect((await scanStatus(s, inboxId)).foundCount).toBe(130);
  });

  it('is idempotent: starting during a scan returns it, and a rescan creates no duplicates (F2-AC2)', async () => {
    const s = await signIn(h, { email: 'scan3@example.test', sub: 'g-scan3' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan3-mail@example.test', sub: 'g-scan3-mail' });
    h.gmail.messages = mailbox(12, 3);
    const first = await post(s, `/v1/inboxes/${inboxId}/scan`);
    const second = await post(s, `/v1/inboxes/${inboxId}/scan`);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ scan: { id: string } }>().scan.id).toBe(first.json<{ scan: { id: string } }>().scan.id);
    await h.queue.drain();
    const before = await detected(s.userId);

    const rescan = await post(s, `/v1/inboxes/${inboxId}/scan`);
    expect(rescan.statusCode).toBe(202);
    await h.queue.drain();
    const after = await detected(s.userId);
    expect(after).toEqual(before);
    expect(after).toHaveLength(12);
    const { rows } = await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM scans WHERE inbox_id = $1', [inboxId]);
    expect(rows[0]?.n).toBe('2');
  });

  it('keeps a company marked "not mine" excluded on rescan (F2-AC3)', async () => {
    const s = await signIn(h, { email: 'scan4@example.test', sub: 'g-scan4' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan4-mail@example.test', sub: 'g-scan4-mail' });
    h.gmail.messages = mailbox(4, 2);
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    await t.owner.query(`UPDATE user_companies SET status = 'not_mine' WHERE user_id = $1 AND company_id = (SELECT id FROM companies WHERE domains[1] = 'brand2.example')`, [s.userId]);
    h.gmail.messages = [...mailbox(4, 2), { id: 'late', receivedAt: new Date('2026-01-01'), from: 'hi@brand2.example', subject: 'Your receipt' }];
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    const rows = await detected(s.userId);
    expect(rows.find((r) => r.domain === 'brand2.example')).toMatchObject({ status: 'not_mine' });
    expect(rows.find((r) => r.domain === 'brand2.example')?.last_seen.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((await scanStatus(s, inboxId)).foundCount).toBe(3); // not_mine is not counted as found
  });

  it('matches a company the catalog already knows instead of creating a placeholder', async () => {
    await t.owner.query(
      `INSERT INTO companies (id, slug, name, category, domains, is_fictional) VALUES ($1, 'sample-bank', 'Sample Bank', 'credit', ARRAY['samplebank.example'], true)`,
      [newId('company')],
    );
    const s = await signIn(h, { email: 'scan5@example.test', sub: 'g-scan5' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan5-mail@example.test', sub: 'g-scan5-mail' });
    h.gmail.messages = [{ id: 'sb', receivedAt: new Date('2021-03-01'), from: 'Sample Bank <alerts@notify.samplebank.example>', subject: 'Welcome to Sample Bank' }];
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    const { rows } = await t.owner.query<{ slug: string; category: string; grievance_email: string | null }>(
      `SELECT c.slug, c.category, c.grievance_email FROM user_companies uc JOIN companies c ON c.id = uc.company_id WHERE uc.user_id = $1`,
      [s.userId],
    );
    expect(rows).toEqual([{ slug: 'sample-bank', category: 'credit', grievance_email: null }]);
  });

  it('creates a placeholder company with no grievance contact for an unknown domain', async () => {
    const s = await signIn(h, { email: 'scan6@example.test', sub: 'g-scan6' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan6-mail@example.test', sub: 'g-scan6-mail' });
    h.gmail.messages = [{ id: 'u', receivedAt: new Date('2021-03-01'), from: 'hi@my-new-shop.example', subject: 'Your order' }];
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    const { rows } = await t.owner.query<{ name: string; grievance_email: string | null; grievance_status: string; category: string }>(
      `SELECT c.name, c.grievance_email, c.grievance_status, c.category FROM companies c WHERE c.domains @> ARRAY['my-new-shop.example']`,
    );
    expect(rows).toEqual([{ name: 'My New Shop', grievance_email: null, grievance_status: 'unknown', category: 'other' }]);
  });

  it('stores no email content: no subject, sender name, address or message id anywhere in the database', async () => {
    const s = await signIn(h, { email: 'scan7@example.test', sub: 'g-scan7' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan7-mail@example.test', sub: 'g-scan7-mail' });
    h.gmail.messages = [
      { id: 'secret-message-id-777', receivedAt: new Date('2022-02-02'), from: '"Zed Zebra Secret Sender" <orders@zebra-store.example>', subject: 'Welcome Zed, your zebra order is confirmed' },
    ];
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    const everything = JSON.stringify([
      (await t.owner.query('SELECT * FROM user_companies')).rows,
      (await t.owner.query('SELECT * FROM scans')).rows,
      (await t.owner.query('SELECT * FROM companies')).rows,
      (await t.owner.query('SELECT * FROM audit_log')).rows,
    ]);
    for (const secret of ['secret-message-id-777', 'Zed Zebra', 'orders@', 'zebra order is confirmed', 'Welcome Zed']) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(everything).toContain('zebra-store.example'); // the company domain is the finding
  });

  it('records a failed scan with a code, and a new scan completes (retry)', async () => {
    const s = await signIn(h, { email: 'scan8@example.test', sub: 'g-scan8' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan8-mail@example.test', sub: 'g-scan8-mail' });
    h.gmail.messages = mailbox(5, 2);
    h.gmail.failListOn = { call: h.gmail.listCalls + 1, error: new GmailApiError('quota') };
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    expect(await scanStatus(s, inboxId)).toMatchObject({ status: 'failed', errorCode: 'gmail_quota' });
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    expect(await scanStatus(s, inboxId)).toMatchObject({ status: 'done', foundCount: 5 });
  });

  it('skips messages that cannot be dated and still finishes (regression)', async () => {
    const s = await signIn(h, { email: 'scan12@example.test', sub: 'g-scan12' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan12-mail@example.test', sub: 'g-scan12-mail' });
    h.gmail.messages = [
      ...mailbox(3, 2),
      { id: 'odd', receivedAt: new Date(0), from: 'hi@odd-date.example', subject: 'Your receipt', undatable: true },
    ];
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    expect(await scanStatus(s, inboxId)).toMatchObject({ status: 'done', foundCount: 3, errorCode: null });
    expect(h.logs.text()).toMatch(/"skipped":1/);
  });

  it('logs which call failed, the HTTP status and Google reason and status, and nothing else (retryable)', async () => {
    const s = await signIn(h, { email: 'scan13@example.test', sub: 'g-scan13' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan13-mail@example.test', sub: 'g-scan13-mail' });
    h.gmail.messages = mailbox(3, 2);
    h.gmail.failListOn = {
      call: h.gmail.listCalls + 1,
      error: new GmailApiError('auth', {
        call: 'messages.list',
        httpStatus: 403,
        reason: 'accessNotConfigured',
        googleStatus: 'PERMISSION_DENIED',
      }),
    };
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    expect(await scanStatus(s, inboxId)).toMatchObject({ status: 'failed', errorCode: 'gmail_auth' });
    const line = h.logs.lines().find((l) => l.msg === 'scan failed' && l.failedCall === 'messages.list');
    expect(line).toMatchObject({
      errorCode: 'gmail_auth',
      failedCall: 'messages.list',
      httpStatus: 403,
      googleReason: 'accessNotConfigured',
      googleStatus: 'PERMISSION_DENIED',
    });
    // Retryable: the next scan runs and finishes.
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    expect(await scanStatus(s, inboxId)).toMatchObject({ status: 'done', foundCount: 3 });
  });

  it('marks the inbox as needing reconnection when Google says the grant is gone', async () => {
    const s = await signIn(h, { email: 'scan9@example.test', sub: 'g-scan9' });
    const { inboxId, refreshToken } = await connectInbox(h, s, { email: 'scan9-mail@example.test', sub: 'g-scan9-mail' });
    h.google.revoked.add(refreshToken); // the user removed access in their Google account
    h.gmail.messages = mailbox(2, 2);
    await post(s, `/v1/inboxes/${inboxId}/scan`);
    await h.queue.drain();
    expect(await scanStatus(s, inboxId)).toMatchObject({ status: 'failed', errorCode: 'gmail_auth' });
    const list = (await h.app.inject({ method: 'GET', url: '/v1/inboxes', headers: { cookie: s.cookie } })).json<{ inboxes: Array<{ id: string; status: string }> }>();
    expect(list.inboxes.find((i) => i.id === inboxId)?.status).toBe('error');
    expect((await post(s, `/v1/inboxes/${inboxId}/scan`)).statusCode).toBe(409);
  });

  it('resumes an interrupted scan from its saved cursor after a restart', async () => {
    const s = await signIn(h, { email: 'scan10@example.test', sub: 'g-scan10' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan10-mail@example.test', sub: 'g-scan10-mail' });
    h.gmail.messages = mailbox(130, 2);
    // A scan that had processed the first two pages when the process stopped.
    const scanId = newId('scan');
    await t.owner.query(`INSERT INTO scans (id, inbox_id, status, progress_pct, cursor, started_at) VALUES ($1, $2, 'running', 70, '200', now())`, [scanId, inboxId]);
    h.gmail.calls.length = 0;
    expect(await h.app.services?.scans.resumeInterrupted()).toBeGreaterThanOrEqual(1);
    await h.queue.drain();
    const lists = h.gmail.calls.filter((c) => c.startsWith('list:'));
    expect(lists.map((c) => c.split(':')[2])).toEqual(['200']);
    expect(await scanStatus(s, inboxId)).toMatchObject({ status: 'done', progressPct: 100 });
  });

  it('stops calling Gmail once the inbox is disconnected mid-scan (F1-AC3)', async () => {
    const s = await signIn(h, { email: 'scan11@example.test', sub: 'g-scan11' });
    const { inboxId } = await connectInbox(h, s, { email: 'scan11-mail@example.test', sub: 'g-scan11-mail' });
    h.gmail.messages = mailbox(130, 2);
    h.gmail.calls.length = 0;
    const second = h.gmail.listCalls + 2;
    h.gmail.beforeList = async (call) => {
      if (call === second) await h.app.services?.inboxes.disconnect(s.userId, inboxId);
    };
    try {
      await post(s, `/v1/inboxes/${inboxId}/scan`);
      await h.queue.drain();
    } finally {
      h.gmail.beforeList = undefined;
    }
    // The second list call was already in flight; no third page was requested and the scan did not finish.
    expect(h.gmail.calls.filter((c) => c.startsWith('list:'))).toHaveLength(2);
    expect(await scanStatus(s, inboxId)).toMatchObject({ status: 'failed', errorCode: 'inbox_disconnected' });
  });

  it('uses the inbox token only in memory: access tokens are never stored', async () => {
    const { rows } = await t.owner.query<{ hit: string }>(`SELECT 'x' AS hit FROM inboxes WHERE token_ciphertext LIKE '%at-%' OR token_ciphertext LIKE '%access-%'`);
    expect(rows).toHaveLength(0);
  });
});

describe('account deletion with connected inboxes', () => {
  it('revokes every Gmail token and drops them', async () => {
    const s = await signIn(h, { email: 'del@example.test', sub: 'g-del' });
    const a = await connectInbox(h, s, { email: 'del-a@example.test', sub: 'g-del-a' });
    const b = await connectInbox(h, s, { email: 'del-b@example.test', sub: 'g-del-b' });
    expect((await h.app.inject({ method: 'DELETE', url: '/v1/me', headers: authed(s) })).statusCode).toBe(202);
    await h.queue.drain();
    expect(h.google.revoked.has(a.refreshToken)).toBe(true);
    expect(h.google.revoked.has(b.refreshToken)).toBe(true);
    const { rows } = await t.owner.query<{ status: string; token_ciphertext: string | null }>('SELECT status, token_ciphertext FROM inboxes WHERE user_id = $1', [s.userId]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'disconnected' && r.token_ciphertext === null)).toBe(true);
  });
});

describe('secrets and personal data in logs', () => {
  it('never appear: no tokens, addresses, domains, subjects or OAuth codes', () => {
    const text = h.logs.text();
    expect(text.length).toBeGreaterThan(0);
    for (const forbidden of [/@example\.test/, /refresh-|rt-|at-rt|access-/, /plain-refresh-token/, /brand\d+\.example/, /Welcome to|receipt|invoice/i, /code=|state=/, /erase_session=/, /g-scan/]) {
      expect(text).not.toMatch(forbidden);
    }
    expect(text).not.toContain(GMAIL_SEND_SCOPE);
  });
});
