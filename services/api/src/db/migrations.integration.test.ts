import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../common/ids.js';
import {
  addDraft,
  addEvent,
  createTestDb,
  draftRequest,
  markSent,
  pgError,
  seedUser,
  sha256,
  type TestDb,
} from '../../test/db-helper.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';

// Postgres error codes
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const INSUFFICIENT_PRIVILEGE = '42501';

const EXPECTED_TABLES = [
  'audit_log',
  'companies',
  'idempotency_keys',
  'inboxes',
  'oauth_states',
  'reply_labels',
  'request_drafts',
  'request_events',
  'requests',
  'scans',
  'sessions',
  'user_companies',
  'users',
];
const APPEND_ONLY = ['audit_log', 'request_drafts', 'request_events'];

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

describe('migrations', () => {
  it('create exactly the Phase 1 tables from scratch', async () => {
    const { rows } = await t.owner.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
  });

  it('can be re-run without changes', async () => {
    const { rows } = await t.owner.query<{ current_database: string }>('SELECT current_database()');
    const url = new URL(process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://erase:erase@localhost:5432/postgres');
    url.pathname = `/${rows[0]?.current_database}`;
    await expect(runMigrations(url.toString(), MIGRATIONS_FOLDER)).resolves.toBeUndefined();
  });

  it('keep email content out of the schema (PRD section 8, F2-AC4)', async () => {
    const { rows } = await t.owner.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const contentLike = rows
      .filter((r) => /(body|html|snippet|subject|message|content|raw|mime|attachment|preview)/i.test(r.column_name))
      .map((r) => `${r.table_name}.${r.column_name}`)
      .sort();
    // Only our own outgoing draft text, which the user approves. Nothing from received mail.
    expect(contentLike).toEqual(['request_drafts.body', 'request_drafts.subject']);
  });
});

describe('app role privileges', () => {
  it('has every table classified as append-only or mutable (add the table here when you add one)', async () => {
    const { rows } = await t.owner.query<{ table_name: string; priv: string; ok: boolean }>(
      `SELECT c.relname AS table_name, p.priv, has_table_privilege('erase_app', c.oid, p.priv) AS ok
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
        WHERE c.relkind = 'r'`,
    );
    const granted = new Map<string, string[]>();
    for (const r of rows) if (r.ok) granted.set(r.table_name, [...(granted.get(r.table_name) ?? []), r.priv]);

    expect([...new Set(rows.map((r) => r.table_name))].sort()).toEqual(EXPECTED_TABLES);
    for (const table of EXPECTED_TABLES) {
      const privs = (granted.get(table) ?? []).sort();
      expect(privs, table).toEqual(APPEND_ONLY.includes(table) ? ['INSERT', 'SELECT'] : ['INSERT', 'SELECT', 'UPDATE']);
    }
  });

  it('cannot update, delete or truncate append-only tables', async () => {
    const seed = await seedUser(t.owner, 'priv');
    const { requestId } = await draftRequest(t.owner, seed);
    await t.app.query(`INSERT INTO audit_log (id, actor_type, action) VALUES ($1, 'system', 'test.insert')`, [newId('audit')]);
    await addEvent(t.app, requestId, 'drafted', 'system', null);

    const denied = [
      `UPDATE audit_log SET action = 'tampered'`,
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
      `UPDATE request_events SET type = 'closed'`,
      'DELETE FROM request_events',
      'TRUNCATE request_events',
      `UPDATE request_drafts SET body = 'rewritten'`,
      'DELETE FROM request_drafts',
    ];
    for (const sql of denied) expect((await pgError(t.app.query(sql))).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot delete from mutable tables either (no deletes in Phase 1)', async () => {
    expect((await pgError(t.app.query('DELETE FROM requests'))).code).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await pgError(t.app.query('DELETE FROM users'))).code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('send guard (defence in depth behind the service layer)', () => {
  it('blocks sending a request that has no approval', async () => {
    const { requestId } = await draftRequest(t.owner, await seedUser(t.owner, 'g1'));
    const err = await pgError(markSent(t.app, requestId));
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.message).toMatch(/without a user approval/);
  });

  it('blocks an approval of the wrong hash, or by anyone but the user', async () => {
    const { requestId, hash } = await draftRequest(t.owner, await seedUser(t.owner, 'g2'));
    await addEvent(t.app, requestId, 'approved', 'user', sha256('some other text'));
    expect((await pgError(markSent(t.app, requestId))).code).toBe(CHECK_VIOLATION);
    await addEvent(t.app, requestId, 'approved', 'system', hash);
    expect((await pgError(markSent(t.app, requestId))).code).toBe(CHECK_VIOLATION);
    await addEvent(t.app, requestId, 'approved', 'admin', hash);
    expect((await pgError(markSent(t.app, requestId))).code).toBe(CHECK_VIOLATION);
  });

  it('allows sending after a user approves the current draft', async () => {
    const { requestId, hash } = await draftRequest(t.owner, await seedUser(t.owner, 'g3'));
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    await markSent(t.app, requestId);
    const { rows } = await t.owner.query<{ status: string }>('SELECT status FROM requests WHERE id = $1', [requestId]);
    expect(rows[0]?.status).toBe('sent');
  });

  it('requires a fresh approval after an edit', async () => {
    const { requestId, hash: h1 } = await draftRequest(t.owner, await seedUser(t.owner, 'g4'));
    await addEvent(t.app, requestId, 'approved', 'user', h1);
    const h2 = await addDraft(t.owner, requestId, 2, 'edited draft');
    expect(h2).not.toBe(h1);
    expect((await pgError(markSent(t.app, requestId))).code).toBe(CHECK_VIOLATION);
    await addEvent(t.app, requestId, 'approved', 'user', h2);
    await markSent(t.app, requestId);
  });

  it('requires a fresh approval even when an edit reverts to previously approved text', async () => {
    const { requestId, hash: h1 } = await draftRequest(t.owner, await seedUser(t.owner, 'g5'), 'original');
    await addEvent(t.app, requestId, 'approved', 'user', h1);
    await addDraft(t.owner, requestId, 2, 'changed');
    const reverted = await addDraft(t.owner, requestId, 3, 'original');
    expect(reverted).toBe(h1);
    expect((await pgError(markSent(t.app, requestId))).code).toBe(CHECK_VIOLATION);
    await addEvent(t.app, requestId, 'approved', 'user', h1);
    await markSent(t.app, requestId);
  });

  it('also guards the other ways out of the pre-send states', async () => {
    const { requestId } = await draftRequest(t.owner, await seedUser(t.owner, 'g6'));
    for (const status of ['replied_deleted', 'no_reply', 'bounced']) {
      const err = await pgError(
        t.app.query(
          `UPDATE requests SET status = $2, sent_at = now(), thread_id = 't', due_at = now() WHERE id = $1`,
          [requestId, status],
        ),
      );
      expect(err.code, status).toBe(CHECK_VIOLATION);
    }
  });

  it('blocks inserting a request that is already sent', async () => {
    const seed = await seedUser(t.owner, 'g7');
    const err = await pgError(
      t.app.query(
        `INSERT INTO requests (id, user_id, user_company_id, status, sent_at, thread_id, due_at)
         VALUES ($1, $2, $3, 'sent', now(), 't', now())`,
        [newId('request'), seed.userId, seed.userCompanyId],
      ),
    );
    expect(err.code).toBe(CHECK_VIOLATION);
  });

  it('lets a draft be discarded without approval', async () => {
    const { requestId } = await draftRequest(t.owner, await seedUser(t.owner, 'g8'));
    await t.app.query(`UPDATE requests SET status = 'closed' WHERE id = $1`, [requestId]);
  });

  it('does not re-check requests that were already sent', async () => {
    const { requestId, hash } = await draftRequest(t.owner, await seedUser(t.owner, 'g9'));
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    await markSent(t.app, requestId);
    await t.app.query(`UPDATE requests SET status = 'replied_deleted' WHERE id = $1`, [requestId]);
  });
});

describe('constraints', () => {
  it('require prefixed ULID ids', async () => {
    const err = await pgError(
      t.owner.query(`INSERT INTO users (id, google_sub, email, name) VALUES ('abc', 's', 'e@example.test', 'n')`),
    );
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint).toBe('users_id_format');
  });

  it('require approved and sent events to carry a draft hash', async () => {
    const { requestId } = await draftRequest(t.owner, await seedUser(t.owner, 'c1'));
    for (const type of ['approved', 'sent']) {
      expect((await pgError(addEvent(t.owner, requestId, type, 'user', null))).constraint).toBe('request_events_approval_has_hash');
    }
    expect((await pgError(addEvent(t.owner, requestId, 'approved', 'user', 'not-a-hash'))).constraint).toBe('request_events_hash_format');
  });

  it('require a sent request to carry its send details', async () => {
    const seed = await seedUser(t.owner, 'c2');
    const { requestId, hash } = await draftRequest(t.owner, seed);
    await addEvent(t.owner, requestId, 'approved', 'user', hash);
    const err = await pgError(t.owner.query(`UPDATE requests SET status = 'sent' WHERE id = $1`, [requestId]));
    expect(err.constraint).toBe('requests_sent_has_details');
  });

  it('allow one open request per detected company', async () => {
    const seed = await seedUser(t.owner, 'c3');
    const first = await draftRequest(t.owner, seed);
    const err = await pgError(
      t.owner.query('INSERT INTO requests (id, user_id, user_company_id) VALUES ($1, $2, $3)', [newId('request'), seed.userId, seed.userCompanyId]),
    );
    expect(err.code).toBe(UNIQUE_VIOLATION);
    await t.owner.query(`UPDATE requests SET status = 'closed' WHERE id = $1`, [first.requestId]);
    await t.owner.query('INSERT INTO requests (id, user_id, user_company_id) VALUES ($1, $2, $3)', [newId('request'), seed.userId, seed.userCompanyId]);
  });

  it('keep a request and an inbox inside their own user', async () => {
    const a = await seedUser(t.owner, 'own-a');
    const b = await seedUser(t.owner, 'own-b');
    const stolenCompany = await pgError(
      t.owner.query('INSERT INTO requests (id, user_id, user_company_id) VALUES ($1, $2, $3)', [newId('request'), a.userId, b.userCompanyId]),
    );
    expect(stolenCompany.code).toBe(FK_VIOLATION);
    const stolenInbox = await pgError(
      t.owner.query(
        `INSERT INTO user_companies (id, user_id, company_id, inbox_id, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, now(), now())`,
        [newId('userCompany'), a.userId, b.companyId, b.inboxId],
      ),
    );
    expect(stolenInbox.code).toBe(FK_VIOLATION);
  });

  it('allow a company to be detected once per user', async () => {
    const seed = await seedUser(t.owner, 'c4');
    const err = await pgError(
      t.owner.query(
        `INSERT INTO user_companies (id, user_id, company_id, inbox_id, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, now(), now())`,
        [newId('userCompany'), seed.userId, seed.companyId, seed.inboxId],
      ),
    );
    expect(err.constraint).toBe('user_companies_user_company_key');
  });

  it('allow one active scan per inbox', async () => {
    const seed = await seedUser(t.owner, 'c5');
    const insert = (status: string) =>
      t.owner.query('INSERT INTO scans (id, inbox_id, status) VALUES ($1, $2, $3)', [newId('scan'), seed.inboxId, status]);
    await insert('queued');
    expect((await pgError(insert('running'))).constraint).toBe('scans_one_active_per_inbox');
    await insert('done');
    await insert('failed');
  });

  describe('inbox tokens and retention', () => {
    const insertInbox = (userId: string, fields: string, values: unknown[]) =>
      t.owner.query(`INSERT INTO inboxes (id, user_id, email, ${fields}) VALUES ($1, $2, $3, ${values.map((_, i) => `$${i + 4}`).join(', ')})`, [
        newId('inbox'),
        userId,
        `${newId('inbox').toLowerCase()}@example.test`,
        ...values,
      ]);

    it('require a stored token while connected', async () => {
      const { userId } = await seedUser(t.owner, 'i1');
      const err = await pgError(insertInbox(userId, 'status', ['connected']));
      expect(err.constraint).toBe('inboxes_connected_has_token');
    });

    it('drop the token and start the retention clock on disconnect', async () => {
      const { userId } = await seedUser(t.owner, 'i2');
      const keepsToken = await pgError(
        insertInbox(userId, 'status, token_ciphertext, token_key_id, disconnected_at, purge_after', ['disconnected', 'ct', 'k', new Date(), new Date()]),
      );
      expect(keepsToken.constraint).toBe('inboxes_disconnected_dropped_token');
      const noClock = await pgError(insertInbox(userId, 'status, disconnected_at', ['disconnected', new Date()]));
      expect(noClock.constraint).toBe('inboxes_disconnected_dropped_token');
      await insertInbox(userId, 'status, disconnected_at, purge_after', ['disconnected', new Date(), new Date(Date.now() + 30 * 86_400_000)]);
    });

    it('only allow purge_after after a disconnect', async () => {
      const { userId } = await seedUser(t.owner, 'i3');
      const err = await pgError(insertInbox(userId, 'status, token_ciphertext, token_key_id, purge_after', ['connected', 'ct', 'k', new Date()]));
      expect(err.constraint).toBe('inboxes_purge_needs_disconnect');
    });
  });

  describe('grievance contacts (catalog rules)', () => {
    const insertCompany = (fields: Record<string, unknown>) => {
      const id = newId('company');
      const row = { id, slug: `co-${id.slice(-8).toLowerCase()}`, name: 'Co', ...fields };
      const cols = Object.keys(row);
      return t.owner.query(
        `INSERT INTO companies (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('allow an unknown contact, which blocks drafting in the service', async () => {
      await insertCompany({});
    });

    it('require a source page and a verification date with every address', async () => {
      const noSource = await pgError(insertCompany({ grievance_email: 'privacy@real-co.in', grievance_verified_on: '2026-01-01' }));
      expect(noSource.constraint).toBe('companies_grievance_provenance');
      const noDate = await pgError(insertCompany({ grievance_email: 'privacy@real-co.in', grievance_source: 'https://real-co.in/privacy' }));
      expect(noDate.constraint).toBe('companies_grievance_provenance');
      await insertCompany({ grievance_email: 'privacy@real-co.in', grievance_source: 'https://real-co.in/privacy', grievance_verified_on: '2026-01-01' });
    });

    it('limit fictional entries to @example.com, and keep @example.com out of real entries', async () => {
      const provenance = { grievance_source: 'https://example.com/privacy', grievance_verified_on: '2026-01-01' };
      const fictionalReal = await pgError(insertCompany({ ...provenance, grievance_email: 'privacy@real-co.in', is_fictional: true }));
      expect(fictionalReal.constraint).toBe('companies_fictional_example_only');
      const realFake = await pgError(insertCompany({ ...provenance, grievance_email: 'privacy@example.com', is_fictional: false }));
      expect(realFake.constraint).toBe('companies_real_not_example');
      await insertCompany({ ...provenance, grievance_email: 'privacy@example.com', is_fictional: true });
    });

    it('require a contact for a verified entry and a well-formed slug', async () => {
      expect((await pgError(insertCompany({ grievance_status: 'verified' }))).constraint).toBe('companies_verified_has_contact');
      expect((await pgError(insertCompany({ slug: 'Not A Slug' }))).constraint).toBe('companies_slug_format');
    });
    describe('contact channels (email or web form) and the self-serve link', () => {
      const form = { grievance_channel: 'web_form', grievance_form_url: 'https://real-co.in/privacy/request', grievance_source: 'https://real-co.in/privacy', grievance_verified_on: '2026-01-01' };

      it('accept a verified web form with no email address', async () => {
        await insertCompany({ ...form, grievance_status: 'verified' });
      });

      it('need a source page and a date for a form, as for an address', async () => {
        const noSource = await pgError(insertCompany({ ...form, grievance_source: null }));
        expect(noSource.constraint).toBe('companies_grievance_provenance');
        const noDate = await pgError(insertCompany({ ...form, grievance_verified_on: null }));
        expect(noDate.constraint).toBe('companies_grievance_provenance');
      });

      it('keep one channel at a time', async () => {
        const both = await pgError(insertCompany({ ...form, grievance_email: 'privacy@real-co.in' }));
        expect(both.constraint).toBe('companies_channel_fields');
        const emailWithForm = await pgError(insertCompany({ ...form, grievance_channel: 'email', grievance_email: 'privacy@real-co.in' }));
        expect(emailWithForm.constraint).toBe('companies_channel_fields');
        const badChannel = await pgError(insertCompany({ grievance_channel: 'fax' }));
        expect(badChannel.code).toBe(CHECK_VIOLATION); // refused by the channel checks (Postgres reports the first that fails)
        expect(['companies_channel_fields', 'companies_channel_valid']).toContain(badChannel.constraint);
      });

      it('need the form URL for a verified web form, and an address for a verified email contact', async () => {
        const noUrl = await pgError(insertCompany({ grievance_channel: 'web_form', grievance_status: 'verified' }));
        expect(noUrl.constraint).toBe('companies_verified_has_contact');
        const noEmail = await pgError(insertCompany({ grievance_status: 'verified' }));
        expect(noEmail.constraint).toBe('companies_verified_has_contact');
      });

      it('allow only https URLs', async () => {
        expect((await pgError(insertCompany({ ...form, grievance_form_url: 'http://real-co.in/form' }))).constraint).toBe('companies_urls_https');
        expect((await pgError(insertCompany({ self_serve_url: 'http://real-co.in/delete' }))).constraint).toBe('companies_urls_https');
        expect((await pgError(insertCompany({ self_serve_url: 'https://real-co.in/delete me' }))).constraint).toBe('companies_urls_https');
        await insertCompany({ self_serve_url: 'https://real-co.in/account/delete' });
      });

      it('keep fictional forms and links on example.com, and example.com out of real entries', async () => {
        const fictionalForm = { ...form, grievance_form_url: 'https://example.com/privacy/request', grievance_source: 'https://example.com/privacy' };
        expect((await pgError(insertCompany({ ...form, is_fictional: true }))).constraint).toBe('companies_fictional_example_only');
        expect((await pgError(insertCompany({ ...fictionalForm, is_fictional: false }))).constraint).toBe('companies_real_not_example');
        expect((await pgError(insertCompany({ self_serve_url: 'https://real-co.in/delete', is_fictional: true }))).constraint).toBe('companies_fictional_example_only');
        expect((await pgError(insertCompany({ self_serve_url: 'https://www.example.com/delete', is_fictional: false }))).constraint).toBe('companies_real_not_example');
        await insertCompany({ ...fictionalForm, is_fictional: true, grievance_status: 'verified', self_serve_url: 'https://www.example.com/delete' });
      });

      it('do not treat a look-alike host as example.com', async () => {
        // notexample.com is a real-looking host: allowed for a real entry, refused for a fictional one.
        await insertCompany({ self_serve_url: 'https://notexample.com/delete', is_fictional: false });
        expect((await pgError(insertCompany({ self_serve_url: 'https://notexample.com/delete', is_fictional: true }))).constraint).toBe('companies_fictional_example_only');
      });
    });
  });

  it('keep a reply label confidence between 0 and 1', async () => {
    const { requestId } = await draftRequest(t.owner, await seedUser(t.owner, 'c6'));
    const insert = (confidence: number) =>
      t.owner.query(`INSERT INTO reply_labels (id, request_id, label, confidence, source) VALUES ($1, $2, 'other', $3, 'model')`, [
        newId('replyLabel'),
        requestId,
        confidence,
      ]);
    expect((await pgError(insert(1.5))).constraint).toBe('reply_labels_confidence_range');
    await insert(0.82);
  });
});
