import { describe, expect, it } from 'vitest';
import { EnvError, googleRedirectUri, isRealSendEnabled, jobsEnabled, loadEnv } from './env.js';

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

  it('reads the scan limits: window and cap are optional, the cap defaults to 50000', () => {
    const defaults = loadEnv(base);
    expect(defaults.SCAN_WINDOW_YEARS).toBeUndefined();
    expect(defaults.SCAN_MAX_MESSAGES).toBe(50_000);
    const set = loadEnv({ ...base, SCAN_WINDOW_YEARS: '5', SCAN_MAX_MESSAGES: '2000', SCAN_EXCLUDE: 'employer.example' });
    expect(set).toMatchObject({ SCAN_WINDOW_YEARS: 5, SCAN_MAX_MESSAGES: 2000, SCAN_EXCLUDE: 'employer.example' });
    expect(loadEnv({ ...base, SCAN_WINDOW_YEARS: '', SCAN_MAX_MESSAGES: '' }).SCAN_MAX_MESSAGES).toBe(50_000);
    expect(failure({ ...base, SCAN_WINDOW_YEARS: '0' }).issues.map((i) => i.variable)).toEqual(['SCAN_WINDOW_YEARS']);
    expect(failure({ ...base, SCAN_MAX_MESSAGES: '5' }).issues.map((i) => i.variable)).toEqual(['SCAN_MAX_MESSAGES']);
  });

  it('reads the activity thresholds: 90 and 365 days by default, old must be greater than recent', () => {
    expect(loadEnv(base)).toMatchObject({ ACTIVITY_RECENT_DAYS: 90, ACTIVITY_OLD_DAYS: 365 });
    expect(loadEnv({ ...base, ACTIVITY_RECENT_DAYS: '30', ACTIVITY_OLD_DAYS: '180' })).toMatchObject({ ACTIVITY_RECENT_DAYS: 30, ACTIVITY_OLD_DAYS: 180 });
    expect(loadEnv({ ...base, ACTIVITY_RECENT_DAYS: '', ACTIVITY_OLD_DAYS: '' }).ACTIVITY_OLD_DAYS).toBe(365);
    expect(failure({ ...base, ACTIVITY_RECENT_DAYS: '200', ACTIVITY_OLD_DAYS: '100' }).issues.map((i) => i.variable)).toEqual(['ACTIVITY_OLD_DAYS']);
    expect(failure({ ...base, ACTIVITY_RECENT_DAYS: '0' }).issues.map((i) => i.variable)).toEqual(['ACTIVITY_RECENT_DAYS']);
  });

  it('reads the tracking settings: follow-up after 30 days, one follow-up, poll every 15 minutes, retention 30 and 7 days', () => {
    expect(loadEnv(base)).toMatchObject({
      FOLLOWUP_AFTER_DAYS: 30,
      FOLLOWUP_MAX: 1,
      REPLY_POLL_MINUTES: 15,
      REPLY_POLL_MAX_AGE_DAYS: 120,
      INBOX_RETENTION_DAYS: 30,
      ACCOUNT_PURGE_AFTER_DAYS: 7,
    });
    expect(loadEnv({ ...base, FOLLOWUP_AFTER_DAYS: '14', FOLLOWUP_MAX: '0', ACCOUNT_PURGE_AFTER_DAYS: '0' })).toMatchObject({
      FOLLOWUP_AFTER_DAYS: 14,
      FOLLOWUP_MAX: 0,
      ACCOUNT_PURGE_AFTER_DAYS: 0,
    });
    expect(loadEnv({ ...base, FOLLOWUP_AFTER_DAYS: '', REPLY_POLL_MINUTES: '' })).toMatchObject({ FOLLOWUP_AFTER_DAYS: 30, REPLY_POLL_MINUTES: 15 });
  });

  it.each([
    ['FOLLOWUP_AFTER_DAYS', '0'],
    ['FOLLOWUP_MAX', '4'],
    ['REPLY_POLL_MINUTES', '0'],
    ['REPLY_POLL_MAX_AGE_DAYS', '1000'],
    ['INBOX_RETENTION_DAYS', '-1'],
    ['ACCOUNT_PURGE_AFTER_DAYS', '31'],
  ])('refuses %s=%s, naming only the variable', (name, value) => {
    expect(failure({ ...base, [name]: value }).issues.map((i) => i.variable)).toEqual([name]);
  });

  it('runs the background tasks by default, except in tests, and JOBS_ENABLED overrides both ways', () => {
    expect(jobsEnabled(loadEnv(base))).toBe(true);
    expect(jobsEnabled(loadEnv({ ...base, NODE_ENV: 'test' }))).toBe(false);
    expect(jobsEnabled(loadEnv({ ...base, NODE_ENV: 'test', JOBS_ENABLED: 'true' }))).toBe(true);
    expect(jobsEnabled(loadEnv({ ...base, JOBS_ENABLED: 'false' }))).toBe(false);
    expect(failure({ ...base, JOBS_ENABLED: 'yes' }).issues.map((i) => i.variable)).toEqual(['JOBS_ENABLED']);
  });

  it('derives the Google redirect URI from API_PUBLIC_URL with the registered callback path', () => {
    expect(googleRedirectUri(loadEnv(base))).toBe('http://localhost:4000/v1/auth/google/callback');
    expect(googleRedirectUri(loadEnv({ ...base, API_PUBLIC_URL: 'https://api.erase.me' }))).toBe(
      'https://api.erase.me/v1/auth/google/callback',
    );
  });

  it('takes WEB_ORIGIN as an origin: a trailing slash is normalised, a path is refused', () => {
    expect(loadEnv({ ...base, WEB_ORIGIN: 'http://localhost:3005' }).WEB_ORIGIN).toBe('http://localhost:3005');
    expect(loadEnv({ ...base, WEB_ORIGIN: 'http://localhost:3005/' }).WEB_ORIGIN).toBe('http://localhost:3005');
    expect(loadEnv({ ...base, WEB_ORIGIN: 'HTTPS://App.Erase.Me' }).WEB_ORIGIN).toBe('https://app.erase.me');
    expect(loadEnv(base).WEB_ORIGIN).toBe('http://localhost:3000');
    for (const bad of ['http://localhost:3000/app', 'http://localhost:3000?x=1', 'ftp://localhost', 'localhost:3000', 'http://user@localhost:3000']) {
      expect(failure({ ...base, WEB_ORIGIN: bad }).issues.map((i) => i.variable), bad).toEqual(['WEB_ORIGIN']);
    }
  });

  it('requires hardening settings in production', () => {
    const err = failure({ ...base, NODE_ENV: 'production', WEB_ORIGIN: 'http://erase.example' });
    expect(err.issues.map((i) => i.variable).sort()).toEqual(['AI_SERVICE_TOKEN', 'API_PUBLIC_URL', 'TOKEN_MASTER_KEY', 'WEB_ORIGIN']);
    const ok = loadEnv({
      ...base,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://app.erase.me',
      API_PUBLIC_URL: 'https://api.erase.me',
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
