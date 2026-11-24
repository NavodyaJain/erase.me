import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { scrubString } from './common/scrub.js';
import { EnvError, googleRedirectUri, jobsEnabled, loadEnv, type Env } from './config/env.js';
import { createDb, type Db } from './db/client.js';
import { LocalKeyProvider } from './crypto/key-provider.js';
import { InProcessJobQueue } from './jobs/queue.js';
import { PgTaskLock, Scheduler } from './jobs/scheduler.js';
import { HttpGoogleOAuthClient, type GoogleOAuthClient } from './modules/auth/google-oauth.js';
import { purgeTask } from './modules/purge/purge.service.js';
import { loadCatalog } from './modules/companies/catalog.js';
import { createCompaniesRepository } from './modules/companies/companies.repository.js';
import { HttpGmailClient, type GmailClient } from './modules/gmail/gmail.client.js';
import { createHealthRepository } from './modules/health/health.repository.js';

export interface StartContext {
  env: Env;
  app: FastifyInstance;
  db: Db;
}

export interface StartOptions {
  /** Extra plugins registered before listening (the dev helper). Never used by the production entry. */
  plugins?: Array<(ctx: StartContext) => Promise<void>>;
  /** Replaces the Google and Gmail clients and the catalog folder. Used only by the end-to-end entry (e2e/server.ts); the production entry never passes it. */
  overrides?: { google?: GoogleOAuthClient; gmail?: GmailClient; catalogDir?: string; authRateLimitPerMinute?: number };
  /** Where the browser lands after Google. Defaults to WEB_ORIGIN. */
  postAuthRedirect?: string;
}

export async function start(opts: StartOptions = {}): Promise<void> {
  const env = loadEnv();
  const { db, pool, close } = createDb(env.DATABASE_URL);
  const health = createHealthRepository(pool);
  const queue = new InProcessJobQueue((name, err) =>
    process.stderr.write(`Job ${name} failed: ${scrubString(err instanceof Error ? err.message : 'unknown error')}
`),
  );
  const app = buildApp({
    env,
    pingDatabase: () => health.pingDatabase(),
    modules: {
      db,
      queue,
      gmail: opts.overrides?.gmail ?? new HttpGmailClient({ maxRequestsPerSecond: 15 }),
      // Secrets stay inside these two objects: they are never logged or returned.
      google:
        opts.overrides?.google ??
        (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? new HttpGoogleOAuthClient({
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              redirectUri: googleRedirectUri(env),
            })
          : undefined),
      keys: env.TOKEN_MASTER_KEY ? new LocalKeyProvider(env.TOKEN_MASTER_KEY) : undefined,
      ...(opts.overrides?.authRateLimitPerMinute ? { authRateLimitPerMinute: opts.overrides.authRateLimitPerMinute } : {}),
      ...(opts.postAuthRedirect ? { postAuthRedirect: opts.postAuthRedirect } : {}),
    },
  });
  pool.on('error', (err) => app.log.error({ err }, 'database pool error'));
  // Company names, categories and the must-keep flag come from the reviewed catalog. Fictional entries only outside production.
  const catalog = loadCatalog({
    includeFictional: env.NODE_ENV !== 'production' && env.NODE_ENV !== 'staging',
    ...(opts.overrides?.catalogDir ? { dir: opts.overrides.catalogDir } : {}),
  });
  const synced = await createCompaniesRepository(db).syncCatalog(catalog);
  app.log.info({ entries: catalog.length, ...synced }, 'catalog synced');
  for (const plugin of opts.plugins ?? []) await plugin({ env, app, db });

  // Background tasks run inside this process, behind a Postgres lock so a second process skips a task already running.
  const scheduler = new Scheduler({ lock: new PgTaskLock(pool), log: { info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m) } });
  const replies = app.services?.replies;
  if (replies) scheduler.add({ name: 'poll-replies', everyMs: env.REPLY_POLL_MINUTES * 60_000, run: () => replies.runOnce() });
  const followups = app.services?.followups;
  // Hourly: a request is due its follow-up once FOLLOWUP_AFTER_DAYS have passed, so the check never needs to be faster.
  if (followups) scheduler.add({ name: 'followup-sweep', everyMs: 60 * 60_000, run: () => followups.sweep() });

  const purge = app.services?.purge;
  // Hourly: removes ended sessions, disconnected inboxes past their retention and accounts past the undo period. Counts are logged, nothing else.
  if (purge) scheduler.add(purgeTask(purge));

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await scheduler.stop();
    await app.close();
    await queue.drain();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  if (jobsEnabled(env)) scheduler.start();
  const resumed = await app.services?.scans.resumeInterrupted();
  if (resumed) app.log.info({ resumed }, 'resumed interrupted scans');
  if (!env.GOOGLE_CLIENT_ID) app.log.warn('GOOGLE_CLIENT_ID is not set: sign-in is disabled');
  if (!env.TOKEN_MASTER_KEY) app.log.warn('TOKEN_MASTER_KEY is not set: inboxes cannot be connected');
}

export function reportStartupFailure(err: unknown): never {
  if (err instanceof EnvError) {
    process.stderr.write(`${err.message}
`); // variable names and rules only, never values
  } else {
    process.stderr.write(`Startup failed: ${scrubString(err instanceof Error ? err.message : 'unknown error')}
`);
  }
  process.exit(1);
}
