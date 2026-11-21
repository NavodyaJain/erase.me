import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../test/db-helper.js';
import { buildHarness, connectInbox, signIn, type Harness } from '../../test/harness.js';
import { loadEnv } from '../config/env.js';
import { assertDevHelperAllowed, registerDevHelper } from './dev-helper.js';

let t: TestDb;
let h: Harness;
const API_ORIGIN = 'http://localhost:4000';

beforeAll(async () => {
  t = await createTestDb();
  h = await buildHarness(t, { beforeReady: (app, ctx) => registerDevHelper(app, ctx) });
});
afterAll(async () => {
  await h.app.close();
  await t.drop();
});

// The dev page is served by the API, so its Origin is the API origin.
const devAuthed = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: API_ORIGIN });

describe('refusal outside local development', () => {
  it('is refused in production and staging', () => {
    expect(() => assertDevHelperAllowed({ API_HOST: '127.0.0.1', NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => assertDevHelperAllowed({ API_HOST: '127.0.0.1', NODE_ENV: 'staging' })).toThrow();
    expect(() => assertDevHelperAllowed({ API_HOST: '127.0.0.1', NODE_ENV: 'development' })).not.toThrow();
  });

  it('is refused when the API listens beyond loopback', () => {
    expect(() => assertDevHelperAllowed({ NODE_ENV: 'development', API_HOST: '0.0.0.0' })).toThrow(/loopback/);
  });

  it('registers nothing when the check fails', async () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@h/x',
      REDIS_URL: 'redis://h',
      AI_SERVICE_URL: 'http://h',
      TOKEN_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
      AI_SERVICE_TOKEN: 'x'.repeat(20),
      WEB_ORIGIN: 'https://a.example',
      API_PUBLIC_URL: 'https://b.example',
    });
    await expect(registerDevHelper(h.app, { env, db: undefined as never })).rejects.toThrow(/production/);
  });
});

describe('page', () => {
  it('is served with a strict CSP and writes nothing through innerHTML', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/dev/connect' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(res.body).not.toMatch(/innerHTML/);
  });
});

