import { z } from 'zod';
import { EnvError } from '../config/env.js';

const MigrationEnv = z.object({
  DATABASE_MIGRATION_URL: z.string().refine(
    (v) => {
      try {
        return ['postgres:', 'postgresql:'].includes(new URL(v).protocol);
      } catch {
        return false;
      }
    },
    { message: 'must be a valid Postgres URL' },
  ),
});

/** The migrate script needs only the owner-role URL, not the app's restricted one or any other setting. */
export function loadMigrationUrl(source: Record<string, string | undefined> = process.env): string {
  const parsed = MigrationEnv.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((i) => ({ variable: String(i.path[0]), message: i.message })));
  }
  return parsed.data.DATABASE_MIGRATION_URL;
}
