import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseCookies } from '../../common/cookies.js';
import { Problems } from '../../common/errors.js';
import type { AuthContext, SessionService } from './session.service.js';

export const SESSION_COOKIE = 'erase_session';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/**
 * preHandler for routes that need a signed-in user. For anything that changes state it also requires
 * the CSRF header, and rejects a browser Origin that is not the web app (TRD 8.1).
 * The user id always comes from the session, never from the request.
 */
export function createAuthGuard(sessions: SessionService, webOrigin: string) {
  return async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const auth = await sessions.authenticate(token);
    if (!auth) throw Problems.unauthorized();
    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      const header = request.headers[CSRF_HEADER];
      if ((origin !== undefined && origin !== webOrigin) || header !== auth.csrfToken) {
        throw Problems.forbidden();
      }
    }
    request.auth = auth;
  };
}
