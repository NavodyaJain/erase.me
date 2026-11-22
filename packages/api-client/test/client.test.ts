import { describe, expect, it } from 'vitest';
import {
  ApiError,
  createApiClient,
  createIdempotencyKey,
  IDEMPOTENCY_KEY_PATTERN,
  isDraftUnsafe,
  isNotOffered,
  isSendUnavailable,
  isStaleDraft,
  isUseForm,
  type RequestView,
} from '../src/index';
import { fakeApi, ME, problem, REQUEST_ID } from './fake-api';

const BASE = 'http://localhost:4000';
const HASH = 'ab'.repeat(32);

describe('credentials and the CSRF header', () => {
  it('sends the session cookie on every call', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: ME }, 'GET /v1/inboxes': { body: { inboxes: [] } } });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    await client.me();
    await client.inboxes.list();
    expect(api.requests).toHaveLength(2);
    for (const r of api.requests) expect(r.credentials).toBe('include');
  });

  it('keeps the token from GET /v1/me and sends it on every state-changing call, but not on a read', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: ME },
      'GET /v1/companies': { body: { companies: [] } },
      'PUT /v1/companies/ucm_1/keep': { body: { company: { id: 'ucm_1', kept: true } } },
      'DELETE /v1/companies/ucm_1/keep': { body: { company: { id: 'ucm_1', kept: false } } },
      [`POST /v1/requests/${REQUEST_ID}/close`]: { body: {} },
      [`PATCH /v1/requests/${REQUEST_ID}/draft`]: { body: {} },
    });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    await client.me();
    await client.companies.list();
    await client.companies.keep('ucm_1');
    await client.companies.unkeep('ucm_1');
    await client.requests.close(REQUEST_ID);
    await client.requests.editDraft(REQUEST_ID, { baseHash: HASH, subject: 'S', body: 'B' });
    for (const r of api.requests) {
      if (r.method === 'GET') expect(r.headers.get('x-csrf-token'), `${r.method} ${r.path}`).toBeNull();
      else expect(r.headers.get('x-csrf-token'), `${r.method} ${r.path}`).toBe('csrf-token-1');
    }
    expect(api.requests.filter((r) => r.method !== 'GET')).toHaveLength(4);
  });

  it('fetches the token first when a state-changing call is the first thing it does', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: ME }, [`POST /v1/requests/${REQUEST_ID}/close`]: { body: {} } });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    await client.requests.close(REQUEST_ID);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/me', `POST /v1/requests/${REQUEST_ID}/close`]);
    expect(api.requests[1]?.headers.get('x-csrf-token')).toBe('csrf-token-1');
  });

  it('refreshes the token once and retries when the API refuses it, then gives up', async () => {
    let issued = 0;
    const api = fakeApi({
      'GET /v1/me': () => ({ body: { ...ME, csrfToken: `csrf-token-${++issued}` } }),
      [`POST /v1/requests/${REQUEST_ID}/close`]: (r) => (r.headers.get('x-csrf-token') === 'csrf-token-2' ? { body: {} } : problem(403, 'forbidden', 'Not allowed')),
    });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    await client.me(); // token 1
    await expect(client.requests.close(REQUEST_ID)).resolves.toBeDefined(); // refused with token 1, retried with token 2
    expect(api.calls(`POST /v1/requests/${REQUEST_ID}/close`).map((r) => r.headers.get('x-csrf-token'))).toEqual(['csrf-token-1', 'csrf-token-2']);

    const stuck = fakeApi({ 'GET /v1/me': { body: ME }, [`POST /v1/requests/${REQUEST_ID}/close`]: problem(403, 'forbidden', 'Not allowed') });
    const client2 = createApiClient({ baseUrl: BASE, fetch: stuck.fetch });
    await expect(client2.requests.close(REQUEST_ID)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(stuck.calls(`POST /v1/requests/${REQUEST_ID}/close`)).toHaveLength(2); // one retry, not a loop
  });

  it('forgets the token on logout', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: ME }, 'POST /v1/auth/logout': { status: 204 } });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    await client.me();
    expect(client.csrf.get()).toBe('csrf-token-1');
    await client.logout();
    expect(client.csrf.get()).toBeUndefined();
  });

  it('builds the sign-in URL for a browser navigation', () => {
    expect(createApiClient({ baseUrl: BASE }).signInUrl()).toBe('http://localhost:4000/v1/auth/google/start');
  });
});

