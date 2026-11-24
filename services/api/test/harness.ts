import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { LocalKeyProvider } from '../src/crypto/key-provider.js';
import { InProcessJobQueue } from '../src/jobs/queue.js';
import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GoogleOAuthError,
  type AuthorizationParams,
  type CodeExchangeResult,
  type GoogleOAuthClient,
} from '../src/modules/auth/google-oauth.js';
import type { GmailClient, GmailMessageMeta, GmailThread, GmailThreadMessage, MessagePage } from '../src/modules/gmail/gmail.client.js';
import type { GmailApiError } from '../src/modules/gmail/gmail.client.js';
import type { SenderChoice } from '../src/modules/requests/sender.js';
import { captureLogs } from './capture.js';
import type { TestDb } from './db-helper.js';

export const WEB_ORIGIN = 'http://localhost:3000';

export interface FakeGrant {
  email: string;
  sub: string;
  name?: string;
  scopes?: string[];
  refreshToken?: string | null;
}

/** Stands in for Google's OAuth endpoints. Records what it was asked, never talks to the network. */
export class FakeGoogle implements GoogleOAuthClient {
  readonly grants = new Map<string, FakeGrant>();
  readonly verifiers = new Map<string, string>();
  readonly revoked = new Set<string>();
  lastAuthorization: AuthorizationParams | undefined;
  revokeResult = true;
  private counter = 0;

  authorizationUrl(p: AuthorizationParams): string {
    this.lastAuthorization = p;
    return `https://fake-google.test/auth?state=${p.state}&purpose=${p.purpose}`;
  }

  /** Registers what the next exchange of `code` yields. */
  grant(code: string, g: FakeGrant): void {
    this.grants.set(code, g);
  }

  exchangeCode(code: string, codeVerifier: string, expectedNonce: string): Promise<CodeExchangeResult> {
    const g = this.grants.get(code);
    if (!g) return Promise.reject(new GoogleOAuthError('invalid_grant'));
    this.grants.delete(code); // codes are single use
    this.verifiers.set(code, codeVerifier);
    void expectedNonce;
    const refresh = g.refreshToken === null ? undefined : (g.refreshToken ?? `refresh-${++this.counter}-${randomBytes(4).toString('hex')}`);
    return Promise.resolve({
      identity: { sub: g.sub, email: g.email, name: g.name ?? 'Test Person' },
      grantedScopes: g.scopes ?? ['openid', 'email', GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
      accessToken: `access-${randomBytes(4).toString('hex')}`,
      ...(refresh ? { refreshToken: refresh } : {}),
    });
  }

  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number }> {
    if (this.revoked.has(refreshToken)) return Promise.reject(new GoogleOAuthError('invalid_grant'));
    return Promise.resolve({ accessToken: `at-${refreshToken}`, expiresInSec: 3600 });
  }

  revoke(token: string): Promise<boolean> {
    this.revoked.add(token);
    return Promise.resolve(this.revokeResult);
  }
}

export interface FakeMessage {
  id: string;
  receivedAt: Date;
  from: string;
  subject: string;
  listUnsubscribe?: boolean;
  listId?: boolean;
  replyTo?: string;
  /** Hostnames of the List-Unsubscribe targets. */
  unsubscribeHosts?: string[];
  /** Gmail returned a message that cannot be placed in time; the client skips it. */
  undatable?: boolean;
}

/** A mailbox in memory. Implements only the metadata calls the scan is allowed to make. */
export class FakeGmail implements GmailClient {
  messages: FakeMessage[] = [];
  readonly calls: string[] = [];
  /** The Gmail search text of each list call. */
  readonly queries: string[] = [];
  /** Throw this on the Nth list call (1-based), once. */
  failListOn: { call: number; error: GmailApiError } | undefined;
  /** Runs before the Nth list call (1-based). Lets a test act mid-scan, for example disconnect the inbox. */
  beforeList: ((call: number) => Promise<void>) | undefined;
  /** Total list calls so far. Tests use it to aim failures at a call relative to now. */
  listCalls = 0;

  async listMessageIds(accessToken: string, q: { query: string; pageToken?: string; maxResults: number }): Promise<MessagePage> {
    this.calls.push(`list:${accessToken}:${q.pageToken ?? ''}`);
    this.queries.push(q.query);
    this.listCalls += 1;
    await this.beforeList?.(this.listCalls);
    if (this.failListOn?.call === this.listCalls) {
      const err = this.failListOn.error;
      this.failListOn = undefined;
      throw err;
    }
    const start = q.pageToken ? Number(q.pageToken) : 0;
    const slice = this.messages.slice(start, start + q.maxResults);
    const next = start + q.maxResults;
    return {
      ids: slice.map((m) => m.id),
      ...(next < this.messages.length ? { nextPageToken: String(next) } : {}),
      estimatedTotal: this.messages.length,
    };
  }

  /** Threads by id, for the reply check. A thread that is not here does not exist (Gmail answers 404). */
  readonly threads = new Map<string, GmailThreadMessage[]>();
  /** Every thread id asked for, in order, and the token each call used. */
  readonly threadCalls: Array<{ threadId: string; accessToken: string }> = [];
  /** Throw this on the next thread call for this thread id (once), or for any thread when the key is '*'. */
  readonly failThread = new Map<string, GmailApiError>();

  getThreadMetadata(accessToken: string, threadId: string): Promise<GmailThread | null> {
    this.threadCalls.push({ threadId, accessToken });
    const failure = this.failThread.get(threadId) ?? this.failThread.get('*');
    if (failure) {
      this.failThread.delete(threadId);
      return Promise.reject(failure);
    }
    const messages = this.threads.get(threadId);
    return Promise.resolve(messages ? { id: threadId, messages: messages.map((m) => ({ ...m })) } : null);
  }

