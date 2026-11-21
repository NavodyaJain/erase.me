import { sql } from 'drizzle-orm';
import { check, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';

export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const createdAt = () => ts('created_at').notNull().defaultNow();
export const updatedAt = () => ts('updated_at').notNull().defaultNow();

/** Prefixed ULID format, matching src/common/ids.ts. */
export const idCheck = (table: { id: AnyPgColumn }, tableName: string, prefix: string) =>
  check(`${tableName}_id_format`, sql`${table.id} ~ ${sql.raw(`'^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$'`)}`);

export const emptyTextArray = sql`'{}'::text[]`;