describe('send needs an Idempotency-Key', () => {
  const sent = { request: { id: REQUEST_ID, status: 'sent', sentAt: '2026-11-22T10:00:00.000Z', dueAt: '2026-12-22T10:00:00.000Z' }, delivery: 'fake', notice: 'No email was sent.' };

  it('sends the key it is given, exactly, as the Idempotency-Key header', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: ME }, [`POST /v1/requests/${REQUEST_ID}/send`]: { body: sent } });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const key = createIdempotencyKey();
    const result = await client.requests.send(REQUEST_ID, key);
    expect(result.delivery).toBe('fake');
    const call = api.calls(`POST /v1/requests/${REQUEST_ID}/send`)[0];
    expect(call?.headers.get('idempotency-key')).toBe(key);
    expect(call?.headers.get('x-csrf-token')).toBe('csrf-token-1');
    expect(call?.credentials).toBe('include');
  });

  it('makes valid, unique keys', () => {
    const keys = new Set(Array.from({ length: 20 }, () => createIdempotencyKey()));
    expect(keys.size).toBe(20);
    for (const k of keys) expect(k).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it('refuses to call without a usable key, before anything is sent', () => {
    const api = fakeApi({});
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    expect(() => client.requests.send(REQUEST_ID, '')).toThrow(TypeError);
    expect(() => client.requests.send(REQUEST_ID, 'short')).toThrow(TypeError);
    expect(() => client.requests.send(REQUEST_ID, 'has spaces in it')).toThrow(TypeError);
    expect(api.requests).toHaveLength(0);
  });

  it('uses the same key on a retry, so the API can answer the first result again', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: ME }, [`POST /v1/requests/${REQUEST_ID}/send`]: (_r, n) => (n === 1 ? problem(502, 'send_outcome_unknown', 'We could not confirm the message was sent') : { body: sent }) });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const key = createIdempotencyKey();
    await expect(client.requests.send(REQUEST_ID, key)).rejects.toMatchObject({ code: 'send_outcome_unknown' });
    await client.requests.send(REQUEST_ID, key);
    expect(api.calls(`POST /v1/requests/${REQUEST_ID}/send`).map((r) => r.headers.get('idempotency-key'))).toEqual([key, key]);
  });
});