  getMessageMetadata(accessToken: string, id: string): Promise<GmailMessageMeta | null> {
    this.calls.push(`meta:${accessToken}`);
    const m = this.messages.find((x) => x.id === id);
    if (!m || m.undatable) return Promise.resolve(null);
    return Promise.resolve({
      id: m.id,
      receivedAt: m.receivedAt,
      from: m.from,
      subject: m.subject,
      hasListUnsubscribe: m.listUnsubscribe ?? false,
      hasListId: m.listId ?? false,
      replyTo: m.replyTo,
      listUnsubscribeHosts: m.unsubscribeHosts ?? [],
    });
  }
}

export interface Harness {
  app: FastifyInstance;
  env: Env;
  google: FakeGoogle;
  gmail: FakeGmail;
  queue: InProcessJobQueue;
  logs: ReturnType<typeof captureLogs>;
  masterKey: string;
  clock: { now: Date };
}

export interface HarnessOptions {
  withGoogle?: boolean;
  withKeys?: boolean;
  envOverrides?: Record<string, string>;
  authRateLimitPerMinute?: number;
  /** Replaces the default sender choice (fake in test). */
  sender?: SenderChoice;
  /** Runs after the app is built and before it is ready, for example to register the dev helper. */
  beforeReady?: (app: FastifyInstance, ctx: { env: Env; db: Db }) => Promise<void>;
}

export async function buildHarness(t: TestDb, opts: HarnessOptions = {}): Promise<Harness> {
  const masterKey = randomBytes(32).toString('base64');
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@localhost:5432/x',
    REDIS_URL: 'redis://localhost:6379',
    AI_SERVICE_URL: 'http://localhost:8000',
    WEB_ORIGIN,
    API_PUBLIC_URL: 'http://localhost:4000',
    LOG_LEVEL: 'debug',
    ...opts.envOverrides,
  });
  // A pool, not the single test connection: the requests module runs real concurrent transactions.
  const pool = new pg.Pool({ connectionString: t.appUrl, max: 8 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  const logs = captureLogs();
  const google = new FakeGoogle();
  const gmail = new FakeGmail();
  const clock = { now: new Date('2026-11-22T10:00:00Z') };
  const queue = new InProcessJobQueue((name, err) => {
    throw new Error(`job ${name} failed: ${err instanceof Error ? err.message : 'unknown'}`);
  });
  const app = buildApp({
    env,
    pingDatabase: () => Promise.resolve(),
    logStream: logs.stream,
    modules: {
      db,
      google: opts.withGoogle === false ? undefined : google,
      gmail,
      keys: opts.withKeys === false ? undefined : new LocalKeyProvider(masterKey),
      queue,
      now: () => new Date(clock.now),
      authRateLimitPerMinute: opts.authRateLimitPerMinute ?? 10_000,
      ...(opts.sender ? { sender: opts.sender } : {}),
    },
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });
  await opts.beforeReady?.(app, { env, db });
  await app.ready();
  return { app, env, google, gmail, queue, logs, masterKey, clock };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

const cookieValue = (setCookie: string | string[] | undefined, name: string): string | undefined => {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit?.split(';')[0]?.slice(name.length + 1);
};

/** Runs the whole sign-in flow against the fake Google and returns the cookie and CSRF token. */
export async function signIn(h: Harness, who: { email: string; sub: string; name?: string }, code = `code-${who.sub}`): Promise<Session> {
  h.google.grant(code, who);
  const start = await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
  const state = h.google.lastAuthorization?.state ?? '';
  const stateCookie = cookieValue(start.headers['set-cookie'], 'erase_oauth_state') ?? '';
  const cb = await h.app.inject({
    method: 'GET',
    url: `/v1/auth/google/callback?code=${code}&state=${state}`,
    headers: { cookie: `erase_oauth_state=${stateCookie}` },
  });
  const session = cookieValue(cb.headers['set-cookie'], 'erase_session');
  if (!session) throw new Error(`sign-in failed: ${cb.headers.location ?? cb.statusCode}`);
  const cookie = `erase_session=${session}`;
  const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
  const body = me.json<{ id: string; csrfToken: string }>();
  return { cookie, csrf: body.csrfToken, userId: body.id };
}

export const authed = (s: Session) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: WEB_ORIGIN });

/** Connects an inbox through the connect flow. Returns the inbox id. */
export async function connectInbox(
  h: Harness,
  s: Session,
  g: FakeGrant,
  code = `connect-${g.sub}-${g.email}`,
): Promise<{ inboxId: string; refreshToken: string }> {
  h.google.grant(code, { refreshToken: `rt-${code}`, ...g });
  const start = await h.app.inject({ method: 'POST', url: '/v1/inboxes/connect/start', headers: authed(s) });
  if (start.statusCode !== 200) throw new Error(`connect start failed: ${start.statusCode}`);
  const state = h.google.lastAuthorization?.state ?? '';
  const stateCookie = cookieValue(start.headers['set-cookie'], 'erase_oauth_state') ?? '';
  const cb = await h.app.inject({
    method: 'GET',
    url: `/v1/auth/google/callback?code=${code}&state=${state}`,
    headers: { cookie: `${s.cookie}; erase_oauth_state=${stateCookie}` },
  });
  if (!String(cb.headers.location).includes('inbox=connected')) throw new Error(`connect failed: ${cb.headers.location}`);
  const list = await h.app.inject({ method: 'GET', url: '/v1/inboxes', headers: { cookie: s.cookie } });
  const inbox = list.json<{ inboxes: Array<{ id: string; email: string }> }>().inboxes.find((i) => i.email === g.email);
  if (!inbox) throw new Error('inbox not listed');
  return { inboxId: inbox.id, refreshToken: g.refreshToken ?? `rt-${code}` };
}
