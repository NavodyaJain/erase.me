import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { serializeCookie } from '../../common/cookies.js';
import { Problems } from '../../common/errors.js';
import { isId } from '../../common/ids.js';
import type { Env } from '../../config/env.js';
import { OAUTH_STATE_COOKIE } from '../auth/auth.controller.js';
import type { AuthService } from '../auth/auth.service.js';
import type { InboxService } from './inbox.service.js';
import type { ScanService } from './scan.service.js';

const InboxParams = z.object({ id: z.string().refine((v) => isId('inbox', v), 'invalid inbox id') });

export interface GmailRoutesDeps {
  env: Env;
  auth: AuthService;
  inboxes: InboxService;
  scans: ScanService;
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export const gmailRoutes: FastifyPluginAsync<GmailRoutesDeps> = async (app, deps) => {
  const { env, auth, inboxes, scans, requireUser } = deps;
  const userId = (request: FastifyRequest): string => {
    if (!request.auth) throw Problems.unauthorized();
    return request.auth.user.id; // from the session, never from the request
  };

  app.get('/v1/inboxes', { preHandler: requireUser }, async (request) => ({
    inboxes: await inboxes.list(userId(request)),
  }));

  // POST, not GET: the web app shows the "what we read / keep / never do" panel first (F1-AC2),
  // then calls this and navigates to the returned URL.
  app.post('/v1/inboxes/connect/start', { preHandler: requireUser }, async (request, reply) => {
    const uid = userId(request);
    await inboxes.assertCanAddInbox(uid);
    const { url, state } = await auth.begin('connect', uid);
    return reply
      .header(
        'set-cookie',
        serializeCookie(OAUTH_STATE_COOKIE, state, {
          secure: env.API_PUBLIC_URL.startsWith('https:'),
          ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
          path: '/v1/auth/google',
          maxAgeSec: 600,
        }),
      )
      .send({ authorizationUrl: url });
  });

  app.delete('/v1/inboxes/:id', { preHandler: requireUser }, async (request) => {
    const { id } = InboxParams.parse(request.params);
    const { revokedAtGoogle } = await inboxes.disconnect(userId(request), id);
    return { status: 'disconnected' as const, revokedAtGoogle };
  });

  app.post('/v1/inboxes/:id/scan', { preHandler: requireUser }, async (request, reply) => {
    const { id } = InboxParams.parse(request.params);
    const { scan, created } = await scans.start(userId(request), id);
    return reply.status(created ? 202 : 200).send({ scan });
  });

  app.get('/v1/inboxes/:id/scan', { preHandler: requireUser }, async (request) => {
    const { id } = InboxParams.parse(request.params);
    return { scan: await scans.latest(userId(request), id) };
  });
};
