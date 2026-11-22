import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actorFactory, type Actor, type SeedOptions } from '../../../test/actors.js';
import { createTestDb, type TestDb } from '../../../test/db-helper.js';
import { authed, buildHarness, type Harness, type Session } from '../../../test/harness.js';
import { newId } from '../../common/ids.js';
import { FakeGmailSender } from '../requests/sender.js';

let t: TestDb;
let h: Harness;
const sender = new FakeGmailSender();
const actor = actorFactory(() => t);

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
});

// ---------- helpers ----------

interface Item {
  id: string;
  company: string;
  kept: boolean;
  mustKeep: boolean;
  confidence: string;
  signals: string[];
  selfServeUrl: string | null;
  openRequest: { id: string; status: string } | null;
}
interface View {
  request: { id: string; status: string };
  company: { kept: boolean };
  draft: { hash: string; subject: string; body: string };
  approved: boolean;
  canSend: boolean;
  blockers: Array<{ code: string; message: string }>;
}

const keep = (s: Session, id: string) => h.app.inject({ method: 'PUT', url: `/v1/companies/${id}/keep`, headers: authed(s) });
const unkeep = (s: Session, id: string) => h.app.inject({ method: 'DELETE', url: `/v1/companies/${id}/keep`, headers: authed(s) });
const list = async (s: Session) => (await h.app.inject({ method: 'GET', url: '/v1/companies', headers: { cookie: s.cookie } })).json<{ companies: Item[] }>().companies;
const create = (s: Session, ids: string[]) => h.app.inject({ method: 'POST', url: '/v1/requests/drafts', headers: authed(s), payload: { userCompanyIds: ids } });
const get = (s: Session, id: string) => h.app.inject({ method: 'GET', url: `/v1/requests/${id}`, headers: { cookie: s.cookie } });
const edit = (s: Session, id: string, baseHash: string, subject: string, body: string) =>
  h.app.inject({ method: 'PATCH', url: `/v1/requests/${id}/draft`, headers: authed(s), payload: { baseHash, subject, body } });
const approve = (s: Session, id: string, draftHash: string) => h.app.inject({ method: 'POST', url: `/v1/requests/${id}/approve`, headers: authed(s), payload: { draftHash } });
const send = (s: Session, id: string, key: string) => h.app.inject({ method: 'POST', url: `/v1/requests/${id}/send`, headers: { ...authed(s), 'idempotency-key': key } });
const close = (s: Session, id: string) => h.app.inject({ method: 'POST', url: `/v1/requests/${id}/close`, headers: authed(s) });
const key = () => `key-${randomBytes(8).toString('hex')}`;
const audit = async (targetId: string) =>
  (await t.owner.query<{ action: string; actor_id: string }>('SELECT action, actor_id FROM audit_log WHERE target_id = $1 ORDER BY at, id', [targetId])).rows;

/** A request for a new company, edited so it can be approved (the [OPEN] marker removed). */
async function request(a: Actor, o: SeedOptions = {}) {
  const c = await a.seed(o);
  const res = (await create(a.s, [c.ucId])).json<{ results: Array<{ requestId: string }> }>().results[0];
  const id = res?.requestId ?? '';
  const v = (await get(a.s, id)).json<View>();
  const body = v.draft.body.split('\n').filter((l) => !l.startsWith('[OPEN')).join('\n');
  const edited = (await edit(a.s, id, v.draft.hash, v.draft.subject, body)).json<View>();
  return { ...c, id, hash: edited.draft.hash };
}

// ---------- the list ----------

describe('GET /v1/companies', () => {
  it('lists the user\'s detected companies with what the UI needs, and nothing hidden', async () => {
    const a = await actor(h, 'list1');
    const shown = await a.seed({ name: 'Shown Co', signals: ['welcome', 'list_unsubscribe'], selfServeUrl: undefined });
    await a.seed({ name: 'Gone Co', status: 'not_mine' });
    const items = await list(a.s);
    expect(items.map((i) => i.id)).toEqual([shown.ucId]);
    expect(items[0]).toMatchObject({
      company: 'Shown Co',
      kept: false,
      mustKeep: false,
      confidence: 'high',
      signals: ['list_unsubscribe', 'welcome'],
      selfServeUrl: null,
      openRequest: null,
    });
  });

  it('shows a company\'s open request', async () => {
    const a = await actor(h, 'list2');
    const r = await request(a);
    const [item] = await list(a.s);
    expect(item?.openRequest).toEqual({ id: r.id, status: 'drafted' });
  });

  it('shows only the signed-in user\'s companies, and needs a session', async () => {
    const a = await actor(h, 'list3');
    const b = await actor(h, 'list4');
    await a.seed({ name: 'Only A' });
    expect(await list(b.s)).toEqual([]);
    expect((await h.app.inject({ method: 'GET', url: '/v1/companies' })).statusCode).toBe(401);
  });
});

// ---------- set and clear ----------

