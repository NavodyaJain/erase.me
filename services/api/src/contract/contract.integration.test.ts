import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { actorFactory, type Actor } from '../../test/actors.js';
import { problemSchemaFor, spec, validateAgainst, type Json } from '../../test/contract.js';
import { createTestDb, type TestDb } from '../../test/db-helper.js';
import { authed, buildHarness, connectInbox, signIn, type Harness } from '../../test/harness.js';
import { FakeGmailSender, SenderOutcomeUnknownError, SenderRejectedError, type RequestSender } from '../modules/requests/sender.js';

/**
 * Contract tests: what the API really answers is what openapi.json says it answers. Every served /v1 route is in the
 * document and the reverse, every response below is checked against its documented schema, and every error `code`
 * seen is one the document lists for that operation and status.
 */

let t: TestDb;
const actor = actorFactory(() => t);
const sender = new FakeGmailSender();
let h: Harness;
const served: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  t = await createTestDb();
  h = await buildHarness(t, {
    sender: { kind: 'ready', sender },
    beforeReady: (app) => {
      app.addHook('onRoute', (route) => {
        for (const method of ([] as string[]).concat(route.method)) served.push({ method, url: route.url });
      });
      return Promise.resolve();
    },
  });
});
afterAll(async () => {
  await h.app.close();
  await t.drop();
});

// ---------- matching a real call to its documented operation ----------

const methods = ['get', 'put', 'post', 'patch', 'delete'] as const;
const specOps = Object.entries(spec.paths as Json).flatMap(([template, item]) => methods.filter((m) => item[m]).map((m) => ({ method: m.toUpperCase(), template, op: item[m] as Json })));

const templateRegex = (template: string): RegExp => new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);

