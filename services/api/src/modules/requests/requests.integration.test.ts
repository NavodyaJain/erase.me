import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, pgError, type TestDb } from '../../../test/db-helper.js';
import { authed, buildHarness, connectInbox, signIn, type Harness, type Session } from '../../../test/harness.js';
import { newId } from '../../common/ids.js';
import { hashDraft } from './draft-hash.js';
import { verhoeffCheckDigit } from './draft-safety.js';
import { FakeGmailSender, SenderOutcomeUnknownError, SenderRejectedError, type RequestSender } from './sender.js';

const CHECK_VIOLATION = '23514';

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

// ---------- helpers ----------

type Contact = 'fictional' | 'real' | 'none' | 'unverified' | 'bounced' | 'form' | 'realform';
interface SeedOptions {
  name?: string;
  contact?: Contact;
  mustKeep?: boolean;
  signals?: string[];
  status?: 'active' | 'not_mine';
  riskLevel?: 'must_keep';
  /** The company's own account-deletion page. */
  selfServeUrl?: string;
}

interface Actor {
  s: Session;
  inboxId: string;
  email: string;
  name: string;
  /** Adds a detected company for this user and returns its user_company id and company id. */
  seed(o?: SeedOptions): Promise<{ ucId: string; companyId: string; contactEmail: string | null }>;
}

