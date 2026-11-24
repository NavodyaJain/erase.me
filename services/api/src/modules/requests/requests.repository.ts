import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';
import { companies, idempotencyKeys, inboxes, requestDrafts, requestEvents, requestFollowups, requestReplies, requests, userCompanies, users } from '../../db/schema/index.js';
import type { RequestEventType, RequestStatus } from './state-machine.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export interface RequestRow {
  id: string;
  userId: string;
  userCompanyId: string;
  status: RequestStatus;
  threadId: string | null;
  /** `email`: sent from the person's Gmail. `web_form`: the person pasted it into the company's form. */
  channel: 'email' | 'web_form';
  /** The Message-ID of the message that was sent, so a follow-up can answer it. */
  sentRfcMessageId: string | null;
  sentAt: Date | null;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Replies seen on a sent request's thread, as counts and times. Nothing from the messages themselves. */
export interface ReplySummary {
  /** Replies from a person, and automatic ones, counted apart. */
  count: number;
  automaticCount: number;
  firstAt: Date | null;
  lastAt: Date | null;
  /** Whether the first reply from a person came from the company's own domain. Null until there is one. */
  senderMatch: 'company' | 'other' | 'unknown' | null;
}

export interface DraftRow {
  id: string;
  requestId: string;
  /** Set for a follow-up's draft; null for the first request's. */
  followupId: string | null;
  version: number;
  toEmail: string;
  subject: string;
  body: string;
  draftHash: string;
  createdBy: 'template' | 'ai' | 'user';
  createdAt: Date;
}