function operationFor(method: string, url: string): { template: string; op: Json } {
  const path = url.split('?')[0] as string;
  const hit = specOps.find((o) => o.method === method && templateRegex(o.template).test(path));
  if (!hit) throw new Error(`${method} ${path} is not in openapi.json`);
  return hit;
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  h.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

/**
 * Checks one real response: its status is documented for that operation, a JSON body matches the documented schema,
 * and an error's code is one the document lists for that status.
 */
function conforms(method: string, url: string, res: LightMyRequestResponse): { code?: string } {
  const { template, op } = operationFor(method, url);
  const documented = op.responses[String(res.statusCode)] as Json | undefined;
  expect(documented, `${method} ${template} answered ${res.statusCode}, which the document does not list`).toBeDefined();

  const contentType = String(res.headers['content-type'] ?? '');
  if (contentType.includes('application/problem+json')) {
    const body = res.json<Json>();
    const examples = Object.keys(documented?.content?.['application/problem+json']?.examples ?? {});
    expect(examples, `${method} ${template} ${res.statusCode}: code "${String(body.code)}" is not documented`).toContain(body.code);
    expect(validateAgainst(problemSchemaFor(body.code as string), body), `${method} ${template} ${res.statusCode} ${String(body.code)}`).toEqual([]);
    expect(body.status).toBe(res.statusCode);
    return { code: body.code as string };
  }
  const schemaRef = documented?.content?.['application/json']?.schema?.$ref as string | undefined;
  if (schemaRef) {
    const errors = validateAgainst(schemaRef.replace('#/components/schemas/', ''), res.json());
    expect(errors, `${method} ${template} ${res.statusCode} body`).toEqual([]);
  } else if (res.statusCode === 204) {
    expect(res.body).toBe('');
  }
  return {};
}

/** Makes the call and checks it conforms. */
async function checked(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: unknown) {
  const res = await call(method, url, headers, payload);
  const { code } = conforms(method, url, res);
  return { res, code };
}

const key = () => `key-${Math.random().toString(36).slice(2, 12)}${Date.now()}`;

// ---------- the document and the server agree on what exists ----------

describe('every served route is documented, and every documented route is served', () => {
  it('matches in both directions', () => {
    const fromServer = new Set(
      served
        .filter((r) => r.url.startsWith('/v1/') && r.method !== 'HEAD' && r.method !== 'OPTIONS')
        .map((r) => `${r.method} ${r.url.replace(/:([A-Za-z]+)/g, '{$1}')}`),
    );
    const fromSpec = new Set(specOps.map((o) => `${o.method} ${o.template}`));
    expect([...fromServer].filter((r) => !fromSpec.has(r)).sort(), 'served but not documented').toEqual([]);
    expect([...fromSpec].filter((r) => !fromServer.has(r)).sort(), 'documented but not served').toEqual([]);
    expect(fromServer.size).toBeGreaterThanOrEqual(20);
  });
});

// ---------- real responses ----------

describe('responses match the document', () => {
  it('account, inboxes and scans', async () => {
    const s = await signIn(h, { email: 'contract1@example.test', sub: 'g-contract1' });
    const headers = authed(s);
    expect((await checked('GET', '/v1/me', { cookie: s.cookie })).res.statusCode).toBe(200);
    expect((await checked('GET', '/v1/inboxes', { cookie: s.cookie })).res.statusCode).toBe(200);

    const { inboxId } = await connectInbox(h, s, { email: 'contract1-mail@example.test', sub: 'g-contract1-mail' });
    const list = await checked('GET', '/v1/inboxes', { cookie: s.cookie });
    expect(list.res.json<{ inboxes: unknown[] }>().inboxes).toHaveLength(1);
    expect((await checked('POST', '/v1/inboxes/connect/start', headers)).res.statusCode).toBe(200);

    h.gmail.messages = [{ id: 'm1', receivedAt: new Date('2026-01-01'), from: 'hi@contract-co.example', subject: 'Your receipt' }];
    expect((await checked('GET', `/v1/inboxes/${inboxId}/scan`, { cookie: s.cookie })).res.statusCode).toBe(404);
    const started = await checked('POST', `/v1/inboxes/${inboxId}/scan`, headers);
    expect(started.res.statusCode).toBe(202);
    const again = await checked('POST', `/v1/inboxes/${inboxId}/scan`, headers);
    expect(again.res.statusCode).toBe(200); // already running
    await h.queue.drain();
    const done = await checked('GET', `/v1/inboxes/${inboxId}/scan`, { cookie: s.cookie });
    expect(done.res.json<{ scan: { status: string } }>().scan.status).toBe('done');
    expect((await checked('DELETE', `/v1/inboxes/${inboxId}`, headers)).res.json()).toEqual({ status: 'disconnected', revokedAtGoogle: true });
    expect((await checked('POST', `/v1/inboxes/${inboxId}/scan`, headers)).code).toBe('inbox_not_connected');
    expect((await checked('DELETE', '/v1/me', headers)).res.statusCode).toBe(202);
  });

  it('the sign-in redirects, logout and the standard refusals', async () => {
    const start = await checked('GET', '/v1/auth/google/start');
    expect(start.res.statusCode).toBe(302);
    const callback = await checked('GET', '/v1/auth/google/callback?error=access_denied&state=x');
    expect(callback.res.statusCode).toBe(302);

    expect((await checked('GET', '/v1/me')).code).toBe('unauthorized');
    expect((await checked('GET', '/v1/companies')).code).toBe('unauthorized');
    const s = await signIn(h, { email: 'contract2@example.test', sub: 'g-contract2' });
    expect((await checked('POST', '/v1/auth/logout', { cookie: s.cookie })).code).toBe('forbidden'); // no CSRF token
    expect((await checked('POST', '/v1/auth/logout', authed(s))).res.statusCode).toBe(204);
    expect((await checked('GET', '/v1/me', { cookie: s.cookie })).code).toBe('unauthorized'); // the session is gone

    const s2 = await signIn(h, { email: 'contract3@example.test', sub: 'g-contract3' });
    expect((await checked('GET', '/v1/requests/req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA', { cookie: s2.cookie })).code).toBe('not_found');
    expect((await checked('GET', '/v1/requests/not-an-id', { cookie: s2.cookie })).code).toBe('validation_failed');
    expect((await checked('POST', '/v1/requests/drafts', authed(s2), { userCompanyIds: [] })).code).toBe('validation_failed');
    const bad = await call('POST', '/v1/requests/drafts', { ...authed(s2), 'content-type': 'application/json' }, '{not json');
    expect(conforms('POST', '/v1/requests/drafts', bad).code).toBe('malformed_request');
  });

  it('companies and keep', async () => {
    const a = await actor(h, 'contract4');
    const c = await a.seed({ name: 'Contract Co', signals: ['receipt', 'welcome'], selfServeUrl: 'https://example.com/account/delete', contact: 'fictional' });
    await a.seed({ name: 'Plain Co', contact: 'none' });
    const open = await a.seed({ name: 'Open Co' });
    await checked('POST', '/v1/requests/drafts', authed(a.s), { userCompanyIds: [open.ucId] });

    const list = await checked('GET', '/v1/companies', { cookie: a.s.cookie });
    const items = list.res.json<{ companies: Array<{ company: string; openRequest: unknown; selfServeUrl: string | null }> }>().companies;
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.company === 'Open Co')?.openRequest).not.toBeNull();
    expect(items.find((i) => i.company === 'Contract Co')?.selfServeUrl).toBe('https://example.com/account/delete');

    const kept = await checked('PUT', `/v1/companies/${c.ucId}/keep`, authed(a.s));
    expect(kept.res.json<{ company: { kept: boolean } }>().company.kept).toBe(true);
    const cleared = await checked('DELETE', `/v1/companies/${c.ucId}/keep`, authed(a.s));
    expect(cleared.res.json<{ company: { kept: boolean } }>().company.kept).toBe(false);
    expect((await checked('PUT', '/v1/companies/ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA/keep', authed(a.s))).code).toBe('not_found');

    const must = await a.seed({ mustKeep: true, contact: 'none' });
    expect((await checked('PUT', `/v1/companies/${must.ucId}/keep`, authed(a.s))).code).toBe('must_keep');
    const gone = await a.seed({ status: 'not_mine' });
    expect((await checked('PUT', `/v1/companies/${gone.ucId}/keep`, authed(a.s))).code).toBe('company_excluded');
  });

  it('creating requests: every outcome, and the whole request lifecycle', async () => {
    const a = await actor(h, 'contract5');
    const email = await a.seed({ name: 'Email Co', contact: 'fictional' });
    const form = await a.seed({ name: 'Form Co', contact: 'form' });
    const keptCo = await a.seed({ name: 'Kept Co', contact: 'fictional' });
    const must = await a.seed({ name: 'Must Co', mustKeep: true, contact: 'none' });
    const none = await a.seed({ name: 'None Co', contact: 'none' });
    await checked('PUT', `/v1/companies/${keptCo.ucId}/keep`, authed(a.s));

    const created = await checked('POST', '/v1/requests/drafts', authed(a.s), { userCompanyIds: [email.ucId, form.ucId, keptCo.ucId, must.ucId, none.ucId] });
    const results = created.res.json<{ results: Array<{ userCompanyId: string; outcome: string; reason?: string; requestId?: string; formUrl?: string }> }>().results;
    const byCompany = Object.fromEntries(results.map((r) => [r.userCompanyId, r]));
    expect(byCompany[email.ucId]?.outcome).toBe('created');
    expect(byCompany[form.ucId]).toMatchObject({ outcome: 'use_form', formUrl: 'https://example.com/privacy/request' });
    expect(byCompany[keptCo.ucId]?.outcome).toBe('kept');
    expect(byCompany[must.ucId]).toMatchObject({ outcome: 'blocked', reason: 'must_keep' });
    expect(byCompany[none.ucId]).toMatchObject({ outcome: 'blocked', reason: 'no_contact' });

    const id = byCompany[email.ucId]?.requestId as string;
    const formId = byCompany[form.ucId]?.requestId as string;
    expect((await checked('GET', '/v1/requests', { cookie: a.s.cookie })).res.json<{ requests: unknown[] }>().requests).toHaveLength(2);
    const view = (await checked('GET', `/v1/requests/${id}`, { cookie: a.s.cookie })).res.json<{ draft: { hash: string; subject: string; body: string } }>();

    // Edit: stale hash, ID number, then the [OPEN] marker removed.
    expect((await checked('PATCH', `/v1/requests/${id}/draft`, authed(a.s), { baseHash: 'ab'.repeat(32), subject: 'S', body: 'B' })).code).toBe('draft_changed');
    const unsafe = await checked('PATCH', `/v1/requests/${id}/draft`, authed(a.s), { baseHash: view.draft.hash, subject: 'S', body: 'My PAN is ABCDE1234F' });
    expect(unsafe.code).toBe('draft_unsafe');
    expect(unsafe.res.json<{ findings: string[] }>().findings).toEqual(['pan']);
    expect((await checked('POST', `/v1/requests/${id}/approve`, authed(a.s), { draftHash: view.draft.hash })).code).toBe('draft_unsafe'); // the [OPEN] marker
    const body = view.draft.body.split('\n').filter((l) => !l.startsWith('[OPEN')).join('\n');
    const edited = (await checked('PATCH', `/v1/requests/${id}/draft`, authed(a.s), { baseHash: view.draft.hash, subject: view.draft.subject, body })).res.json<{ draft: { hash: string } }>();

    // Not approved yet, then approved, then kept and cleared.
    expect((await checked('POST', `/v1/requests/${id}/send`, { ...authed(a.s), 'idempotency-key': key() })).code).toBe('approval_required');
    expect((await checked('POST', `/v1/requests/${id}/send`, authed(a.s))).code).toBe('idempotency_key_required');
    const approved = await checked('POST', `/v1/requests/${id}/approve`, authed(a.s), { draftHash: edited.draft.hash });
    expect(approved.res.json<{ approved: boolean; canSend: boolean }>()).toMatchObject({ approved: true, canSend: true });
    await checked('PUT', `/v1/companies/${email.ucId}/keep`, authed(a.s));
    expect((await checked('POST', `/v1/requests/${id}/send`, { ...authed(a.s), 'idempotency-key': key() })).code).toBe('kept');
    await checked('DELETE', `/v1/companies/${email.ucId}/keep`, authed(a.s));

    // Send, replay, and the refusals after it.
    const k = key();
    const sent = await checked('POST', `/v1/requests/${id}/send`, { ...authed(a.s), 'idempotency-key': k });
    expect(sent.res.json()).toMatchObject({ delivery: 'fake', notice: expect.stringContaining('No email was sent') });
    const replay = await checked('POST', `/v1/requests/${id}/send`, { ...authed(a.s), 'idempotency-key': k });
    expect(replay.res.json()).toEqual(sent.res.json());
    expect((await checked('POST', `/v1/requests/${id}/send`, { ...authed(a.s), 'idempotency-key': key() })).code).toBe('already_sent');
    expect((await checked('PATCH', `/v1/requests/${id}/draft`, authed(a.s), { baseHash: edited.draft.hash, subject: 'S', body: 'B' })).code).toBe('request_not_editable');
    expect((await checked('POST', `/v1/requests/${id}/close`, authed(a.s))).code).toBe('request_not_closable');

    // A web-form request cannot be sent by email; a key already used for another request is refused first.
    expect((await checked('POST', `/v1/requests/${formId}/send`, { ...authed(a.s), 'idempotency-key': k })).code).toBe('idempotency_key_reuse');
    expect((await checked('POST', `/v1/requests/${formId}/send`, { ...authed(a.s), 'idempotency-key': key() })).code).toBe('use_form');

    // The web-form request.
    const formView = (await checked('GET', `/v1/requests/${formId}`, { cookie: a.s.cookie })).res.json<{ useForm: boolean; draft: { hash: string } }>();
    expect(formView.useForm).toBe(true);
    const useForm = await checked('POST', `/v1/requests/${formId}/approve`, authed(a.s), { draftHash: formView.draft.hash });
    expect(useForm.code).toBe('use_form');
    expect(useForm.res.json()).toMatchObject({ formUrl: 'https://example.com/privacy/request' });
    expect((await checked('POST', `/v1/requests/${formId}/close`, authed(a.s))).res.statusCode).toBe(200);
    expect((await checked('POST', `/v1/requests/${formId}/approve`, authed(a.s), { draftHash: formView.draft.hash })).code).toBe('use_form');
  });

  it('refusals that depend on the company: must-keep, kept, a lost contact, a reused key, a closed request', async () => {
    const a = await actor(h, 'contract6');
    const r1 = await makeApproved(a, { contact: 'fictional' });
    await t.owner.query('UPDATE companies SET must_keep = true WHERE id = $1', [r1.companyId]);
    expect((await checked('POST', `/v1/requests/${r1.id}/send`, { ...authed(a.s), 'idempotency-key': key() })).code).toBe('must_keep');

    const r2 = await makeApproved(a, { contact: 'fictional' });
    await t.owner.query("UPDATE companies SET grievance_status = 'unknown' WHERE id = $1", [r2.companyId]);
    expect((await checked('POST', `/v1/requests/${r2.id}/send`, { ...authed(a.s), 'idempotency-key': key() })).code).toBe('no_contact');

    const r3 = await makeApproved(a, { contact: 'fictional' });
    const r4 = await makeApproved(a, { contact: 'fictional' });
    const k = key();
    expect((await checked('POST', `/v1/requests/${r3.id}/send`, { ...authed(a.s), 'idempotency-key': k })).res.statusCode).toBe(200);
    const reuse = await checked('POST', `/v1/requests/${r4.id}/send`, { ...authed(a.s), 'idempotency-key': k });
    expect(reuse.code).toBe('idempotency_key_reuse');
    expect(reuse.res.statusCode).toBe(422);

    expect((await checked('POST', `/v1/requests/${r4.id}/close`, authed(a.s))).res.statusCode).toBe(200);
    expect((await checked('POST', `/v1/requests/${r4.id}/approve`, authed(a.s), { draftHash: r4.hash })).code).toBe('invalid_transition');
  });

  it('send failures and unavailable sending', async () => {
    const failing = new FakeGmailSender();
    const failHarness = await buildHarness(t, { sender: { kind: 'ready', sender: failing } });
    const unavailable = await buildHarness(t, { sender: { kind: 'unavailable', code: 'real_send_blocked', detail: 'Real sending stays off until the statute citation in the draft template has been verified.' } });
    const disabled = await buildHarness(t, { sender: { kind: 'unavailable', code: 'send_disabled', detail: 'Sending is not switched on in this environment.' } });
    const real: RequestSender = { mode: 'real', send: () => Promise.resolve({ threadId: 't', messageId: 'm', delivery: 'real' }) };
    const capped = await buildHarness(t, { sender: { kind: 'ready', sender: real }, envOverrides: { REAL_SEND_DAILY_CAP: '1' } });
    const noGoogle = await buildHarness(t, { withGoogle: false });
    const limited = await buildHarness(t, { authRateLimitPerMinute: 2 });
    try {
      const run = async (harness: Harness, label: string, act: (r: { id: string; s: Actor['s'] }, harness: Harness) => Promise<void>, contact: 'fictional' | 'real' = 'fictional') => {
        const a = await actorFactory(() => t)(harness, label);
        const r = await makeApproved(a, { contact }, harness);
        await act({ id: r.id, s: a.s }, harness);
      };
      const send = async (harness: Harness, r: { id: string; s: Actor['s'] }) => {
        const res = await harness.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/send`, headers: { ...authed(r.s), 'idempotency-key': key() } });
        return { res, ...conforms('POST', `/v1/requests/${r.id}/send`, res) };
      };

      await run(failHarness, 'cfail1', async (r, hh) => {
        failing.beforeSend = () => Promise.reject(new SenderRejectedError());
        expect((await send(hh, r)).code).toBe('send_failed');
        failing.beforeSend = () => Promise.reject(new SenderOutcomeUnknownError());
        expect((await send(hh, r)).code).toBe('send_outcome_unknown');
        failing.beforeSend = undefined;
        expect((await send(hh, r)).code).toBe('send_in_progress');
      });
      await run(unavailable, 'cblock', async (r, hh) => expect((await send(hh, r)).code).toBe('real_send_blocked'));
      await run(disabled, 'cdisabled', async (r, hh) => expect((await send(hh, r)).code).toBe('send_disabled'));
      // The daily cap counts real sends per user: the second send by the same user is refused.
      const same = await actorFactory(() => t)(capped, 'ccap3');
      const first = await makeApproved(same, { contact: 'real' }, capped);
      const secondReq = await makeApproved(same, { contact: 'real' }, capped);
      expect((await send(capped, { id: first.id, s: same.s })).res.statusCode).toBe(200);
      expect((await send(capped, { id: secondReq.id, s: same.s })).code).toBe('daily_cap_reached');

      const start = await noGoogle.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
      expect(conforms('GET', '/v1/auth/google/start', start).code).toBe('auth_not_configured');

      const codes: Array<number> = [];
      for (let i = 0; i < 4; i++) {
        const res = await limited.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
        codes.push(res.statusCode);
        if (res.statusCode === 429) expect(conforms('GET', '/v1/auth/google/start', res).code).toBe('rate_limited');
      }
      expect(codes).toContain(429);
    } finally {
      for (const x of [failHarness, unavailable, disabled, capped, noGoogle, limited]) await x.app.close();
    }
  });

  it('reporting an outcome, and marking a web-form request as submitted: every status and error code is documented', async () => {
    const a = await actor(h, 'contract8');
    const outcomeUrl = (id: string) => `/v1/requests/${id}/outcome`;

    // An email request: there is no outcome to report before it is sent, then each outcome and taking it back.
    const r = await makeApproved(a, { contact: 'fictional' });
    expect((await checked('PUT', outcomeUrl(r.id), authed(a.s), { outcome: 'refused' })).code).toBe('invalid_transition');
    expect((await checked('PUT', outcomeUrl(r.id), authed(a.s), { outcome: 'not-an-outcome' })).code).toBe('validation_failed');
    expect((await checked('PUT', outcomeUrl('req_00000000000000000000000000'), authed(a.s), { outcome: 'refused' })).code).toBe('not_found');
    expect((await checked('POST', `/v1/requests/${r.id}/send`, { ...authed(a.s), 'idempotency-key': key() })).res.statusCode).toBe(200);
    for (const outcome of ['confirmed_erased', 'refused', 'needs_more_info', 'no_answer_yet']) {
      const res = (await checked('PUT', outcomeUrl(r.id), authed(a.s), { outcome })).res;
      expect(res.statusCode).toBe(200);
      expect(res.json<{ outcome: { value: string; setByUser: boolean } }>().outcome.value).toBe(outcome);
    }
    expect((await checked('GET', '/v1/requests', { cookie: a.s.cookie })).res.json<{ requests: Array<{ channel: string; outcome: string | null }> }>().requests[0]).toMatchObject({ channel: 'email' });

    // A web-form request: copy, then say it was pasted into the form.
    const form = await a.seed({ contact: 'form' });
    const created = (await checked('POST', '/v1/requests/drafts', authed(a.s), { userCompanyIds: [form.ucId] })).res.json<{ results: Array<{ requestId: string }> }>();
    const formId = created.results[0]?.requestId as string;
    const view = (await checked('GET', `/v1/requests/${formId}`, { cookie: a.s.cookie })).res.json<{ draft: { hash: string; subject: string; body: string }; canMarkSubmitted: boolean }>();
    expect(view.canMarkSubmitted).toBe(false); // the [OPEN] line is still there
    const submitted = (hash: string) => checked('POST', `/v1/requests/${formId}/submitted`, authed(a.s), { draftHash: hash });
    const open = await submitted(view.draft.hash);
    expect(open.code).toBe('draft_unsafe');
    expect(open.res.statusCode).toBe(422);
    const body = view.draft.body.split('\n').filter((l) => !l.startsWith('[OPEN')).join('\n');
    const edited = (await checked('PATCH', `/v1/requests/${formId}/draft`, authed(a.s), { baseHash: view.draft.hash, subject: view.draft.subject, body })).res.json<{ draft: { hash: string } }>();
    expect((await submitted(view.draft.hash)).code).toBe('draft_changed');
    expect((await checked('POST', `/v1/requests/${formId}/submitted`, authed(a.s), { draftHash: 'not-a-hash' })).code).toBe('validation_failed');
    expect((await checked('POST', `/v1/requests/${r.id}/submitted`, authed(a.s), { draftHash: r.hash })).code).toBe('already_sent');
    const ok = await submitted(edited.draft.hash);
    expect(ok.res.statusCode).toBe(200);
    expect(ok.res.json<{ request: { status: string; channel: string }; useForm: boolean }>()).toMatchObject({ request: { status: 'sent', channel: 'web_form' }, useForm: true });
    expect((await submitted(edited.draft.hash)).res.statusCode).toBe(200); // saying it again changes nothing

    // An email company is not a form request; the other guards are covered in outcomes.integration.test.ts.
    const emailDraft = await makeApprovedDraftOnly(a);
    expect((await checked('POST', `/v1/requests/${emailDraft.id}/submitted`, authed(a.s), { draftHash: emailDraft.hash })).code).toBe('not_a_form_request');
    const closed = await a.seed({ contact: 'form' });
    const closedId = (await checked('POST', '/v1/requests/drafts', authed(a.s), { userCompanyIds: [closed.ucId] })).res.json<{ results: Array<{ requestId: string }> }>().results[0]?.requestId as string;
    await checked('POST', `/v1/requests/${closedId}/close`, authed(a.s));
    expect((await checked('POST', `/v1/requests/${closedId}/submitted`, authed(a.s), { draftHash: 'a'.repeat(64) })).code).toBe('invalid_transition');
    expect((await checked('POST', `/v1/requests/req_00000000000000000000000000/submitted`, authed(a.s), { draftHash: 'a'.repeat(64) })).code).toBe('not_found');
  });

  it('inbox limit', async () => {
    const s = await signIn(h, { email: 'contract7@example.test', sub: 'g-contract7' });
    for (let i = 1; i <= 5; i++) await connectInbox(h, s, { email: `c7-box${i}@example.test`, sub: `g-c7-box${i}` });
    expect((await checked('POST', '/v1/inboxes/connect/start', authed(s))).code).toBe('inbox_limit');
  });
});

/** A request for a new fictional company that has been edited and approved, ready to send. */
async function makeApproved(a: Actor, o: { contact: 'fictional' | 'real' }, harness: Harness = h) {
  const c = await a.seed({ contact: o.contact });
  const created = await harness.app.inject({ method: 'POST', url: '/v1/requests/drafts', headers: authed(a.s), payload: { userCompanyIds: [c.ucId] } });
  const id = created.json<{ results: Array<{ requestId: string }> }>().results[0]?.requestId as string;
  const view = (await harness.app.inject({ method: 'GET', url: `/v1/requests/${id}`, headers: { cookie: a.s.cookie } })).json<{ draft: { hash: string; subject: string; body: string } }>();
  const body = view.draft.body.split('\n').filter((l) => !l.startsWith('[OPEN')).join('\n');
  const edited = (await harness.app.inject({ method: 'PATCH', url: `/v1/requests/${id}/draft`, headers: authed(a.s), payload: { baseHash: view.draft.hash, subject: view.draft.subject, body } })).json<{ draft: { hash: string } }>();
  const approved = await harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/approve`, headers: authed(a.s), payload: { draftHash: edited.draft.hash } });
  expect(approved.statusCode).toBe(200);
  return { id, hash: edited.draft.hash, companyId: c.companyId, ucId: c.ucId };
}

/** A drafted email request whose [OPEN] line is resolved. Not approved. */
async function makeApprovedDraftOnly(a: Actor, harness: Harness = h) {
  const c = await a.seed({ contact: 'fictional' });
  const created = await harness.app.inject({ method: 'POST', url: '/v1/requests/drafts', headers: authed(a.s), payload: { userCompanyIds: [c.ucId] } });
  const id = created.json<{ results: Array<{ requestId: string }> }>().results[0]?.requestId as string;
  const view = (await harness.app.inject({ method: 'GET', url: `/v1/requests/${id}`, headers: { cookie: a.s.cookie } })).json<{ draft: { hash: string; subject: string; body: string } }>();
  const body = view.draft.body.split('\n').filter((l) => !l.startsWith('[OPEN')).join('\n');
  const edited = (await harness.app.inject({ method: 'PATCH', url: `/v1/requests/${id}/draft`, headers: authed(a.s), payload: { baseHash: view.draft.hash, subject: view.draft.subject, body } })).json<{ draft: { hash: string } }>();
  return { id, hash: edited.draft.hash };
}
