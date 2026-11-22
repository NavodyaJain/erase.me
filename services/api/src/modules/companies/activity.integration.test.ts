import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorFactory } from '../../../test/actors.js';
import { createTestDb, type TestDb } from '../../../test/db-helper.js';
import { authed, buildHarness, type FakeMessage, type Harness } from '../../../test/harness.js';

let t: TestDb;
let h: Harness;
const actor = actorFactory(() => t);

beforeAll(async () => {
  t = await createTestDb();
  h = await buildHarness(t);
});
afterAll(async () => {
  await h.app.close();
  await t.drop();
});

const DAY = 24 * 60 * 60 * 1000;
/** The harness clock is fixed, so "N days ago" is exact. */
const daysAgo = (n: number, harness: Harness = h): Date => new Date(harness.clock.now.getTime() - n * DAY);

interface Item {
  id: string;
  company: string;
  activity: 'looks_in_use' | 'looks_unused' | null;
}
const list = async (harness: Harness, cookie: string) =>
  (await harness.app.inject({ method: 'GET', url: '/v1/companies', headers: { cookie } })).json<{ companies: Item[] }>().companies;

const mail = (id: string, from: string, subject: string, at: Date, o: Partial<FakeMessage> = {}): FakeMessage => ({ id, receivedAt: at, from, subject, ...o });

async function scan(harness: Harness, a: { s: { cookie: string; csrf: string; userId: string }; inboxId: string }, messages: FakeMessage[]) {
  harness.gmail.messages = messages;
  const res = await harness.app.inject({ method: 'POST', url: `/v1/inboxes/${a.inboxId}/scan`, headers: authed(a.s as never) });
  expect(res.statusCode).toBe(202);
  await harness.queue.drain();
}

const lastTransactional = async (userId: string, domain: string) =>
  (
    await t.owner.query<{ last_transactional_at: Date | null; last_seen: Date }>(
      'SELECT uc.last_transactional_at, uc.last_seen FROM user_companies uc JOIN companies c ON c.id = uc.company_id WHERE uc.user_id = $1 AND $2 = ANY(c.domains)',
      [userId, domain],
    )
  ).rows[0];

