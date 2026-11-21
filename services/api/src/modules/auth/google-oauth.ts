import { z } from 'zod';

export const SIGNIN_SCOPES = ['openid', 'email', 'profile'] as const;
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
/** Used only after the user approves a request (PRD F6). Requested at connect so approval needs no second consent. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const CONNECT_SCOPES = ['openid', 'email', GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const TIMEOUT_MS = 10_000;
const CLOCK_SKEW_SEC = 60;

export type GoogleOAuthErrorCode = 'invalid_grant' | 'bad_response' | 'unavailable' | 'invalid_id_token';

/** Never carries a response body or token: only a stable code. */
export class GoogleOAuthError extends Error {
  constructor(readonly code: GoogleOAuthErrorCode) {
    super(`google oauth: ${code}`);
    this.name = 'GoogleOAuthError';
  }
}

export interface Identity {
  sub: string;
  email: string;
  name: string;
}

export interface CodeExchangeResult {
  identity: Identity;
  /** Scopes Google actually granted (the user can untick boxes on the consent screen). */
  grantedScopes: string[];
  refreshToken?: string;
  accessToken: string;
}

export interface AuthorizationParams {
  purpose: 'signin' | 'connect';
  state: string;
  nonce: string;
  codeChallenge: string;
  /** Pre-selects the account for a reconnect. */
  loginHint?: string;
}

/** Everything the API needs from Google's OAuth endpoints. Tests and the fake Gmail provide their own. */
export interface GoogleOAuthClient {
  authorizationUrl(params: AuthorizationParams): string;
  exchangeCode(code: string, codeVerifier: string, expectedNonce: string): Promise<CodeExchangeResult>;
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number }>;
  /** True when the token is revoked, or was already invalid. False when Google could not be reached. */
  revoke(token: string): Promise<boolean>;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(''),
  id_token: z.string().min(1).optional(),
});

const IdClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  exp: z.number(),
  nonce: z.string().optional(),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});

/**
 * Checks the claims of an ID token that was received straight from Google's token endpoint over TLS
 * (OpenID Connect Core 3.1.3.7: the TLS server validation may stand in for the signature check).
 * Issuer, audience, expiry, nonce and a verified email are all required.
 */
export function readIdToken(idToken: string, clientId: string, expectedNonce: string, nowSec: number): Identity {
  const payload = idToken.split('.')[1];
  if (!payload) throw new GoogleOAuthError('invalid_id_token');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleOAuthError('invalid_id_token');
  }
  const parsed = IdClaims.safeParse(raw);
  if (!parsed.success) throw new GoogleOAuthError('invalid_id_token');
  const c = parsed.data;
  if (!ISSUERS.has(c.iss) || c.aud !== clientId || c.exp + CLOCK_SKEW_SEC < nowSec) {
    throw new GoogleOAuthError('invalid_id_token');
  }
  if (c.nonce !== expectedNonce || c.email_verified !== true) throw new GoogleOAuthError('invalid_id_token');
  return { sub: c.sub, email: c.email.toLowerCase(), name: c.name?.trim() || c.email.split('@')[0] || 'User' };
}

export interface HttpGoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class HttpGoogleOAuthClient implements GoogleOAuthClient {
  private readonly http: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: HttpGoogleOAuthOptions) {
    this.http = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  authorizationUrl(p: AuthorizationParams): string {
    const q = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: 'code',
      scope: (p.purpose === 'signin' ? SIGNIN_SCOPES : CONNECT_SCOPES).join(' '),
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
    });
    if (p.purpose === 'connect') {
      // A refresh token is only issued with offline access, and only reliably with an explicit consent prompt.
      q.set('access_type', 'offline');
      q.set('prompt', 'consent');
      q.set('include_granted_scopes', 'false');
    } else {
      q.set('prompt', 'select_account');
    }
    if (p.loginHint) q.set('login_hint', p.loginHint);
    return `${AUTH_URL}?${q.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string, expectedNonce: string): Promise<CodeExchangeResult> {
    const body = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.opts.redirectUri,
    });
    if (!body.id_token) throw new GoogleOAuthError('invalid_id_token');
    const identity = readIdToken(body.id_token, this.opts.clientId, expectedNonce, Math.floor(this.now() / 1000));
    return {
      identity,
      grantedScopes: body.scope.split(' ').filter(Boolean),
      accessToken: body.access_token,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number }> {
    const body = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { accessToken: body.access_token, expiresInSec: body.expires_in };
  }

  async revoke(token: string): Promise<boolean> {
    try {
      const res = await this.http(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 400 invalid_token means it is already revoked or expired: nothing left to revoke.
      return res.ok || res.status === 400;
    } catch {
      return false;
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<z.infer<typeof TokenResponse>> {
    let res: Response;
    try {
      res = await this.http(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
          ...params,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GoogleOAuthError('unavailable');
    }
    if (res.status === 400 || res.status === 401) throw new GoogleOAuthError('invalid_grant');
    if (!res.ok) throw new GoogleOAuthError('unavailable');
    const parsed = TokenResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new GoogleOAuthError('bad_response');
    return parsed.data;
  }
}
