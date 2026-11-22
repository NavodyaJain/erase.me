import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseCookies, serializeCookie } from '../common/cookies.js';
import { Problems } from '../common/errors.js';
import { isId } from '../common/ids.js';
import type { Env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { OAUTH_STATE_COOKIE } from '../modules/auth/auth.controller.js';
import { createAuthGuard, SESSION_COOKIE } from '../modules/auth/auth.guard.js';
import { ExcludeList, parseExcludeList } from '../modules/gmail/detection-rules.js';
import { toDetectionViews } from '../modules/gmail/detections.js';
import { createGmailRepository } from '../modules/gmail/gmail.repository.js';
import { registrableDomain } from '../modules/gmail/signals.js';
import { renderDevPage } from './dev-page.js';

/** Development only. This folder is excluded from the production build (tsconfig.build.json). */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** Refuses to run anywhere that is not a local development machine. */
export function assertDevHelperAllowed(env: Pick<Env, 'NODE_ENV' | 'API_HOST'>): void {
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
    throw new Error('The dev helper is disabled when NODE_ENV is production or staging.');
  }
  if (!LOOPBACK.has(env.API_HOST)) {
    throw new Error('The dev helper only runs when API_HOST is a loopback address (127.0.0.1 or localhost).');
  }
}

const ScanBody = z.object({ inboxId: z.string().refine((v) => isId('inbox', v), 'invalid inbox id') });

/**
 * A small page at /dev/connect to sign in, connect a Gmail inbox, run a scan and read the results,
 * without the web app. It shows company, first seen, last seen and signals. It never shows or fetches
 * subjects, sender addresses or message ids. Not part of the OpenAPI contract.
 */
export async function registerDevHelper(app: FastifyInstance, ctx: { env: Env; db: Db }): Promise<void> {
  assertDevHelperAllowed(ctx.env);
  const services = app.services;
  if (!services) throw new Error('dev helper needs the auth and Gmail modules');
  const { env } = ctx;
  const repo = createGmailRepository(ctx.db);
  const apiOrigin = new URL(env.API_PUBLIC_URL).origin;
  // The page is served by the API itself, so its Origin is the API origin, not the web app's.
  const requireUser = createAuthGuard(services.sessions, apiOrigin);

  const userId = (request: FastifyRequest): string => {
    if (!request.auth) throw Problems.unauthorized();
    return request.auth.user.id;
  };

  await app.register(async (dev) => {
    dev.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'no-store');
      reply.header('x-robots-tag', 'noindex');
      return payload;
    });

    dev.get('/dev/connect', async (_request, reply) => {
      const nonce = randomBytes(16).toString('base64');
      return reply
        .header(
          'content-security-policy',
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        )
        .type('text/html; charset=utf-8')
        .send(renderDevPage(nonce));
    });

    dev.get('/dev/api/state', async (request) => {
      const auth = await services.sessions.authenticate(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
      const setup = {
        googleConfigured: env.GOOGLE_CLIENT_ID !== undefined,
        encryptionConfigured: env.TOKEN_MASTER_KEY !== undefined,
      };
      if (!auth) return { signedIn: false as const, setup };
      const [inboxes, detections, own] = await Promise.all([
        services.inboxes.list(auth.user.id),
        repo.listDetections(auth.user.id),
        repo.listOwnAddresses(auth.user.id),
      ]);
      const exclude = new ExcludeList(parseExcludeList(env.SCAN_EXCLUDE), own, registrableDomain);
      const scans: Record<string, unknown> = {};
      for (const inbox of inboxes) {
        scans[inbox.id] = await services.scans.latest(auth.user.id, inbox.id).catch(() => null);
      }
      return {
        signedIn: true as const,
        setup,
        csrfToken: auth.csrfToken,
        inboxes: inboxes.map((i) => ({ id: i.id, email: i.email, status: i.status, lastScanAt: i.lastScanAt })),
        scans,
        // Company-level fields only: name, domain, dates, the signals used, confidence and the must-keep flag.
        results: toDetectionViews(detections, exclude, { now: new Date(), config: { recentDays: env.ACTIVITY_RECENT_DAYS, oldDays: env.ACTIVITY_OLD_DAYS } }).map(({ category: _category, ...row }) => row),
      };
    });

    dev.post('/dev/api/connect', { preHandler: requireUser }, async (request, reply) => {
      const uid = userId(request);
      await services.inboxes.assertCanAddInbox(uid);
      const { url, state } = await services.auth.begin('connect', uid);
      return reply
        .header('set-cookie', serializeCookie(OAUTH_STATE_COOKIE, state, { path: '/v1/auth/google', maxAgeSec: 600 }))
        .send({ authorizationUrl: url });
    });

    dev.post('/dev/api/scan', { preHandler: requireUser }, async (request, reply) => {
      const { inboxId } = ScanBody.parse(request.body);
      const { scan, created } = await services.scans.start(userId(request), inboxId);
      return reply.status(created ? 202 : 200).send({ scan });
    });

    dev.post('/dev/api/disconnect', { preHandler: requireUser }, async (request) => {
      const { inboxId } = ScanBody.parse(request.body);
      return services.inboxes.disconnect(userId(request), inboxId);
    });
  });

  app.log.warn('dev helper enabled at /dev/connect (development only)');
}
