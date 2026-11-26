import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppServices } from '../src/app.js';
import type { Env } from '../src/config/env.js';
import { wipeE2eData } from './db.js';
import type { FakeGmail, FakeGoogle } from './fakes.js';
import { assertE2eAllowed } from './guard.js';

/** The app's clock in the e2e stack: real time plus whatever a test has moved it on by. The database clock is not moved. */
export class E2eClock {
  private offsetMs = 0;
  readonly now = (): Date => new Date(Date.now() + this.offsetMs);
  advanceDays(days: number): Date {
    this.offsetMs += days * 24 * 60 * 60 * 1000;
    return this.now();
  }
  reset(): void {
    this.offsetMs = 0;
  }
}

export interface E2eDeps {
  /** Checked again here, so these routes cannot be added to an app that fails the guard. */
  env: Pick<Env, 'NODE_ENV' | 'ALLOW_REAL_SEND' | 'API_PUBLIC_URL'>;
  source: Record<string, string | undefined>;
  /** The owner connection to the e2e database. */
  owner: Pick<pg.Pool, 'query'>;
  clock: E2eClock;
  google: FakeGoogle;
  gmail: FakeGmail;
  services: () => AppServices | undefined;
}

/** Every route the e2e stack adds. A test checks that a normal or production app answers none of them. */
export const E2E_ROUTES = [
  ['GET', '/e2e/google/authorize'],
  ['POST', '/e2e/reset'],
  ['POST', '/e2e/clock'],
  ['POST', '/e2e/google/identity'],
  ['GET', '/e2e/google/revoked'],
  ['POST', '/e2e/replies'],
  ['POST', '/e2e/jobs/:name'],
  ['GET', '/e2e/data'],
] as const;

const JOBS = {
  'poll-replies': (s: AppServices) => s.replies.runOnce(),
  'followup-sweep': (s: AppServices) => s.followups.sweep(),
  purge: (s: AppServices) => s.purge.runOnce(),
} as const;

/** What a person has in the database, as counts, and a fingerprint of the content so "untouched" can be checked. */
const OWNED: Record<string, string> = {
  inboxes: 'SELECT to_jsonb(x)::text AS r FROM inboxes x WHERE x.user_id = $1',
  companies: 'SELECT to_jsonb(x)::text AS r FROM user_companies x WHERE x.user_id = $1',
  requests: 'SELECT to_jsonb(x)::text AS r FROM requests x WHERE x.user_id = $1',
  drafts: 'SELECT to_jsonb(x)::text AS r FROM request_drafts x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
  events: 'SELECT to_jsonb(x)::text AS r FROM request_events x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
  followups: 'SELECT to_jsonb(x)::text AS r FROM request_followups x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
  replies: 'SELECT to_jsonb(x)::text AS r FROM request_replies x JOIN requests q ON q.id = x.request_id WHERE q.user_id = $1',
  sendClaims: 'SELECT to_jsonb(x)::text AS r FROM idempotency_keys x WHERE x.user_id = $1',
};

