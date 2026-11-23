import pg from 'pg';

/**
 * Database roles belong to the whole Postgres cluster, not to one database. Migration 0001 creates `erase_app` with
 * "create it if it is missing", which is a check followed by a create, and the test helper does the same for the login
 * role. Test files run in parallel and each migrates its own fresh database, so on a brand new cluster (CI, or a new
 * container) two files can both find a role missing and one fails with a duplicate key on pg_authid_rolname_index.
 * Locally the roles already exist, so it never shows.
 *
 * This runs once, in the main process, before any worker starts. The roles it creates are exactly the ones the
 * migration and the helper would create (the same names, NOLOGIN group role, and the login role as a member of it), and
 * the migrations themselves are untouched. If Postgres is not reachable, nothing happens here: tests that need a
 * database report that themselves with a clear message.
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://erase:erase@localhost:5432/postgres';
  const admin = new pg.Client({ connectionString: url });
  try {
    await admin.connect();
  } catch {
    return;
  }
  try {
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erase_app') THEN
          CREATE ROLE erase_app NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erase_api_test') THEN
          CREATE ROLE erase_api_test LOGIN PASSWORD 'erase_api_test' IN ROLE erase_app;
        END IF;
      END $$`);
  } finally {
    await admin.end();
  }
}
