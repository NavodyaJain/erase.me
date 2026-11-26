import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { E2E_ROUTES, E2eClock, registerE2eControls, type E2eDeps } from '../../e2e/controls.js';
import { FakeGmail, FakeGoogle } from '../../e2e/fakes.js';
import { createTestDb, type TestDb } from '../db-helper.js';
import { buildHarness, type Harness } from '../harness.js';

/**
 * The e2e controls have no sign-in: they can move the clock, add replies and wipe the database. These tests show that a
 * normal or production app does not have them, and that nothing can add them where the guard says no.
 */
const api = path.resolve(__dirname, '../..');
const urlOf = (route: string) => route.replace(':name', 'purge');

const deps = (over: Partial<E2eDeps> = {}): E2eDeps => ({
  env: { NODE_ENV: 'development', ALLOW_REAL_SEND: false, API_PUBLIC_URL: 'http://localhost:4100' },
  source: { E2E_MODE: 'true', DATABASE_URL: 'postgres://u:p@localhost:5432/erase_e2e' },
  owner: { query: () => Promise.reject(new Error('not used')) },
  clock: new E2eClock(),
  google: new FakeGoogle('http://localhost:4100'),
  gmail: new FakeGmail(),
  services: () => undefined,
  ...over,
});

describe('a normal start has none of the e2e controls', () => {
  let t: TestDb;
  let h: Harness;
  beforeAll(async () => {
    t = await createTestDb();
    h = await buildHarness(t);
  });
  afterAll(async () => {
    await h.app.close();
    await t.drop();
  });

  it.each(E2E_ROUTES)('%s %s is not found in the app as the product builds it', async (method, route) => {
    expect(h.app.hasRoute({ method, url: route })).toBe(false);
    const res = await h.app.inject({ method, url: urlOf(route), payload: method === 'POST' ? { advanceDays: 31, who: 'second' } : undefined });
    expect(res.statusCode).toBe(404);
  });

  it('nor in an app built with the production settings', async () => {
    const env = { ...h.env, NODE_ENV: 'production' as const };
    const app = buildApp({ env, pingDatabase: () => Promise.resolve() });
    try {
      await app.ready();
      for (const [method, route] of E2E_ROUTES) expect((await app.inject({ method, url: urlOf(route) })).statusCode, `${method} ${route}`).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('every route the controls add is in the list checked above', async () => {
    const app = Fastify();
    const added: string[] = [];
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) if (m !== 'HEAD') added.push(`${m} ${r.url}`);
    });
    registerE2eControls(app, deps());
    await app.ready();
    expect(added.sort()).toEqual(E2E_ROUTES.map(([m, r]) => `${m} ${r}`).sort());
    await app.close();
  });
});

describe('the controls cannot be added where the guard says no', () => {
  const good = deps();
  it.each([
    ['production', { env: { ...good.env, NODE_ENV: 'production' as const } }],
    ['staging', { env: { ...good.env, NODE_ENV: 'staging' as const } }],
    ['real sending on', { env: { ...good.env, ALLOW_REAL_SEND: true } }],
    ['no E2E_MODE', { source: { DATABASE_URL: good.source.DATABASE_URL } }],
    ['the development database', { source: { E2E_MODE: 'true', DATABASE_URL: 'postgres://u:p@localhost:5432/erase' } }],
    ['a remote database', { source: { E2E_MODE: 'true', DATABASE_URL: 'postgres://u:p@db.example.com:5432/erase_e2e' } }],
  ] as Array<[string, Partial<E2eDeps>]>)('%s: refuses, and registers nothing', async (_name, over) => {
    const app = Fastify();
    expect(() => registerE2eControls(app, deps(over))).toThrow(/refused to start/);
    await app.ready();
    for (const [method, route] of E2E_ROUTES) expect(app.hasRoute({ method, url: route })).toBe(false);
    await app.close();
  });
});

describe('the e2e entry itself', () => {
  /** Starts services/api/e2e/server.ts as a real process. It must stop before it reaches any database. */
  const launch = (env: Record<string, string>) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['E2E_MODE', 'NODE_ENV', 'ALLOW_REAL_SEND', 'DATABASE_URL'].includes(k)));
    // A port nothing listens on: if the guard did not stop it, it would fail to reach Postgres and say something else.
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'e2e/server.ts'], { cwd: api, env: { ...base, E2E_DATABASE_ADMIN_URL: 'postgres://u:p@localhost:1/postgres', ...env } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 40_000 });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };

  it.each([
    ['without E2E_MODE', {}, /E2E_MODE must be "true"/],
    ['in production, even with E2E_MODE', { E2E_MODE: 'true', NODE_ENV: 'production' }, /NODE_ENV must not be production/],
    ['in staging', { E2E_MODE: 'true', NODE_ENV: 'staging' }, /NODE_ENV must not be staging/],
    ['with real sending on', { E2E_MODE: 'true', ALLOW_REAL_SEND: 'true' }, /ALLOW_REAL_SEND must be false/],
  ] as Array<[string, Record<string, string>, RegExp]>)('refuses to start %s', (_name, env, message) => {
    const r = launch(env);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(message);
  }, 60_000);

  it('is the only place the controls are registered, and the product’s start never imports them', () => {
    for (const file of ['src/server.ts', 'src/start.ts', 'src/app.ts']) {
      expect(readFileSync(path.join(api, file), 'utf8'), file).not.toMatch(/registerE2eControls|\/e2e\/|E2eClock/);
    }
    const scripts = (JSON.parse(readFileSync(path.join(api, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.start ?? '').not.toContain('e2e');
    expect(scripts.dev ?? '').not.toContain('e2e');
  });
});