describe('keep: set and clear', () => {
  it('sets it, shows it in the list, and clears it', async () => {
    const a = await actor(h, 'keep1');
    const c = await a.seed();
    const set = await keep(a.s, c.ucId);
    expect(set.statusCode).toBe(200);
    expect(set.json<{ company: Item }>().company).toMatchObject({ id: c.ucId, kept: true });
    expect((await list(a.s))[0]?.kept).toBe(true);

    const cleared = await unkeep(a.s, c.ucId);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ company: Item }>().company.kept).toBe(false);
    expect((await list(a.s))[0]?.kept).toBe(false);
  });

  it('is idempotent, and records an audit entry only when something changed', async () => {
    const a = await actor(h, 'keep2');
    const c = await a.seed();
    await keep(a.s, c.ucId);
    await keep(a.s, c.ucId);
    await unkeep(a.s, c.ucId);
    await unkeep(a.s, c.ucId);
    expect(await audit(c.ucId)).toEqual([
      { action: 'company.keep_set', actor_id: a.s.userId },
      { action: 'company.keep_cleared', actor_id: a.s.userId },
    ]);
  });

  it('keeps the original time when set again', async () => {
    const a = await actor(h, 'keep3');
    const c = await a.seed();
    await keep(a.s, c.ucId);
    const first = (await t.owner.query<{ kept_at: Date }>('SELECT kept_at FROM user_companies WHERE id = $1', [c.ucId])).rows[0]?.kept_at;
    await keep(a.s, c.ucId);
    const second = (await t.owner.query<{ kept_at: Date }>('SELECT kept_at FROM user_companies WHERE id = $1', [c.ucId])).rows[0]?.kept_at;
    expect(second).toEqual(first);
  });

  it('refuses another user\'s company for both set and clear, and leaves it untouched', async () => {
    const owner = await actor(h, 'keep4');
    const other = await actor(h, 'keep5');
    const c = await owner.seed();
    await keep(owner.s, c.ucId);
    expect((await keep(other.s, c.ucId)).statusCode).toBe(404);
    expect((await unkeep(other.s, c.ucId)).statusCode).toBe(404);
    expect((await list(owner.s))[0]?.kept).toBe(true);
    expect((await list(other.s))).toEqual([]);
    expect((await audit(c.ucId)).map((e) => e.actor_id)).toEqual([owner.s.userId]);
  });

  it('answers 409 must_keep for a must-keep company and 409 company_excluded for one marked not mine', async () => {
    const a = await actor(h, 'keep6');
    const must = await a.seed({ mustKeep: true, contact: 'none' });
    const gone = await a.seed({ status: 'not_mine' });
    const m = await keep(a.s, must.ucId);
    expect(m.statusCode).toBe(409);
    expect(m.json()).toMatchObject({ code: 'must_keep' });
    expect(m.json<{ detail: string }>().detail).not.toMatch(/will delete|guarantee/i); // banned-words:ignore - asserts the phrase is absent
    const g = await keep(a.s, gone.ucId);
    expect(g.statusCode).toBe(409);
    expect(g.json()).toMatchObject({ code: 'company_excluded' });
    expect((await unkeep(a.s, gone.ucId)).json()).toMatchObject({ code: 'company_excluded' });
  });

  it('treats a company hidden from the list (a delivery service) as missing', async () => {
    const a = await actor(h, 'keep7');
    const ghost = await a.seed({ domainOverride: 'elasticemail.com' });
    expect((await keep(a.s, ghost.ucId)).statusCode).toBe(404);
  });

  it('validates the id and needs a session and the CSRF token', async () => {
    const a = await actor(h, 'keep8');
    const c = await a.seed();
    expect((await keep(a.s, 'nope')).statusCode).toBe(400);
    expect((await keep(a.s, newId('userCompany'))).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'PUT', url: `/v1/companies/${c.ucId}/keep` })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'PUT', url: `/v1/companies/${c.ucId}/keep`, headers: { cookie: a.s.cookie } })).statusCode).toBe(403);
    expect((await list(a.s))[0]?.kept).toBe(false);
  });
});

// ---------- requests for a kept company ----------

