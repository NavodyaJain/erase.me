import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../src/config/env.js';
import { reportStartupFailure, start } from '../src/start.js';
import { e2eAppUrl, e2eOwnerUrl, prepareE2eDatabase, wipeE2eData } from './db.js';
import { FakeGmail, FakeGoogle } from './fakes.js';
import { assertE2eAllowed } from './guard.js';

/**
 * The end-to-end API (`pnpm --filter @erase/api e2e:server`). It is a separate entry: src/server.ts never imports this
 * folder. It uses a dedicated database, a fake Google and a fake Gmail, and a fictional catalog, and it refuses to run
 * unless assertE2eAllowed says every guard holds.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = process.env.E2E_API_PORT ?? '4100';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3100';
const adminUrl = process.env.E2E_DATABASE_ADMIN_URL ?? process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://erase:erase@localhost:5432/postgres';

Object.assign(process.env, {
  NODE_ENV: 'development',
  API_HOST: '127.0.0.1',
  API_PORT,
  API_PUBLIC_URL: `http://localhost:${API_PORT}`,
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  DATABASE_URL: e2eAppUrl(adminUrl),
  GOOGLE_CLIENT_ID: 'e2e-client-id',
  GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
  // A fixed throwaway key: it protects nothing real, because the tokens in this stack are fakes.
  TOKEN_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  // Required by the env schema but not used here: jobs run in process and nothing calls the AI service.
  REDIS_URL: 'redis://localhost:6379',
  AI_SERVICE_URL: 'http://localhost:8000',
  ALLOW_REAL_SEND: 'false',
  // Background tasks stay off here: tests run them on request, so nothing happens on a timer.
  JOBS_ENABLED: 'false',
  LOG_LEVEL: 'warn',
});

async function main(): Promise<void> {
  const env = loadEnv();
  assertE2eAllowed(env, process.env);
  await prepareE2eDatabase(adminUrl);
  const owner = new pg.Pool({ connectionString: e2eOwnerUrl(adminUrl), max: 2 });

  await start({
    overrides: {
      google: new FakeGoogle(env.API_PUBLIC_URL),
      gmail: new FakeGmail(),
      catalogDir: path.join(here, 'catalog'),
      // Every test signs in again from the same address, which the real limit (30 a minute) would refuse.
      authRateLimitPerMinute: 10_000,
    },
    plugins: [
      ({ app }) => {
        // The fake Google consent page: it approves at once and returns to the real callback.
        app.get('/e2e/google/authorize', async (request, reply) => {
          const q = request.query as { state?: string; purpose?: string };
          const back = new URL('/v1/auth/google/callback', env.API_PUBLIC_URL);
          back.searchParams.set('code', q.purpose === 'connect' ? 'e2e-code-connect' : 'e2e-code-signin');
          back.searchParams.set('state', q.state ?? '');
          return reply.redirect(back.toString());
        });
        // Between tests: forget every person, inbox, scan and request.
        app.post('/e2e/reset', async (_request, reply) => {
          await wipeE2eData(owner);
          return reply.code(204).send();
        });
        return Promise.resolve();
      },
    ],
  });
}

main().catch(reportStartupFailure);
