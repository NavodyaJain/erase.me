import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, numeric, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './accounts.js';
import { userCompanies } from './companies.js';
import { actorType, draftAuthor, replyLabel, replyLabelSource, requestEventType, requestStatus } from './enums.js';
import { createdAt, emptyTextArray, idCheck, ts, updatedAt } from './_shared.js';

const SHA256_HEX = sql.raw(`'^[0-9a-f]{64}$'`);

/**
 * An erasure request (F6, F7). `status` follows the state machine in PRD F7. Leaving the pre-send
 * states requires a user approval of the current draft: the service enforces it and a database
 * trigger (migration 0002) enforces it again.
 */
export const requests = pgTable(
  'requests',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    userCompanyId: text('user_company_id').notNull(),
    status: requestStatus('status').notNull().default('drafted'),
    threadId: text('thread_id'),
    sentAt: ts('sent_at'),
    dueAt: ts('due_at'),
    day30FollowupAt: ts('day30_followup_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A request can only point at a company that belongs to the same user.
    foreignKey({
      name: 'requests_user_company_owner_fk',
      columns: [t.userCompanyId, t.userId],
      foreignColumns: [userCompanies.id, userCompanies.userId],
    }),
    index('requests_user_id_idx').on(t.userId),
    index('requests_status_due_at_idx').on(t.status, t.dueAt),
    // One open request per detected company; a closed or bounced one can be replaced.
    uniqueIndex('requests_one_open_per_user_company')
      .on(t.userCompanyId)
      .where(sql`${t.status} not in ('closed', 'bounced')`),
    idCheck(t, 'requests', 'req'),
    // A request that has been sent carries its send details (F6-AC3).
    check(
      'requests_sent_has_details',
      sql`${t.status} in ('drafted', 'approved', 'closed', 'bounced') OR (${t.sentAt} IS NOT NULL AND ${t.threadId} IS NOT NULL AND ${t.dueAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Draft text the user reviews and approves (PRD section 8: "request drafts and approved text: yes").
 * This is Erase.me's own outgoing text, never email received from a company. Rows are immutable:
 * an edit inserts a new version, which changes the hash and requires approval again (F6-AC2).
 */
export const requestDrafts = pgTable(
  'request_drafts',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id),
    version: integer('version').notNull(),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** sha256 hex over the canonical (to, subject, body). Computed by the service. */
    draftHash: text('draft_hash').notNull(),
    createdBy: draftAuthor('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('request_drafts_request_version_key').on(t.requestId, t.version),
    idCheck(t, 'request_drafts', 'drf'),
    check('request_drafts_version_positive', sql`${t.version} >= 1`),
    check('request_drafts_hash_format', sql`${t.draftHash} ~ ${SHA256_HEX}`),
    check('request_drafts_body_size', sql`char_length(${t.body}) between 1 and 20000`),
  ],
);

/** Append-only history of a request (F7-AC1). The app role has INSERT and SELECT only. */
export const requestEvents = pgTable(
  'request_events',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id),
    type: requestEventType('type').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id'),
    /** Hash of the draft this event refers to. Required for `approved` and `sent`. */
    draftHash: text('draft_hash'),
    /** References and codes only. Never draft text, reply text or addresses. */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('request_events_request_created_idx').on(t.requestId, t.createdAt),
    idCheck(t, 'request_events', 'evt'),
    check('request_events_hash_format', sql`${t.draftHash} IS NULL OR ${t.draftHash} ~ ${SHA256_HEX}`),
    check('request_events_approval_has_hash', sql`${t.type} NOT IN ('approved', 'sent') OR ${t.draftHash} IS NOT NULL`),
    check('request_events_payload_object', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
);

/** Classified reply label (F7). Only the label, confidence and signal tags are stored, never reply text. */
export const replyLabels = pgTable(
  'reply_labels',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id),
    label: replyLabel('label').notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull(),
    signals: text('signals').array().notNull().default(emptyTextArray),
    source: replyLabelSource('source').notNull(),
    confirmedBy: text('confirmed_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('reply_labels_request_id_idx').on(t.requestId),
    idCheck(t, 'reply_labels', 'rlb'),
    check('reply_labels_confidence_range', sql`${t.confidence} between 0 and 1`),
  ],
);
