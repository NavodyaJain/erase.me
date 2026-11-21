import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './common/errors.js';
import { buildLogger } from './common/logger.js';
import type { Env } from './config/env.js';
import { healthRoutes } from './modules/health/health.controller.js';
import { HealthService } from './modules/health/health.service.js';

export interface AppDeps {
  env: Env;
  pingDatabase: () => Promise<void>;
  /** Tests pass a stream to capture log output. */
  logStream?: NodeJS.WritableStream;
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

  return app;
}
