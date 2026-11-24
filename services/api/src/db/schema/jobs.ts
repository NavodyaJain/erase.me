import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, idCheck, ts } from './_shared.js';
import { jsonb } from 'drizzle-orm/pg-core';

/**
 * One row per run of a purge task. Counts only: the database refuses anything in `counts` that is not a whole number,
 * so no id, address or text can be written here. Written by the purge functions, read by the app.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    task: text('task').notNull(),
    dryRun: boolean('dry_run').notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    counts: jsonb('counts').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    idCheck(t, 'job_runs', 'job'),
    check('job_runs_task', sql`${t.task} IN ('purge_user', 'purge_inboxes', 'purge_users', 'purge_sessions', 'purge_requests')`),
    check('job_runs_counts_only', sql`public.counts_only(${t.counts})`),
    index('job_runs_task_started_idx').on(t.task, t.startedAt),
  ],
);
