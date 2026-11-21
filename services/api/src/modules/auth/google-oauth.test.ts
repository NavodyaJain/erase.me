import { describe, expect, it } from 'vitest';
import {
  CONNECT_SCOPES,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GoogleOAuthError,
  HttpGoogleOAuthClient,
  readIdToken,
} from './google-oauth.js';

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const REDIRECT = 'http://localhost:4000/v1/auth/google/callback';
const NOW = 1_800_000_000;

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const goodClaims = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: 'sub-1',
  exp: NOW + 3600,
  nonce: 'n1',
  email: 'Person@Example.test',
  email_verified: true,
  name: 'Person',
};

const client = (fetchImpl: typeof fetch = () => Promise.reject(new Error('no network in this test'))) =>
  new HttpGoogleOAuthClient({ clientId: CLIENT_ID, clientSecret: 'shh-secret', redirectUri: REDIRECT, fetch: fetchImpl, now: () => NOW * 1000 });

describe('authorizationUrl', () => {
  it('sign-in asks for openid, email and profile only, with PKCE', () => {
    const url = new URL(client().authorizationUrl({ purpose: 'signin', state: 's', nonce: 'n', codeChallenge: 'cc' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.search).not.toContain('shh-secret');
  });

  it('connect asks for Gmail read and send with offline access, and no profile scope', () => {
    const url = new URL(client().authorizationUrl({ purpose: 'connect', state: 's', nonce: 'n', codeChallenge: 'cc' }));
    const scopes = url.searchParams.get('scope')?.split(' ');
    expect(scopes).toEqual([...CONNECT_SCOPES]);
    expect(scopes).toContain(GMAIL_READONLY_SCOPE);
    expect(scopes).toContain(GMAIL_SEND_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('readIdToken', () => {
  it('accepts a good token and normalises the email', () => {
    expect(readIdToken(jwt(goodClaims), CLIENT_ID, 'n1', NOW)).toEqual({ sub: 'sub-1', email: 'person@example.test', name: 'Person' });
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }],
    ['wrong issuer', { iss: 'https://evil.test' }],
    ['expired', { exp: NOW - 3600 }],
    ['wrong nonce', { nonce: 'other' }],
    ['unverified email', { email_verified: false }],
    ['missing email', { email: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(() => readIdToken(jwt({ ...goodClaims, ...patch }), CLIENT_ID, 'n1', NOW)).toThrow(GoogleOAuthError);
  });

  it('rejects garbage', () => {
    expect(() => readIdToken('not-a-jwt', CLIENT_ID, 'n1', NOW)).toThrow(GoogleOAuthError);
    expect(() => readIdToken('a.!!!.c', CLIENT_ID, 'n1', NOW)).toThrow(GoogleOAuthError);
  });
});

describe('token endpoint', () => {
  const ok = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('exchanges a code, sending the PKCE verifier and secret in the body, not the URL', async () => {
    let seen: { url: string; body: string } | undefined;
    const c = client((url, init) => {
      seen = { url: String(url), body: String(init?.body) };
      return ok({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', scope: `openid email ${GMAIL_READONLY_SCOPE}`, id_token: jwt(goodClaims) })();
    });
    const r = await c.exchangeCode('the-code', 'the-verifier', 'n1');
    expect(r.refreshToken).toBe('rt');
    expect(r.grantedScopes).toContain(GMAIL_READONLY_SCOPE);
    expect(r.identity.email).toBe('person@example.test');
    expect(seen?.url).toBe('https://oauth2.googleapis.com/token');
    expect(seen?.body).toContain('code_verifier=the-verifier');
    expect(seen?.body).toContain('client_secret=shh-secret');
  });

  it('maps failures to codes that carry no response content', async () => {
    const bad = client(ok({ error: 'invalid_grant', error_description: 'secret detail person@example.test' }, 400));
    const err = await bad.exchangeCode('c', 'v', 'n1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect((err as GoogleOAuthError).code).toBe('invalid_grant');
    expect((err as Error).message).not.toContain('person@example.test');
    await expect(client(ok({}, 503)).refreshAccessToken('rt')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client(ok({ unexpected: true })).refreshAccessToken('rt')).rejects.toMatchObject({ code: 'bad_response' });
    await expect(client().refreshAccessToken('rt')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('treats a rejected client (wrong secret) as unavailable with detail, not as a revoked grant', async () => {
    const err = await client(ok({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 401))
      .refreshAccessToken('rt')
      .then(
        () => new GoogleOAuthError('bad_response'),
        (e: unknown) => e as GoogleOAuthError,
      );
    expect(err.code).toBe('unavailable');
    expect(err.detail).toEqual({ httpStatus: 401, reason: 'invalid_client' });
    const grant = await client(ok({ error: 'invalid_grant' }, 400))
      .refreshAccessToken('rt')
      .then(
        () => new GoogleOAuthError('bad_response'),
        (e: unknown) => e as GoogleOAuthError,
      );
    expect(grant.code).toBe('invalid_grant');
    expect(grant.detail).toEqual({ httpStatus: 400, reason: 'invalid_grant' });
  });

  it('revoke is true for ok and already-invalid tokens, false when Google is unreachable', async () => {
    expect(await client(ok({}, 200)).revoke('t')).toBe(true);
    expect(await client(ok({ error: 'invalid_token' }, 400)).revoke('t')).toBe(true);
    expect(await client(ok({}, 500)).revoke('t')).toBe(false);
    expect(await client().revoke('t')).toBe(false);
  });
});
