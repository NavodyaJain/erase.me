import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** What a handler supplies. Extension members (for example `checks`) are allowed by RFC 9457. */
interface ProblemInput {
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
  [extension: string]: unknown;
}

/** RFC 9457 problem details with a stable machine-readable `code` (TRD 6.2). */
export interface ProblemDetails extends ProblemInput {
  type: string;
  instance?: string;
  requestId?: string;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(title);
    this.name = 'AppError';
  }
}

export const Problems = {
  notFound: (detail?: string) => new AppError(404, 'not_found', 'Not found', detail),
  unauthorized: () => new AppError(401, 'unauthorized', 'Sign in required'),
  forbidden: () => new AppError(403, 'forbidden', 'Not allowed'),
  deletionPending: () =>
    new AppError(403, 'deletion_pending', 'Your data is scheduled to be deleted', 'Undo it from Your data to use Erase.me again. Nothing is sent, checked or followed up while it is pending.'),
  tooManyRequests: () => new AppError(429, 'rate_limited', 'Too many requests'),
  badRequest: (code: string, title: string, detail?: string) => new AppError(400, code, title, detail),
  unavailable: (code: string, title: string, detail?: string) => new AppError(503, code, title, detail),
  conflict: (code: string, title: string, detail?: string) => new AppError(409, code, title, detail),
  notReady: (checks: Record<string, 'ok' | 'fail'>) =>
    new AppError(503, 'not_ready', 'Service not ready', undefined, { checks }),
};

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Sign in required',
  403: 'Not allowed',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Request too large',
  415: 'Unsupported media type',
  422: 'Unprocessable request',
  429: 'Too many requests',
};

function send(reply: FastifyReply, request: FastifyRequest, problem: ProblemInput) {
  const body: ProblemDetails = {
    type: `urn:erase:problem:${problem.code}`,
    ...problem,
    // Path only. The query string can carry OAuth codes or other sensitive values.
    instance: request.url.split('?')[0] ?? '/',
    requestId: request.id,
  };
  return reply.status(problem.status).type('application/problem+json').send(body);
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    send(reply, request, { title: 'Not found', status: 404, code: 'not_found' }),
  );

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      return send(reply, request, {
        ...error.extensions,
        title: error.title,
        status: error.status,
        code: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
      });
    }
    if (error instanceof ZodError) {
      // Report where and which rule failed. Never echo the submitted values.
      return send(reply, request, {
        title: 'Request validation failed',
        status: 400,
        code: 'validation_failed',
        errors: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (error as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Framework errors (bad JSON, oversized body, wrong media type). Their messages can quote
      // request content, so only a generic detail is returned.
      return send(reply, request, {
        title: TITLES[status] ?? 'Bad request',
        status,
        code: status === 400 ? 'malformed_request' : `http_${status}`,
        detail: 'The request could not be processed.',
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    return send(reply, request, { title: 'Internal error', status: 500, code: 'internal_error' });
  });
}
