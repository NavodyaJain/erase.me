import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { scrubString } from '../common/scrub.js';
import { loadMigrationUrl } from './migration-env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/db (tsx) and from dist/db (compiled) as long as src/db/migrations is shipped.
export const MIGRATIONS_FOLDER = path.resolve(here, '../../src/db/migrations');

/** Applies pending migrations as the owner role. Forward-only (TRD 12). */
export async function runMigrations(connectionString: string, folder: string = MIGRATIONS_FOLDER): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations(loadMigrationUrl())
    .then(() => process.stdout.write('Migrations applied.\n'))
    .catch((err: unknown) => {
      process.stderr.write(`Migration failed: ${scrubString(err instanceof Error ? err.message : 'unknown error')}\n`);
      process.exit(1);
    });
}
