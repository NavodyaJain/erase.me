import { buildApp } from './app.js';
import { scrubString } from './common/scrub.js';
import { EnvError, googleRedirectUri, loadEnv } from './config/env.js';
import { createDb } from './db/client.js';
import { LocalKeyProvider } from './crypto/key-provider.js';
import { InProcessJobQueue } from './jobs/queue.js';
import { HttpGoogleOAuthClient } from './modules/auth/google-oauth.js';
import { HttpGmailClient } from './modules/gmail/gmail.client.js';
import { createHealthRepository } from './modules/health/health.repository.js';

async function main(): Promise<void> {
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
      gmail: new HttpGmailClient(),
      // Secrets stay inside these two objects: they are never logged or returned.
      google:
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? new HttpGoogleOAuthClient({
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              redirectUri: googleRedirectUri(env),
            })
          : undefined,
      keys: env.TOKEN_MASTER_KEY ? new LocalKeyProvider(env.TOKEN_MASTER_KEY) : undefined,
    },
  });
  pool.on('error', (err) => app.log.error({ err }, 'database pool error'));

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await queue.drain();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  const resumed = await app.services?.scans.resumeInterrupted();
  if (resumed) app.log.info({ resumed }, 'resumed interrupted scans');
  if (!env.GOOGLE_CLIENT_ID) app.log.warn('GOOGLE_CLIENT_ID is not set: sign-in is disabled');
  if (!env.TOKEN_MASTER_KEY) app.log.warn('TOKEN_MASTER_KEY is not set: inboxes cannot be connected');
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) {
    process.stderr.write(`${err.message}\n`); // variable names and rules only, never values
  } else {
    process.stderr.write(`Startup failed: ${scrubString(err instanceof Error ? err.message : 'unknown error')}\n`);
  }
  process.exit(1);
});
