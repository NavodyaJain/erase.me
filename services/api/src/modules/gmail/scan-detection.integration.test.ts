import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, buildHarness, connectInbox, signIn, type FakeMessage, type Harness } from '../../../test/harness.js';
import { createTestDb, type TestDb } from '../../../test/db-helper.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Db } from '../../db/client.js';
import * as schema from '../../db/schema/index.js';
import { newId } from '../../common/ids.js';
import { loadCatalog } from '../companies/catalog.js';
import { createCompaniesRepository } from '../companies/companies.repository.js';
import { buildScanQuery, SCAN_QUERY } from './scan.service.js';

let t: TestDb;
let h: Harness;
beforeAll(async () => {
  t = await createTestDb();
  // The catalog is synced at start-up in the real server; do the same here.
  await createCompaniesRepository(drizzle(t.app, { schema }) as unknown as Db).syncCatalog(loadCatalog({ includeFictional: true }));
  h = await buildHarness(t);
});
afterAll(async () => {
  await h.app.close();
  await t.drop();
});

const msg = (id: string, from: string, subject: string, over: Partial<FakeMessage> = {}): FakeMessage => ({
  id,
  receivedAt: new Date('2025-03-01T00:00:00Z'),
  from,
  subject,
  ...over,
});

async function scanWith(harness: Harness, who: string, messages: FakeMessage[], inboxEmail = `${who}-mail@example.test`) {
  const s = await signIn(harness, { email: `${who}@example.test`, sub: `g-${who}` });
  const { inboxId } = await connectInbox(harness, s, { email: inboxEmail, sub: `g-${who}-mail` });
  harness.gmail.messages = messages;
  const res = await harness.app.inject({ method: 'POST', url: `/v1/inboxes/${inboxId}/scan`, headers: authed(s) });
  expect(res.statusCode).toBe(202);
  await harness.queue.drain();
  const { rows } = await t.owner.query<{ name: string; domain: string; signals: string[]; risk_level: string | null; must_keep: boolean }>(
    `SELECT c.name, c.domains[1] AS domain, uc.signal_types AS signals, uc.risk_level, c.must_keep
       FROM user_companies uc JOIN companies c ON c.id = uc.company_id WHERE uc.user_id = $1 ORDER BY 2`,
    [s.userId],
  );
  return { s, inboxId, rows };
}

describe('display names (item 2)', () => {
  it('uses the catalog name, and a cleaned domain name for unknown domains', async () => {
    const { rows } = await scanWith(h, 'names', [
      msg('a', 'hi@mail.sampleshop.example', 'Your order confirmation'),
      msg('b', 'hi@happnmail.com', 'Welcome to the app'),
      msg('c', 'hi@cool-things.example', 'Welcome'),
    ]);
    expect(Object.fromEntries(rows.map((r) => [r.domain, r.name]))).toEqual({
      'cool-things.example': 'Cool Things',
      'happn.com': 'Happn',
      'sampleshop.example': 'Sample Shop',
    });
  });
});

describe('email-delivery services (item 3)', () => {
  it('attributes to the brand in Reply-To or List-Unsubscribe, and records no delivery service as a company', async () => {
    const { rows } = await scanWith(h, 'esp', [
      msg('1', '"Brand" <b1@em.sendgrid.net>', 'Welcome aboard', { replyTo: 'help@viasendgrid.example' }),
      msg('2', 'x@mail.elasticemail.com', 'Welcome', { unsubscribeHosts: ['list.viaunsub.example', 'x.elasticemail.com'], listUnsubscribe: true }),
      msg('3', 'x@amazonses.com', 'Welcome'),
      msg('4', 'x@mailgun.org', 'Welcome', { replyTo: 'noone@gmail.com' }),
      msg('5', 'x@rsgsv.net', 'Your receipt', { unsubscribeHosts: ['x.mailchimp.com'], listUnsubscribe: true }),
    ]);
    expect(rows.map((r) => r.domain)).toEqual(['viasendgrid.example', 'viaunsub.example']);
    const { rows: all } = await t.owner.query<{ domains: string[] }>('SELECT domains FROM companies');
    const flat = all.flatMap((r) => r.domains);
    for (const esp of ['sendgrid.net', 'elasticemail.com', 'amazonses.com', 'mailgun.org', 'rsgsv.net', 'mailchimp.com']) {
      expect(flat, esp).not.toContain(esp);
    }
  });
});

