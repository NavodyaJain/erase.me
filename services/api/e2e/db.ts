import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

export const E2E_DB_NAME = 'erase_e2e';
const APP_ROLE = 'erase_api_e2e';

const withDb = (base: string, db: string, creds?: { user: string; password: string }): string => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (creds) {
    u.username = creds.user;
    u.password = creds.password;
  }
  return u.toString();
};

/** The URL the API connects with: the restricted login role, on the e2e database only. */
export const e2eAppUrl = (adminUrl: string): string => withDb(adminUrl, E2E_DB_NAME, { user: APP_ROLE, password: APP_ROLE });
/** The owner URL, used to apply migrations and to wipe test data between tests. */
export const e2eOwnerUrl = (adminUrl: string): string => withDb(adminUrl, E2E_DB_NAME);

/**
 * Drops and recreates the dedicated e2e database and applies every migration. Only ever touches `erase_e2e`: the dev
 * database (`erase`) is never named here.
 */
export async function prepareE2eDatabase(adminUrl: string): Promise<void> {
  const admin = new pg.Client({ connectionString: withDb(adminUrl, 'postgres') });
  try {
    await admin.connect();
  } catch {
    throw new Error('Cannot reach Postgres for the e2e stack. Start it with `docker compose up -d postgres`, or set E2E_DATABASE_ADMIN_URL.');
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${E2E_DB_NAME}`);
    await runMigrations(e2eOwnerUrl(adminUrl));
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE}' IN ROLE erase_app;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$`);
  } finally {
    await admin.end();
  }
}

/** Removes everything a test created (people, inboxes, scans, requests) and keeps the synced catalog. */
export async function wipeE2eData(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  await pool.query('TRUNCATE users, oauth_states CASCADE');
}