/** A follow-up to a request with no reply: its status and when it was sent. The text is in its drafts. */
export interface FollowupRow {
  id: string;
  requestId: string;
  sequence: number;
  status: 'drafted' | 'approved' | 'sent' | 'submitted' | 'cancelled';
  approvedHash: string | null;
  sentAt: Date | null;
  gmailMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A request the follow-up sweep may act on. */
export interface FollowupCandidate {
  requestId: string;
  userId: string;
}

export interface EventRow {
  id: string;
  type: string;
  actorType: 'user' | 'system' | 'admin';
  draftHash: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Everything about the company a request is for that the guards need. */
export interface CompanyContext {
  userCompanyId: string;
  inboxId: string;
  userCompanyStatus: 'active' | 'not_mine' | 'requested';
  /** When the user chose "keep" for this company, if they did. */
  keptAt: Date | null;
  riskLevel: string | null;
  signals: string[];
  companyId: string;
  companyName: string;
  mustKeep: boolean;
  isFictional: boolean;
  grievanceEmail: string | null;
  grievanceSource: string | null;
  grievanceVerifiedOn: string | null;
  grievanceStatus: 'unknown' | 'verified' | 'bounced';
  /** `email` (grievanceEmail) or `web_form` (grievanceFormUrl). */
  grievanceChannel: 'email' | 'web_form';
  grievanceFormUrl: string | null;
  selfServeUrl: string | null;
}

export interface ClaimRow {
  id: string;
  requestId: string;
  status: 'in_progress' | 'completed' | 'failed';
  responseStatus: number | null;
  response: unknown;
  /** Set for a follow-up's send. */
  followupId: string | null;
}

const requestColumns = {
  id: requests.id,
  userId: requests.userId,
  userCompanyId: requests.userCompanyId,
  status: requests.status,
  threadId: requests.threadId,
  channel: requests.channel,
  sentRfcMessageId: requests.sentRfcMessageId,
  sentAt: requests.sentAt,
  dueAt: requests.dueAt,
  createdAt: requests.createdAt,
  updatedAt: requests.updatedAt,
};

const draftColumns = {
  id: requestDrafts.id,
  requestId: requestDrafts.requestId,
  followupId: requestDrafts.followupId,
  version: requestDrafts.version,
  toEmail: requestDrafts.toEmail,
  subject: requestDrafts.subject,
  body: requestDrafts.body,
  draftHash: requestDrafts.draftHash,
  createdBy: requestDrafts.createdBy,
  createdAt: requestDrafts.createdAt,
};

const contextColumns = {
  userCompanyId: userCompanies.id,
  inboxId: userCompanies.inboxId,
  userCompanyStatus: userCompanies.status,
  keptAt: userCompanies.keptAt,
  riskLevel: userCompanies.riskLevel,
  signals: userCompanies.signalTypes,
  companyId: companies.id,
  companyName: companies.name,
  mustKeep: companies.mustKeep,
  isFictional: companies.isFictional,
  grievanceEmail: companies.grievanceEmail,
  grievanceSource: companies.grievanceSource,
  grievanceVerifiedOn: companies.grievanceVerifiedOn,
  grievanceStatus: companies.grievanceStatus,
  grievanceChannel: companies.grievanceChannel,
  grievanceFormUrl: companies.grievanceFormUrl,
  selfServeUrl: companies.selfServeUrl,
};

const followupColumns = {
  id: requestFollowups.id,
  requestId: requestFollowups.requestId,
  sequence: requestFollowups.sequence,
  status: requestFollowups.status,
  approvedHash: requestFollowups.approvedHash,
  sentAt: requestFollowups.sentAt,
  gmailMessageId: requestFollowups.gmailMessageId,
  createdAt: requestFollowups.createdAt,
  updatedAt: requestFollowups.updatedAt,
};

const claimColumns = {
  id: idempotencyKeys.id,
  requestId: idempotencyKeys.requestId,
  status: idempotencyKeys.status,
  responseStatus: idempotencyKeys.responseStatus,
  response: idempotencyKeys.response,
  followupId: idempotencyKeys.followupId,
};

function methods(x: Executor) {
  return {
    async profile(userId: string): Promise<{ name: string; email: string } | undefined> {
      const [row] = await x.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
      return row;
    },

    /** Ownership is part of the query: another user's company looks like a missing one. */
    async contextForUserCompany(userId: string, userCompanyId: string): Promise<CompanyContext | undefined> {
      const [row] = await x
        .select(contextColumns)
        .from(userCompanies)
        .innerJoin(companies, eq(companies.id, userCompanies.companyId))
        .where(and(eq(userCompanies.id, userCompanyId), eq(userCompanies.userId, userId)));
      return row as CompanyContext | undefined;
    },

    async contextForRequest(userId: string, requestId: string): Promise<CompanyContext | undefined> {
      const [row] = await x
        .select(contextColumns)
        .from(requests)
        .innerJoin(userCompanies, and(eq(userCompanies.id, requests.userCompanyId), eq(userCompanies.userId, requests.userId)))
        .innerJoin(companies, eq(companies.id, userCompanies.companyId))
        .where(and(eq(requests.id, requestId), eq(requests.userId, userId)));
      return row as CompanyContext | undefined;
    },

    async getRequest(userId: string, requestId: string): Promise<RequestRow | undefined> {
      const [row] = await x
        .select(requestColumns)
        .from(requests)
        .where(and(eq(requests.id, requestId), eq(requests.userId, userId)));
      return row as RequestRow | undefined;
    },

    /** True while the person has asked to delete their data. Nothing is sent for them then, even by a call already on its way. */
    async deletionPending(userId: string): Promise<boolean> {
      const rows = await x.select({ status: users.status }).from(users).where(eq(users.id, userId));
      return rows[0]?.status !== 'active';
    },

    /** Takes the row lock that serialises edit, approve, close and send on one request. */
    async lockRequest(userId: string, requestId: string): Promise<RequestRow | undefined> {
      const [row] = await x
        .select(requestColumns)
        .from(requests)
        .where(and(eq(requests.id, requestId), eq(requests.userId, userId)))
        .for('update');
      return row as RequestRow | undefined;
    },

    async listRequests(userId: string) {
      return x
        .select({ ...requestColumns, companyName: companies.name, mustKeep: companies.mustKeep })
        .from(requests)
        .innerJoin(userCompanies, eq(userCompanies.id, requests.userCompanyId))
        .innerJoin(companies, eq(companies.id, userCompanies.companyId))
        .where(eq(requests.userId, userId))
        .orderBy(desc(requests.updatedAt), desc(requests.id));
    },

    async findOpenRequest(userCompanyId: string): Promise<RequestRow | undefined> {
      const [row] = await x
        .select(requestColumns)
        .from(requests)
        .where(and(eq(requests.userCompanyId, userCompanyId), sql`${requests.status} not in ('closed', 'bounced')`));
      return row as RequestRow | undefined;
    },

    /** Returns undefined when the company already has an open request (unique index). */
    async insertRequest(userId: string, userCompanyId: string, channel: 'email' | 'web_form' = 'email'): Promise<RequestRow | undefined> {
      const [row] = await x
        .insert(requests)
        .values({ id: newId('request'), userId, userCompanyId, status: 'drafted', channel })
        .onConflictDoNothing()
        .returning(requestColumns);
      return row as RequestRow | undefined;
    },

    async setStatus(requestId: string, status: RequestStatus): Promise<void> {
      await x.update(requests).set({ status, updatedAt: sql`now()` }).where(eq(requests.id, requestId));
    },

    async markSent(requestId: string, p: { threadId: string; sentAt: Date; dueAt: Date; sentMessageId?: string; sentRfcMessageId?: string }): Promise<void> {
      await x
        .update(requests)
        .set({
          status: 'sent',
          threadId: p.threadId,
          sentAt: p.sentAt,
          dueAt: p.dueAt,
          day30FollowupAt: p.dueAt,
          sentMessageId: p.sentMessageId ?? null,
          sentRfcMessageId: p.sentRfcMessageId ?? null,
          updatedAt: sql`now()`,
        })
        .where(eq(requests.id, requestId));
    },

    /**
     * The person pasted the draft into the company's web form. Nothing was sent from here, so there is no thread. The
     * request is `sent` from then on (the clock for a reply starts) and is marked as a form request.
     */
    async markSubmitted(requestId: string, p: { sentAt: Date; dueAt: Date }): Promise<void> {
      await x
        .update(requests)
        .set({ status: 'sent', channel: 'web_form', threadId: null, sentAt: p.sentAt, dueAt: p.dueAt, day30FollowupAt: p.dueAt, updatedAt: sql`now()` })
        .where(eq(requests.id, requestId));
    },

    /** How many replies have been seen on this request, from metadata rows only. */
    async replySummary(requestId: string): Promise<ReplySummary> {
      const [row] = await x
        .select({
          count: sql<number>`count(*) filter (where not ${requestReplies.automatic})`.mapWith(Number),
          automaticCount: sql<number>`count(*) filter (where ${requestReplies.automatic})`.mapWith(Number),
          firstAt: sql<Date | string | null>`min(${requestReplies.receivedAt}) filter (where not ${requestReplies.automatic})`,
          lastAt: sql<Date | string | null>`max(${requestReplies.receivedAt}) filter (where not ${requestReplies.automatic})`,
          senderMatch: sql<ReplySummary['senderMatch']>`(array_agg(${requestReplies.senderMatch} order by ${requestReplies.receivedAt}, ${requestReplies.id}) filter (where not ${requestReplies.automatic}))[1]`,
        })
        .from(requestReplies)
        .where(eq(requestReplies.requestId, requestId));
      const at = (v: Date | string | null | undefined): Date | null => (v ? new Date(v) : null);
      return {
        count: row?.count ?? 0,
        automaticCount: row?.automaticCount ?? 0,
        firstAt: at(row?.firstAt),
        lastAt: at(row?.lastAt),
        senderMatch: row?.senderMatch ?? null,
      };
    },

    async latestDraft(requestId: string): Promise<DraftRow | undefined> {
      const [row] = await x
        .select(draftColumns)
        .from(requestDrafts)
        .where(and(eq(requestDrafts.requestId, requestId), isNull(requestDrafts.followupId)))
        .orderBy(desc(requestDrafts.version))
        .limit(1);
      return row as DraftRow | undefined;
    },

    // ---- follow-ups (Phase 2) ----

    /** Every follow-up of a request, the first one first. */
    async followups(requestId: string): Promise<FollowupRow[]> {
      const rows = await x.select(followupColumns).from(requestFollowups).where(eq(requestFollowups.requestId, requestId)).orderBy(requestFollowups.sequence);
      return rows as FollowupRow[];
    },

    /** Undefined when this sequence number or another open follow-up already exists. */
    async insertFollowup(requestId: string, sequence: number): Promise<FollowupRow | undefined> {
      const [row] = await x.insert(requestFollowups).values({ id: newId('followup'), requestId, sequence, status: 'drafted' }).onConflictDoNothing().returning(followupColumns);
      return row as FollowupRow | undefined;
    },

    async setFollowup(id: string, patch: { status: FollowupRow['status']; approvedHash?: string | null; sentAt?: Date; gmailMessageId?: string }): Promise<void> {
      await x
        .update(requestFollowups)
        .set({
          status: patch.status,
          ...(patch.approvedHash !== undefined ? { approvedHash: patch.approvedHash } : {}),
          ...(patch.sentAt ? { sentAt: patch.sentAt } : {}),
          ...(patch.gmailMessageId ? { gmailMessageId: patch.gmailMessageId } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(requestFollowups.id, id));
    },

    async latestFollowupDraft(followupId: string): Promise<DraftRow | undefined> {
      const [row] = await x.select(draftColumns).from(requestDrafts).where(eq(requestDrafts.followupId, followupId)).orderBy(desc(requestDrafts.version)).limit(1);
      return row as DraftRow | undefined;
    },

    async insertFollowupDraft(d: { requestId: string; followupId: string; version: number; to: string; subject: string; body: string; hash: string; createdBy: 'template' | 'user' }): Promise<DraftRow> {
      const [row] = await x
        .insert(requestDrafts)
        .values({
          id: newId('draft'),
          requestId: d.requestId,
          followupId: d.followupId,
          version: d.version,
          toEmail: d.to,
          subject: d.subject,
          body: d.body,
          draftHash: d.hash,
          createdBy: d.createdBy,
          createdAt: sql`clock_timestamp()`,
        })
        .returning(draftColumns);
      return row as DraftRow;
    },

    /** A user approval of exactly this follow-up draft hash, at or after the draft (mirrors migration 0013). */
    async hasFollowupApproval(requestId: string, draftHash: string, notBefore: Date): Promise<boolean> {
      const rows = await x
        .select({ id: requestEvents.id })
        .from(requestEvents)
        .where(and(eq(requestEvents.requestId, requestId), eq(requestEvents.type, 'followup_approved'), eq(requestEvents.actorType, 'user'), eq(requestEvents.draftHash, draftHash), gte(requestEvents.createdAt, notBefore)))
        .limit(1);
      return rows.length > 0;
    },

    /**
     * Requests whose follow-up day has come and that have no follow-up yet. Nobody who asked to delete their data, no company the
     * person keeps, no must-keep company and none marked as not theirs. Only requests still waiting (sent, or no reply): one with a
     * reply or a reported outcome is left alone.
     */
    async followupCandidates(now: Date, afterDays: number, limit: number): Promise<FollowupCandidate[]> {
      const result = await x.execute<{ request_id: string; user_id: string }>(sql`
        SELECT r.id AS request_id, r.user_id
          FROM requests r
          JOIN user_companies uc ON uc.id = r.user_company_id AND uc.user_id = r.user_id
          JOIN companies c ON c.id = uc.company_id
          JOIN users u ON u.id = r.user_id AND u.status = 'active'
         WHERE r.status IN ('sent', 'no_reply')
           AND r.sent_at IS NOT NULL
           AND r.sent_at + make_interval(days => ${afterDays}) <= ${now}::timestamptz
           AND uc.kept_at IS NULL
           AND uc.status <> 'not_mine'
           AND uc.risk_level IS DISTINCT FROM 'must_keep'
           AND c.must_keep = false
           AND NOT EXISTS (SELECT 1 FROM request_followups f WHERE f.request_id = r.id)
         ORDER BY r.sent_at ASC, r.id
         LIMIT ${limit}`);
      return result.rows.map((row) => ({ requestId: row.request_id, userId: row.user_id }));
    },

    /** `created_at` is the wall clock at insert (not the transaction start), so event order matches lock order. */
    async insertDraft(d: { requestId: string; version: number; to: string; subject: string; body: string; hash: string; createdBy: 'template' | 'user' }): Promise<DraftRow> {
      const [row] = await x
        .insert(requestDrafts)
        .values({
          id: newId('draft'),
          requestId: d.requestId,
          version: d.version,
          toEmail: d.to,
          subject: d.subject,
          body: d.body,
          draftHash: d.hash,
          createdBy: d.createdBy,
          createdAt: sql`clock_timestamp()`,
        })
        .returning(draftColumns);
      return row as DraftRow;
    },

    async insertEvent(e: {
      requestId: string;
      type: RequestEventType;
      actorType: 'user' | 'system' | 'admin';
      actorId?: string;
      draftHash?: string;
      payload?: Record<string, unknown>;
    }): Promise<void> {
      await x.insert(requestEvents).values({
        id: newId('event'),
        requestId: e.requestId,
        type: e.type,
        actorType: e.actorType,
        actorId: e.actorId ?? null,
        draftHash: e.draftHash ?? null,
        payload: e.payload ?? {},
        createdAt: sql`clock_timestamp()`,
      });
    },

    async events(requestId: string): Promise<EventRow[]> {
      const rows = await x
        .select({
          id: requestEvents.id,
          type: requestEvents.type,
          actorType: requestEvents.actorType,
          draftHash: requestEvents.draftHash,
          payload: requestEvents.payload,
          createdAt: requestEvents.createdAt,
        })
        .from(requestEvents)
        .where(eq(requestEvents.requestId, requestId))
        .orderBy(requestEvents.createdAt, requestEvents.id);
      return rows as EventRow[];
    },

    /** A user approval of exactly this hash, recorded at or after the draft it approves (mirrors migration 0002). */
    async hasUserApproval(requestId: string, draftHash: string, notBefore: Date): Promise<boolean> {
      const rows = await x
        .select({ id: requestEvents.id })
        .from(requestEvents)
        .where(
          and(
            eq(requestEvents.requestId, requestId),
            eq(requestEvents.type, 'approved'),
            eq(requestEvents.actorType, 'user'),
            eq(requestEvents.draftHash, draftHash),
            gte(requestEvents.createdAt, notBefore),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async inbox(inboxId: string) {
      const [row] = await x
        .select({ id: inboxes.id, userId: inboxes.userId, email: inboxes.email, status: inboxes.status, scopes: inboxes.scopes })
        .from(inboxes)
        .where(eq(inboxes.id, inboxId));
      return row;
    },

    // ---- idempotency claims ----

    async findClaim(userId: string, scope: 'send' | 'followup_send', key: string): Promise<ClaimRow | undefined> {
      const [row] = await x
        .select(claimColumns)
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
      return row as ClaimRow | undefined;
    },

    async activeSendClaim(requestId: string): Promise<ClaimRow | undefined> {
      const [row] = await x
        .select(claimColumns)
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.requestId, requestId), eq(idempotencyKeys.scope, 'send'), inArray(idempotencyKeys.status, ['in_progress', 'completed'])));
      return row as ClaimRow | undefined;
    },

    /** A follow-up send is in flight or done for this follow-up. */
    async activeFollowupClaim(followupId: string): Promise<ClaimRow | undefined> {
      const [row] = await x
        .select(claimColumns)
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.followupId, followupId), eq(idempotencyKeys.scope, 'followup_send'), inArray(idempotencyKeys.status, ['in_progress', 'completed'])));
      return row as ClaimRow | undefined;
    },

    /** Undefined when another send for this request (or follow-up) is already in flight or done, or the key was used. */
    async insertClaim(userId: string, requestId: string, key: string, followupId?: string): Promise<ClaimRow | undefined> {
      const [row] = await x
        .insert(idempotencyKeys)
        .values({ id: newId('idempotencyKey'), userId, scope: followupId ? 'followup_send' : 'send', key, requestId, ...(followupId ? { followupId } : {}), status: 'in_progress' })
        .onConflictDoNothing()
        .returning(claimColumns);
      return row as ClaimRow | undefined;
    },

    /** A failed claim (the sender refused, nothing was sent) is taken over by a retry with the same key. */
    async reclaim(claimId: string): Promise<ClaimRow | undefined> {
      const rows = await x
        .update(idempotencyKeys)
        .set({ status: 'in_progress', responseStatus: null, response: null, completedAt: null })
        .where(and(eq(idempotencyKeys.id, claimId), eq(idempotencyKeys.status, 'failed')))
        .returning(claimColumns);
      return rows[0] as ClaimRow | undefined;
    },

    async completeClaim(claimId: string, responseStatus: number, response: Record<string, unknown>): Promise<void> {
      await x
        .update(idempotencyKeys)
        .set({ status: 'completed', responseStatus, response, completedAt: sql`now()` })
        .where(eq(idempotencyKeys.id, claimId));
    },

    async failClaim(claimId: string): Promise<void> {
      await x.update(idempotencyKeys).set({ status: 'failed', completedAt: sql`now()` }).where(eq(idempotencyKeys.id, claimId));
    },

    /** Real sends the user has completed since `since`, for the daily cap. Fake sends do not count. */
    async countRealSendsSince(userId: string, since: Date): Promise<number> {
      const [row] = await x
        .select({ n: sql<number>`count(*)::int` })
        .from(requestEvents)
        .innerJoin(requests, eq(requests.id, requestEvents.requestId))
        .where(and(eq(requests.userId, userId), inArray(requestEvents.type, ['sent', 'followup_sent']), gte(requestEvents.createdAt, since), sql`${requestEvents.payload}->>'delivery' = 'real'`));
      return row?.n ?? 0;
    },
  };
}

export type RequestsTx = ReturnType<typeof methods>;

/** The only code that touches requests, drafts, events and send claims. */
export function createRequestsRepository(db: Db) {
  return {
    ...methods(db),
    /** One database transaction. Row locks taken inside it are released at the end. */
    transaction<T>(fn: (tx: RequestsTx) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(methods(tx)));
    },
  };
}
export type RequestsRepository = ReturnType<typeof createRequestsRepository>;
