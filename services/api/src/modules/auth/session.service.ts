import { createHash, randomBytes } from 'node:crypto';
import type { AuthRepository, AuthUser } from './auth.repository.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The sliding expiry is extended at most this often, so reads do not become writes. */
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

export interface AuthContext {
  sessionId: string;
  user: AuthUser;
  /** Derived from the session token: only the holder of the cookie can compute it. */
  csrfToken: string;
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
export const csrfFor = (sessionToken: string): string =>
  createHash('sha256').update(`erase-csrf:${sessionToken}`).digest('base64url');

export class SessionService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A new random session for the user. Sign-in always issues a fresh one, so a pre-login id is never reused. */
  async create(userId: string): Promise<{ token: string; maxAgeSec: number }> {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    await this.repo.createSession({
      userId,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    });
    return { token, maxAgeSec: SESSION_TTL_MS / 1000 };
  }

  /** Returns undefined for an unknown, expired or revoked token. Extends the 30-day sliding expiry. */
  async authenticate(token: string | undefined): Promise<AuthContext | undefined> {
    if (!token || token.length > 128) return undefined;
    const now = this.now();
    const session = await this.repo.findSession(sha256Hex(token), now);
    if (!session) return undefined;
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.repo.touchSession(session.id, now, new Date(now.getTime() + SESSION_TTL_MS));
    }
    return { sessionId: session.id, user: session.user, csrfToken: csrfFor(token) };
  }

  revoke(sessionId: string): Promise<void> {
    return this.repo.revokeSession(sessionId, this.now());
  }

  revokeAll(userId: string): Promise<void> {
    return this.repo.revokeAllSessions(userId, this.now());
  }
}
