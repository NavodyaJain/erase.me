import { describe, expect, it } from 'vitest';
import { EnvError, isRealSendEnabled, loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://erase_api:pw@localhost:5432/erase',
  REDIS_URL: 'redis://localhost:6379',
  AI_SERVICE_URL: 'http://localhost:8000',
};
const key32 = Buffer.alloc(32, 7).toString('base64');

function failure(source: Record<string, string | undefined>): EnvError {
  try {
    loadEnv(source);
  } catch (e) {
    expect(e).toBeInstanceOf(EnvError);
    return e as EnvError;
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    const env = loadEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.ALLOW_REAL_SEND).toBe(false);
    expect(env.REAL_SEND_DAILY_CAP).toBe(5);
  });

  it('treats empty values as unset (as copied from .env.example)', () => {
    const env = loadEnv({ ...base, TOKEN_MASTER_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', AI_SERVICE_TOKEN: '' });
    expect(env.TOKEN_MASTER_KEY).toBeUndefined();
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it('names every missing required variable', () => {
    const err = failure({});
    expect(err.issues.map((i) => i.variable).sort()).toEqual(['AI_SERVICE_URL', 'DATABASE_URL', 'REDIS_URL']);
  });

  it('never echoes values in its error message', () => {
    const err = failure({
      ...base,
      DATABASE_URL: 'not-a-url-SECRETVALUE1',
      TOKEN_MASTER_KEY: 'SECRETKEYVALUE2',
      AI_SERVICE_TOKEN: 'SECRET3',
    });
    expect(err.message).not.toMatch(/SECRET/);
    expect(err.issues.map((i) => i.variable).sort()).toEqual(['AI_SERVICE_TOKEN', 'DATABASE_URL', 'TOKEN_MASTER_KEY']);
  });

  it('rejects URLs with the wrong protocol', () => {
    expect(failure({ ...base, DATABASE_URL: 'mysql://localhost/db' }).issues[0]?.variable).toBe('DATABASE_URL');
    expect(failure({ ...base, REDIS_URL: 'http://localhost' }).issues[0]?.variable).toBe('REDIS_URL');
  });

  describe('TOKEN_MASTER_KEY', () => {
    it('accepts base64 of 32 bytes', () => {
      expect(loadEnv({ ...base, TOKEN_MASTER_KEY: key32 }).TOKEN_MASTER_KEY).toBe(key32);
    });
    it('rejects other lengths and non-base64', () => {
      expect(failure({ ...base, TOKEN_MASTER_KEY: Buffer.alloc(16, 1).toString('base64') }).issues[0]?.variable).toBe('TOKEN_MASTER_KEY');
      expect(failure({ ...base, TOKEN_MASTER_KEY: 'not base64 !!' }).issues[0]?.variable).toBe('TOKEN_MASTER_KEY');
    });
  });

  describe('real sends', () => {
    it('are off unless ALLOW_REAL_SEND=true', () => {
      expect(isRealSendEnabled(loadEnv(base))).toBe(false);
      expect(isRealSendEnabled(loadEnv({ ...base, ALLOW_REAL_SEND: 'false' }))).toBe(false);
    });
    it('turn on only with the flag and a positive daily cap', () => {
      expect(isRealSendEnabled(loadEnv({ ...base, ALLOW_REAL_SEND: 'true', REAL_SEND_DAILY_CAP: '3' }))).toBe(true);
      expect(failure({ ...base, ALLOW_REAL_SEND: 'true', REAL_SEND_DAILY_CAP: '0' }).issues[0]?.variable).toBe('REAL_SEND_DAILY_CAP');
    });
    it('cannot be enabled in the test environment', () => {
      expect(failure({ ...base, NODE_ENV: 'test', ALLOW_REAL_SEND: 'true' }).issues[0]?.variable).toBe('ALLOW_REAL_SEND');
    });
    it('only accept "true" or "false"', () => {
      expect(failure({ ...base, ALLOW_REAL_SEND: 'yes' }).issues[0]?.variable).toBe('ALLOW_REAL_SEND');
    });
  });

  it('requires hardening settings in production', () => {
    const err = failure({ ...base, NODE_ENV: 'production', WEB_ORIGIN: 'http://erase.example' });
    expect(err.issues.map((i) => i.variable).sort()).toEqual(['AI_SERVICE_TOKEN', 'TOKEN_MASTER_KEY', 'WEB_ORIGIN']);
    const ok = loadEnv({
      ...base,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://app.erase.me',
      TOKEN_MASTER_KEY: key32,
      AI_SERVICE_TOKEN: 'x'.repeat(32),
    });
    expect(ok.NODE_ENV).toBe('production');
  });

  it('needs Google client id and secret together', () => {
    expect(failure({ ...base, GOOGLE_CLIENT_ID: 'id' }).issues[0]?.variable).toBe('GOOGLE_CLIENT_ID');
    expect(loadEnv({ ...base, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }).GOOGLE_CLIENT_ID).toBe('id');
  });
});
