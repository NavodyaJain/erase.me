import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { newId } from '../src/common/ids.js';
import { runMigrations } from '../src/db/migrate.js';

/** A superuser URL for a local or CI Postgres (docker compose, or the CI service container). */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://erase:erase@localhost:5432/postgres';
const APP_ROLE_LOGIN = 'erase_api_test';

export interface TestDb {
  /** Owner connection: seeds data and bypasses privilege checks. */
  owner: pg.Client;
  /** Connection as a member of the restricted `erase_app` role, like the API. */
  app: pg.Client;
  drop(): Promise<void>;
}

function urlFor(base: string, db: string, creds?: { user: string; password: string }): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (creds) {
    u.username = creds.user;
    u.password = creds.password;
  }
  return u.toString();
}

/** Creates a fresh database, applies every migration from scratch and connects both roles. */
export async function createTestDb(): Promise<TestDb> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch {
    throw new Error('Cannot reach Postgres for integration tests. Run `make up`, or set TEST_DATABASE_ADMIN_URL.');
  }
  const name = `erase_test_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const ownerUrl = urlFor(ADMIN_URL, name);
  await runMigrations(ownerUrl);

  // Migration 0001 creates the NOLOGIN group role erase_app. The host normally creates the login role.
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE_LOGIN}') THEN
        CREATE ROLE ${APP_ROLE_LOGIN} LOGIN PASSWORD '${APP_ROLE_LOGIN}' IN ROLE erase_app;
      END IF;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);

  const owner = new pg.Client({ connectionString: ownerUrl });
  const app = new pg.Client({ connectionString: urlFor(ADMIN_URL, name, { user: APP_ROLE_LOGIN, password: APP_ROLE_LOGIN }) });
  await owner.connect();
  await app.connect();

  return {
    owner,
    app,
    async drop() {
      await app.end();
      await owner.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The Postgres error code and message of a failed query. Fails the test if the query succeeds. */
export async function pgError(query: Promise<unknown>): Promise<{ code: string; message: string; constraint?: string }> {
  try {
    await query;
  } catch (e) {
    const err = e as { code?: string; message: string; constraint?: string };
    return { code: err.code ?? '', message: err.message, ...(err.constraint ? { constraint: err.constraint } : {}) };
  }
  throw new Error('expected the query to fail, but it succeeded');
}

export interface Seed {
  userId: string;
  inboxId: string;
  companyId: string;
  userCompanyId: string;
}

/** Inserts a user, a connected inbox, a fictional company and a detected company. */
export async function seedUser(owner: pg.Client, label = 'a'): Promise<Seed> {
  const userId = newId('user');
  const inboxId = newId('inbox');
  const companyId = newId('company');
  const userCompanyId = newId('userCompany');
  await owner.query('INSERT INTO users (id, google_sub, email, name) VALUES ($1, $2, $3, $4)', [
    userId,
    `sub-${userId}`,
    `${label}.${userId.slice(-6).toLowerCase()}@example.test`,
    `Test user ${label}`,
  ]);
  await owner.query(
    `INSERT INTO inboxes (id, user_id, email, token_ciphertext, token_key_id, scopes)
     VALUES ($1, $2, $3, 'ciphertext', 'key-1', ARRAY['gmail.readonly','gmail.send'])`,
    [inboxId, userId, `${label}.${userId.slice(-6).toLowerCase()}@example.test`],
  );
  await owner.query(
    `INSERT INTO companies (id, slug, name, category, grievance_email, grievance_source, grievance_verified_on,
                            grievance_status, is_fictional)
     VALUES ($1, $2, 'Fictional Co', 'saas', 'privacy@example.com', 'https://example.com/privacy',
             '2026-01-01', 'verified', true)`,
    [companyId, `fictional-${companyId.slice(-8).toLowerCase()}`],
  );
  await owner.query(
    `INSERT INTO user_companies (id, user_id, company_id, inbox_id, first_seen, last_seen, signal_types)
     VALUES ($1, $2, $3, $4, now() - interval '30 days', now(), ARRAY['welcome'])`,
    [userCompanyId, userId, companyId, inboxId],
  );
  return { userId, inboxId, companyId, userCompanyId };
}

export interface DraftedRequest {
  requestId: string;
  hash: string;
  version: number;
}

/** A request in `drafted` with one draft version. */
export async function draftRequest(owner: pg.Client, seed: Seed, text = 'first draft'): Promise<DraftedRequest> {
  const requestId = newId('request');
  await owner.query('INSERT INTO requests (id, user_id, user_company_id) VALUES ($1, $2, $3)', [
    requestId,
    seed.userId,
    seed.userCompanyId,
  ]);
  const hash = await addDraft(owner, requestId, 1, text);
  return { requestId, hash, version: 1 };
}

export async function addDraft(owner: pg.Client, requestId: string, version: number, text: string): Promise<string> {
  const hash = sha256(text);
  await owner.query(
    `INSERT INTO request_drafts (id, request_id, version, to_email, subject, body, draft_hash, created_by)
     VALUES ($1, $2, $3, 'privacy@example.com', 'Request', $4, $5, 'template')`,
    [newId('draft'), requestId, version, text, hash],
  );
  return hash;
}

export async function addEvent(
  client: pg.Client,
  requestId: string,
  type: string,
  actorType: 'user' | 'system' | 'admin',
  draftHash: string | null,
): Promise<void> {
  await client.query(
    'INSERT INTO request_events (id, request_id, type, actor_type, draft_hash) VALUES ($1, $2, $3, $4, $5)',
    [newId('event'), requestId, type, actorType, draftHash],
  );
}

export const markSent = (client: pg.Client, requestId: string) =>
  client.query(
    `UPDATE requests SET status = 'sent', sent_at = now(), thread_id = 'thread-1', due_at = now() + interval '30 days'
      WHERE id = $1`,
    [requestId],
  );