describe('a kept company is not offered for requests', () => {
  it('answers outcome kept at create, makes no request, and says why', async () => {
    const a = await actor(h, 'kreq1');
    const c = await a.seed({ name: 'Kept Co' });
    await keep(a.s, c.ucId);
    const r = (await create(a.s, [c.ucId])).json<{ results: Array<{ outcome: string; message: string; requestId?: string }> }>().results[0];
    expect(r?.outcome).toBe('kept');
    expect(r?.message).toMatch(/You chose to keep Kept Co/);
    expect(r?.message).toMatch(/Undo "keep"/);
    expect(r?.message).not.toMatch(/will delete|guarantee/i); // banned-words:ignore - asserts the phrase is absent
    expect(r).not.toHaveProperty('requestId');
    expect((await t.owner.query('SELECT 1 FROM requests WHERE user_company_id = $1', [c.ucId])).rows).toHaveLength(0);
  });

  it('answers each company separately in a batch, and works again once cleared', async () => {
    const a = await actor(h, 'kreq2');
    const kept = await a.seed();
    const fine = await a.seed();
    await keep(a.s, kept.ucId);
    const results = (await create(a.s, [kept.ucId, fine.ucId])).json<{ results: Array<{ userCompanyId: string; outcome: string }> }>().results;
    expect(Object.fromEntries(results.map((r) => [r.userCompanyId, r.outcome]))).toEqual({ [kept.ucId]: 'kept', [fine.ucId]: 'created' });
    await unkeep(a.s, kept.ucId);
    expect((await create(a.s, [kept.ucId])).json<{ results: Array<{ outcome: string }> }>().results[0]?.outcome).toBe('created');
  });

  it('puts must_keep before kept: a must-keep company is still refused as must_keep', async () => {
    const a = await actor(h, 'kreq3');
    const c = await a.seed({ mustKeep: true, contact: 'none' });
    await t.owner.query('UPDATE user_companies SET kept_at = now() WHERE id = $1', [c.ucId]);
    expect((await create(a.s, [c.ucId])).json<{ results: Array<{ outcome: string; reason: string }> }>().results[0]).toMatchObject({ outcome: 'blocked', reason: 'must_keep' });
  });
});

describe('a request in progress is refused at approve and send once the company is kept', () => {
  it('refuses to approve a drafted request with 409 kept, and lets it go on once cleared', async () => {
    const a = await actor(h, 'kapp1');
    const r = await request(a);
    await keep(a.s, r.ucId);

    const view = (await get(a.s, r.id)).json<View>();
    expect(view.company.kept).toBe(true);
    expect(view.canSend).toBe(false);
    expect(view.blockers.map((b) => b.code)).toContain('kept');

    const refused = await approve(a.s, r.id, r.hash);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'kept' });
    expect(refused.json<{ detail: string }>().detail).toMatch(/Undo "keep"/);
    const status = (await t.owner.query<{ status: string }>('SELECT status FROM requests WHERE id = $1', [r.id])).rows[0]?.status;
    expect(status).toBe('drafted');
    expect((await t.owner.query("SELECT 1 FROM request_events WHERE request_id = $1 AND type = 'approved'", [r.id])).rows).toHaveLength(0);

    await unkeep(a.s, r.ucId);
    expect((await approve(a.s, r.id, r.hash)).statusCode).toBe(200);
  });

  it('refuses to send an approved request with 409 kept, without calling the sender, and sends once cleared', async () => {
    const a = await actor(h, 'ksend1');
    const r = await request(a);
    expect((await approve(a.s, r.id, r.hash)).statusCode).toBe(200);
    await keep(a.s, r.ucId);

    const refused = await send(a.s, r.id, key());
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'kept' });
    expect(sender.calls).toBe(0);
    expect((await t.owner.query<{ status: string }>('SELECT status FROM requests WHERE id = $1', [r.id])).rows[0]?.status).toBe('approved');
    expect((await t.owner.query('SELECT 1 FROM idempotency_keys WHERE request_id = $1', [r.id])).rows).toHaveLength(0);

    await unkeep(a.s, r.ucId);
    const sent = await send(a.s, r.id, key());
    expect(sent.statusCode).toBe(200);
    expect(sender.calls).toBe(1);
  });

  it('still lets the user edit and close the request while the company is kept', async () => {
    const a = await actor(h, 'kedit1');
    const r = await request(a);
    await keep(a.s, r.ucId);
    const edited = await edit(a.s, r.id, r.hash, 'A subject', 'A new body of text.');
    expect(edited.statusCode).toBe(200);
    const closed = await close(a.s, r.id);
    expect(closed.statusCode).toBe(200);
    expect(closed.json<View>().request.status).toBe('closed');
  });

  it('leaves an already sent request alone, and a replayed send key still returns its result', async () => {
    const a = await actor(h, 'ksent1');
    const r = await request(a);
    await approve(a.s, r.id, r.hash);
    const k = key();
    const first = await send(a.s, r.id, k);
    expect(first.statusCode).toBe(200);

    await keep(a.s, r.ucId);
    const view = (await get(a.s, r.id)).json<View>();
    expect(view.request.status).toBe('sent');
    const replay = await send(a.s, r.id, k);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(sender.calls).toBe(1);
    // A new key is refused because it is already sent, not because it is kept.
    expect((await send(a.s, r.id, key())).json()).toMatchObject({ code: 'already_sent' });
  });

  it('leaves another user\'s requests unaffected by this user\'s keep', async () => {
    const a = await actor(h, 'kiso1');
    const b = await actor(h, 'kiso2');
    const ra = await request(a);
    const rb = await request(b);
    await keep(a.s, ra.ucId);
    expect((await approve(b.s, rb.id, rb.hash)).statusCode).toBe(200);
    expect((await approve(a.s, ra.id, ra.hash)).statusCode).toBe(409);
  });
});