describe('own and employer senders (item 4)', () => {
  it("leaves out the user's own addresses and a custom-domain inbox's domain", async () => {
    const { rows } = await scanWith(
      h,
      'own',
      [
        msg('1', 'own@example.test', 'Welcome'), // the sign-in address
        msg('2', 'own-mail@myfirm.example', 'Welcome'), // the inbox address
        msg('3', 'hr@mail.myfirm.example', 'Welcome'), // same custom domain
        msg('4', 'hi@realbrand.example', 'Welcome'),
      ],
      'own-mail@myfirm.example',
    );
    expect(rows.map((r) => r.domain)).toEqual(['realbrand.example']);
  });

  it('leaves out configured employer domains (SCAN_EXCLUDE)', async () => {
    const withEmployer = await buildHarness(t, { envOverrides: { SCAN_EXCLUDE: 'employer.example, boss@personal.example' } });
    try {
      const { rows } = await scanWith(withEmployer, 'emp', [
        msg('1', 'it@corp.employer.example', 'Welcome'),
        msg('2', 'boss@personal.example', 'Welcome'),
        msg('3', 'other@personal.example', 'Welcome'),
        msg('4', 'hi@realbrand2.example', 'Welcome'),
      ]);
      expect(rows.map((r) => r.domain)).toEqual(['personal.example', 'realbrand2.example']);
    } finally {
      await withEmployer.app.close();
    }
  });
});

