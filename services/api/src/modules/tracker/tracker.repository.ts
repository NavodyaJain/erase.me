import { sql } from 'drizzle-orm';
import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';

/** A sent request whose Gmail thread should be checked for replies. */
export interface PollableRequest {
  requestId: string;
  userId: string;
  inboxId: string;
  status: 'sent' | 'no_reply';
  threadId: string;
  /** Gmail's id of the message we sent, and its Message-ID header. Either may be missing for an older request. */
  sentMessageId: string | null;
  sentRfcMessageId: string | null;
  /** Domains that belong to the company: its own and the one the request was addressed to. */
  companyDomains: string[];
  contactEmail: string | null;
}

/** One reply found on a thread. Metadata only: this is exactly what is stored. */
export interface NewReply {
  gmailMessageId: string;
  receivedAt: Date;
  senderDomain: string | null;
  senderMatch: 'company' | 'other' | 'unknown';
  automatic: boolean;
}

export interface ApplyResult {
  /** Replies that were not recorded before, and how many of those were automatic. */
  added: number;
  addedAutomatic: number;
  /** The request moved to `reply_received`. */
  moved: boolean;
}

interface PollRow extends Record<string, unknown> {
  request_id: string;
  user_id: string;
  inbox_id: string;
  status: 'sent' | 'no_reply';
  thread_id: string;
  sent_message_id: string | null;
  sent_rfc_message_id: string | null;
  company_domains: string[] | null;
  to_email: string | null;
}

/**
 * Data access for tracking after send. Everything here is metadata: ids, times, a domain and flags.
 * A user whose account is pending deletion, or whose inbox is not connected, is never returned for polling
 * (the 7-day undo window pauses reply checks), and a reply is not applied to such a user either.
 */
export function createTrackerRepository(db: Db) {
  return {
    /** The requests to check, the longest-unchecked first. */
    async listPollable(now: Date, maxAgeDays: number, limit: number): Promise<PollableRequest[]> {
      const result = await db.execute<PollRow>(sql`
        SELECT r.id AS request_id, r.user_id, uc.inbox_id, r.status, r.thread_id, r.sent_message_id, r.sent_rfc_message_id,
               c.domains AS company_domains,
               (SELECT d.to_email FROM request_drafts d WHERE d.request_id = r.id ORDER BY d.version DESC LIMIT 1) AS to_email
          FROM requests r
          JOIN user_companies uc ON uc.id = r.user_company_id AND uc.user_id = r.user_id
          JOIN companies c ON c.id = uc.company_id
          JOIN users u ON u.id = r.user_id AND u.status = 'active'
          JOIN inboxes i ON i.id = uc.inbox_id AND i.status = 'connected'
         WHERE r.status IN ('sent', 'no_reply')
           AND r.channel = 'email'
           AND r.thread_id IS NOT NULL
           AND r.sent_at > ${now}::timestamptz - make_interval(days => ${maxAgeDays})
         ORDER BY r.reply_checked_at ASC NULLS FIRST, r.id
         LIMIT ${limit}`);
      return result.rows.map((row) => ({
        requestId: row.request_id,
        userId: row.user_id,
        inboxId: row.inbox_id,
        status: row.status,
        threadId: row.thread_id,
        sentMessageId: row.sent_message_id,
        sentRfcMessageId: row.sent_rfc_message_id,
        companyDomains: row.company_domains ?? [],
        contactEmail: row.to_email,
      }));
    },

    /** A check that could not finish: remember when, and count it. The request goes to the back of the queue. */
    async recordFailedCheck(requestId: string, now: Date): Promise<void> {
      await db.execute(sql`UPDATE requests SET reply_checked_at = ${now}, reply_check_failures = reply_check_failures + 1 WHERE id = ${requestId}`);
    },

    /**
     * Stores the replies found and, if a person (not an automatic message) has replied, moves the request to
     * `reply_received` and records the event. Done in one transaction on the locked request, so a reply that arrives
     * while the person is setting an outcome, or after the account went into deletion, changes nothing it should not.
     * An automatic reply is stored but never changes the status.
     */
    async applyCheck(requestId: string, now: Date, replies: NewReply[]): Promise<ApplyResult> {
      return db.transaction(async (tx) => {
        const locked = await tx.execute<{ status: string; user_status: string; first_reply_at: Date | null }>(sql`
          SELECT r.status, u.status AS user_status, r.first_reply_at
            FROM requests r JOIN users u ON u.id = r.user_id
           WHERE r.id = ${requestId} FOR UPDATE OF r`);
        const row = locked.rows[0];
        if (!row) return { added: 0, addedAutomatic: 0, moved: false };
        const active = row.user_status === 'active';

        const added: NewReply[] = [];
        if (active) {
          for (const r of replies) {
            const inserted = await tx.execute(sql`
              INSERT INTO request_replies (id, request_id, gmail_message_id, received_at, sender_domain, sender_match, automatic)
              VALUES (${newId('reply')}, ${requestId}, ${r.gmailMessageId}, ${r.receivedAt}, ${r.senderDomain}, ${r.senderMatch}, ${r.automatic})
              ON CONFLICT (request_id, gmail_message_id) DO NOTHING
              RETURNING id`);
            if (inserted.rows.length > 0) added.push(r);
          }
        }

        const people = added.filter((r) => !r.automatic);
        const moves = active && people.length > 0 && (row.status === 'sent' || row.status === 'no_reply');
        if (moves) {
          const first = people.reduce((a, b) => (a.receivedAt <= b.receivedAt ? a : b)).receivedAt;
          await tx.execute(sql`
            UPDATE requests
               SET status = 'reply_received',
                   first_reply_at = COALESCE(first_reply_at, ${first}),
                   reply_checked_at = ${now}, reply_check_failures = 0, updated_at = ${now}
             WHERE id = ${requestId}`);
          await tx.execute(sql`
            INSERT INTO request_events (id, request_id, type, actor_type, payload)
            VALUES (${newId('event')}, ${requestId}, 'reply_received', 'system',
                    ${JSON.stringify({ replies: people.length, automatic: added.length - people.length, from: row.status })}::jsonb)`);
        } else {
          await tx.execute(sql`UPDATE requests SET reply_checked_at = ${now}, reply_check_failures = 0 WHERE id = ${requestId}`);
        }
        return { added: added.length, addedAutomatic: added.length - people.length, moved: moves };
      });
    },

    /** A check that found nothing new, or a thread that no longer exists. */
    async recordCheck(requestId: string, now: Date): Promise<void> {
      await db.execute(sql`UPDATE requests SET reply_checked_at = ${now}, reply_check_failures = 0 WHERE id = ${requestId}`);
    },
  };
}

export type TrackerRepository = ReturnType<typeof createTrackerRepository>;
