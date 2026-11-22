import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../test/db-helper.js';
import { buildHarness, signIn, type Harness } from '../../test/harness.js';

/**
 * The web app runs on a different port (or host) from the API. Everything that depends on where it runs comes from
 * WEB_ORIGIN: CORS, the CSRF origin check, and where the browser lands after Google. These tests use a web origin that
 * is not the default, to show nothing is hard-coded to http://localhost:3000.
 */

const WEB = 'http://localhost:3005';
const DEFAULT_WEB = 'http://localhost:3000';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const open = (overrides: Record<string, string>): Promise<Harness> => buildHarness(t, { envOverrides: overrides });

describe('WEB_ORIGIN drives CORS', () => {
  it('allows the configured origin with credentials, and no other', async () => {
    const h = await open({ WEB_ORIGIN: WEB });
    try {
      const pre = await h.app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: WEB } });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe(WEB);
      expect(pre.headers['access-control-allow-credentials']).toBe('true');
      expect(String(pre.headers['access-control-allow-headers'])).toMatch(/x-csrf-token/);
      expect(String(pre.headers['access-control-allow-headers'])).toMatch(/idempotency-key/);
      expect(String(pre.headers['access-control-allow-methods'])).toMatch(/PUT/); // keep this uses PUT

      const other = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { origin: DEFAULT_WEB } });
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
      const actual = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { origin: WEB } });
      expect(actual.headers['access-control-allow-origin']).toBe(WEB);
      expect(actual.headers.vary).toMatch(/Origin/);
    } finally {
      await h.app.close();
    }
  });

  it('works when the setting has a trailing slash', async () => {
    const h = await open({ WEB_ORIGIN: `${WEB}/` });
    try {
      expect(h.env.WEB_ORIGIN).toBe(WEB);
      const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { origin: WEB } });
      expect(res.headers['access-control-allow-origin']).toBe(WEB);
    } finally {
      await h.app.close();
    }
  });
});

describe('WEB_ORIGIN drives the CSRF origin check', () => {
  it('accepts a state-changing call from the configured origin and refuses the default one', async () => {
    const h = await open({ WEB_ORIGIN: WEB });
    try {
      const s = await signIn(h, { email: 'origin1@example.test', sub: 'g-origin1' });
      const headers = (origin: string) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin });
      const wrong = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: headers(DEFAULT_WEB) });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toMatchObject({ code: 'forbidden' });
      expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: s.cookie } })).statusCode).toBe(200); // still signed in
      const right = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: headers(WEB) });
      expect(right.statusCode).toBe(204);
    } finally {
      await h.app.close();
    }
  });
});

describe('WEB_ORIGIN drives the redirect after Google', () => {
  const callback = async (h: Harness) => {
    h.google.grant('code-origin', { email: 'origin2@example.test', sub: 'g-origin2' });
    await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    const state = h.google.lastAuthorization?.state ?? '';
    return h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=code-origin&state=${state}`, headers: { cookie: `erase_oauth_state=${state}` } });
  };

  it('sends the browser to the configured web origin after sign-in, and with an error code on failure', async () => {
    const h = await open({ WEB_ORIGIN: WEB });
    try {
      const ok = await callback(h);
      expect(ok.statusCode).toBe(302);
      expect(ok.headers.location).toBe(`${WEB}/`);
      await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
      const state = h.google.lastAuthorization?.state ?? '';
      const denied = await h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?error=access_denied&state=${state}`, headers: { cookie: `erase_oauth_state=${state}` } });
      expect(denied.headers.location).toBe(`${WEB}/?auth_error=access_denied`);
    } finally {
      await h.app.close();
    }
  });

  it('follows a web origin on another host and scheme too', async () => {
    const h = await open({ WEB_ORIGIN: 'https://app.example.com' });
    try {
      expect((await callback(h)).headers.location).toBe('https://app.example.com/');
    } finally {
      await h.app.close();
    }
  });
});

describe('the session cookie works across ports and is set from config', () => {
  const cookies = async (overrides: Record<string, string>): Promise<string> => {
    const h = await open(overrides);
    try {
      h.google.grant('code-cookie', { email: 'origin3@example.test', sub: 'g-origin3' });
      await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
      const state = h.google.lastAuthorization?.state ?? '';
      const res = await h.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=code-cookie&state=${state}`, headers: { cookie: `erase_oauth_state=${state}` } });
      return ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('erase_session=')) ?? '';
    } finally {
      await h.app.close();
    }
  };

  it('is host-only, HttpOnly and SameSite=Lax in local development, so one cookie serves localhost on any port', async () => {
    const cookie = await cookies({ WEB_ORIGIN: WEB });
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/); // a cookie is scoped to the host, not the port
    expect(cookie).not.toMatch(/Secure/); // the local API is http
  });

  it('gets Secure from an https API_PUBLIC_URL and a parent Domain from COOKIE_DOMAIN', async () => {
    const cookie = await cookies({ WEB_ORIGIN: 'https://app.example.com', API_PUBLIC_URL: 'https://api.example.com', COOKIE_DOMAIN: '.example.com' });
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Domain=\.example\.com/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});
