import { buildApp } from './app.js';
import { scrubString } from './common/scrub.js';
import { EnvError, loadEnv } from './config/env.js';
import { createDb } from './db/client.js';
import { createHealthRepository } from './modules/health/health.repository.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { pool, close } = createDb(env.DATABASE_URL);
  const health = createHealthRepository(pool);
  const app = buildApp({ env, pingDatabase: () => health.pingDatabase() });
  pool.on('error', (err) => app.log.error({ err }, 'database pool error'));

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) {
    process.stderr.write(`${err.message}\n`); // variable names and rules only, never values
  } else {
    process.stderr.write(`Startup failed: ${scrubString(err instanceof Error ? err.message : 'unknown error')}\n`);
  }
  process.exit(1);
});
