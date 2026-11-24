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
  'job_runs',
  'oauth_states',
  'reply_labels',
  'request_drafts',
  'request_events',
  'request_followups',
  'request_replies',
  'requests',
  'scans',
  'sessions',
  'user_companies',
  'users',
];
const APPEND_ONLY = ['audit_log', 'request_drafts', 'request_events', 'request_replies'];

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
    // Only our own outgoing draft text, which the user approves, and four columns whose names say "message" but which
    // hold opaque ids: Gmail's id of a message, and the Message-ID header of the one we sent. Nothing from received mail.
    expect(contentLike).toEqual([
      'request_drafts.body',
      'request_drafts.subject',
      'request_followups.gmail_message_id',
      'request_replies.gmail_message_id',
      'requests.sent_message_id',
      'requests.sent_rfc_message_id',
    ]);
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
      const expected = table === 'job_runs' ? ['SELECT'] : APPEND_ONLY.includes(table) ? ['INSERT', 'SELECT'] : ['INSERT', 'SELECT', 'UPDATE'];
      expect(privs, table).toEqual(expected); // job_runs is written only by the purge functions
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

describe('reply tracking (Phase 2)', () => {
  /** A sent request, made by moving a drafted one through approval as the real service does. */
  async function sentRequest(label: string): Promise<string> {
    const { requestId, hash } = await draftRequest(t.owner, await seedUser(t.owner, label));
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    await markSent(t.app, requestId);
    return requestId;
  }
  const addReply = (requestId: string, over: { messageId?: string; domain?: string | null; match?: string; automatic?: boolean } = {}) =>
    t.app.query(
      `INSERT INTO request_replies (id, request_id, gmail_message_id, received_at, sender_domain, sender_match, automatic)
       VALUES ($1, $2, $3, now(), $4, $5, $6)`,
      [newId('reply'), requestId, over.messageId ?? 'msg-1', over.domain === undefined ? 'company.example' : over.domain, over.match ?? 'company', over.automatic ?? false],
    );

  it('moves a sent request on to reply_received, and records the reply as metadata', async () => {
    const requestId = await sentRequest('r1');
    await t.app.query(`UPDATE requests SET status = 'reply_received', first_reply_at = now() WHERE id = $1`, [requestId]);
    await addReply(requestId, { domain: 'mail.company.example', match: 'company' });
    const { rows } = await t.owner.query<{ sender_domain: string; sender_match: string; automatic: boolean }>(
      'SELECT sender_domain, sender_match, automatic FROM request_replies WHERE request_id = $1',
      [requestId],
    );
    expect(rows).toEqual([{ sender_domain: 'mail.company.example', sender_match: 'company', automatic: false }]);
  });

  it('records a reply once per message: the same Gmail message cannot be added twice', async () => {
    const requestId = await sentRequest('r2');
    await addReply(requestId, { messageId: 'same-message' });
    expect((await pgError(addReply(requestId, { messageId: 'same-message' }))).code).toBe(UNIQUE_VIOLATION);
    await addReply(requestId, { messageId: 'another-message' });
  });

  it('refuses anything that is not a plain domain: no address, name, subject or text can be stored in a reply row', async () => {
    const requestId = await sentRequest('r3');
    for (const bad of ['someone@company.example', 'Some One <a@b.example>', 'has space.example', 'Subject: erase my data', '-lead.example', 'trail.example-', 'a'.repeat(254)]) {
      expect((await pgError(addReply(requestId, { domain: bad, messageId: `m-${bad.length}` }))).code, bad).toBe(CHECK_VIOLATION);
    }
    await addReply(requestId, { domain: null, match: 'unknown', messageId: 'no-domain' });
  });

  it('refuses a message id that is not a plain id, and a reply for a request that does not exist', async () => {
    const requestId = await sentRequest('r4');
    for (const bad of ['has space', 'a/b', 'x'.repeat(129), '']) {
      expect((await pgError(addReply(requestId, { messageId: bad }))).code, bad).toBe(CHECK_VIOLATION);
    }
    expect((await pgError(addReply(newId('request')))).code).toBe(FK_VIOLATION);
  });

  it('lets the app role add and read replies, never change or delete them', async () => {
    const requestId = await sentRequest('r5');
    await addReply(requestId, { messageId: 'kept' });
    expect((await t.app.query('SELECT 1 FROM request_replies WHERE request_id = $1', [requestId])).rowCount).toBe(1);
    for (const sql of [`UPDATE request_replies SET automatic = true`, 'DELETE FROM request_replies', 'TRUNCATE request_replies']) {
      expect((await pgError(t.app.query(sql))).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('keeps the send guard: a request still cannot leave drafted without approval, whatever the new statuses', async () => {
    const { requestId } = await draftRequest(t.owner, await seedUser(t.owner, 'r6'));
    for (const status of ['sent', 'reply_received', 'replied_deleted', 'no_reply']) {
      const err = await pgError(t.app.query(`UPDATE requests SET status = '${status}', sent_at = now(), thread_id = 't', due_at = now() WHERE id = $1`, [requestId]));
      expect(err.code, status).toBe(CHECK_VIOLATION);
    }
  });

  it('accepts a request copied into a web form: sent with no Gmail thread, and refuses a thread on a form request', async () => {
    const { requestId, hash } = await draftRequest(t.owner, await seedUser(t.owner, 'r7'));
    await t.app.query(`UPDATE requests SET channel = 'web_form' WHERE id = $1`, [requestId]);
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    await t.app.query(`UPDATE requests SET status = 'sent', sent_at = now(), due_at = now() + interval '30 days' WHERE id = $1`, [requestId]);
    expect((await pgError(t.app.query(`UPDATE requests SET thread_id = 'thread-x' WHERE id = $1`, [requestId]))).code).toBe(CHECK_VIOLATION);
  });

  it('still refuses an email request that is sent without a thread', async () => {
    const { requestId, hash } = await draftRequest(t.owner, await seedUser(t.owner, 'r8'));
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    const err = await pgError(t.app.query(`UPDATE requests SET status = 'sent', sent_at = now(), due_at = now() WHERE id = $1`, [requestId]));
    expect(err.code).toBe(CHECK_VIOLATION);
  });

  it('has the new event types, and a failure count that cannot go negative', async () => {
    const requestId = await sentRequest('r9');
    for (const type of ['reply_received', 'outcome_set', 'followup_drafted', 'submitted']) await addEvent(t.app, requestId, type, 'system', null);
    // Approving or sending a follow-up is recorded against the exact draft, like the first request: a hash is required.
    for (const type of ['followup_approved', 'followup_sent']) {
      expect((await pgError(addEvent(t.app, requestId, type, 'user', null))).code, type).toBe(CHECK_VIOLATION);
      await addEvent(t.app, requestId, type, 'user', sha256('a follow-up draft'));
    }
    expect((await pgError(t.app.query(`UPDATE requests SET reply_check_failures = -1 WHERE id = $1`, [requestId]))).code).toBe(CHECK_VIOLATION);
  });
});

describe('follow-ups (Phase 2)', () => {
  async function sentRequest(label: string) {
    const seed = await seedUser(t.owner, label);
    const { requestId, hash } = await draftRequest(t.owner, seed);
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    await markSent(t.app, requestId);
    return { requestId, seed };
  }
  const addFollowup = (requestId: string, sequence = 1, status = 'drafted') =>
    t.app.query(`INSERT INTO request_followups (id, request_id, sequence, status) VALUES ($1, $2, $3, $4) RETURNING id`, [newId('followup'), requestId, sequence, status]);
  const followupDraft = async (requestId: string, followupId: string, version: number, text: string) => {
    const hash = sha256(text);
    await t.owner.query(
      `INSERT INTO request_drafts (id, request_id, followup_id, version, to_email, subject, body, draft_hash, created_by) VALUES ($1, $2, $3, $4, 'privacy@example.com', 'Re: Request', $5, $6, 'template')`,
      [newId('draft'), requestId, followupId, version, text, hash],
    );
    return hash;
  };
  const newFollowup = async (requestId: string, sequence = 1) => ((await addFollowup(requestId, sequence)).rows[0] as { id: string }).id;
  const setStatus = (id: string, status: string) =>
    t.app.query(`UPDATE request_followups SET status = $2::followup_status, sent_at = CASE WHEN $2::text IN ('sent', 'submitted') THEN now() ELSE sent_at END WHERE id = $1`, [id, status]);

  it('keeps its drafts apart from the first request: each has its own versions', async () => {
    const { requestId } = await sentRequest('f1');
    const followupId = await newFollowup(requestId);
    await followupDraft(requestId, followupId, 1, 'follow-up text');
    await followupDraft(requestId, followupId, 2, 'follow-up text, edited');
    // The first request still has its own version 1 and cannot get a second version 1.
    expect((await pgError(t.owner.query(`INSERT INTO request_drafts (id, request_id, version, to_email, subject, body, draft_hash, created_by) VALUES ($1, $2, 1, 'a@example.com', 'S', 'B', $3, 'user')`, [newId('draft'), requestId, sha256('x')]))).code).toBe(UNIQUE_VIOLATION);
    expect((await pgError(followupDraft(requestId, followupId, 2, 'again'))).code).toBe(UNIQUE_VIOLATION);
  });

  it('allows one follow-up being worked on at a time, a numbered sequence, and no more than three', async () => {
    const { requestId } = await sentRequest('f2');
    const first = await newFollowup(requestId);
    expect((await pgError(addFollowup(requestId, 2))).code).toBe(UNIQUE_VIOLATION); // the first is still open
    expect((await pgError(addFollowup(requestId, 1, 'cancelled'))).code).toBe(UNIQUE_VIOLATION); // the sequence number is taken
    await t.owner.query(`UPDATE request_followups SET status = 'cancelled' WHERE id = $1`, [first]);
    await addFollowup(requestId, 2);
    expect((await pgError(addFollowup(requestId, 4, 'cancelled'))).code).toBe(CHECK_VIOLATION);
    expect((await pgError(addFollowup(requestId, 0, 'cancelled'))).code).toBe(CHECK_VIOLATION);
  });

  describe('the approval guard behind the service layer', () => {
    it('refuses to mark a follow-up sent or submitted when nothing was approved', async () => {
      const { requestId } = await sentRequest('f3');
      const id = await newFollowup(requestId);
      expect((await pgError(setStatus(id, 'sent'))).code).toBe(CHECK_VIOLATION); // no draft at all
      await followupDraft(requestId, id, 1, 'follow-up text');
      const err = await pgError(setStatus(id, 'sent'));
      expect(err.code).toBe(CHECK_VIOLATION);
      expect(err.message).toMatch(/without a user approval/);
      expect((await pgError(setStatus(id, 'submitted'))).code).toBe(CHECK_VIOLATION);
    });

    it('refuses an approval of another hash, by anyone but the user, or of the first request instead', async () => {
      const { requestId, seed } = await sentRequest('f4');
      const id = await newFollowup(requestId);
      const hash = await followupDraft(requestId, id, 1, 'follow-up text');
      await addEvent(t.app, requestId, 'followup_approved', 'user', sha256('some other text'));
      expect((await pgError(setStatus(id, 'sent'))).code).toBe(CHECK_VIOLATION);
      await addEvent(t.app, requestId, 'followup_approved', 'system', hash);
      expect((await pgError(setStatus(id, 'sent'))).code).toBe(CHECK_VIOLATION);
      await addEvent(t.app, requestId, 'followup_approved', 'admin', hash);
      expect((await pgError(setStatus(id, 'sent'))).code).toBe(CHECK_VIOLATION);
      await addEvent(t.app, requestId, 'approved', 'user', hash); // the first request's kind of approval does not count
      expect((await pgError(setStatus(id, 'sent'))).code).toBe(CHECK_VIOLATION);
      expect(seed.userId).toBeTruthy();
    });

    it('allows it after the user approves the current draft, and an edit makes the approval stop counting', async () => {
      const { requestId } = await sentRequest('f5');
      const id = await newFollowup(requestId);
      const v1 = await followupDraft(requestId, id, 1, 'follow-up text');
      await addEvent(t.app, requestId, 'followup_approved', 'user', v1);
      const v2 = await followupDraft(requestId, id, 2, 'follow-up text, edited after approval');
      expect(v2).not.toBe(v1);
      expect((await pgError(setStatus(id, 'sent'))).code).toBe(CHECK_VIOLATION); // approval was of version 1
      await addEvent(t.app, requestId, 'followup_approved', 'user', v2);
      await setStatus(id, 'sent');
      const { rows } = await t.owner.query<{ status: string; sent_at: Date | null }>('SELECT status, sent_at FROM request_followups WHERE id = $1', [id]);
      expect(rows[0]?.status).toBe('sent');
      expect(rows[0]?.sent_at).not.toBeNull();
    });

    it('does not apply to another follow-up on the same request, and refuses creating one already sent', async () => {
      const { requestId } = await sentRequest('f6');
      const first = await newFollowup(requestId);
      const hash = await followupDraft(requestId, first, 1, 'first follow-up');
      await addEvent(t.app, requestId, 'followup_approved', 'user', hash);
      await setStatus(first, 'sent');
      const second = await newFollowup(requestId, 2);
      await followupDraft(requestId, second, 1, 'second follow-up');
      expect((await pgError(setStatus(second, 'sent'))).code).toBe(CHECK_VIOLATION); // the first one's approval is not this one's
      expect((await pgError(addFollowup(requestId, 3, 'sent'))).code).toBe(CHECK_VIOLATION); // cannot be born sent
    });

    it('lets a web-form follow-up be marked submitted after approval, and only then', async () => {
      const { requestId } = await sentRequest('f7');
      const id = await newFollowup(requestId);
      const hash = await followupDraft(requestId, id, 1, 'copy-only follow-up');
      expect((await pgError(setStatus(id, 'submitted'))).code).toBe(CHECK_VIOLATION);
      await addEvent(t.app, requestId, 'followup_approved', 'user', hash);
      await setStatus(id, 'submitted');
    });
  });

  it('refuses a sent follow-up with no time, a malformed hash or message id, and the app role cannot delete', async () => {
    const { requestId } = await sentRequest('f8');
    const id = await newFollowup(requestId);
    expect((await pgError(t.owner.query(`ALTER TABLE request_followups DISABLE TRIGGER request_followups_send_requires_approval`).then(() => t.owner.query(`UPDATE request_followups SET status = 'sent' WHERE id = $1`, [id])))).code).toBe(CHECK_VIOLATION);
    await t.owner.query(`ALTER TABLE request_followups ENABLE TRIGGER request_followups_send_requires_approval`);
    expect((await pgError(t.app.query(`UPDATE request_followups SET approved_hash = 'nope' WHERE id = $1`, [id]))).code).toBe(CHECK_VIOLATION);
    expect((await pgError(t.app.query(`UPDATE request_followups SET gmail_message_id = 'has space' WHERE id = $1`, [id]))).code).toBe(CHECK_VIOLATION);
    expect((await pgError(t.app.query('DELETE FROM request_followups'))).code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('keeps the first request send guard and its drafts as they were', async () => {
    const { requestId } = await draftRequest(t.owner, await seedUser(t.owner, 'f9'));
    expect((await pgError(markSent(t.app, requestId))).code).toBe(CHECK_VIOLATION);
  });

  it('counts a follow-up send as a claim of its own: one active per follow-up, and the scope and follow-up must go together', async () => {
    const { requestId, seed } = await sentRequest('f10');
    const id = await newFollowup(requestId);
    const claim = (scope: string, followupId: string | null, key: string) =>
      t.app.query(`INSERT INTO idempotency_keys (id, user_id, scope, key, request_id, followup_id) VALUES ($1, $2, $3, $4, $5, $6)`, [newId('idempotencyKey'), seed.userId, scope, key, requestId, followupId]);
    await claim('followup_send', id, 'followup-key-00000001');
    expect((await pgError(claim('followup_send', id, 'followup-key-00000002'))).code).toBe(UNIQUE_VIOLATION); // one active send per follow-up
    expect((await pgError(claim('followup_send', null, 'followup-key-00000003'))).code).toBe(CHECK_VIOLATION);
    expect((await pgError(claim('send', id, 'followup-key-00000004'))).code).toBe(CHECK_VIOLATION);
    expect((await pgError(claim('other', null, 'followup-key-00000005'))).code).toBe(CHECK_VIOLATION);
  });
});