describe('state, connect, scan and results', () => {
  it('reports signed out without a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/dev/api/state' });
    expect(res.json()).toMatchObject({ signedIn: false });
  });

  it('lets a signed-in user connect, scan and read company-level results only', async () => {
    const s = await signIn(h, { email: 'dev@example.test', sub: 'g-dev' });
    const { inboxId } = await connectInbox(h, s, { email: 'dev-mail@example.test', sub: 'g-dev-mail' });
    h.gmail.messages = [
      { id: 'secret-id-1', receivedAt: new Date('2019-03-04'), from: '"Hidden Sender" <noreply@loanly.example>', subject: 'Welcome to Loanly, confidential subject' },
      { id: 'secret-id-2', receivedAt: new Date('2024-07-09'), from: 'billing@loanly.example', subject: 'Your invoice 4411' },
      { id: 'secret-id-3', receivedAt: new Date('2021-01-01'), from: 'hi@streamo.example', subject: 'Big sale', listUnsubscribe: true },
    ];

    const scan = await h.app.inject({ method: 'POST', url: '/dev/api/scan', headers: devAuthed(s), payload: { inboxId } });
    expect(scan.statusCode).toBe(202);
    await h.queue.drain();

    const state = await h.app.inject({ method: 'GET', url: '/dev/api/state', headers: { cookie: s.cookie } });
    const body = state.json<{ signedIn: boolean; results: Array<Record<string, unknown>>; scans: Record<string, { status: string; foundCount: number }> }>();
    expect(body.signedIn).toBe(true);
    expect(body.scans[inboxId]).toMatchObject({ status: 'done', foundCount: 2 });
    expect(body.results).toEqual([
      { company: 'Streamo', domain: 'streamo.example', firstSeen: '2021-01-01', lastSeen: '2021-01-01', signals: ['list_unsubscribe'] },
      { company: 'Loanly', domain: 'loanly.example', firstSeen: '2019-03-04', lastSeen: '2024-07-09', signals: ['receipt', 'welcome'] },
    ].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)));
    for (const secret of ['secret-id', 'Hidden Sender', 'noreply@', 'billing@', 'confidential', 'invoice 4411', 'Big sale']) {
      expect(state.body, secret).not.toContain(secret);
    }
  });

  it('hides companies marked "not mine"', async () => {
    const s = await signIn(h, { email: 'dev2@example.test', sub: 'g-dev2' });
    const { inboxId } = await connectInbox(h, s, { email: 'dev2-mail@example.test', sub: 'g-dev2-mail' });
    h.gmail.messages = [
      { id: 'a', receivedAt: new Date('2020-01-01'), from: 'x@keepme.example', subject: 'Your receipt' },
      { id: 'b', receivedAt: new Date('2020-01-01'), from: 'x@dropme.example', subject: 'Your receipt' },
    ];
    await h.app.inject({ method: 'POST', url: '/dev/api/scan', headers: devAuthed(s), payload: { inboxId } });
    await h.queue.drain();
    await t.owner.query(
      "UPDATE user_companies SET status = 'not_mine' WHERE user_id = $1 AND company_id = (SELECT id FROM companies WHERE domains[1] = 'dropme.example')",
      [s.userId],
    );
    const body = (await h.app.inject({ method: 'GET', url: '/dev/api/state', headers: { cookie: s.cookie } })).json<{ results: Array<{ domain: string }> }>();
    expect(body.results.map((r) => r.domain)).toEqual(['keepme.example']);
  });

  it('shows each user only their own results', async () => {
    const other = await signIn(h, { email: 'dev3@example.test', sub: 'g-dev3' });
    const body = (await h.app.inject({ method: 'GET', url: '/dev/api/state', headers: { cookie: other.cookie } })).json<{ results: unknown[]; inboxes: unknown[] }>();
    expect(body.results).toEqual([]);
    expect(body.inboxes).toEqual([]);
  });

  it('starts a connection and sets the state cookie for the Google callback', async () => {
    const s = await signIn(h, { email: 'dev4@example.test', sub: 'g-dev4' });
    const res = await h.app.inject({ method: 'POST', url: '/dev/api/connect', headers: devAuthed(s) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ authorizationUrl: string }>().authorizationUrl).toMatch(/^https:\/\/fake-google\.test\/auth/);
    expect(String(res.headers['set-cookie'])).toMatch(/erase_oauth_state=.+Path=\/v1\/auth\/google/);
    expect(h.google.lastAuthorization?.purpose).toBe('connect');
  });
});

describe('protection', () => {
  it('requires a session, the CSRF token and the API origin on every action', async () => {
    const s = await signIn(h, { email: 'dev5@example.test', sub: 'g-dev5' });
    for (const url of ['/dev/api/connect', '/dev/api/scan', '/dev/api/disconnect']) {
      expect((await h.app.inject({ method: 'POST', url, payload: {} })).statusCode, url).toBe(401);
      expect((await h.app.inject({ method: 'POST', url, headers: { cookie: s.cookie, origin: API_ORIGIN }, payload: {} })).statusCode, url).toBe(403);
      expect((await h.app.inject({ method: 'POST', url, headers: { ...devAuthed(s), origin: 'https://evil.test' }, payload: {} })).statusCode, url).toBe(403);
    }
  });

  it("cannot scan or disconnect another user's inbox", async () => {
    const a = await signIn(h, { email: 'dev6@example.test', sub: 'g-dev6' });
    const b = await signIn(h, { email: 'dev7@example.test', sub: 'g-dev7' });
    const { inboxId } = await connectInbox(h, a, { email: 'dev6-mail@example.test', sub: 'g-dev6-mail' });
    expect((await h.app.inject({ method: 'POST', url: '/dev/api/scan', headers: devAuthed(b), payload: { inboxId } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: '/dev/api/disconnect', headers: devAuthed(b), payload: { inboxId } })).statusCode).toBe(404);
  });

  it('has no send route', () => {
    expect(h.app.printRoutes({ commonPrefix: false })).not.toMatch(/send/i);
  });
});
