import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, buildHarness, signIn, WEB_ORIGIN, type Harness } from '../../../test/harness.js';
import { createTestDb, type TestDb } from '../../../test/db-helper.js';
import { sha256Hex } from './session.service.js';

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

const header = (res: { headers: Record<string, unknown> }, name: string) => res.headers[name] as string | string[] | undefined;

describe('Google sign-in', () => {
  it('starts with PKCE, a state, a nonce and sign-in scopes only', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/fake-google\.test\/auth\?state=/);
    expect(h.google.lastAuthorization).toMatchObject({ purpose: 'signin' });
    expect(h.google.lastAuthorization?.codeChallenge.length).toBeGreaterThan(30);
    expect(h.google.lastAuthorization?.nonce.length).toBeGreaterThan(10);
    const cookie = String(header(res, 'set-cookie'));
    expect(cookie).toMatch(/erase_oauth_state=.+HttpOnly/);
    expect(cookie).toMatch(/Path=\/v1\/auth\/google/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('signs in, creates the user, sets a hardened session cookie and redirects to the web app', async () => {
    h.google.grant('c1', { email: 'Ada@Example.test', sub: 'sub-ada', name: 'Ada' });
    await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    const state = h.google.lastAuthorization?.state ?? '';
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=c1&state=${state}`,
      headers: { cookie: `erase_oauth_state=${state}` },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/`);
    const cookies = ([] as string[]).concat(header(res, 'set-cookie') ?? []);
    const session = cookies.find((c) => c.startsWith('erase_session='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Max-Age=2592000/);
    expect(cookies.find((c) => c.startsWith('erase_oauth_state='))).toMatch(/Max-Age=0/);

    const sessionCookie = (session ?? '').split(';')[0] ?? '';
    const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: sessionCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'ada@example.test', name: 'Ada' });
  });

  it('stores only a hash of the session token', async () => {
    const s = await signIn(h, { email: 'hash@example.test', sub: 'sub-hash' });
    const token = s.cookie.split('=')[1] ?? '';
    const { rows } = await t.owner.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = $1', [s.userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('is idempotent per Google account and issues a new session each sign-in', async () => {
    const a = await signIn(h, { email: 'twice@example.test', sub: 'sub-twice' }, 'twice-1');
    const b = await signIn(h, { email: 'twice@example.test', sub: 'sub-twice' }, 'twice-2');
    expect(a.userId).toBe(b.userId);
    expect(a.cookie).not.toBe(b.cookie);
  });

  it('rejects a callback whose state cookie is missing or different (login CSRF)', async () => {
    h.google.grant('c2', { email: 'x@example.test', sub: 'sub-x' });
    await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    const state = h.google.lastAuthorization?.state ?? '';
    const noCookie = await h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=c2&state=${state}` });
    expect(noCookie.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=invalid_state`);
    const wrong = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=c2&state=${state}`,
      headers: { cookie: 'erase_oauth_state=other' },
    });
    expect(wrong.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=invalid_state`);
    expect(String(header(noCookie, 'set-cookie'))).not.toMatch(/erase_session=[^;]/);
  });

  it('rejects a replayed state and an expired state', async () => {
    h.google.grant('c3', { email: 'r@example.test', sub: 'sub-r' });
    await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    const state = h.google.lastAuthorization?.state ?? '';
    const ok = await h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=c3&state=${state}`, headers: { cookie: `erase_oauth_state=${state}` } });
    expect(ok.headers.location).toBe(`${WEB_ORIGIN}/`);
    h.google.grant('c3b', { email: 'r@example.test', sub: 'sub-r' });
    const replay = await h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=c3b&state=${state}`, headers: { cookie: `erase_oauth_state=${state}` } });
    expect(replay.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=invalid_state`);

    h.google.grant('c3c', { email: 'r@example.test', sub: 'sub-r' });
    await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    const late = h.google.lastAuthorization?.state ?? '';
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 60_000);
    try {
      const expired = await h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=c3c&state=${late}`, headers: { cookie: `erase_oauth_state=${late}` } });
      expect(expired.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=invalid_state`);
    } finally {
      h.clock.now = new Date(h.clock.now.getTime() - 11 * 60_000);
    }
  });

  it('reports a denied consent by code only', async () => {
    await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    const state = h.google.lastAuthorization?.state ?? '';
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?error=access_denied&state=${state}`,
      headers: { cookie: `erase_oauth_state=${state}` },
    });
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=access_denied`);
  });

  it('reports a failed code exchange without leaking details', async () => {
    await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    const state = h.google.lastAuthorization?.state ?? '';
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=never-granted&state=${state}`,
      headers: { cookie: `erase_oauth_state=${state}` },
    });
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=exchange_failed`);
  });
});

describe('sessions and CSRF', () => {
  it('requires a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthorized' });
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: 'erase_session=not-a-session' } })).statusCode).toBe(401);
  });

  it('refuses a state-changing call without the CSRF token, or from another origin', async () => {
    const s = await signIn(h, { email: 'csrf@example.test', sub: 'sub-csrf' });
    const none = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: s.cookie } });
    expect(none.statusCode).toBe(403);
    const wrong = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: s.cookie, 'x-csrf-token': 'wrong' } });
    expect(wrong.statusCode).toBe(403);
    const foreign = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { ...authed(s), origin: 'https://evil.test' } });
    expect(foreign.statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: s.cookie } })).statusCode).toBe(200);
  });

  it('logs out: the session is revoked server-side and the cookie cleared', async () => {
    const s = await signIn(h, { email: 'out@example.test', sub: 'sub-out' });
    const res = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: authed(s) });
    expect(res.statusCode).toBe(204);
    expect(String(header(res, 'set-cookie'))).toMatch(/erase_session=; .*Max-Age=0/);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: s.cookie } })).statusCode).toBe(401);
  });

  it('expires after 30 days and slides while in use', async () => {
    const s = await signIn(h, { email: 'slide@example.test', sub: 'sub-slide' });
    const start = h.clock.now;
    try {
      h.clock.now = new Date(start.getTime() + 20 * 86_400_000);
      expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: s.cookie } })).statusCode).toBe(200);
      h.clock.now = new Date(start.getTime() + 45 * 86_400_000); // 25 days after the last use: still valid
      expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: s.cookie } })).statusCode).toBe(200);
      h.clock.now = new Date(start.getTime() + 80 * 86_400_000); // 35 days idle: expired
      expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: s.cookie } })).statusCode).toBe(401);
    } finally {
      h.clock.now = start;
    }
  });

  it('answers CORS only for the web origin, with credentials', async () => {
    const ok = await h.app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: WEB_ORIGIN } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { origin: 'https://evil.test' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('account deletion', () => {
  it('ends every session at once, anonymises the user, and keeps the audit trail', async () => {
    const s1 = await signIn(h, { email: 'gone@example.test', sub: 'sub-gone' }, 'gone-1');
    const s2 = await signIn(h, { email: 'gone@example.test', sub: 'sub-gone' }, 'gone-2');
    const res = await h.app.inject({ method: 'DELETE', url: '/v1/me', headers: authed(s1) });
    expect(res.statusCode).toBe(202);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: s2.cookie } })).statusCode).toBe(401);
    await h.queue.drain();

    const { rows } = await t.owner.query<{ email: string; name: string; google_sub: string; deleted_at: Date | null; status: string }>(
      'SELECT email, name, google_sub, deleted_at, status FROM users WHERE id = $1',
      [s1.userId],
    );
    expect(rows[0]).toMatchObject({ name: 'Deleted user', status: 'deleting' });
    expect(rows[0]?.email).not.toContain('gone@');
    expect(rows[0]?.google_sub).not.toContain('sub-gone');
    expect(rows[0]?.deleted_at).not.toBeNull();

    const audit = await t.owner.query<{ action: string }>('SELECT action FROM audit_log WHERE target_id = $1 ORDER BY at', [s1.userId]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['account.deletion_requested', 'account.deletion_completed']));
  });

  it('does not let a deleted account sign back in', async () => {
    const s = await signIn(h, { email: 'back@example.test', sub: 'sub-back' }, 'back-1');
    await h.app.inject({ method: 'DELETE', url: '/v1/me', headers: authed(s) });
    await h.queue.drain();
    h.google.grant('back-2', { email: 'back@example.test', sub: 'sub-back' });
    await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    const state = h.google.lastAuthorization?.state ?? '';
    const res = await h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=back-2&state=${state}`, headers: { cookie: `erase_oauth_state=${state}` } });
    // The google_sub was replaced, so this becomes a brand-new account rather than reviving the deleted one.
    const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: String(([] as string[]).concat(header(res, 'set-cookie') ?? []).find((c) => c.startsWith('erase_session='))).split(';')[0] ?? '' } });
    expect(me.json<{ id: string }>().id).not.toBe(s.userId);
  });
});

describe('rate limiting', () => {
  it('limits the auth start route per client', async () => {
    const limited = await buildHarness(t, { authRateLimitPerMinute: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.app.inject({ method: 'GET', url: '/v1/auth/google/start' })).statusCode);
      expect(codes).toEqual([302, 302, 302, 429, 429]);
    } finally {
      await limited.app.close();
    }
  });
});

describe('configuration gaps', () => {
  it('answers 503 auth_not_configured without Google credentials', async () => {
    const bare = await buildHarness(t, { withGoogle: false });
    try {
      const res = await bare.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'auth_not_configured' });
    } finally {
      await bare.app.close();
    }
  });
});

describe('logs', () => {
  it('contain no emails, tokens, session ids or OAuth codes after all of the above', () => {
    const text = h.logs.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/@example\.test/);
    expect(text).not.toMatch(/erase_session/);
    expect(text).not.toMatch(/code=|state=/);
    expect(text).not.toMatch(/sub-(ada|gone|back|x|r)/);
  });
});
