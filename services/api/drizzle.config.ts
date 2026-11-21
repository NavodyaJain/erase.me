import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` needs no database connection. Migrations are applied by src/db/migrate.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  strict: true,
  verbose: true,
});
