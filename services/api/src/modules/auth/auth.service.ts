import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Problems } from '../../common/errors.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { AuthRepository } from './auth.repository.js';
import { GoogleOAuthError, type CodeExchangeResult, type GoogleOAuthClient } from './google-oauth.js';
import { sha256Hex, type SessionService } from './session.service.js';

const STATE_TTL_MS = 10 * 60 * 1000;

export type FlowFailure =
  | 'access_denied'
  | 'invalid_state'
  | 'exchange_failed'
  | 'scopes_missing'
  | 'no_refresh_token'
  | 'inbox_limit'
  | 'account_unavailable';

/** A failure the user can be told about by a code on the redirect, never by a message. */
export class OAuthFlowError extends Error {
  constructor(readonly reason: FlowFailure) {
    super(`oauth flow: ${reason}`);
    this.name = 'OAuthFlowError';
  }
}

/** Completes an inbox connection (task 4). Throws OAuthFlowError to reject it. */
export type ConnectHandler = (userId: string, result: CodeExchangeResult) => Promise<void>;

export type CallbackOutcome =
  | { kind: 'signed_in'; sessionToken: string; maxAgeSec: number }
  | { kind: 'inbox_connected' }
  | { kind: 'failed'; reason: FlowFailure };

export interface AuthServiceDeps {
  repo: AuthRepository;
  sessions: SessionService;
  audit: AuditRepository;
  /** Undefined when GOOGLE_CLIENT_ID is not configured. */
  google: GoogleOAuthClient | undefined;
  connect: ConnectHandler;
  now?: () => Date;
}

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class AuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private google(): GoogleOAuthClient {
    if (!this.deps.google) {
      throw Problems.unavailable('auth_not_configured', 'Google sign-in is not configured');
    }
    return this.deps.google;
  }

  /**
   * Starts a Google authorization. `state` is also set as a short-lived cookie by the caller, so the
   * callback can prove it comes from the same browser (login CSRF defence). PKCE protects the code.
   */
  async begin(purpose: 'signin' | 'connect', userId?: string): Promise<{ url: string; state: string }> {
    const google = this.google();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    await this.deps.repo.createOauthState({
      stateHash: sha256Hex(state),
      purpose,
      ...(userId ? { userId } : {}),
      codeVerifier,
      nonce,
      expiresAt: new Date(this.now().getTime() + STATE_TTL_MS),
    });
    const url = google.authorizationUrl({
      purpose,
      state,
      nonce,
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    });
    return { url, state };
  }

  async complete(input: {
    code: string | undefined;
    state: string | undefined;
    error: string | undefined;
    /** The state cookie from this browser. */
    cookieState: string | undefined;
    /** The signed-in user, if any (required for `connect`). */
    sessionUserId: string | undefined;
    requestId: string;
  }): Promise<CallbackOutcome> {
    const { state, cookieState } = input;
    if (!state || !cookieState || !sameSecret(state, cookieState)) return { kind: 'failed', reason: 'invalid_state' };
    const stored = await this.deps.repo.consumeOauthState(sha256Hex(state), this.now());
    if (!stored) return { kind: 'failed', reason: 'invalid_state' };
    if (input.error) return { kind: 'failed', reason: 'access_denied' };
    if (!input.code) return { kind: 'failed', reason: 'invalid_state' };
    if (stored.purpose === 'connect' && stored.userId !== input.sessionUserId) {
      return { kind: 'failed', reason: 'invalid_state' };
    }

    let result: CodeExchangeResult;
    try {
      result = await this.google().exchangeCode(input.code, stored.codeVerifier, stored.nonce);
    } catch (err) {
      if (err instanceof GoogleOAuthError) return { kind: 'failed', reason: 'exchange_failed' };
      throw err;
    }

    if (stored.purpose === 'connect') {
      try {
        await this.deps.connect(stored.userId as string, result);
      } catch (err) {
        if (err instanceof OAuthFlowError) return { kind: 'failed', reason: err.reason };
        throw err;
      }
      return { kind: 'inbox_connected' };
    }

    const user = await this.deps.repo.upsertUser({
      googleSub: result.identity.sub,
      email: result.identity.email.toLowerCase(),
      name: result.identity.name,
    });
    if (!user) return { kind: 'failed', reason: 'account_unavailable' };
    const session = await this.deps.sessions.create(user.id);
    await this.deps.audit.record({
      actorType: 'user',
      actorId: user.id,
      action: 'auth.sign_in',
      targetType: 'user',
      targetId: user.id,
      requestId: input.requestId,
    });
    return { kind: 'signed_in', sessionToken: session.token, maxAgeSec: session.maxAgeSec };
  }
}
