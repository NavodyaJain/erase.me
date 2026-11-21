import type { FastifyPluginAsync } from 'fastify';
import type { HealthService } from './health.service.js';

/**
 * Liveness (/healthz) never touches dependencies. Readiness (/readyz) checks the database.
 * Redis is added to readiness when queues arrive (task 3 and 4).
 */
export const healthRoutes: FastifyPluginAsync<{ service: HealthService }> = async (app, { service }) => {
  app.get('/healthz', async () => ({ status: 'ok' as const }));
  app.get('/readyz', async () => service.readiness());
};
