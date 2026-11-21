import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './accounts.js';
import { createdAt, idCheck, ts } from './_shared.js';

export const OAUTH_PURPOSES = ['signin', 'connect'] as const;
export const oauthPurpose = pgEnum('oauth_purpose', OAUTH_PURPOSES);

/**
 * Server-side sessions (TRD 8.1). The browser holds a random token; only its SHA-256 hash is stored,
 * so a database read cannot be replayed as a session. 30-day sliding expiry. A new session is issued at every sign-in (the old one is revoked), which prevents fixation.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    idCheck(t, 'sessions', 'ses'),
  ],
);

/**
 * One row per Google authorization attempt: the state, the PKCE verifier and the nonce.
 * Short-lived and single-use. `user_id` is set for `connect` (the signed-in user adding an inbox).
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: text('id').primaryKey(),
    stateHash: text('state_hash').notNull(),
    purpose: oauthPurpose('purpose').notNull(),
    userId: text('user_id').references(() => users.id),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce').notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
  },
  (t) => [
    uniqueIndex('oauth_states_state_hash_key').on(t.stateHash),
    idCheck(t, 'oauth_states', 'ost'),
    check('oauth_states_connect_has_user', sql`${t.purpose} <> 'connect' OR ${t.userId} IS NOT NULL`),
  ],
);
