import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './common/errors.js';
import { buildLogger } from './common/logger.js';
import { createRateLimiter } from './common/rate-limit.js';
import type { Env } from './config/env.js';
import type { KeyProvider } from './crypto/key-provider.js';
import { TokenVault } from './crypto/token-vault.js';
import type { Db } from './db/client.js';
import type { InProcessJobQueue } from './jobs/queue.js';
import { createAuditRepository } from './modules/audit/audit.repository.js';
import { AccountService, DELETE_ACCOUNT_JOB } from './modules/auth/account.service.js';
import { authRoutes } from './modules/auth/auth.controller.js';
import { createAuthGuard } from './modules/auth/auth.guard.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import { AuthService } from './modules/auth/auth.service.js';
import type { GoogleOAuthClient } from './modules/auth/google-oauth.js';
import { SessionService } from './modules/auth/session.service.js';
import type { GmailClient } from './modules/gmail/gmail.client.js';
import { gmailRoutes } from './modules/gmail/gmail.controller.js';
import { createGmailRepository } from './modules/gmail/gmail.repository.js';
import { ReplyPoller } from './modules/tracker/reply-poller.js';
import { createTrackerRepository } from './modules/tracker/tracker.repository.js';
import { InboxService } from './modules/gmail/inbox.service.js';
import { SCAN_JOB, ScanService, scanOptionsFromEnv } from './modules/gmail/scan.service.js';
import { companiesRoutes } from './modules/companies/companies.controller.js';
import { createCompaniesRepository } from './modules/companies/companies.repository.js';
import { CompaniesService } from './modules/companies/companies.service.js';
import { parseExcludeList } from './modules/gmail/detection-rules.js';
import { createRequestsRepository } from './modules/requests/requests.repository.js';
import { requestsRoutes } from './modules/requests/requests.controller.js';
import { FollowupsService } from './modules/requests/followups.service.js';
import { FOLLOWUP_WORDING } from './modules/requests/followup-template.js';
import { RequestsService } from './modules/requests/requests.service.js';
import { STATUTE_CITATION } from './modules/requests/draft-citation.js';
import { HttpGmailSender } from './modules/requests/http-gmail-sender.js';
import { selectSender, type SenderChoice } from './modules/requests/sender.js';
import { healthRoutes } from './modules/health/health.controller.js';
import { HealthService } from './modules/health/health.service.js';

export interface AppDeps {
  env: Env;
  pingDatabase: () => Promise<void>;
  /** Tests pass a stream to capture log output. */
  logStream?: NodeJS.WritableStream;
  /** When set, auth and Gmail routes are registered. Health alone needs only the two fields above. */
  modules?: {
    db: Db;
    /** Undefined when GOOGLE_CLIENT_ID is not configured: auth routes then answer 503 `auth_not_configured`. */
    google: GoogleOAuthClient | undefined;
    gmail: GmailClient;
    /** Undefined when TOKEN_MASTER_KEY is not configured: connecting an inbox then answers 503. */
    keys: KeyProvider | undefined;
    queue: InProcessJobQueue;
    now?: () => Date;
    /** Requests per minute per client on the auth start and callback routes. Default 30. */
    authRateLimitPerMinute?: number;
    /** Where the browser lands after Google. Defaults to WEB_ORIGIN. */
    postAuthRedirect?: string;
    /** Tests inject a sender. Otherwise the choice follows selectSender (fake in development and test, real only when allowed). */
    sender?: SenderChoice;
    /** Tests set this to try a real follow-up. Otherwise it follows FOLLOWUP_WORDING.signedOff, which the owner changes in code. */
    followupWordingSignedOff?: boolean;
  };
}

export interface AppServices {
  scans: ScanService;
  inboxes: InboxService;
  account: AccountService;
  requests: RequestsService;
  companies: CompaniesService;
  sessions: SessionService;
  auth: AuthService;
  /** Looks for replies on sent requests' threads. Run by the scheduler, and by tests. */
  replies: ReplyPoller;
  /** Follow-ups to requests with no reply, and the sweep that prepares them. */
  followups: FollowupsService;
}

