import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { inboxStatus, scanStatus, userStatus } from './enums.js';
import { createdAt, emptyTextArray, idCheck, ts, updatedAt } from './_shared.js';

/** PRD section 8: Google account id, email and name are stored for sign-in. */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    googleSub: text('google_sub').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    status: userStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [uniqueIndex('users_google_sub_key').on(t.googleSub), idCheck(t, 'users', 'usr')],
);

/**
 * A connected Gmail inbox (F1). The refresh token is stored encrypted (envelope encryption, TRD 8.3).
 * `purge_after` is the retention field: set to disconnect time + 30 days. The purge job is Phase 2.
 */
export const inboxes = pgTable(
  'inboxes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    email: text('email').notNull(),
    provider: text('provider').notNull().default('gmail'),
    status: inboxStatus('status').notNull().default('connected'),
    tokenCiphertext: text('token_ciphertext'),
    tokenKeyId: text('token_key_id'),
    scopes: text('scopes').array().notNull().default(emptyTextArray),
    connectedAt: ts('connected_at').notNull().defaultNow(),
    disconnectedAt: ts('disconnected_at'),
    lastScanAt: ts('last_scan_at'),
    purgeAfter: ts('purge_after'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('inboxes_user_email_key').on(t.userId, t.email),
    // Target for composite foreign keys that must stay within one user.
    unique('inboxes_id_user_key').on(t.id, t.userId),
    index('inboxes_user_id_idx').on(t.userId),
    idCheck(t, 'inboxes', 'inb'),
    check('inboxes_provider_gmail', sql`${t.provider} = 'gmail'`),
    check(
      'inboxes_connected_has_token',
      sql`${t.status} <> 'connected' OR (${t.tokenCiphertext} IS NOT NULL AND ${t.tokenKeyId} IS NOT NULL)`,
    ),
    // Disconnecting revokes the token, so no ciphertext may remain, and the retention clock must start.
    check(
      'inboxes_disconnected_dropped_token',
      sql`${t.status} <> 'disconnected' OR (${t.tokenCiphertext} IS NULL AND ${t.disconnectedAt} IS NOT NULL AND ${t.purgeAfter} IS NOT NULL)`,
    ),
    check('inboxes_purge_needs_disconnect', sql`${t.purgeAfter} IS NULL OR ${t.disconnectedAt} IS NOT NULL`),
  ],
);

/** One scan job run per inbox (F2). `cursor` is a Gmail page token; it is not email content. */
export const scans = pgTable(
  'scans',
  {
    id: text('id').primaryKey(),
    inboxId: text('inbox_id')
      .notNull()
      .references(() => inboxes.id),
    status: scanStatus('status').notNull().default('queued'),
    progressPct: integer('progress_pct').notNull().default(0),
    foundCount: integer('found_count').notNull().default(0),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    cursor: text('cursor'),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (t) => [
    index('scans_inbox_id_idx').on(t.inboxId),
    // At most one active scan per inbox: makes "start scan" idempotent (F2-AC2).
    uniqueIndex('scans_one_active_per_inbox')
      .on(t.inboxId)
      .where(sql`${t.status} in ('queued', 'running')`),
    idCheck(t, 'scans', 'scn'),
    check('scans_progress_range', sql`${t.progressPct} between 0 and 100`),
    check('scans_found_count_nonneg', sql`${t.foundCount} >= 0`),
  ],
);
