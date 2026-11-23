import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { assertE2eAllowed } from '../../e2e/guard.js';

const ok = { E2E_MODE: 'true', DATABASE_URL: 'postgres://u:p@localhost:5432/erase_e2e' };
const envFor = (node: string, extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: node,
    DATABASE_URL: ok.DATABASE_URL,
    REDIS_URL: 'redis://localhost:6379',
    AI_SERVICE_URL: 'http://localhost:8000',
    ...extra,
  });

describe('the e2e stack guard', () => {
  it('allows development with E2E_MODE=true and a local _e2e database', () => {
    expect(() => assertE2eAllowed(envFor('development'), ok)).not.toThrow();
    expect(() => assertE2eAllowed(envFor('test'), ok)).not.toThrow();
  });

  it('refuses in production and staging, even with E2E_MODE=true', () => {
    expect(() => assertE2eAllowed({ NODE_ENV: 'production', ALLOW_REAL_SEND: false }, ok)).toThrow(/NODE_ENV must not be production/);
    expect(() => assertE2eAllowed({ NODE_ENV: 'staging', ALLOW_REAL_SEND: false }, ok)).toThrow(/staging/);
  });

  it('refuses without E2E_MODE=true', () => {
    expect(() => assertE2eAllowed(envFor('development'), { DATABASE_URL: ok.DATABASE_URL })).toThrow(/E2E_MODE/);
    expect(() => assertE2eAllowed(envFor('development'), { ...ok, E2E_MODE: '1' })).toThrow(/E2E_MODE/);
  });

  it('refuses any database that is not a local one ending in _e2e, so the dev database is never touched', () => {
    for (const url of ['postgres://u:p@localhost:5432/erase', 'postgres://u:p@localhost:5432/erase_test_e2e_x', 'postgres://u:p@db.prod.example.com:5432/erase_e2e', 'not a url', '']) {
      expect(() => assertE2eAllowed(envFor('development'), { ...ok, DATABASE_URL: url }), url).toThrow(/DATABASE_URL/);
    }
  });

  it('refuses when real sending is on', () => {
    expect(() => assertE2eAllowed({ NODE_ENV: 'development', ALLOW_REAL_SEND: true }, ok)).toThrow(/ALLOW_REAL_SEND/);
  });
});

describe('the e2e stack stays out of the product', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const src = path.resolve(__dirname, '../../src');
  const files = walk(src).filter((f) => /\.(ts|js)$/.test(f) && !/\.test\.ts$/.test(f));

  it('nothing under src imports the e2e folder or the fakes', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/(from|import\()\s*['"][^'"]*e2e\//);
  });

  it('the production entry passes no overrides', () => {
    for (const entry of ['server.ts']) {
      const text = readFileSync(path.join(src, entry), 'utf8');
      expect(text).not.toMatch(/overrides|FakeGoogle|FakeGmail|E2E_MODE/);
    }
  });

  it('the env schema has no e2e switch, and the OpenAPI contract has no e2e route', () => {
    expect(readFileSync(path.join(src, 'config/env.ts'), 'utf8')).not.toMatch(/E2E/);
    expect(readFileSync(path.resolve(__dirname, '../../openapi/openapi.json'), 'utf8')).not.toMatch(/e2e/i);
  });
});