async function actor(harness: Harness, label: string): Promise<Actor> {
  const email = `${label}@example.test`;
  const name = `Person ${label}`;
  const s = await signIn(harness, { email, sub: `g-${label}`, name });
  const { inboxId } = await connectInbox(harness, s, { email: `${label}-mail@example.test`, sub: `g-${label}-mail` });
  return {
    s,
    inboxId,
    email,
    name,
    async seed(o = {}) {
      const companyId = newId('company');
      const ucId = newId('userCompany');
      const slug = `co-${randomBytes(5).toString('hex')}`;
      const domain = `${slug}.example`;
      const contact = o.contact ?? 'fictional';
      const cols = {
        fictional: ['privacy@example.com', 'https://example.com/privacy', '2026-01-01', 'verified', true],
        real: [`grievance@${domain}`, `https://${domain}/privacy`, '2026-01-01', 'verified', false],
        none: [null, null, null, 'unknown', false],
        unverified: [`grievance@${domain}`, `https://${domain}/privacy`, '2026-01-01', 'unknown', false],
        bounced: [`grievance@${domain}`, `https://${domain}/privacy`, '2026-01-01', 'bounced', false],
        form: [null, 'https://example.com/privacy', '2026-01-01', 'verified', true],
        realform: [null, `https://${domain}/privacy`, '2026-01-01', 'verified', false],
      }[contact];
      const formUrl = contact === 'form' ? 'https://example.com/privacy/request' : contact === 'realform' ? `https://${domain}/privacy/request` : null;
      await t.owner.query(
        `INSERT INTO companies (id, slug, name, domains, category, grievance_email, grievance_source, grievance_verified_on, grievance_status, is_fictional, must_keep, grievance_channel, grievance_form_url, self_serve_url)
         VALUES ($1, $2, $3, ARRAY[$4], 'ecommerce', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [companyId, slug, o.name ?? `Shop ${slug.slice(3, 8)}`, domain, ...cols, o.mustKeep ?? false, formUrl ? 'web_form' : 'email', formUrl, o.selfServeUrl ?? null],
      );
      await t.owner.query(
        `INSERT INTO user_companies (id, user_id, company_id, inbox_id, first_seen, last_seen, signal_types, status, risk_level)
         VALUES ($1, $2, $3, $4, now() - interval '90 days', now(), $5, $6, $7)`,
        [ucId, s.userId, companyId, inboxId, o.signals ?? ['welcome', 'receipt'], o.status ?? 'active', o.riskLevel ?? null],
      );
      return { ucId, companyId, contactEmail: cols[0] as string | null };
    },
  };
}

interface View {
  request: { id: string; status: string; sentAt: string | null; dueAt: string | null };
  company: { name: string; mustKeep: boolean };
  draft: { version: number; to: string; subject: string; body: string; hash: string; createdBy: string };
  approved: boolean;
  events: Array<{ type: string; actor: string; payload: Record<string, unknown> }>;
  canSend: boolean;
  blockers: Array<{ code: string; message: string; findings?: string[] }>;
}

const api = (harness: Harness) => ({
  create: (s: Session, ids: string[]) => harness.app.inject({ method: 'POST', url: '/v1/requests/drafts', headers: authed(s), payload: { userCompanyIds: ids } }),
  get: (s: Session, id: string) => harness.app.inject({ method: 'GET', url: `/v1/requests/${id}`, headers: { cookie: s.cookie } }),
  list: (s: Session) => harness.app.inject({ method: 'GET', url: '/v1/requests', headers: { cookie: s.cookie } }),
  edit: (s: Session, id: string, baseHash: string, subject: string, body: string) =>
    harness.app.inject({ method: 'PATCH', url: `/v1/requests/${id}/draft`, headers: authed(s), payload: { baseHash, subject, body } }),
  approve: (s: Session, id: string, draftHash: string) =>
    harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/approve`, headers: authed(s), payload: { draftHash } }),
  close: (s: Session, id: string) => harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/close`, headers: authed(s) }),
  send: (s: Session, id: string, key?: string) =>
    harness.app.inject({ method: 'POST', url: `/v1/requests/${id}/send`, headers: { ...authed(s), ...(key ? { 'idempotency-key': key } : {}) } }),
});
const A = api;
const key = () => `key-${randomBytes(8).toString('hex')}`;

/** Creates a request for a new company and returns its id and first view. */
async function newRequest(harness: Harness, a: Actor, o: SeedOptions = {}) {
  const c = await a.seed(o);
  const res = await A(harness).create(a.s, [c.ucId]);
  const result = res.json<{ results: Array<{ outcome: string; requestId?: string }> }>().results[0];
  if (!result?.requestId) throw new Error(`no request created: ${JSON.stringify(result)}`);
  const view = (await A(harness).get(a.s, result.requestId)).json<View>();
  return { ...c, id: result.requestId, view };
}

/** Removes the unresolved [OPEN] line (the owner's job once the citation is verified) so the draft can be approved. */
async function resolveMarker(harness: Harness, a: Actor, id: string): Promise<View> {
  const v = (await A(harness).get(a.s, id)).json<View>();
  const body = v.draft.body
    .split('\n')
    .filter((l) => !l.startsWith('[OPEN'))
    .join('\n');
  const res = await A(harness).edit(a.s, id, v.draft.hash, v.draft.subject, body);
  expect(res.statusCode).toBe(200);
  return res.json<View>();
}

async function approved(harness: Harness, a: Actor, o: SeedOptions = {}) {
  const r = await newRequest(harness, a, o);
  const v = await resolveMarker(harness, a, r.id);
  const res = await A(harness).approve(a.s, r.id, v.draft.hash);
  expect(res.statusCode).toBe(200);
  return { ...r, view: res.json<View>() };
}

const requestRow = async (id: string) => (await t.owner.query<{ status: string; thread_id: string | null }>('SELECT status, thread_id FROM requests WHERE id = $1', [id])).rows[0];
const events = async (id: string) => (await t.owner.query<{ type: string; actor_type: string; payload: Record<string, unknown> }>('SELECT type, actor_type, payload FROM request_events WHERE request_id = $1 ORDER BY created_at, id', [id])).rows;
const draftCount = async (id: string) => Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM request_drafts WHERE request_id = $1', [id])).rows[0]?.n);

// ---------- create ----------

describe('create a request and its draft', () => {
  it('creates a request with a template draft to the verified contact, hedged, not yet sendable', async () => {
    const a = await actor(h, 'create1');
    const r = await newRequest(h, a, { name: 'Sample Shop' });
    expect(r.view.request.status).toBe('drafted');
    expect(r.view.draft).toMatchObject({ version: 1, to: 'privacy@example.com', createdBy: 'template' });
    expect(r.view.draft.hash).toBe(hashDraft({ to: r.view.draft.to, subject: r.view.draft.subject, body: r.view.draft.body }));
    expect(r.view.draft.body).toContain(`Name: ${a.name}`);
    expect(r.view.draft.body).toContain(`Email address: ${a.email}`);
    expect(r.view.draft.body).toMatch(/likely holds/);
    expect(r.view.draft.body).toContain('[OPEN: statute citation and commencement date pending verification.');
    expect(r.view.events.map((e) => e.type)).toEqual(['drafted']);
    expect(r.view.canSend).toBe(false);
    expect(r.view.blockers.map((b) => b.code)).toContain('draft_unsafe');
  });

  it('is idempotent per company: a second create returns the open request', async () => {
    const a = await actor(h, 'create2');
    const c = await a.seed();
    const first = (await A(h).create(a.s, [c.ucId])).json<{ results: Array<{ outcome: string; requestId: string }> }>().results[0];
    const second = (await A(h).create(a.s, [c.ucId])).json<{ results: Array<{ outcome: string; requestId: string }> }>().results[0];
    expect(first?.outcome).toBe('created');
    expect(second).toMatchObject({ outcome: 'existing', requestId: first?.requestId });
    expect(await draftCount(first?.requestId ?? '')).toBe(1);
  });

  it('creates concurrently for the same company without duplicates', async () => {
    const a = await actor(h, 'create3');
    const c = await a.seed();
    const results = await Promise.all([1, 2, 3].map(() => A(h).create(a.s, [c.ucId])));
    const outcomes = results.map((r) => r.json<{ results: Array<{ outcome: string; requestId: string }> }>().results[0]);
    expect(outcomes.filter((o) => o?.outcome === 'created')).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o?.requestId)).size).toBe(1);
  });

  it('answers each company separately in a batch', async () => {
    const a = await actor(h, 'batch');
    const other = await actor(h, 'batch-other');
    const ok = await a.seed();
    const noContact = await a.seed({ contact: 'none' });
    const mustKeep = await a.seed({ mustKeep: true, contact: 'none' });
    const notMine = await a.seed({ status: 'not_mine' });
    const foreign = await other.seed();
    const res = await A(h).create(a.s, [ok.ucId, noContact.ucId, mustKeep.ucId, notMine.ucId, foreign.ucId]);
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.json<{ results: Array<{ userCompanyId: string; outcome: string; reason?: string }> }>().results.map((r) => [r.userCompanyId, r]));
    expect(byId[ok.ucId]?.outcome).toBe('created');
    expect(byId[noContact.ucId]).toMatchObject({ outcome: 'blocked', reason: 'no_contact' });
    expect(byId[mustKeep.ucId]).toMatchObject({ outcome: 'blocked', reason: 'must_keep' });
    expect(byId[notMine.ucId]).toMatchObject({ outcome: 'blocked', reason: 'company_excluded' });
    expect(byId[foreign.ucId]).toMatchObject({ outcome: 'blocked', reason: 'not_found' });
  });

  it('rejects malformed input', async () => {
    const a = await actor(h, 'create4');
    expect((await A(h).create(a.s, [])).statusCode).toBe(400);
    expect((await A(h).create(a.s, ['nope'])).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/v1/requests/drafts', headers: authed(a.s), payload: { userCompanyIds: [newId('userCompany')], extra: 1 } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/v1/requests/drafts', payload: {} })).statusCode).toBe(401);
  });
});

// ---------- must_keep ----------

describe('must_keep companies', () => {
  it('refuses to create a request, explains why, and makes no deletion promise', async () => {
    const a = await actor(h, 'mk1');
    const c = await a.seed({ name: 'Google', mustKeep: true, contact: 'real' });
    const res = await A(h).create(a.s, [c.ucId]);
    const r = res.json<{ results: Array<{ outcome: string; reason: string; message: string }> }>().results[0];
    expect(r).toMatchObject({ outcome: 'blocked', reason: 'must_keep' });
    expect(r?.message).toMatch(/needed to keep your account working/);
    expect(r?.message).toMatch(/does not offer a deletion request/);
    expect(r?.message).not.toMatch(/will delete|will be deleted|guarantee|we will erase/i); // banned-words:ignore - asserts these phrases are absent
    const { rows } = await t.owner.query('SELECT 1 FROM requests WHERE user_company_id = $1', [c.ucId]);
    expect(rows).toHaveLength(0);
  });

  it('also refuses when the detected company is flagged must_keep for the user', async () => {
    const a = await actor(h, 'mk2');
    const c = await a.seed({ riskLevel: 'must_keep' });
    expect((await A(h).create(a.s, [c.ucId])).json<{ results: Array<{ reason: string }> }>().results[0]?.reason).toBe('must_keep');
  });

  it('stops approval and sending if the company became must_keep after the request was made', async () => {
    const a = await actor(h, 'mk3');
    const r = await newRequest(h, a);
    const v = await resolveMarker(h, a, r.id);
    await t.owner.query('UPDATE companies SET must_keep = true WHERE id = $1', [r.companyId]);
    const refused = await A(h).approve(a.s, r.id, v.draft.hash);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'must_keep' });

    await t.owner.query('UPDATE companies SET must_keep = false WHERE id = $1', [r.companyId]);
    expect((await A(h).approve(a.s, r.id, v.draft.hash)).statusCode).toBe(200);
    await t.owner.query('UPDATE companies SET must_keep = true WHERE id = $1', [r.companyId]);
    const send = await A(h).send(a.s, r.id, key());
    expect(send.statusCode).toBe(409);
    expect(send.json()).toMatchObject({ code: 'must_keep' });
    expect(sender.calls).toBe(0);
    expect((await requestRow(r.id))?.status).toBe('approved');
  });
});

// ---------- contacts ----------

describe('grievance contacts', () => {
  it.each([
    ['no contact at all', 'none'],
    ['an address that is not marked verified', 'unverified'],
    ['a contact that bounced', 'bounced'],
  ] as const)('blocks a draft for a company with %s, explains why, and notes it for follow-up', async (_label, contact) => {
    const a = await actor(h, `contact-${contact}`);
    const c = await a.seed({ contact });
    const r = (await A(h).create(a.s, [c.ucId])).json<{ results: Array<{ outcome: string; reason: string; message: string }> }>().results[0];
    expect(r?.outcome).toBe('blocked');
    expect(r?.reason).toBe(contact === 'bounced' ? 'contact_bounced' : 'no_contact');
    expect(r?.message).toMatch(/grievance contact/);
    const { rows } = await t.owner.query('SELECT 1 FROM audit_log WHERE action = $1 AND target_id = $2', ['company.contact_missing', c.companyId]);
    expect(rows.length).toBeGreaterThan(0);
    expect((await t.owner.query('SELECT 1 FROM requests WHERE user_company_id = $1', [c.ucId])).rows).toHaveLength(0);
  });

  it('blocks send if the contact lost its verification after the draft was made', async () => {
    const a = await actor(h, 'contact-lost');
    const r = await approved(h, a);
    await t.owner.query("UPDATE companies SET grievance_status = 'unknown' WHERE id = $1", [r.companyId]);
    const send = await A(h).send(a.s, r.id, key());
    expect(send.statusCode).toBe(409);
    expect(send.json()).toMatchObject({ code: 'no_contact' });
    expect(sender.calls).toBe(0);
  });

  it('blocks send if the contact address changed since the draft (the recipient is fixed)', async () => {
    const a = await actor(h, 'contact-changed');
    const r = await approved(h, a);
    await t.owner.query("UPDATE companies SET grievance_email = 'other@example.com' WHERE id = $1", [r.companyId]);
    const send = await A(h).send(a.s, r.id, key());
    expect(send.json()).toMatchObject({ code: 'contact_changed' });
    expect(sender.calls).toBe(0);
  });

  it('uses only @example.com for fictional companies (the database enforces it too)', async () => {
    const a = await actor(h, 'contact-fict');
    const c = await a.seed({ contact: 'fictional' });
    expect(c.contactEmail).toMatch(/@example\.com$/);
    const err = await pgError(t.owner.query("UPDATE companies SET grievance_email = 'real@brand.example' WHERE id = $1", [c.companyId]));
    expect(err.code).toBe(CHECK_VIOLATION);
  });

  it('never lets the user choose the recipient', async () => {
    const a = await actor(h, 'contact-to');
    const r = await newRequest(h, a);
    const res = await h.app.inject({ method: 'PATCH', url: `/v1/requests/${r.id}/draft`, headers: authed(a.s), payload: { baseHash: r.view.draft.hash, subject: 's', body: 'b', to: 'me@evil.example' } });
    expect(res.statusCode).toBe(400);
  });
});

// ---------- edit ----------

describe('edit', () => {
  it('creates a new version, changes the hash and records an edited event', async () => {
    const a = await actor(h, 'edit1');
    const r = await newRequest(h, a);
    const v2 = await resolveMarker(h, a, r.id);
    expect(v2.draft.version).toBe(2);
    expect(v2.draft.createdBy).toBe('user');
    expect(v2.draft.hash).not.toBe(r.view.draft.hash);
    expect(v2.draft.to).toBe(r.view.draft.to);
    expect(v2.events.map((e) => e.type)).toEqual(['drafted', 'edited']);
    expect(await draftCount(r.id)).toBe(2);
  });

  it('makes no new version when nothing changed', async () => {
    const a = await actor(h, 'edit2');
    const r = await newRequest(h, a);
    const res = await A(h).edit(a.s, r.id, r.view.draft.hash, r.view.draft.subject, r.view.draft.body);
    expect(res.statusCode).toBe(200);
    expect(await draftCount(r.id)).toBe(1);
  });

  it('refuses an edit based on an old version (no silent overwrite)', async () => {
    const a = await actor(h, 'edit3');
    const r = await newRequest(h, a);
    await resolveMarker(h, a, r.id);
    const stale = await A(h).edit(a.s, r.id, r.view.draft.hash, 'S', 'B');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'draft_changed' });
    expect((await A(h).edit(a.s, r.id, 'not-a-hash', 'S', 'B')).statusCode).toBe(400);
  });

  it('cannot edit a sent or closed request', async () => {
    const a = await actor(h, 'edit4');
    const r = await approved(h, a);
    expect((await A(h).send(a.s, r.id, key())).statusCode).toBe(200);
    const res = await A(h).edit(a.s, r.id, r.view.draft.hash, 'S', 'B');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'request_not_editable' });
  });

  it('validates the new text', async () => {
    const a = await actor(h, 'edit5');
    const r = await newRequest(h, a);
    expect((await A(h).edit(a.s, r.id, r.view.draft.hash, '', 'B')).statusCode).toBe(400);
    expect((await A(h).edit(a.s, r.id, r.view.draft.hash, 'two\nlines', 'B')).statusCode).toBe(400);
    expect((await A(h).edit(a.s, r.id, r.view.draft.hash, 'S', 'x'.repeat(20_001))).statusCode).toBe(400);
  });
});

// ---------- the approval guard ----------

describe('send needs an approval of the exact current draft', () => {
  it('refuses to send a request that was never approved, and sends nothing', async () => {
    const a = await actor(h, 'guard1');
    const r = await newRequest(h, a);
    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'approval_required' });
    expect(sender.calls).toBe(0);
    expect((await requestRow(r.id))?.status).toBe('drafted');
  });

  it('refuses even when the status was forced to approved without an approval event (application guard, not the trigger)', async () => {
    const a = await actor(h, 'guard2');
    const r = await newRequest(h, a);
    await resolveMarker(h, a, r.id);
    await t.owner.query("UPDATE requests SET status = 'approved' WHERE id = $1", [r.id]);
    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'approval_required' });
    expect(sender.calls).toBe(0);
    expect((await requestRow(r.id))?.status).toBe('approved');
  });

  it('approves, sends once, and records every step as an event', async () => {
    const a = await actor(h, 'guard3');
    const r = await approved(h, a);
    expect(r.view.approved).toBe(true);
    expect(r.view.canSend).toBe(true);
    expect(r.view.blockers).toEqual([]);

    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ request: { status: string; sentAt: string; dueAt: string }; delivery: string; notice?: string }>();
    expect(body.request.status).toBe('sent');
    expect(body.delivery).toBe('fake');
    expect(body.notice).toMatch(/No email was sent/);
    expect((Date.parse(body.request.dueAt) - Date.parse(body.request.sentAt)) / 86_400_000).toBeCloseTo(30, 3);
    expect(sender.calls).toBe(1);
    expect(sender.messages[0]).toMatchObject({ to: 'privacy@example.com', from: expect.stringContaining('@example.test') });

    const row = await requestRow(r.id);
    expect(row?.status).toBe('sent');
    expect(row?.thread_id).toMatch(/^fake-thread-/);
    const ev = await events(r.id);
    expect(ev.map((e) => e.type)).toEqual(['drafted', 'edited', 'approved', 'sent']);
    expect(ev.at(-1)).toMatchObject({ actor_type: 'user', payload: { delivery: 'fake', version: 2 } });
    expect(ev.find((e) => e.type === 'approved')?.actor_type).toBe('user');
  });

  it('needs a fresh approval after an edit: an old approval does not count (F6-AC2)', async () => {
    const a = await actor(h, 'guard4');
    const r = await approved(h, a);
    const first = r.view.draft;

    const edited = await A(h).edit(a.s, r.id, first.hash, first.subject, `${first.body}\nOne more line.`);
    expect(edited.json<View>().request.status).toBe('drafted');
    expect(edited.json<View>().approved).toBe(false);
    const stale = await A(h).send(a.s, r.id, key());
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'approval_required' });

    // Reverting to the earlier text gives the earlier hash again; it still needs a new approval.
    const reverted = (await A(h).edit(a.s, r.id, edited.json<View>().draft.hash, first.subject, first.body)).json<View>();
    expect(reverted.draft.hash).toBe(first.hash);
    expect(reverted.approved).toBe(false);
    expect((await A(h).send(a.s, r.id, key())).statusCode).toBe(409);
    expect(sender.calls).toBe(0);

    expect((await A(h).approve(a.s, r.id, reverted.draft.hash)).statusCode).toBe(200);
    expect((await A(h).send(a.s, r.id, key())).statusCode).toBe(200);
    expect(sender.calls).toBe(1);
  });

  it('refuses a stale approval even if the status is forced back to approved (application guard)', async () => {
    const a = await actor(h, 'guard5');
    const r = await approved(h, a);
    await A(h).edit(a.s, r.id, r.view.draft.hash, r.view.draft.subject, `${r.view.draft.body}\nChanged.`);
    await t.owner.query("UPDATE requests SET status = 'approved' WHERE id = $1", [r.id]);
    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'approval_required' });
    expect(sender.calls).toBe(0);
  });

  it('is backed by the database: the trigger refuses the same thing', async () => {
    const a = await actor(h, 'guard6');
    const r = await newRequest(h, a);
    const err = await pgError(t.app.query("UPDATE requests SET status = 'sent', sent_at = now(), thread_id = 'x', due_at = now() WHERE id = $1", [r.id]));
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.message).toMatch(/without a user approval/);
  });
});

// ---------- forged or mismatched hashes ----------

describe('forged or mismatched hashes', () => {
  it('refuses to approve a hash that is not the current draft', async () => {
    const a = await actor(h, 'forge1');
    const r = await newRequest(h, a);
    const wrong = await A(h).approve(a.s, r.id, hashDraft({ to: 'a', subject: 'b', body: 'c' }));
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ code: 'draft_changed' });
    expect((await A(h).approve(a.s, r.id, 'xyz')).statusCode).toBe(400);
    expect((await A(h).approve(a.s, r.id, 'A'.repeat(64))).statusCode).toBe(400);
    expect((await requestRow(r.id))?.status).toBe('drafted');
    expect((await events(r.id)).map((e) => e.type)).toEqual(['drafted']);
  });

  it('refuses to approve a hash from an older version after an edit', async () => {
    const a = await actor(h, 'forge2');
    const r = await newRequest(h, a);
    await resolveMarker(h, a, r.id);
    const res = await A(h).approve(a.s, r.id, r.view.draft.hash);
    expect(res.json()).toMatchObject({ code: 'draft_changed' });
  });

  it.each([
    ['an approval recorded by the system', 'system', 'current'],
    ['an approval recorded by an admin', 'admin', 'current'],
    ['a user approval of a different hash', 'user', 'other'],
    ['a user approval of another request\'s hash', 'user', 'foreign'],
  ] as const)('does not accept %s', async (_label, actorType, which) => {
    const a = await actor(h, `forge-${actorType}-${which}`);
    const r = await newRequest(h, a);
    const v = await resolveMarker(h, a, r.id);
    const foreign = await newRequest(h, a);
    const hash = which === 'current' ? v.draft.hash : which === 'other' ? hashDraft({ to: 'x', subject: 'y', body: 'z' }) : foreign.view.draft.hash;
    await t.app.query("INSERT INTO request_events (id, request_id, type, actor_type, draft_hash) VALUES ($1, $2, 'approved', $3, $4)", [newId('event'), r.id, actorType, hash]);
    await t.owner.query("UPDATE requests SET status = 'approved' WHERE id = $1", [r.id]);
    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'approval_required' });
    expect(sender.calls).toBe(0);
  });

  it('detects a draft row whose text does not match its hash', async () => {
    const a = await actor(h, 'forge-integrity');
    const r = await newRequest(h, a);
    const v = await resolveMarker(h, a, r.id);
    // Insert a version whose stored hash is not the hash of its text (as the owner, bypassing the service).
    await t.owner.query(
      "INSERT INTO request_drafts (id, request_id, version, to_email, subject, body, draft_hash, created_by) VALUES ($1, $2, 3, $3, 's', 'tampered body', $4, 'user')",
      [newId('draft'), r.id, v.draft.to, hashDraft({ to: v.draft.to, subject: 's', body: 'the body that was approved' })],
    );
    const latest = (await A(h).get(a.s, r.id)).json<View>();
    await t.owner.query("INSERT INTO request_events (id, request_id, type, actor_type, draft_hash) VALUES ($1, $2, 'approved', 'user', $3)", [newId('event'), r.id, latest.draft.hash]);
    await t.owner.query("UPDATE requests SET status = 'approved' WHERE id = $1", [r.id]);
    const res = await A(h).send(a.s, r.id, key());
    expect(res.json()).toMatchObject({ code: 'draft_integrity' });
    expect(sender.calls).toBe(0);
  });
});

// ---------- idempotency ----------

describe('idempotency key on send', () => {
  it('requires a well-formed key', async () => {
    const a = await actor(h, 'idem0');
    const r = await approved(h, a);
    const none = await A(h).send(a.s, r.id);
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ code: 'idempotency_key_required' });
    expect((await A(h).send(a.s, r.id, 'short')).json()).toMatchObject({ code: 'idempotency_key_invalid' });
    expect(sender.calls).toBe(0);
  });

  it('replays the stored answer for a repeated key and sends exactly once', async () => {
    const a = await actor(h, 'idem1');
    const r = await approved(h, a);
    const k = key();
    const first = await A(h).send(a.s, r.id, k);
    const again = await A(h).send(a.s, r.id, k);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(sender.calls).toBe(1);
    expect((await events(r.id)).filter((e) => e.type === 'sent')).toHaveLength(1);
  });

  it('answers 409 already_sent for a new key on a request that was sent', async () => {
    const a = await actor(h, 'idem2');
    const r = await approved(h, a);
    await A(h).send(a.s, r.id, key());
    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'already_sent' });
    expect(sender.calls).toBe(1);
  });

  it('refuses a key that was used for a different request', async () => {
    const a = await actor(h, 'idem3');
    const r1 = await approved(h, a);
    const r2 = await approved(h, a);
    const k = key();
    expect((await A(h).send(a.s, r1.id, k)).statusCode).toBe(200);
    const res = await A(h).send(a.s, r2.id, k);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'idempotency_key_reuse' });
    expect(sender.calls).toBe(1);
    expect((await requestRow(r2.id))?.status).toBe('approved');
  });

  it('sends once when the same key is replayed concurrently', async () => {
    const a = await actor(h, 'idem4');
    const r = await approved(h, a);
    const k = key();
    sender.beforeSend = () => new Promise((resolve) => setTimeout(resolve, 60));
    const results = await Promise.all([A(h).send(a.s, r.id, k), A(h).send(a.s, r.id, k), A(h).send(a.s, r.id, key())]);
    const codes = results.map((x) => x.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(sender.calls).toBe(1);
    expect((await events(r.id)).filter((e) => e.type === 'sent')).toHaveLength(1);
  });
});

// ---------- concurrent edit and send ----------

describe('concurrent edit and send', () => {
  it('never sends text other than what was approved, whichever side wins', async () => {
    const a = await actor(h, 'conc');
    const outcomes = { sendWon: 0, editWon: 0 };
    for (let i = 0; i < 10; i++) {
      const r = await approved(h, a);
      const approvedHash = r.view.draft.hash;
      sender.beforeSend = () => new Promise((resolve) => setTimeout(resolve, 20));
      const callsBefore = sender.calls;
      const jitter = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const [send, edit] = await Promise.all([
        jitter(Math.random() * 6).then(() => A(h).send(a.s, r.id, key())),
        jitter(Math.random() * 6).then(() => A(h).edit(a.s, r.id, approvedHash, r.view.draft.subject, `${r.view.draft.body}\nEdited in a race ${i}.`)),
      ]);
      const sentOk = send.statusCode === 200;
      const editOk = edit.statusCode === 200;
      expect(sentOk !== editOk, `send ${send.statusCode} / edit ${edit.statusCode}`).toBe(true); // exactly one side wins

      const row = await requestRow(r.id);
      const ev = await events(r.id);
      if (sentOk) {
        outcomes.sendWon += 1;
        expect(edit.statusCode).toBe(409);
        expect(row?.status).toBe('sent');
        expect(sender.calls - callsBefore).toBe(1);
        // The message that left is the approved text: one draft version beyond the approved one does not exist.
        expect(await draftCount(r.id)).toBe(2);
        const sentEvent = await t.owner.query<{ draft_hash: string }>("SELECT draft_hash FROM request_events WHERE request_id = $1 AND type = 'sent'", [r.id]);
        expect(sentEvent.rows[0]?.draft_hash).toBe(approvedHash);
        expect(sender.messages.at(-1)?.body).toBe(r.view.draft.body);
      } else {
        outcomes.editWon += 1;
        expect(send.statusCode).toBe(409);
        expect(['approval_required', 'send_in_progress']).toContain(send.json<{ code: string }>().code);
        expect(row?.status).toBe('drafted');
        expect(sender.calls - callsBefore).toBe(0);
        expect(ev.some((e) => e.type === 'sent')).toBe(false);
      }
    }
    expect(outcomes.sendWon + outcomes.editWon).toBe(10);
  });

  it('refuses an edit while a send is in flight, and a send after the edit lands', async () => {
    const a = await actor(h, 'conc2');
    const r = await approved(h, a);
    let release: () => void = () => undefined;
    sender.beforeSend = () => new Promise<void>((resolve) => (release = resolve));
    const sending = A(h).send(a.s, r.id, key());
    await new Promise((resolve) => setTimeout(resolve, 150)); // the send has claimed the request and is waiting on the sender
    const edit = await A(h).edit(a.s, r.id, r.view.draft.hash, r.view.draft.subject, 'Changed while sending');
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ code: 'send_in_progress' });
    const close = await A(h).close(a.s, r.id);
    expect(close.json()).toMatchObject({ code: 'send_in_progress' });
    release();
    expect((await sending).statusCode).toBe(200);
  });
});

// ---------- cross-user ----------

describe('another user cannot see or act on a request', () => {
  it('answers 404 for every route, and shows nothing in their list', async () => {
    const owner = await actor(h, 'owner');
    const other = await actor(h, 'intruder');
    const r = await approved(h, owner);
    const id = r.id;
    const hash = r.view.draft.hash;
    const k = key();

    expect((await A(h).get(other.s, id)).statusCode).toBe(404);
    expect((await A(h).edit(other.s, id, hash, 'S', 'B')).statusCode).toBe(404);
    expect((await A(h).approve(other.s, id, hash)).statusCode).toBe(404);
    expect((await A(h).send(other.s, id, k)).statusCode).toBe(404);
    expect((await A(h).close(other.s, id)).statusCode).toBe(404);
    expect((await A(h).list(other.s)).json<{ requests: unknown[] }>().requests).toEqual([]);
    expect((await A(h).list(owner.s)).json<{ requests: unknown[] }>().requests).toHaveLength(1);

    // They cannot create a request for the owner's detected company either.
    const create = await A(h).create(other.s, [r.ucId]);
    expect(create.json<{ results: Array<{ reason: string }> }>().results[0]?.reason).toBe('not_found');

    // Nothing changed and nothing was sent.
    expect((await requestRow(id))?.status).toBe('approved');
    expect(sender.calls).toBe(0);
    // The owner's request is untouched and can still be sent by the owner, and the other's key left no trace.
    expect((await A(h).send(owner.s, id, k)).statusCode).toBe(200);
  });

  it('requires a session and a CSRF token', async () => {
    const a = await actor(h, 'authz');
    const r = await approved(h, a);
    expect((await h.app.inject({ method: 'GET', url: `/v1/requests/${r.id}` })).statusCode).toBe(401);
    const noCsrf = await h.app.inject({ method: 'POST', url: `/v1/requests/${r.id}/send`, headers: { cookie: a.s.cookie, 'idempotency-key': key() } });
    expect(noCsrf.statusCode).toBe(403);
    expect(sender.calls).toBe(0);
  });
});

// ---------- the ID-number guard ----------

describe('ID-number guard (rules only)', () => {
  const first11 = '23456789012';
  const aadhaar = `${first11}${verhoeffCheckDigit(first11)}`;

  it('refuses to save a draft with a Verhoeff-valid Aadhaar number, without echoing or storing it', async () => {
    const a = await actor(h, 'safe1');
    const r = await newRequest(h, a);
    const res = await A(h).edit(a.s, r.id, r.view.draft.hash, 'Subject', `Please erase. My Aadhaar is ${aadhaar}.`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'draft_unsafe', findings: ['aadhaar'] });
    expect(res.body).not.toContain(aadhaar);
    expect(await draftCount(r.id)).toBe(1);
    const stored = await t.owner.query("SELECT 1 FROM request_drafts WHERE body LIKE '%' || $1 || '%'", [aadhaar]);
    expect(stored.rows).toHaveLength(0);
  });

  it('allows a 12-digit number that fails the checksum (an order number)', async () => {
    const a = await actor(h, 'safe2');
    const r = await newRequest(h, a);
    const bad = `${aadhaar.slice(0, 11)}${(Number(aadhaar[11]) + 1) % 10}`;
    expect((await A(h).edit(a.s, r.id, r.view.draft.hash, 'Subject', `Order ${bad} was placed.`)).statusCode).toBe(200);
  });

  it.each([
    ['PAN', 'My PAN is ABCDE1234F', 'pan'],
    ['passport', 'Passport K1234567', 'passport'],
    ['voter ID', 'EPIC ABC1234567', 'voter_id'],
    ['GSTIN', 'GSTIN 27ABCDE1234F1Z5', 'gstin'],
    ['card number', 'Card 4111 1111 1111 1111', 'card'],
  ])('refuses a draft containing a %s', async (_label, text, finding) => {
    const a = await actor(h, `safe-${finding}`);
    const r = await newRequest(h, a);
    const res = await A(h).edit(a.s, r.id, r.view.draft.hash, 'Subject', text);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ findings: string[] }>().findings).toContain(finding);
  });

  it('blocks approval while the [OPEN] placeholder is still in the text', async () => {
    const a = await actor(h, 'safe3');
    const r = await newRequest(h, a);
    const res = await A(h).approve(a.s, r.id, r.view.draft.hash);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'draft_unsafe', findings: ['open_placeholder'] });
    expect((await requestRow(r.id))?.status).toBe('drafted');
  });

  it('blocks approval and send for a draft that got an ID number some other way (checked again at each step)', async () => {
    const a = await actor(h, 'safe4');
    const r = await approved(h, a);
    // A later version containing an Aadhaar number, inserted as the owner (bypassing the service), then "approved" and forced approved.
    const text = { to: r.view.draft.to, subject: 'Subject', body: `Details ${aadhaar}` };
    const hash = hashDraft(text);
    await t.owner.query("INSERT INTO request_drafts (id, request_id, version, to_email, subject, body, draft_hash, created_by) VALUES ($1, $2, 3, $3, $4, $5, $6, 'user')", [newId('draft'), r.id, text.to, text.subject, text.body, hash]);
    const approve = await A(h).approve(a.s, r.id, hash);
    expect(approve.json()).toMatchObject({ code: 'draft_unsafe' });
    await t.owner.query("INSERT INTO request_events (id, request_id, type, actor_type, draft_hash) VALUES ($1, $2, 'approved', 'user', $3)", [newId('event'), r.id, hash]);
    const send = await A(h).send(a.s, r.id, key());
    expect(send.statusCode).toBe(422);
    expect(send.json()).toMatchObject({ code: 'draft_unsafe', findings: ['aadhaar'] });
    expect(send.body).not.toContain(aadhaar);
    expect(sender.calls).toBe(0);
  });
});

// ---------- failures from the sender ----------

describe('when the sender fails', () => {
  it('leaves the request unsent and the claim in progress when the outcome is unknown, and does not retry', async () => {
    const a = await actor(h, 'unk');
    const r = await approved(h, a);
    sender.beforeSend = () => Promise.reject(new SenderOutcomeUnknownError());
    const k = key();
    const res = await A(h).send(a.s, r.id, k);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'send_outcome_unknown' });
    expect(res.json<{ detail: string }>().detail).toMatch(/Sent folder/);
    expect((await requestRow(r.id))?.status).toBe('approved');
    expect((await events(r.id)).some((e) => e.type === 'sent')).toBe(false);
    const claim = await t.owner.query<{ status: string }>('SELECT status FROM idempotency_keys WHERE request_id = $1', [r.id]);
    expect(claim.rows.map((c) => c.status)).toEqual(['in_progress']);

    sender.beforeSend = undefined;
    const sameKey = await A(h).send(a.s, r.id, k);
    const newKey = await A(h).send(a.s, r.id, key());
    expect(sameKey.json()).toMatchObject({ code: 'send_in_progress' });
    expect(newKey.json()).toMatchObject({ code: 'send_in_progress' });
    expect(sender.calls).toBe(1);
    const edit = await A(h).edit(a.s, r.id, r.view.draft.hash, 'S', 'B');
    expect(edit.json()).toMatchObject({ code: 'send_in_progress' });
  });

  it('frees the request for another attempt when the sender definitely refused', async () => {
    const a = await actor(h, 'rej');
    const r = await approved(h, a);
    sender.beforeSend = () => Promise.reject(new SenderRejectedError());
    const k = key();
    const res = await A(h).send(a.s, r.id, k);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'send_failed' });
    expect((await requestRow(r.id))?.status).toBe('approved');
    expect((await t.owner.query<{ status: string }>('SELECT status FROM idempotency_keys WHERE request_id = $1', [r.id])).rows[0]?.status).toBe('failed');

    sender.beforeSend = undefined;
    const retry = await A(h).send(a.s, r.id, k); // the same key takes over the failed claim
    expect(retry.statusCode).toBe(200);
    expect(sender.calls).toBe(2);
    expect((await events(r.id)).filter((e) => e.type === 'sent')).toHaveLength(1);
  });

  it('allows a new key after a refused attempt', async () => {
    const a = await actor(h, 'rej2');
    const r = await approved(h, a);
    sender.beforeSend = () => Promise.reject(new SenderRejectedError());
    await A(h).send(a.s, r.id, key());
    sender.beforeSend = undefined;
    expect((await A(h).send(a.s, r.id, key())).statusCode).toBe(200);
  });

  it('refuses to send when the inbox is no longer connected', async () => {
    const a = await actor(h, 'inbox');
    const r = await approved(h, a);
    await t.owner.query("UPDATE inboxes SET status = 'disconnected', token_ciphertext = NULL, token_key_id = NULL, disconnected_at = now(), purge_after = now() + interval '30 days' WHERE id = $1", [a.inboxId]);
    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'inbox_not_connected' });
    expect(sender.calls).toBe(0);
  });
});

// ---------- close ----------

describe('close (before sending only)', () => {
  it('closes a drafted or approved request, records it, and frees the company for a new one', async () => {
    const a = await actor(h, 'close1');
    const r = await approved(h, a);
    const res = await A(h).close(a.s, r.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<View>().request.status).toBe('closed');
    expect((await events(r.id)).map((e) => e.type)).toEqual(['drafted', 'edited', 'approved', 'closed']);
    const again = (await A(h).create(a.s, [r.ucId])).json<{ results: Array<{ outcome: string; requestId: string }> }>().results[0];
    expect(again?.outcome).toBe('created');
    expect(again?.requestId).not.toBe(r.id);
  });

  it('cannot close a sent request, approve or send a closed one', async () => {
    const a = await actor(h, 'close2');
    const sent = await approved(h, a);
    await A(h).send(a.s, sent.id, key());
    expect((await A(h).close(a.s, sent.id)).json()).toMatchObject({ code: 'request_not_closable' });

    const closed = await newRequest(h, a);
    await A(h).close(a.s, closed.id);
    const approve = await A(h).approve(a.s, closed.id, closed.view.draft.hash);
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ code: 'invalid_transition' });
    const send = await A(h).send(a.s, closed.id, key());
    expect(send.statusCode).toBe(409);
    expect(sender.calls).toBe(1);
  });
});

// ---------- web-form contacts and the self-serve link ----------

describe('web-form contacts: the draft is for copy and paste, never sent by email', () => {
  const FORM = 'https://example.com/privacy/request';

  it('creates the request with a use_form outcome and the link, and shows the draft for copy and paste', async () => {
    const a = await actor(h, 'form1');
    const c = await a.seed({ contact: 'form', name: 'Forms Co' });
    const r = (await A(h).create(a.s, [c.ucId])).json<{ results: Array<{ outcome: string; requestId: string; formUrl: string; message: string }> }>().results[0];
    expect(r).toMatchObject({ outcome: 'use_form', formUrl: FORM });
    expect(r?.message).toMatch(/web form/);
    expect(r?.message).toMatch(/cannot send this by email/);

    const v = (await A(h).get(a.s, r?.requestId ?? '')).json<View & { useForm: boolean; contact: { channel: string; formUrl: string | null } }>();
    expect(v.useForm).toBe(true);
    expect(v.contact).toEqual({ channel: 'web_form', formUrl: FORM });
    expect(v.draft.to).toBe(FORM); // the form URL is the draft's destination (stored in to_email)
    expect(v.draft.hash).toBe(hashDraft({ to: FORM, subject: v.draft.subject, body: v.draft.body }));
    expect(v.draft.body).toContain('I am submitting this through your web form. Please reply to the email address above.');
    expect(v.draft.body).not.toContain('I am sending this from the email address above');
    expect(v.canSend).toBe(false);
    expect(v.blockers).toContainEqual(expect.objectContaining({ code: 'use_form', formUrl: FORM }));
    expect(v.events.map((e) => e.type)).toEqual(['drafted']);
  });

  it('returns the same request, still as use_form, when asked again, and never makes a duplicate', async () => {
    const a = await actor(h, 'form2');
    const c = await a.seed({ contact: 'form' });
    const results = await Promise.all([1, 2, 3].map(() => A(h).create(a.s, [c.ucId])));
    const outcomes = results.map((r) => r.json<{ results: Array<{ outcome: string; requestId: string }> }>().results[0]);
    expect(outcomes.every((o) => o?.outcome === 'use_form')).toBe(true);
    expect(new Set(outcomes.map((o) => o?.requestId)).size).toBe(1);
    expect((await t.owner.query('SELECT 1 FROM requests WHERE user_company_id = $1', [c.ucId])).rows).toHaveLength(1);
  });

  it('refuses to approve, answering use_form with the link, and records no approval', async () => {
    const a = await actor(h, 'form3');
    const r = await newRequest(h, a, { contact: 'form' });
    const res = await A(h).approve(a.s, r.id, r.view.draft.hash);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'use_form', formUrl: FORM });
    expect((await events(r.id)).map((e) => e.type)).toEqual(['drafted']);
    expect((await requestRow(r.id))?.status).toBe('drafted');
  });

  it('refuses to send, answering use_form with the link, without calling the sender or claiming a key', async () => {
    const a = await actor(h, 'form4');
    const r = await newRequest(h, a, { contact: 'form' });
    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'use_form', formUrl: FORM });
    expect(sender.calls).toBe(0);
    expect((await t.owner.query('SELECT 1 FROM idempotency_keys WHERE request_id = $1', [r.id])).rows).toHaveLength(0);
    expect((await requestRow(r.id))?.status).toBe('drafted');
  });

  it('refuses to send even if the request was forced to approved with a matching approval', async () => {
    const a = await actor(h, 'form5');
    const r = await newRequest(h, a, { contact: 'form' });
    const v = await resolveMarker(h, a, r.id);
    await t.owner.query("INSERT INTO request_events (id, request_id, type, actor_type, draft_hash) VALUES ($1, $2, 'approved', 'user', $3)", [newId('event'), r.id, v.draft.hash]);
    await t.owner.query("UPDATE requests SET status = 'approved' WHERE id = $1", [r.id]);
    const res = await A(h).send(a.s, r.id, key());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'use_form' });
    expect(sender.calls).toBe(0);
  });

  it('still lets the user edit the text to copy, and close the request', async () => {
    const a = await actor(h, 'form6');
    const r = await newRequest(h, a, { contact: 'form' });
    const edited = await resolveMarker(h, a, r.id);
    expect(edited.draft.version).toBe(2);
    expect(edited.draft.to).toBe(FORM);
    expect(edited.draft.body).not.toContain('[OPEN');
    const closed = await A(h).close(a.s, r.id);
    expect(closed.statusCode).toBe(200);
    expect(closed.json<View>().request.status).toBe('closed');
  });

  it('keeps the ID-number guard on the text the user will paste', async () => {
    const a = await actor(h, 'form7');
    const r = await newRequest(h, a, { contact: 'form' });
    const res = await A(h).edit(a.s, r.id, r.view.draft.hash, 'Subject', 'My PAN is ABCDE1234F');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'draft_unsafe' });
  });

  it('checks the form contact like an email contact: verified, sourced, dated, example.com only when fictional', async () => {
    const a = await actor(h, 'form8');
    const real = await a.seed({ contact: 'realform' });
    expect((await A(h).create(a.s, [real.ucId])).json<{ results: Array<{ outcome: string; formUrl: string }> }>().results[0]).toMatchObject({ outcome: 'use_form' });
    // The contact loses its verification: the request can no longer be created.
    const lost = await a.seed({ contact: 'form' });
    await t.owner.query("UPDATE companies SET grievance_status = 'unknown' WHERE id = $1", [lost.companyId]);
    const blocked = (await A(h).create(a.s, [lost.ucId])).json<{ results: Array<{ outcome: string; reason: string }> }>().results[0];
    expect(blocked).toMatchObject({ outcome: 'blocked', reason: 'no_contact' });
    const audit = await t.owner.query('SELECT 1 FROM audit_log WHERE action = $1 AND target_id = $2', ['company.contact_missing', lost.companyId]);
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('puts must_keep before the form: a must-keep company is refused outright', async () => {
    const a = await actor(h, 'form9');
    const c = await a.seed({ contact: 'form', mustKeep: true });
    const r = (await A(h).create(a.s, [c.ucId])).json<{ results: Array<{ outcome: string; reason: string }> }>().results[0];
    expect(r).toMatchObject({ outcome: 'blocked', reason: 'must_keep' });
  });

  it('blocks send if the form link changed since the draft was made', async () => {
    const a = await actor(h, 'form10');
    const r = await newRequest(h, a, { contact: 'form' });
    await t.owner.query("UPDATE companies SET grievance_form_url = 'https://example.com/privacy/new-form' WHERE id = $1", [r.companyId]);
    const v = (await A(h).get(a.s, r.id)).json<View>();
    expect(v.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['use_form', 'contact_changed']));
  });

  it('keeps email companies working in the same batch', async () => {
    const a = await actor(h, 'form11');
    const email = await a.seed({ contact: 'fictional' });
    const form = await a.seed({ contact: 'form' });
    const results = (await A(h).create(a.s, [email.ucId, form.ucId])).json<{ results: Array<{ userCompanyId: string; outcome: string }> }>().results;
    expect(Object.fromEntries(results.map((r) => [r.userCompanyId, r.outcome]))).toEqual({ [email.ucId]: 'created', [form.ucId]: 'use_form' });
    const ready = await approved(h, a); // an email company still goes all the way
    expect((await A(h).send(a.s, ready.id, key())).statusCode).toBe(200);
  });
});

describe('self-serve link', () => {
  const LINK = 'https://example.com/account/delete';
  // A company that is not fictional cannot point at example.com (the database refuses it).
  const REAL_LINK = 'https://brand-real.example/account/delete';

  it('is given in the create results and the request view, for email and form companies', async () => {
    const a = await actor(h, 'serve1');
    const email = await a.seed({ contact: 'fictional', selfServeUrl: LINK });
    const form = await a.seed({ contact: 'form', selfServeUrl: LINK });
    const results = (await A(h).create(a.s, [email.ucId, form.ucId])).json<{ results: Array<{ userCompanyId: string; outcome: string; selfServeUrl?: string; requestId: string }> }>().results;
    for (const r of results) expect(r.selfServeUrl, r.outcome).toBe(LINK);
    const view = (await A(h).get(a.s, results[0]?.requestId ?? '')).json<View & { company: { selfServeUrl: string | null } }>();
    expect(view.company.selfServeUrl).toBe(LINK);
    // Asking again still shows it.
    const again = (await A(h).create(a.s, [email.ucId])).json<{ results: Array<{ outcome: string; selfServeUrl?: string }> }>().results[0];
    expect(again).toMatchObject({ outcome: 'existing', selfServeUrl: LINK });
  });

  it('is also shown when the request is blocked for a missing contact, and left out when there is none', async () => {
    const a = await actor(h, 'serve2');
    const none = await a.seed({ contact: 'none', selfServeUrl: REAL_LINK });
    const plain = await a.seed({ contact: 'fictional' });
    const [blocked, ok] = (await A(h).create(a.s, [none.ucId, plain.ucId])).json<{ results: Array<{ outcome: string; selfServeUrl?: string }> }>().results;
    expect(blocked).toMatchObject({ outcome: 'blocked', selfServeUrl: REAL_LINK });
    expect(ok?.outcome).toBe('created');
    expect(ok).not.toHaveProperty('selfServeUrl');
  });

  it('is never offered for a must-keep company', async () => {
    const a = await actor(h, 'serve3');
    const c = await a.seed({ contact: 'none', mustKeep: true, selfServeUrl: REAL_LINK });
    const r = (await A(h).create(a.s, [c.ucId])).json<{ results: Array<{ outcome: string; reason: string }> }>().results[0];
    expect(r).toMatchObject({ outcome: 'blocked', reason: 'must_keep' });
    expect(r).not.toHaveProperty('selfServeUrl');
  });
});

// ---------- logs ----------

describe('logs carry no draft text, addresses or tokens', () => {
  it('stay clean through create, edit, approve, send and the error paths', async () => {
    const harness = await buildHarness(t, { sender: { kind: 'ready', sender: new FakeGmailSender() } });
    try {
      const a = await actor(harness, 'logs');
      const sentinel = 'SENTINEL-DRAFT-TEXT-7731';
      const first11 = '23456789012';
      const aadhaar = `${first11}${verhoeffCheckDigit(first11)}`;
      const r = await newRequest(harness, a, { name: 'Logged Shop' });

      await A(harness).edit(a.s, r.id, r.view.draft.hash, 'Subject', `Hello ${aadhaar}`); // refused, never logged
      const edited = await A(harness).edit(a.s, r.id, r.view.draft.hash, 'Subject line', `${sentinel} please erase my data.`);
      const hash = edited.json<View>().draft.hash;
      await A(harness).approve(a.s, r.id, hash);
      await A(harness).send(a.s, r.id, key());
      await A(harness).send(a.s, r.id, 'bad'); // validation error path
      await A(harness).get(a.s, r.id);

      const text = harness.logs.text();
      expect(text.length).toBeGreaterThan(0);
      for (const forbidden of [sentinel, aadhaar, 'Subject line', 'privacy@example.com', a.email, `${'logs'}-mail@example.test`, a.name, 'Logged Shop', 'please erase', 'fake-thread', 'idempotency-key', 'x-csrf-token', a.s.csrf, a.s.cookie.split('=')[1] ?? 'x']) {
        expect(text, forbidden).not.toContain(forbidden);
      }
      // What is logged: ids, codes and counts.
      expect(text).toMatch(/request sent/);
      expect(text).toMatch(/"delivery":"fake"/);
    } finally {
      await harness.app.close();
    }
  });
});

// ---------- sending mode ----------

describe('real sending is off by default', () => {
  it('is off in the default environment, and the test environment can never turn it on', async () => {
    const { loadEnv, isRealSendEnabled } = await import('../../config/env.js');
    const base = { DATABASE_URL: 'postgres://u:p@h/x', REDIS_URL: 'redis://h', AI_SERVICE_URL: 'http://h' };
    const env = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(env.ALLOW_REAL_SEND).toBe(false);
    expect(isRealSendEnabled(env)).toBe(false);
    expect(() => loadEnv({ ...base, NODE_ENV: 'test', ALLOW_REAL_SEND: 'true' })).toThrow(/ALLOW_REAL_SEND/);
  });

  it('uses the fake sender in development and test, and refuses everywhere else', async () => {
    const { loadEnv } = await import('../../config/env.js');
    const { selectSender } = await import('./sender.js');
    const base = { DATABASE_URL: 'postgres://u:p@h/x', REDIS_URL: 'redis://h', AI_SERVICE_URL: 'http://h' };
    const real: RequestSender = { mode: 'real', send: () => Promise.reject(new Error('must not be called')) };
    const prod = { NODE_ENV: 'production', TOKEN_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), AI_SERVICE_TOKEN: 'x'.repeat(20), WEB_ORIGIN: 'https://a.example', API_PUBLIC_URL: 'https://b.example' };

    const dev = selectSender(loadEnv({ ...base, NODE_ENV: 'development' }), { citationVerified: false, real: () => real });
    expect(dev.kind === 'ready' && dev.sender.mode).toBe('fake');
    const tst = selectSender(loadEnv({ ...base, NODE_ENV: 'test' }), { citationVerified: true, real: () => real });
    expect(tst.kind === 'ready' && tst.sender.mode).toBe('fake');

    const production = selectSender(loadEnv({ ...base, ...prod }), { citationVerified: true, real: () => real });
    expect(production).toMatchObject({ kind: 'unavailable', code: 'send_disabled' });
  });

  it('keeps real sending blocked until the citation is verified, even with the flag on (no fallback to the fake)', async () => {
    const { loadEnv } = await import('../../config/env.js');
    const { selectSender } = await import('./sender.js');
    const base = { DATABASE_URL: 'postgres://u:p@h/x', REDIS_URL: 'redis://h', AI_SERVICE_URL: 'http://h', ALLOW_REAL_SEND: 'true', REAL_SEND_DAILY_CAP: '3' };
    const real: RequestSender = { mode: 'real', send: () => Promise.reject(new Error('must not be called')) };
    const devOn = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(selectSender(devOn, { citationVerified: false, real: () => real })).toMatchObject({ kind: 'unavailable', code: 'real_send_blocked' });
    const verified = selectSender(devOn, { citationVerified: true, real: () => real });
    expect(verified.kind === 'ready' && verified.sender.mode).toBe('real');
    // The shipped constant is unverified, so with the shipped code the second case cannot happen yet.
    const { STATUTE_CITATION } = await import('./draft-citation.js');
    expect(STATUTE_CITATION.verified).toBe(false);
  });

  it('answers 503 and sends nothing when sending is unavailable, and says so on the request', async () => {
    const blocked = await buildHarness(t, { sender: { kind: 'unavailable', code: 'real_send_blocked', detail: 'Real sending stays off until the statute citation in the draft template has been verified.' } });
    try {
      const a = await actor(blocked, 'blocked');
      const r = await approved(blocked, a);
      expect(r.view.canSend).toBe(false);
      expect(r.view.blockers.map((b) => b.code)).toContain('real_send_blocked');
      const res = await A(blocked).send(a.s, r.id, key());
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'real_send_blocked' });
      expect((await requestRow(r.id))?.status).toBe('approved');
    } finally {
      await blocked.app.close();
    }
  });
});

describe('real mode (with a stubbed real sender; nothing leaves the machine)', () => {
  const realSender = () => {
    const calls: number[] = [];
    const s: RequestSender = {
      mode: 'real',
      send: () => {
        calls.push(1);
        return Promise.resolve({ threadId: `thr-${calls.length}`, messageId: `msg-${calls.length}`, delivery: 'real' as const });
      },
    };
    return { s, calls };
  };

  it('refuses a fictional company, labels a real send as real, and enforces the daily cap', async () => {
    const { s: stub, calls } = realSender();
    const harness = await buildHarness(t, { sender: { kind: 'ready', sender: stub }, envOverrides: { REAL_SEND_DAILY_CAP: '1' } });
    try {
      const a = await actor(harness, 'real1');

      const sample = await approved(harness, a, { contact: 'fictional' });
      const refused = await A(harness).send(a.s, sample.id, key());
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'fictional_company' });

      const one = await approved(harness, a, { contact: 'real' });
      const ok = await A(harness).send(a.s, one.id, key());
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ delivery: 'real' });
      expect(ok.json()).not.toHaveProperty('notice');
      expect((await events(one.id)).at(-1)?.payload).toMatchObject({ delivery: 'real' });

      const two = await approved(harness, a, { contact: 'real' });
      const capped = await A(harness).send(a.s, two.id, key());
      expect(capped.statusCode).toBe(429);
      expect(capped.json()).toMatchObject({ code: 'daily_cap_reached' });
      expect(calls).toHaveLength(1);
    } finally {
      await harness.app.close();
    }
  });

  it('does not count fake sends against the cap', async () => {
    const harness = await buildHarness(t, { sender: { kind: 'ready', sender: new FakeGmailSender() }, envOverrides: { REAL_SEND_DAILY_CAP: '1' } });
    try {
      const a = await actor(harness, 'real2');
      for (let i = 0; i < 3; i++) {
        const r = await approved(harness, a);
        expect((await A(harness).send(a.s, r.id, key())).statusCode).toBe(200);
      }
    } finally {
      await harness.app.close();
    }
  });
});

// ---------- read ----------

describe('read', () => {
  it('lists requests newest first with the company name, and shows the full detail', async () => {
    const a = await actor(h, 'read1');
    const r1 = await newRequest(h, a, { name: 'First Shop' });
    const r2 = await newRequest(h, a, { name: 'Second Shop' });
    const list = (await A(h).list(a.s)).json<{ requests: Array<{ id: string; company: { name: string }; status: string }> }>().requests;
    expect(list.map((x) => x.id)).toEqual([r2.id, r1.id]);
    expect(list[0]?.company.name).toBe('Second Shop');
    const detail = (await A(h).get(a.s, r1.id)).json<View>();
    expect(detail.company).toMatchObject({ name: 'First Shop', mustKeep: false });
    expect((await A(h).get(a.s, 'req_NOTANID')).statusCode).toBe(400);
    expect((await A(h).get(a.s, newId('request'))).statusCode).toBe(404);
  });
});