declare module 'fastify' {
  interface FastifyInstance {
    services?: AppServices;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // pino's Logger type is newer than Fastify's FastifyBaseLogger; the runtime API is the same.
    loggerInstance: buildLogger({
      level: deps.env.LOG_LEVEL,
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    }) as unknown as FastifyBaseLogger,
    // Our own ids only: an incoming X-Request-Id header is ignored so it cannot inject into logs.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // Built-in request logging records URLs, remote addresses and headers. We log a minimal line instead.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    trustProxy: false,
  });

  // Strict CORS allow-list: only the web app may call the API with credentials (TRD 8.1).
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== deps.env.WEB_ORIGIN) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-credentials', 'true');
    reply.header('vary', 'Origin');
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
      reply.header('access-control-allow-headers', 'content-type, x-csrf-token, idempotency-key');
      reply.header('access-control-max-age', '600');
      return reply.status(204).send();
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  registerErrorHandling(app);

  const health = new HealthService(deps.pingDatabase, (check, err) =>
    app.log.warn({ check, err }, 'readiness check failed'),
  );
  void app.register(healthRoutes, { service: health });

  const m = deps.modules;
  if (m) {
    app.decorateRequest('auth', null);
    const now = m.now ?? (() => new Date());
    const authRepo = createAuthRepository(m.db);
    const audit = createAuditRepository(m.db);
    const sessions = new SessionService(authRepo, now);
    const vault = m.keys ? new TokenVault(m.keys) : undefined;
    const gmailRepo = createGmailRepository(m.db);
    const inboxes = new InboxService(gmailRepo, vault, m.google, audit, now);
    const scans = new ScanService(gmailRepo, inboxes, m.gmail, m.queue, now, {
      info: (o, msg) => app.log.info(o, msg),
      warn: (o, msg) => app.log.warn(o, msg),
    }, scanOptionsFromEnv(deps.env));
    const auth = new AuthService({
      repo: authRepo,
      sessions,
      audit,
      google: m.google,
      connect: (userId, result) => inboxes.connect(userId, result),
      now,
    });
    const account = new AccountService(authRepo, sessions, inboxes, m.queue, audit, now);
    // One sender choice for the first request and its follow-up, so both stay behind the same real-send gates.
    const senderChoice =
      m.sender ??
      selectSender(deps.env, {
        citationVerified: STATUTE_CITATION.verified,
        real: () => new HttpGmailSender({ getAccessToken: (inboxId) => inboxes.accessTokenById(inboxId) }),
      });
    const wordingSignedOff = m.followupWordingSignedOff ?? FOLLOWUP_WORDING.signedOff;
    const requestLog = { info: (o: object, msg: string) => app.log.info(o, msg), warn: (o: object, msg: string) => app.log.warn(o, msg) };
    const requestsService = new RequestsService({
      repo: createRequestsRepository(m.db),
      audit,
      inboxes,
      sender: senderChoice,
      realSendDailyCap: deps.env.REAL_SEND_DAILY_CAP,
      followupAfterDays: deps.env.FOLLOWUP_AFTER_DAYS,
      followupMax: deps.env.FOLLOWUP_MAX,
      followupWordingSignedOff: wordingSignedOff,
      now,
      log: requestLog,
    });
    const followupsService = new FollowupsService({
      repo: createRequestsRepository(m.db),
      audit,
      inboxes,
      sender: senderChoice,
      realSendDailyCap: deps.env.REAL_SEND_DAILY_CAP,
      settings: { afterDays: deps.env.FOLLOWUP_AFTER_DAYS, max: deps.env.FOLLOWUP_MAX, wordingSignedOff },
      now,
      log: requestLog,
    });
    const companiesService = new CompaniesService({
      repo: createCompaniesRepository(m.db),
      gmailRepo,
      audit,
      excludeEntries: parseExcludeList(deps.env.SCAN_EXCLUDE),
      activity: { recentDays: deps.env.ACTIVITY_RECENT_DAYS, oldDays: deps.env.ACTIVITY_OLD_DAYS },
      now,
    });
    const replies = new ReplyPoller({
      repo: createTrackerRepository(m.db),
      gmail: m.gmail,
      accessToken: (inboxId) => inboxes.accessTokenById(inboxId),
      ownAddresses: (userId) => gmailRepo.listOwnAddresses(userId),
      now,
      options: { maxAgeDays: deps.env.REPLY_POLL_MAX_AGE_DAYS, batchSize: 100 },
      log: { info: (o, msg) => app.log.info(o, msg), warn: (o, msg) => app.log.warn(o, msg) },
    });
    m.queue.register(SCAN_JOB, (p) => scans.run(p.scanId ?? ''));
    m.queue.register(DELETE_ACCOUNT_JOB, (p) => account.runDeletion(p.userId ?? ''));
    app.decorate('services', { scans, inboxes, account, requests: requestsService, companies: companiesService, sessions, auth, replies, followups: followupsService });

    const requireUser = createAuthGuard(sessions, deps.env.WEB_ORIGIN);
    const limiter = createRateLimiter({ max: m.authRateLimitPerMinute ?? 30, windowMs: 60_000 });
    void app.register(authRoutes, { env: deps.env, auth, postAuthRedirect: m.postAuthRedirect ?? deps.env.WEB_ORIGIN, account, sessions, requireUser, limiter });
    void app.register(companiesRoutes, { companies: companiesService, requireUser });
    void app.register(requestsRoutes, { requests: requestsService, followups: followupsService, requireUser });
    void app.register(gmailRoutes, { env: deps.env, auth, inboxes, scans, requireUser });
  }

  return app;
}