describe('errors and outcomes', () => {
  it('turns a stale approval into a 409 draft_changed ApiError', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: ME }, [`POST /v1/requests/${REQUEST_ID}/approve`]: problem(409, 'draft_changed', 'The draft changed') });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const err = await client.requests.approve(REQUEST_ID, HASH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'draft_changed', title: 'The draft changed', requestId: 'req-id-1' });
    expect(isStaleDraft(err)).toBe(true);
    expect(isUseForm(err)).toBe(false);
  });

  it('carries the form link of a use_form answer', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: ME },
      [`POST /v1/requests/${REQUEST_ID}/approve`]: problem(409, 'use_form', 'Use the company web form', { formUrl: 'https://example.com/privacy/request', selfServeUrl: 'https://example.com/account/delete' }),
    });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const err = await client.requests.approve(REQUEST_ID, HASH).catch((e: unknown) => e);
    expect(isUseForm(err)).toBe(true);
    if (isUseForm(err)) {
      expect(err.extensions.formUrl).toBe('https://example.com/privacy/request');
      expect(err.extensions.selfServeUrl).toBe('https://example.com/account/delete');
    }
  });

  it('recognises must_keep, kept, unsafe drafts and an unavailable sender', async () => {
    const answers = {
      mustKeep: problem(409, 'must_keep', 'No deletion request is offered for this company'),
      kept: problem(409, 'kept', 'You chose to keep this company'),
      unsafe: problem(422, 'draft_unsafe', 'The draft cannot be used yet', { findings: ['pan'] }),
      blocked: problem(503, 'real_send_blocked', 'Sending is not available'),
      disabled: problem(503, 'send_disabled', 'Sending is not available'),
    };
    const make = (a: (typeof answers)[keyof typeof answers]) => {
      const api = fakeApi({ 'GET /v1/me': { body: ME }, [`POST /v1/requests/${REQUEST_ID}/approve`]: a });
      return createApiClient({ baseUrl: BASE, fetch: api.fetch }).requests.approve(REQUEST_ID, HASH).catch((e: unknown) => e);
    };
    expect(isNotOffered(await make(answers.mustKeep))).toBe(true);
    expect(isNotOffered(await make(answers.kept))).toBe(true);
    const unsafe = await make(answers.unsafe);
    expect(isDraftUnsafe(unsafe)).toBe(true);
    if (isDraftUnsafe(unsafe)) expect(unsafe.extensions.findings).toEqual(['pan']);
    expect(isSendUnavailable(await make(answers.blocked))).toBe(true);
    expect(isSendUnavailable(await make(answers.disabled))).toBe(true);
    expect(isSendUnavailable(await make(answers.kept))).toBe(false);
  });

  it('returns a no_contact, must_keep or kept outcome as data, not as an error', async () => {
    const results = [
      { userCompanyId: 'ucm_1', outcome: 'created', requestId: REQUEST_ID },
      { userCompanyId: 'ucm_2', outcome: 'use_form', requestId: 'req_2', formUrl: 'https://example.com/privacy/request' },
      { userCompanyId: 'ucm_3', outcome: 'kept', message: 'You chose to keep Sample Shop.' },
      { userCompanyId: 'ucm_4', outcome: 'blocked', reason: 'must_keep', message: 'Needed to keep your account working.' },
      { userCompanyId: 'ucm_5', outcome: 'blocked', reason: 'no_contact', message: 'No verified contact yet.' },
    ];
    const api = fakeApi({ 'GET /v1/me': { body: ME }, 'POST /v1/requests/drafts': { body: { results } } });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const out = await client.requests.createDrafts(['ucm_1', 'ucm_2', 'ucm_3', 'ucm_4', 'ucm_5']);
    expect(out.map((o) => o.outcome)).toEqual(['created', 'use_form', 'kept', 'blocked', 'blocked']);
    expect(out.filter((o) => o.outcome === 'blocked').map((o) => o.reason)).toEqual(['must_keep', 'no_contact']);
    expect(api.calls('POST /v1/requests/drafts')[0]?.body).toEqual({ userCompanyIds: ['ucm_1', 'ucm_2', 'ucm_3', 'ucm_4', 'ucm_5'] });
  });

  it('reports a missing session as a 401 ApiError', async () => {
    const api = fakeApi({ 'GET /v1/me': problem(401, 'unauthorized', 'Sign in required') });
    await expect(createApiClient({ baseUrl: BASE, fetch: api.fetch }).me()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('reports an unreachable server as network_error with status 0', async () => {
    const client = createApiClient({ baseUrl: BASE, fetch: () => Promise.reject(new TypeError('fetch failed')) });
    const err = await client.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('reports an error without problem details as unreadable_response', async () => {
    const client = createApiClient({ baseUrl: BASE, fetch: () => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 })) });
    const err = await client.inboxes.list().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'unreadable_response' });
  });
});

describe('typed results', () => {
  it('returns the API’s shapes, and startScan says whether a scan was already running', async () => {
    const scan = { id: 'scn_1', inboxId: 'inb_1', status: 'running', progressPct: 40, foundCount: 3, startedAt: null, finishedAt: null, errorCode: null };
    const api = fakeApi({ 'GET /v1/me': { body: ME }, 'POST /v1/inboxes/inb_1/scan': (_r, n) => ({ status: n === 1 ? 202 : 200, body: { scan } }) });
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    expect(await client.inboxes.startScan('inb_1')).toEqual({ scan, alreadyRunning: false });
    expect((await client.inboxes.startScan('inb_1')).alreadyRunning).toBe(true);
  });

  it('exposes the request view with the draft hash to approve', async () => {
    const view = { request: { id: REQUEST_ID, status: 'drafted' }, draft: { hash: HASH, version: 1 }, approved: false, canSend: false, blockers: [] };
    const api = fakeApi({ [`GET /v1/requests/${REQUEST_ID}`]: { body: view } });
    const got: RequestView = (await createApiClient({ baseUrl: BASE, fetch: api.fetch }).requests.get(REQUEST_ID)) as unknown as RequestView;
    expect(got.draft.hash).toBe(HASH);
    expect(api.requests[0]?.path).toBe(`/v1/requests/${REQUEST_ID}`);
  });
});
