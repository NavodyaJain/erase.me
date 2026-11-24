import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './accounts.js';
import { requestFollowups, requests } from './requests.js';
import { createdAt, idCheck, ts } from './_shared.js';

/**
 * Idempotency for actions that send (TRD 6.2: `Idempotency-Key`). A row is a claim on one send:
 * `in_progress` while the message is being handed to the sender, `completed` once the request is marked sent
 * (with the response to replay), `failed` when the sender definitively refused, which frees the request for
 * another attempt. An unknown outcome (a timeout) stays `in_progress` on purpose: the request is not marked
 * sent and not retried automatically. Holds ids, codes and the response sent back; never draft text or addresses.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id),
    /** For a follow-up send: which follow-up. Null for the first request's send. */
    followupId: text('followup_id').references(() => requestFollowups.id),
    status: text('status').notNull().default('in_progress'),
    responseStatus: integer('response_status'),
    response: jsonb('response'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    uniqueIndex('idempotency_keys_user_scope_key').on(t.userId, t.scope, t.key),
    // At most one send in flight or done per request, whatever key it used.
    uniqueIndex('idempotency_keys_one_active_send')
      .on(t.requestId)
      .where(sql`${t.scope} = 'send' and ${t.status} in ('in_progress', 'completed')`),
    // At most one follow-up send in flight or done per follow-up, whatever key it used.
    uniqueIndex('idempotency_keys_one_active_followup_send')
      .on(t.followupId)
      .where(sql`${t.scope} = 'followup_send' and ${t.status} in ('in_progress', 'completed')`),
    idCheck(t, 'idempotency_keys', 'idk'),
    check('idempotency_keys_scope', sql`${t.scope} in ('send', 'followup_send')`),
    check('idempotency_keys_followup_scope', sql`(${t.scope} = 'followup_send') = (${t.followupId} IS NOT NULL)`),
    check('idempotency_keys_status', sql`${t.status} in ('in_progress', 'completed', 'failed')`),
    check('idempotency_keys_key_length', sql`char_length(${t.key}) between 8 and 128`),
    check('idempotency_keys_completed_has_response', sql`${t.status} <> 'completed' OR (${t.response} IS NOT NULL AND ${t.responseStatus} IS NOT NULL)`),
  ],
);
