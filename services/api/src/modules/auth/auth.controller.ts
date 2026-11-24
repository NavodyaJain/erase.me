import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { parseCookies, serializeCookie } from '../../common/cookies.js';
import { Problems } from '../../common/errors.js';
import { CallbackQuery } from '../../contract/schemas.js';
import type { RateLimiter } from '../../common/rate-limit.js';
import type { Env } from '../../config/env.js';
import type { AccountDeletionView, AccountService } from './account.service.js';
import { SESSION_COOKIE } from './auth.guard.js';
import type { AuthService, CallbackOutcome } from './auth.service.js';
import type { SessionService } from './session.service.js';

export const OAUTH_STATE_COOKIE = 'erase_oauth_state';
const OAUTH_COOKIE_PATH = '/v1/auth/google';

export interface AuthRoutesDeps {
  env: Env;
  /** Base URL the browser is sent back to after Google. */
  postAuthRedirect: string;
  auth: AuthService;
  account: AccountService;
  sessions: SessionService;
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Like requireUser, but also lets a person whose deletion is pending in: they must be able to see it and undo it. */
  requireAccount: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  limiter: RateLimiter;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesDeps> = async (app, deps) => {
  const { env, auth, account, sessions, requireAccount, limiter, postAuthRedirect } = deps;
  const secure = env.API_PUBLIC_URL.startsWith('https:');
  const domain = env.COOKIE_DOMAIN;
  const cookieBase = { secure, ...(domain ? { domain } : {}) };

  const limit = async (request: FastifyRequest): Promise<void> => {
    if (!limiter.allow(request.ip)) throw Problems.tooManyRequests();
  };

  app.get('/v1/auth/google/start', { preHandler: limit }, async (_request, reply) => {
    const { url, state } = await auth.begin('signin');
    return reply
      .header('set-cookie', serializeCookie(OAUTH_STATE_COOKIE, state, { ...cookieBase, path: OAUTH_COOKIE_PATH, maxAgeSec: 600 }))
      .redirect(url, 302);
  });

  app.get('/v1/auth/google/callback', { preHandler: limit }, async (request, reply) => {
    const query = CallbackQuery.parse(request.query);
    const cookies = parseCookies(request.headers.cookie);
    const session = await sessions.authenticate(cookies[SESSION_COOKIE]);
    const outcome = await auth.complete({
      code: query.code,
      state: query.state,
      error: query.error,
      cookieState: cookies[OAUTH_STATE_COOKIE],
      // Someone whose deletion is pending cannot connect an inbox: nothing new is added until they undo it.
      sessionUserId: session && !session.user.deletion ? session.user.id : undefined,
      requestId: request.id,
    });
    const clearState = serializeCookie(OAUTH_STATE_COOKIE, '', { ...cookieBase, path: OAUTH_COOKIE_PATH, maxAgeSec: 0 });
    const cookiesOut = [clearState];
    if (outcome.kind === 'signed_in') {
      cookiesOut.push(serializeCookie(SESSION_COOKIE, outcome.sessionToken, { ...cookieBase, maxAgeSec: outcome.maxAgeSec }));
    }
    return reply.header('set-cookie', cookiesOut).redirect(redirectFor(postAuthRedirect, outcome), 302);
  });

  app.post('/v1/auth/logout', { preHandler: requireAccount }, async (request, reply) => {
    if (request.auth) await sessions.revoke(request.auth.sessionId);
    return reply
      .header('set-cookie', serializeCookie(SESSION_COOKIE, '', { ...cookieBase, maxAgeSec: 0 }))
      .status(204)
      .send();
  });

  app.get('/v1/me', { preHandler: requireAccount }, async (request) => {
    const a = request.auth;
    if (!a) throw Problems.unauthorized();
    return { id: a.user.id, email: a.user.email, name: a.user.name, csrfToken: a.csrfToken };
  });

  const body = (view: AccountDeletionView) => ({
    ...view,
    requestedAt: view.requestedAt?.toISOString() ?? null,
    deleteAfter: view.deleteAfter?.toISOString() ?? null,
  });

  // The routes a person can use while their deletion is pending: see it, undo it, or finish it now.
  app.delete('/v1/me', { preHandler: requireAccount }, async (request, reply) => {
    if (!request.auth) throw Problems.unauthorized();
    return reply.status(202).send(body(await account.requestDeletion(request.auth.user.id, request.id)));
  });

  app.get('/v1/me/deletion', { preHandler: requireAccount }, async (request) => {
    if (!request.auth) throw Problems.unauthorized();
    return body(await account.status(request.auth.user.id));
  });

  app.post('/v1/me/deletion/undo', { preHandler: requireAccount }, async (request) => {
    if (!request.auth) throw Problems.unauthorized();
    return body(await account.undo(request.auth.user.id, request.id));
  });

  app.post('/v1/me/deletion/now', { preHandler: requireAccount }, async (request, reply) => {
    if (!request.auth) throw Problems.unauthorized();
    const view = await account.deleteNow(request.auth.user.id, request.id);
    return reply.header('set-cookie', serializeCookie(SESSION_COOKIE, '', { ...cookieBase, maxAgeSec: 0 })).send(body(view));
  });
};

/** Where the browser lands after Google. Codes only, never messages or addresses. */
function redirectFor(base: string, outcome: CallbackOutcome): string {
  // A bare origin lands on `/`; a full URL (the dev helper page) is kept as given.
  const url = new URL(base);
  if (outcome.kind === 'signed_in') return url.toString();
  if (outcome.kind === 'inbox_connected') url.searchParams.set('inbox', 'connected');
  else url.searchParams.set('auth_error', outcome.reason);
  return url.toString();
}