describe('the scan records the date of the latest receipt or transactional message', () => {
  it('uses receipts and order mail, not newsletters, and never moves the date backwards', async () => {
    const a = await actor(h, 'act1');
    await scan(h, a, [
      mail('1', 'hi@shop-a.example', 'Your receipt', new Date('2025-03-01T00:00:00Z')),
      mail('2', 'orders@shop-a.example', 'Thanks', new Date('2025-09-09T00:00:00Z')),
      mail('3', 'news@shop-a.example', 'Big sale', new Date('2026-01-01T00:00:00Z'), { listUnsubscribe: true }),
      mail('4', 'news@shop-b.example', 'Big sale', new Date('2026-02-01T00:00:00Z'), { listUnsubscribe: true }),
    ]);
    const shopA = await lastTransactional(a.s.userId, 'shop-a.example');
    expect(shopA?.last_transactional_at?.toISOString()).toBe('2025-09-09T00:00:00.000Z');
    expect(shopA?.last_seen.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((await lastTransactional(a.s.userId, 'shop-b.example'))?.last_transactional_at).toBeNull();

    // A rescan that sees only a newsletter keeps the date; a newer receipt moves it forward.
    await scan(h, a, [mail('5', 'news@shop-a.example', 'Big sale', new Date('2026-05-01T00:00:00Z'), { listUnsubscribe: true })]);
    expect((await lastTransactional(a.s.userId, 'shop-a.example'))?.last_transactional_at?.toISOString()).toBe('2025-09-09T00:00:00.000Z');
    await scan(h, a, [mail('6', 'hi@shop-a.example', 'Your invoice', new Date('2026-06-01T00:00:00Z'))]);
    expect((await lastTransactional(a.s.userId, 'shop-a.example'))?.last_transactional_at?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('GET /v1/companies shows the activity hint', () => {
  it('looks in use with a receipt in the last 90 days, looks unused after a year of silence, otherwise none', async () => {
    const a = await actor(h, 'act2');
    const inUse = await a.seed({ name: 'In Use Co', lastSeen: daysAgo(3), lastTransactionalAt: daysAgo(10) });
    const edgeIn = await a.seed({ name: 'Edge In', lastSeen: daysAgo(90), lastTransactionalAt: daysAgo(90) });
    const edgeOut = await a.seed({ name: 'Edge Out', lastSeen: daysAgo(91), lastTransactionalAt: daysAgo(91) });
    const unused = await a.seed({ name: 'Unused Co', lastSeen: daysAgo(400), lastTransactionalAt: daysAgo(500) });
    const unusedEdge = await a.seed({ name: 'Unused Edge', lastSeen: daysAgo(366) });
    const newsletter = await a.seed({ name: 'Newsletter Co', lastSeen: daysAgo(2), signals: ['newsletter', 'list_unsubscribe'] });
    const oldReceipt = await a.seed({ name: 'Old Receipt Co', lastSeen: daysAgo(5), lastTransactionalAt: daysAgo(200) });
    const notRescanned = await a.seed({ name: 'Not Rescanned Co', lastSeen: daysAgo(5) });
    const quiet = await a.seed({ name: 'Quiet Co', lastSeen: daysAgo(365) });

    const byId = Object.fromEntries((await list(h, a.s.cookie)).map((c) => [c.id, c.activity]));
    expect(byId[inUse.ucId]).toBe('looks_in_use');
    expect(byId[edgeIn.ucId]).toBe('looks_in_use');
    expect(byId[edgeOut.ucId]).toBeNull();
    expect(byId[unused.ucId]).toBe('looks_unused');
    expect(byId[unusedEdge.ucId]).toBe('looks_unused');
    expect(byId[newsletter.ucId]).toBeNull();
    expect(byId[oldReceipt.ucId]).toBeNull();
    expect(byId[notRescanned.ucId]).toBeNull(); // no "in use" hint until a rescan records a receipt date
    expect(byId[quiet.ucId]).toBeNull();
  });

  it('follows the configured thresholds', async () => {
    const tuned = await buildHarness(t, { envOverrides: { ACTIVITY_RECENT_DAYS: '30', ACTIVITY_OLD_DAYS: '60' } });
    try {
      const a = await actor(tuned, 'act3');
      const recent = await a.seed({ lastSeen: daysAgo(2, tuned), lastTransactionalAt: daysAgo(30, tuned) });
      const lapsed = await a.seed({ lastSeen: daysAgo(31, tuned), lastTransactionalAt: daysAgo(31, tuned) });
      const old = await a.seed({ lastSeen: daysAgo(61, tuned) });
      const byId = Object.fromEntries((await list(tuned, a.s.cookie)).map((c) => [c.id, c.activity]));
      expect(byId[recent.ucId]).toBe('looks_in_use');
      expect(byId[lapsed.ucId]).toBeNull();
      expect(byId[old.ucId]).toBe('looks_unused');
    } finally {
      await tuned.app.close();
    }
  });

  it('is a hint only: it changes nothing about what a user can do with the company', async () => {
    const a = await actor(h, 'act4');
    const unused = await a.seed({ lastSeen: daysAgo(500) });
    const inUse = await a.seed({ lastSeen: daysAgo(1), lastTransactionalAt: daysAgo(1) });
    const res = await h.app.inject({ method: 'POST', url: '/v1/requests/drafts', headers: authed(a.s), payload: { userCompanyIds: [unused.ucId, inUse.ucId] } });
    expect(res.json<{ results: Array<{ outcome: string }> }>().results.map((r) => r.outcome)).toEqual(['created', 'created']);
  });

  it('is not shown for a company hidden from the list, and carries no message text', async () => {
    const a = await actor(h, 'act5');
    await a.seed({ name: 'Hidden', domainOverride: 'sendgrid.net', lastSeen: daysAgo(500) });
    const shown = await a.seed({ name: 'Shown', lastSeen: daysAgo(500) });
    const res = await h.app.inject({ method: 'GET', url: '/v1/companies', headers: { cookie: a.s.cookie } });
    expect(res.json<{ companies: Item[] }>().companies.map((c) => c.id)).toEqual([shown.ucId]);
    expect(Object.keys(res.json<{ companies: Item[] }>().companies[0] ?? {}).sort()).toEqual(
      ['activity', 'category', 'company', 'confidence', 'domain', 'firstSeen', 'id', 'kept', 'lastSeen', 'mustKeep', 'openRequest', 'selfServeUrl', 'signals'],
    );
  });
});