/** Test controls for the e2e stack only. They have no sign-in, which is why the guard comes first. */
export function registerE2eControls(app: FastifyInstance, deps: E2eDeps): void {
  assertE2eAllowed(deps.env, deps.source);
  const { owner, clock, google, gmail } = deps;

  // The fake Google consent page: it approves at once and returns to the real callback.
  app.get('/e2e/google/authorize', async (request, reply) => {
    const q = request.query as { state?: string; purpose?: string };
    const back = new URL('/v1/auth/google/callback', deps.env.API_PUBLIC_URL);
    back.searchParams.set('code', google.codeFor(q.purpose === 'connect' ? 'connect' : 'signin'));
    back.searchParams.set('state', q.state ?? '');
    return reply.redirect(back.toString());
  });

  // Between tests: forget every person, inbox, scan and request, and put the fakes and the clock back.
  app.post('/e2e/reset', async (_request, reply) => {
    await wipeE2eData(owner);
    clock.reset();
    google.reset();
    gmail.reset();
    return reply.code(204).send();
  });

  app.post('/e2e/clock', async (request, reply) => {
    const days = (request.body as { advanceDays?: unknown } | undefined)?.advanceDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 400) return reply.code(400).send({ error: 'advanceDays must be a whole number from 1 to 400' });
    return { now: clock.advanceDays(days).toISOString() };
  });

  /** Chooses who the fake Google signs in next. */
  app.post('/e2e/google/identity', async (request, reply) => {
    const who = (request.body as { who?: unknown } | undefined)?.who;
    if (who !== 'first' && who !== 'second') return reply.code(400).send({ error: 'who must be first or second' });
    google.use(who);
    return reply.code(204).send();
  });

  /** The tokens the fake Google was asked to revoke. They are fake tokens. */
  app.get('/e2e/google/revoked', () => Promise.resolve({ tokens: [...google.revoked] }));

  /** A reply "arrives" on a sent request's thread, from the company, answering our message. Headers only, like the real thing. */
  app.post('/e2e/replies', async (request, reply) => {
    const body = request.body as { requestId?: unknown; automatic?: unknown } | undefined;
    if (typeof body?.requestId !== 'string') return reply.code(400).send({ error: 'requestId is required' });
    const { rows } = await owner.query<{ thread_id: string | null; sent_rfc_message_id: string | null; domain: string }>(
      `SELECT r.thread_id, r.sent_rfc_message_id, c.domains[1] AS domain FROM requests r
         JOIN user_companies uc ON uc.id = r.user_company_id JOIN companies c ON c.id = uc.company_id WHERE r.id = $1`,
      [body.requestId],
    );
    const row = rows[0];
    if (!row?.thread_id || !row.sent_rfc_message_id) return reply.code(409).send({ error: 'this request has no sent thread' });
    gmail.addReply(row.thread_id, {
      from: `privacy@${row.domain}`,
      inReplyTo: row.sent_rfc_message_id.toLowerCase(),
      receivedAt: clock.now(),
      automatic: body.automatic === true,
    });
    return reply.code(204).send();
  });

  /** Runs one background task now, as the scheduler would. */
  app.post('/e2e/jobs/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const services = deps.services();
    if (!Object.hasOwn(JOBS, name) || !services) return reply.code(404).send({ error: 'no such job' });
    return { counts: await JOBS[name as keyof typeof JOBS](services) };
  });

  /** A person's row and what belongs to them, found by user id or by their fictional email. */
  app.get('/e2e/data', async (request, reply) => {
    const q = request.query as { email?: string; userId?: string };
    const found = await owner.query<{ id: string; email: string; name: string; google_sub: string; status: string; deleted_at: Date | null }>(
      'SELECT id, email, name, google_sub, status, deleted_at FROM users WHERE id = $1 OR email = $2',
      [q.userId ?? '', q.email ?? ''],
    );
    const user = found.rows[0];
    if (!user) return reply.code(404).send({ error: 'no such user' });
    const counts: Record<string, number> = {};
    const content: string[] = [];
    for (const [name, sql] of Object.entries(OWNED)) {
      const { rows } = await owner.query<{ r: string }>(sql, [user.id]);
      counts[name] = rows.length;
      content.push(`${name}:${rows.map((x) => x.r).sort().join('|')}`);
    }
    const sent = await owner.query<{ type: string }>(
      `SELECT e.type FROM request_events e JOIN requests q ON q.id = e.request_id WHERE q.user_id = $1 AND e.type IN ('sent', 'followup_sent', 'submitted') ORDER BY e.created_at`,
      [user.id],
    );
    return {
      user: { id: user.id, email: user.email, name: user.name, googleSub: user.google_sub, status: user.status, purged: user.deleted_at !== null },
      counts,
      /** Which sending or submitting events exist, in order. */
      deliveries: sent.rows.map((r) => r.type),
      content: content.join('\n'),
    };
  });
}
