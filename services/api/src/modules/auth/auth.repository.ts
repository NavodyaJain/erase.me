import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';
import { oauthStates, sessions, users } from '../../db/schema/index.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** Set while the person has asked to delete their data and the undo period has not ended. */
  deletion?: { requestedAt: Date; dueAt: Date } | null;
}

export interface DeletionRow {
  status: 'active' | 'suspended' | 'deleting';
  requestedAt: Date | null;
  dueAt: Date | null;
  purgedAt: Date | null;
  tokenRevokeFailed: number;
}

export interface SessionRecord {
  id: string;
  user: AuthUser;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface OauthStateRecord {
  purpose: 'signin' | 'connect';
  userId: string | null;
  codeVerifier: string;
  nonce: string;
}

/** The only code that touches users, sessions and OAuth state tables. */
export function createAuthRepository(db: Db) {
  return {
    async createOauthState(row: {
      stateHash: string;
      purpose: 'signin' | 'connect';
      userId?: string;
      codeVerifier: string;
      nonce: string;
      expiresAt: Date;
    }): Promise<void> {
      await db.insert(oauthStates).values({
        id: newId('oauthState'),
        stateHash: row.stateHash,
        purpose: row.purpose,
        userId: row.userId ?? null,
        codeVerifier: row.codeVerifier,
        nonce: row.nonce,
        expiresAt: row.expiresAt,
      });
    },

    /** Single use: the first caller gets the row, everyone else (replay, expired) gets undefined. */
    async consumeOauthState(stateHash: string, now: Date): Promise<OauthStateRecord | undefined> {
      const [row] = await db
        .update(oauthStates)
        .set({ consumedAt: now })
        .where(
          and(eq(oauthStates.stateHash, stateHash), isNull(oauthStates.consumedAt), gt(oauthStates.expiresAt, now)),
        )
        .returning({
          purpose: oauthStates.purpose,
          userId: oauthStates.userId,
          codeVerifier: oauthStates.codeVerifier,
          nonce: oauthStates.nonce,
        });
      return row;
    },

    /** Creates the user or refreshes email and name. Returns undefined for an account being deleted. */
    async upsertUser(p: { googleSub: string; email: string; name: string }): Promise<AuthUser | undefined> {
      const [row] = await db
        .insert(users)
        .values({ id: newId('user'), googleSub: p.googleSub, email: p.email, name: p.name })
        .onConflictDoUpdate({
          target: users.googleSub,
          set: { email: p.email, name: p.name, updatedAt: sql`now()` },
          // A person inside the undo period may sign in, to undo it. A purged account (tombstone) and a suspended one may not.
          setWhere: sql`${users.status} = 'active' OR (${users.status} = 'deleting' AND ${users.deletedAt} IS NULL AND ${users.deletionDueAt} > now())`,
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          status: users.status,
          requestedAt: users.deletionRequestedAt,
          dueAt: users.deletionDueAt,
          purgedAt: users.deletedAt,
        });
      if (!row) return undefined;
      if (row.status === 'active') return { id: row.id, email: row.email, name: row.name };
      if (row.status === 'deleting' && !row.purgedAt && row.requestedAt && row.dueAt) {
        return { id: row.id, email: row.email, name: row.name, deletion: { requestedAt: row.requestedAt, dueAt: row.dueAt } };
      }
      return undefined;
    },

    async createSession(row: { userId: string; tokenHash: string; expiresAt: Date }): Promise<string> {
      const id = newId('session');
      await db.insert(sessions).values({ id, userId: row.userId, tokenHash: row.tokenHash, expiresAt: row.expiresAt });
      return id;
    },

    async findSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined> {
      const [row] = await db
        .select({
          id: sessions.id,
          lastSeenAt: sessions.lastSeenAt,
          expiresAt: sessions.expiresAt,
          userId: users.id,
          email: users.email,
          name: users.name,
          requestedAt: users.deletionRequestedAt,
          dueAt: users.deletionDueAt,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
            inArray(users.status, ['active', 'deleting']),
            isNull(users.deletedAt),
          ),
        );
      return row
        ? {
            id: row.id,
            lastSeenAt: row.lastSeenAt,
            expiresAt: row.expiresAt,
            user: {
              id: row.userId,
              email: row.email,
              name: row.name,
              deletion: row.requestedAt && row.dueAt ? { requestedAt: row.requestedAt, dueAt: row.dueAt } : null,
            },
          }
        : undefined;
    },

    async touchSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
      await db.update(sessions).set({ lastSeenAt, expiresAt }).where(eq(sessions.id, id));
    },

    async revokeSession(id: string, now: Date): Promise<void> {
      await db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
    },

    async revokeAllSessions(userId: string, now: Date): Promise<void> {
      await db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    },

    /**
     * Starts the undo period. Only an active account can start it; the row says when it was asked and when the purge becomes
     * allowed. False when it is already running, so asking again keeps the first request and its end date.
     */
    async requestDeletion(userId: string, requestedAt: Date, dueAt: Date): Promise<boolean> {
      const rows = await db
        .update(users)
        .set({ status: 'deleting', deletionRequestedAt: requestedAt, deletionDueAt: dueAt, updatedAt: sql`now()` })
        .where(and(eq(users.id, userId), eq(users.status, 'active')))
        .returning({ id: users.id });
      return rows.length > 0;
    },

    /** Ends the undo period early: the purge may run at once. Uses the database clock, which the purge functions also use. */
    async deleteNow(userId: string): Promise<boolean> {
      const rows = await db
        .update(users)
        .set({ deletionDueAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(users.id, userId), eq(users.status, 'deleting'), isNull(users.deletedAt)))
        .returning({ id: users.id });
      return rows.length > 0;
    },

    /** Only inside the undo period. False when it has ended, is not running, or the data is already purged. */
    async undoDeletion(userId: string, now: Date): Promise<boolean> {
      const rows = await db
        .update(users)
        .set({ status: 'active', deletionRequestedAt: null, deletionDueAt: null, tokenRevokeFailed: 0, updatedAt: sql`now()` })
        .where(and(eq(users.id, userId), eq(users.status, 'deleting'), isNull(users.deletedAt), gt(users.deletionDueAt, now)))
        .returning({ id: users.id });
      return rows.length > 0;
    },

    async setTokenRevokeFailed(userId: string, count: number): Promise<void> {
      await db.update(users).set({ tokenRevokeFailed: count }).where(eq(users.id, userId));
    },

    async deletionRow(userId: string): Promise<DeletionRow | undefined> {
      const [row] = await db
        .select({
          status: users.status,
          requestedAt: users.deletionRequestedAt,
          dueAt: users.deletionDueAt,
          purgedAt: users.deletedAt,
          tokenRevokeFailed: users.tokenRevokeFailed,
        })
        .from(users)
        .where(eq(users.id, userId));
      return row;
    },
  };
}
export type AuthRepository = ReturnType<typeof createAuthRepository>;