describe('must keep (item 5)', () => {
  it('flags the account provider and gives it no deletion path', async () => {
    const { rows } = await scanWith(h, 'mk', [msg('1', 'no-reply@accounts.google.com', 'Welcome to your account'), msg('2', 'hi@realbrand3.example', 'Welcome')]);
    const google = rows.find((r) => r.domain === 'google.com');
    expect(google).toMatchObject({ name: 'Google', must_keep: true, risk_level: 'must_keep' });
    expect(rows.find((r) => r.domain === 'realbrand3.example')).toMatchObject({ must_keep: false, risk_level: null });
  });

  it('has no grievance contact for a must-keep company, so a draft cannot be addressed', async () => {
    const { rows } = await t.owner.query<{ grievance_email: string | null; grievance_status: string }>(
      "SELECT grievance_email, grievance_status FROM companies WHERE must_keep",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual({ grievance_email: null, grievance_status: 'unknown' });
  });
});

describe('transactional senders (item 7)', () => {
  it('detects order, statement and alert senders from headers alone', async () => {
    const { rows } = await scanWith(h, 'tx', [
      msg('1', 'orders@shop-a.example', 'Thanks'),
      msg('2', 'no-reply@bank-b.example', 'Your e-statement is ready'),
      msg('3', 'info@news-c.example', 'Big weekend deals', { listUnsubscribe: true }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.domain, r.signals]));
    expect(by['shop-a.example']).toEqual(['transactional']);
    expect(by['bank-b.example']).toEqual(['receipt', 'transactional']); // "e-statement" reads as a statement and as a receipt
    expect(by['news-c.example']).toEqual(['list_unsubscribe']);
  });
});

describe('scan window and cap (item 6)', () => {
  it('searches the whole mailbox by default, with banks and shops covered by the query', async () => {
    h.gmail.queries.length = 0;
    await scanWith(h, 'win0', [msg('1', 'hi@win0.example', 'Welcome')]);
    expect(h.gmail.queries[0]).toBe(`(${SCAN_QUERY})`);
    for (const term of ['category:purchases', 'statement', 'transaction', 'order', 'booking']) expect(SCAN_QUERY).toContain(term);
    expect(h.gmail.queries[0]).not.toContain('after:');
  });

  it('applies SCAN_WINDOW_YEARS as an after: date, counted from the day the scan was created', async () => {
    const windowed = await buildHarness(t, { envOverrides: { SCAN_WINDOW_YEARS: '3' } });
    try {
      await scanWith(windowed, 'win3', [msg('1', 'hi@win3.example', 'Welcome')]);
      // The scan is stamped with the database clock when it is created, so the expected date follows today's date.
      const today = new Date();
      expect(windowed.gmail.queries[0]).toBe(buildScanQuery(3, today));
      expect(windowed.gmail.queries[0]).toContain(`after:${today.getUTCFullYear() - 3}/`);
    } finally {
      await windowed.app.close();
    }
  });

  it('keeps the same query when a scan resumes later (stored page tokens stay valid)', () => {
    const created = new Date('2026-11-22T10:00:00Z');
    expect(buildScanQuery(2, created)).toBe(buildScanQuery(2, created));
    expect(buildScanQuery(2, created)).toMatch(/after:2024\/11\/22$/);
    expect(buildScanQuery(undefined, created)).toBe(`(${SCAN_QUERY})`);
  });

  it('stops at SCAN_MAX_MESSAGES and says so in the log (hitCap), without failing', async () => {
    const capped = await buildHarness(t, { envOverrides: { SCAN_MAX_MESSAGES: '100' } });
    try {
      const messages = Array.from({ length: 250 }, (_, i) => msg(`m${i}`, `hi@cap${i}.example`, 'Welcome'));
      const { s, inboxId } = await scanWith(capped, 'cap', messages);
      const scan = (await capped.app.inject({ method: 'GET', url: `/v1/inboxes/${inboxId}/scan`, headers: { cookie: s.cookie } })).json<{ scan: { status: string; foundCount: number } }>().scan;
      expect(scan).toMatchObject({ status: 'done', foundCount: 100 });
      const line = capped.logs.lines().find((l) => l.msg === 'scan finished');
      expect(line).toMatchObject({ scanned: 100, hitCap: true, windowYears: null });
    } finally {
      await capped.app.close();
    }
  });

  it('reports hitCap false and the ignored count when the whole mailbox was read', async () => {
    await scanWith(h, 'full', [msg('1', 'hi@full.example', 'Welcome'), msg('2', 'friend@gmail.com', 'Welcome'), msg('3', 'x@em.sendgrid.net', 'Welcome')]);
    const line = h.logs.lines().filter((l) => l.msg === 'scan finished').at(-1);
    expect(line).toMatchObject({ scanned: 3, ignored: 2, found: 1, hitCap: false });
  });
});

describe('found count matches what is shown', () => {
  it('counts only shown companies; hidden and not-mine rows are logged as counts, never named', async () => {
    const harness = await buildHarness(t, { envOverrides: { SCAN_EXCLUDE: 'employer-found.example' } });
    try {
      const s = await signIn(harness, { email: 'found@example.test', sub: 'g-found' });
      const { inboxId } = await connectInbox(harness, s, { email: 'found-mail@example.test', sub: 'g-found-mail' });
      // Rows from earlier scans: a delivery service, an employer domain and a company marked "not mine".
      for (const [domain, status] of [
        ['elasticemail.com', 'active'],
        ['employer-found.example', 'active'],
        ['notmine-found.example', 'not_mine'],
      ] as const) {
        const companyId = newId('company');
        await t.owner.query("INSERT INTO companies (id, slug, name, domains) VALUES ($1, $2, $3, ARRAY[$4])", [companyId, domain.replace(/\./g, '-'), domain, domain]);
        await t.owner.query(
          "INSERT INTO user_companies (id, user_id, company_id, inbox_id, first_seen, last_seen, signal_types, status) VALUES ($1, $2, $3, $4, now(), now(), ARRAY['welcome'], $5)",
          [newId('userCompany'), s.userId, companyId, inboxId, status],
        );
      }
      harness.gmail.messages = [msg('1', 'hi@shown-a.example', 'Welcome'), msg('2', 'hi@shown-b.example', 'Your receipt'), msg('3', 'x@em.sendgrid.net', 'Welcome')];
      await harness.app.inject({ method: 'POST', url: `/v1/inboxes/${inboxId}/scan`, headers: authed(s) });
      await harness.queue.drain();

      const scan = (await harness.app.inject({ method: 'GET', url: `/v1/inboxes/${inboxId}/scan`, headers: { cookie: s.cookie } })).json<{ scan: { status: string; foundCount: number } }>().scan;
      expect(scan).toMatchObject({ status: 'done', foundCount: 2 }); // two shown, not five stored
      const { rows } = await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM user_companies WHERE user_id = $1', [s.userId]);
      expect(rows[0]?.n).toBe('5');

      const line = harness.logs.lines().find((l) => l.msg === 'scan finished');
      expect(line).toMatchObject({ found: 2, hidden: 2, notMine: 1 });
      expect(harness.logs.text()).not.toMatch(/elasticemail|employer-found|notmine-found|shown-a|shown-b/);
    } finally {
      await harness.app.close();
    }
  });
});

describe('logs', () => {
  it('stay free of domains, addresses and subjects', () => {
    const text = h.logs.text();
    for (const forbidden of [/@/, /sendgrid|elasticemail|happn|sampleshop|myfirm|employer/i, /Welcome|receipt|statement/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});
