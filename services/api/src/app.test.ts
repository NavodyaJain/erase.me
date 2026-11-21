import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { captureLogs } from '../test/capture.js';
import { buildApp } from './app.js';
import { AppError, Problems } from './common/errors.js';
import { loadEnv } from './config/env.js';

const env = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://erase_api:pw@localhost:5432/erase',
  REDIS_URL: 'redis://localhost:6379',
  AI_SERVICE_URL: 'http://localhost:8000',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let app: FastifyInstance | undefined;

function make(pingDatabase: () => Promise<void> = async () => undefined) {
  const logs = captureLogs();
  app = buildApp({ env, pingDatabase, logStream: logs.stream });
  // Test-only routes, registered before the first request.
  app.post('/_t/echo', async (req) => req.body);
  app.post('/_t/validate', async (req) => z.object({ count: z.number() }).parse(req.body));
  app.get('/_t/app-error', async () => {
    throw Problems.conflict('request_not_approved', 'Request is not approved', 'Approve the current draft first.');
  });
  app.get('/_t/custom-error', async () => {
    throw new AppError(422, 'custom_rule', 'Custom rule failed', undefined, { field: 'x' });
  });
  app.get('/_t/boom', async () => {
    throw new Error('explosion for riya.s@gmail.com');
  });
  return { app, logs };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health endpoints', () => {
  it('GET /healthz is a liveness probe that touches no dependency', async () => {
    const { app } = make(async () => {
      throw new Error('database down');
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reports ready when the database answers', async () => {
    const { app } = make();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('GET /readyz answers 503 problem details when the database is down, without leaking the cause', async () => {
    const { app, logs } = make(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 for riya.s@gmail.com');
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'not_ready', status: 503, checks: { database: 'fail' } });
    expect(res.body).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|riya/);
    expect(logs.text()).toContain('readiness check failed');
    expect(logs.text()).not.toMatch(/10\.0\.0\.5|riya\.s/);
  });
});

describe('problem details', () => {
  it('answers unknown routes with 404 and never echoes the query string', async () => {
    const { app } = make();
    const res = await app.inject({ method: 'GET', url: '/nope?code=SECRETCODE&email=riya.s@gmail.com' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body).toMatchObject({ type: 'urn:erase:problem:not_found', code: 'not_found', status: 404, instance: '/nope' });
    expect(res.body).not.toMatch(/SECRETCODE|riya/);
  });

  it('maps AppError to its status, code and extensions', async () => {
    const { app } = make();
    const conflict = await app.inject({ method: 'GET', url: '/_t/app-error' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: 'request_not_approved',
      title: 'Request is not approved',
      detail: 'Approve the current draft first.',
    });
    const custom = await app.inject({ method: 'GET', url: '/_t/custom-error' });
    expect(custom.json()).toMatchObject({ status: 422, code: 'custom_rule', field: 'x' });
  });

  it('maps validation failures to 400 with paths and rules but not values', async () => {
    const { app } = make();
    const res = await app.inject({ method: 'POST', url: '/_t/validate', payload: { count: 'SUBMITTED-VALUE-123' } });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; errors: Array<{ path: string; message: string }> }>();
    expect(body.code).toBe('validation_failed');
    expect(body.errors[0]?.path).toBe('count');
    expect(res.body).not.toContain('SUBMITTED-VALUE-123');
  });

  it('answers malformed JSON with a generic 400', async () => {
    const { app } = make();
    const res = await app.inject({
      method: 'POST',
      url: '/_t/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"draft": "Dear Acme, riya.s@gmail.com" oops',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'malformed_request', detail: 'The request could not be processed.' });
    expect(res.body).not.toMatch(/Acme|riya|oops/);
  });

  it('hides the cause of unexpected errors', async () => {
    const { app, logs } = make();
    const res = await app.inject({ method: 'GET', url: '/_t/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'internal_error', status: 500 });
    expect(res.body).not.toMatch(/explosion|riya/);
    expect(logs.text()).toContain('unhandled error');
    expect(logs.text()).not.toContain('riya.s@gmail.com');
  });

  it('always includes a request id', async () => {
    const { app } = make();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.json<{ requestId: string }>().requestId).toMatch(UUID);
  });
});

describe('request handling', () => {
  it('sets a request id and security headers, and ignores an incoming X-Request-Id', async () => {
    const { app } = make();
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'attacker\nlog-line' } });
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('logs one minimal line per request and no personal data', async () => {
    const { app, logs } = make();
    await app.inject({
      method: 'POST',
      url: '/_t/echo?email=riya.s@gmail.com&code=OAUTH-CODE-123',
      headers: {
        authorization: 'Bearer ya29.a0AfH6SMB-secret-token',
        cookie: 'sid=SESSIONSECRET',
        'x-forwarded-for': '203.0.113.42',
      },
      payload: { subject: 'Erase my data', body: 'Dear Acme, please erase my records. PAN ABCDE1234F', to: 'privacy@acme.example' },
    });
    const text = logs.text();
    for (const s of ['riya.s@gmail.com', 'OAUTH-CODE-123', 'ya29', 'SESSIONSECRET', '203.0.113.42', 'Dear Acme', 'ABCDE1234F', 'privacy@acme.example']) {
      expect(text).not.toContain(s);
    }
    const completed = logs.lines().filter((l) => l.msg === 'request completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ method: 'POST', route: '/_t/echo', statusCode: 200 });
  });
});
