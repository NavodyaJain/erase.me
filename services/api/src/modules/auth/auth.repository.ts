import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';
import { oauthStates, sessions, users } from '../../db/schema/index.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
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
          setWhere: eq(users.status, 'active'),
        })
        .returning({ id: users.id, email: users.email, name: users.name, status: users.status });
      return row && row.status === 'active' ? { id: row.id, email: row.email, name: row.name } : undefined;
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
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
            eq(users.status, 'active'),
          ),
        );
      return row
        ? {
            id: row.id,
            lastSeenAt: row.lastSeenAt,
            expiresAt: row.expiresAt,
            user: { id: row.userId, email: row.email, name: row.name },
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

    async markUserDeleting(userId: string): Promise<boolean> {
      const rows = await db
        .update(users)
        .set({ status: 'deleting', updatedAt: sql`now()` })
        .where(and(eq(users.id, userId), ne(users.status, 'deleting')))
        .returning({ id: users.id });
      return rows.length > 0;
    },

    /** Replaces personal fields. The row stays so foreign keys and the append-only history remain valid. */
    async anonymiseUser(userId: string, now: Date): Promise<void> {
      await db
        .update(users)
        .set({
          googleSub: `deleted:${userId}`,
          email: `${userId}@deleted.invalid`,
          name: 'Deleted user',
          status: 'deleting',
          deletedAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
    },
  };
}
export type AuthRepository = ReturnType<typeof createAuthRepository>;
