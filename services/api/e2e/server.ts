import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../src/config/env.js';
import { reportStartupFailure, start } from '../src/start.js';
import { E2eClock, registerE2eControls } from './controls.js';
import { e2eAppUrl, e2eOwnerUrl, prepareE2eDatabase } from './db.js';
import { FakeGmail, FakeGoogle } from './fakes.js';
import { assertE2eAllowed, assertE2eLaunchAllowed } from './guard.js';

/**
 * The end-to-end API (`pnpm --filter @erase/api e2e:server`). It is a separate entry: src/server.ts never imports this
 * folder. It uses a dedicated database, a fake Google and a fake Gmail, and a fictional catalog, and it refuses to run
 * unless assertE2eAllowed says every guard holds.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = process.env.E2E_API_PORT ?? '4100';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3100';
const adminUrl = process.env.E2E_DATABASE_ADMIN_URL ?? process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://erase:erase@localhost:5432/postgres';

// Refuse on the environment as given, before anything below overrides it.
try {
  assertE2eLaunchAllowed(process.env);
} catch (err) {
  reportStartupFailure(err);
}

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

  const clock = new E2eClock();
  const google = new FakeGoogle(env.API_PUBLIC_URL);
  const gmail = new FakeGmail();

  await start({
    overrides: {
      google,
      gmail,
      now: clock.now,
      catalogDir: path.join(here, 'catalog'),
      // Every test signs in again from the same address, which the real limit (30 a minute) would refuse.
      authRateLimitPerMinute: 10_000,
    },
    plugins: [
      ({ app }) => {
        registerE2eControls(app, { env, source: process.env, owner, clock, google, gmail, services: () => app.services });
        return Promise.resolve();
      },
    ],
  });
}

main().catch(reportStartupFailure);
