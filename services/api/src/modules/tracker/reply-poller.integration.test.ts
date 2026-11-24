import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../common/ids.js';
import { createDb, type DbHandle } from '../../db/client.js';
import { addEvent, createTestDb, draftRequest, markSent, seedUser, type Seed, type TestDb } from '../../../test/db-helper.js';
import { FakeGmail } from '../../../test/harness.js';
import { GmailApiError, type GmailThreadMessage } from '../gmail/gmail.client.js';
import { ReplyPoller, type PollCounts } from './reply-poller.js';
import { createTrackerRepository } from './tracker.repository.js';

let t: TestDb;
let handle: DbHandle;
beforeAll(async () => {
  t = await createTestDb();
  // The poller runs as the app role, like the API: this also checks that role has every privilege it needs.
  handle = createDb(t.appUrl, () => undefined);
});
afterAll(async () => {
  await handle.close();
  await t.drop();
});

const NOW = new Date('2026-11-24T12:00:00Z');
const OUR_RFC = 'sent-1@erase.example';

interface Made {
  seed: Seed;
  requestId: string;
  threadId: string;
  userEmail: string;
}

/** A sent email request, made the way the service makes one: approved by the user, then sent. */
async function sentRequest(
  label: string,
  over: {
    status?: string;
    channel?: 'email' | 'web_form';
    sentDaysAgo?: number;
    rfc?: string | null;
    companyDomains?: string[];
    inboxStatus?: 'connected' | 'disconnected' | 'error';
    userStatus?: 'active' | 'deleting';
    checkedAt?: Date | null;
    thread?: string;
  } = {},
): Promise<Made> {
  const seed = await seedUser(t.owner, label);
  const { requestId, hash } = await draftRequest(t.owner, seed);
  const threadId = over.thread ?? `thread-${requestId.slice(-8)}`;
  if ((over.channel ?? 'email') === 'email') {
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    await markSent(t.app, requestId);
    await t.owner.query(
      `UPDATE requests SET thread_id = $2, sent_at = $3, sent_message_id = $4, sent_rfc_message_id = $5, status = $6, reply_checked_at = $7 WHERE id = $1`,
      [requestId, threadId, new Date(NOW.getTime() - (over.sentDaysAgo ?? 3) * 86_400_000), `ours-${requestId.slice(-6)}`, over.rfc === undefined ? OUR_RFC : over.rfc, over.status ?? 'sent', over.checkedAt ?? null],
    );
  } else {
    await t.owner.query(`UPDATE requests SET channel = 'web_form' WHERE id = $1`, [requestId]);
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    await t.owner.query(`UPDATE requests SET status = 'sent', sent_at = $2, due_at = $2 WHERE id = $1`, [requestId, NOW]);
  }
  if (over.companyDomains) await t.owner.query('UPDATE companies SET domains = $2 WHERE id = $1', [seed.companyId, over.companyDomains]);
  if (over.inboxStatus && over.inboxStatus !== 'connected') {
    await t.owner.query(
      over.inboxStatus === 'disconnected'
        ? `UPDATE inboxes SET status = 'disconnected', token_ciphertext = NULL, token_key_id = NULL, disconnected_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`
        : `UPDATE inboxes SET status = 'error' WHERE id = $1`,
      [seed.inboxId],
    );
  }
  if (over.userStatus === 'deleting') await t.owner.query(`UPDATE users SET status = 'deleting', deleted_at = now() WHERE id = $1`, [seed.userId]);
  const { rows } = await t.owner.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [seed.userId]);
  return { seed, requestId, threadId, userEmail: rows[0]?.email ?? '' };
}

const msg = (id: string, from: string | undefined, over: Partial<GmailThreadMessage> = {}): GmailThreadMessage => ({
  id,
  receivedAt: new Date('2026-11-23T09:00:00Z'),
  fromAddress: from,
  messageId: `${id}@mail.example`,
  inReplyTo: OUR_RFC,
  references: [OUR_RFC],
  automatic: false,
  ...over,
});

let gmail: FakeGmail;
let logs: Array<{ level: string; o: Record<string, unknown>; msg: string }>;
let tokenFor: (inboxId: string) => Promise<string>;
let now: Date;

function poller(options = { maxAgeDays: 120, batchSize: 100 }): ReplyPoller {
  const repo = createTrackerRepository(handle.db);
  return new ReplyPoller({
    repo,
    gmail,
    accessToken: (inboxId) => tokenFor(inboxId),
    ownAddresses: async (userId) => {
      const { rows } = await t.owner.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1 UNION SELECT email FROM inboxes WHERE user_id = $1',
        [userId],
      );
      return rows.map((r) => r.email.toLowerCase());
    },
    now: () => now,
    options,
    log: { info: (o, m) => logs.push({ level: 'info', o, msg: m }), warn: (o, m) => logs.push({ level: 'warn', o, msg: m }) },
  });
}

const row = async (id: string) =>
  (
    await t.owner.query<{ status: string; first_reply_at: Date | null; reply_checked_at: Date | null; reply_check_failures: number; day30_followup_at: Date | null; due_at: Date | null }>(
      'SELECT status, first_reply_at, reply_checked_at, reply_check_failures, day30_followup_at, due_at FROM requests WHERE id = $1',
      [id],
    )
  ).rows[0];
const replies = async (id: string) =>
  (await t.owner.query<{ gmail_message_id: string; sender_domain: string | null; sender_match: string; automatic: boolean }>(
    'SELECT gmail_message_id, sender_domain, sender_match, automatic FROM request_replies WHERE request_id = $1 ORDER BY gmail_message_id',
    [id],
  )).rows;
const eventTypes = async (id: string) => (await t.owner.query<{ type: string; actor_type: string; payload: Record<string, unknown> }>('SELECT type, actor_type, payload FROM request_events WHERE request_id = $1 AND type = $2', [id, 'reply_received'])).rows;

beforeEach(async () => {
  // Every test shares one database, so earlier tests' requests are put out of the way (a closed request is never checked).
  await t.owner.query(`UPDATE requests SET status = 'closed'`);
  gmail = new FakeGmail();
  logs = [];
  now = new Date(NOW);
  tokenFor = () => Promise.resolve('access-token');
});

describe('finding a reply', () => {
  it('moves a sent request to reply_received when someone at the company answers our message', async () => {
    const r = await sentRequest('p1', { companyDomains: ['company.example'] });
    gmail.threads.set(r.threadId, [msg('ours', r.userEmail, { messageId: OUR_RFC, inReplyTo: undefined, references: [] }), msg('reply-1', 'Privacy@Mail.Company.Example')]);
    const counts = await poller().runOnce();
    expect(counts).toMatchObject({ checked: 1, replied: 1, newReplies: 1, automatic: 0, failed: 0 });
    const request = await row(r.requestId);
    expect(request?.status).toBe('reply_received');
    expect(request?.first_reply_at?.toISOString()).toBe('2026-11-23T09:00:00.000Z');
    expect(request?.reply_checked_at?.toISOString()).toBe(NOW.toISOString());
    expect(await replies(r.requestId)).toEqual([{ gmail_message_id: 'reply-1', sender_domain: 'company.example', sender_match: 'company', automatic: false }]);
    expect(await eventTypes(r.requestId)).toEqual([{ type: 'reply_received', actor_type: 'system', payload: { replies: 1, automatic: 0, from: 'sent' } }]);
  });

  it('keeps the follow-up clock and the due date as they were', async () => {
    const r = await sentRequest('p2');
    const before = await row(r.requestId);
    gmail.threads.set(r.threadId, [msg('reply-1', 'someone@other.example')]);
    await poller().runOnce();
    const after = await row(r.requestId);
    expect(after?.day30_followup_at).toEqual(before?.day30_followup_at);
    expect(after?.due_at).toEqual(before?.due_at);
  });

  it('is idempotent: a second run records nothing new and adds no second event', async () => {
    const r = await sentRequest('p3');
    gmail.threads.set(r.threadId, [msg('reply-1', 'a@company.example')]);
    await poller().runOnce();
    // The person takes the request back to "no answer yet": it must not flip to reply_received again by itself.
    await t.owner.query(`UPDATE requests SET status = 'sent' WHERE id = $1`, [r.requestId]);
    const counts = await poller().runOnce();
    expect(counts).toMatchObject({ newReplies: 0, replied: 0 });
    expect((await row(r.requestId))?.status).toBe('sent');
    expect(await replies(r.requestId)).toHaveLength(1);
    expect(await eventTypes(r.requestId)).toHaveLength(1);
  });

  it('also finds a reply on a request that was marked no_reply', async () => {
    const r = await sentRequest('p4', { status: 'no_reply' });
    gmail.threads.set(r.threadId, [msg('late-reply', 'a@company.example')]);
    await poller().runOnce();
    expect((await row(r.requestId))?.status).toBe('reply_received');
    expect((await eventTypes(r.requestId))[0]?.payload).toMatchObject({ from: 'no_reply' });
  });

  it('records an automatic reply with its own flag, leaves the status, and still finds a later person', async () => {
    const r = await sentRequest('p5');
    gmail.threads.set(r.threadId, [msg('auto-1', 'noreply@company.example', { automatic: true })]);
    expect(await poller().runOnce()).toMatchObject({ newReplies: 1, automatic: 1, replied: 0 });
    expect((await row(r.requestId))?.status).toBe('sent');
    expect(await eventTypes(r.requestId)).toHaveLength(0);
    expect((await replies(r.requestId))[0]).toMatchObject({ gmail_message_id: 'auto-1', automatic: true });

    gmail.threads.set(r.threadId, [msg('auto-1', 'noreply@company.example', { automatic: true }), msg('human-1', 'dpo@company.example')]);
    expect(await poller().runOnce()).toMatchObject({ newReplies: 1, replied: 1 });
    expect((await row(r.requestId))?.status).toBe('reply_received');
    expect((await eventTypes(r.requestId))[0]?.payload).toEqual({ replies: 1, automatic: 0, from: 'sent' });
  });
});

describe('what is not a reply', () => {
  it('ignores our own sent message, the person\'s own addresses, and messages that do not answer ours', async () => {
    const r = await sentRequest('n1');
    const ours = `ours-${r.requestId.slice(-6)}`;
    gmail.threads.set(r.threadId, [
      msg(ours, 'company-contact@example.test', { messageId: OUR_RFC, inReplyTo: undefined, references: [] }), // the message we sent (by id)
      msg('self-note', r.userEmail.toUpperCase().toLowerCase()), // the person writing to themselves on the thread
      msg('unrelated', 'x@company.example', { inReplyTo: 'something-else@x.example', references: ['something-else@x.example'] }),
    ]);
    expect(await poller().runOnce()).toMatchObject({ checked: 1, newReplies: 0, replied: 0 });
    expect((await row(r.requestId))?.status).toBe('sent');
    expect(await replies(r.requestId)).toEqual([]);
  });

  it('counts any message from someone else when the Message-ID of the sent message was never learned', async () => {
    const r = await sentRequest('n2', { rfc: null });
    gmail.threads.set(r.threadId, [msg('r1', 'a@company.example', { inReplyTo: undefined, references: [] })]);
    expect(await poller().runOnce()).toMatchObject({ replied: 1 });
  });

  it('recognises a reply by References when In-Reply-To is missing', async () => {
    const r = await sentRequest('n3');
    gmail.threads.set(r.threadId, [msg('r1', 'a@company.example', { inReplyTo: undefined, references: ['other@x.example', OUR_RFC] })]);
    expect(await poller().runOnce()).toMatchObject({ replied: 1 });
  });
});

describe('who the reply came from', () => {
  it.each([
    ['the company domain', 'a@company.example', ['company.example'], 'company', 'company.example'],
    ['a subdomain of it', 'a@mail.company.co.in', ['company.co.in'], 'company', 'company.co.in'],
    ['the domain the request was sent to', 'a@example.com', [], 'company', 'example.com'], // the seeded contact is privacy@example.com
    ['another domain (a support platform)', 'help@support-desk.example', ['company.example'], 'other', 'support-desk.example'],
    ['a message with no usable From', undefined, ['company.example'], 'unknown', null],
  ])('%s', async (_name, from, domains, match, domain) => {
    const r = await sentRequest('w', { companyDomains: domains });
    gmail.threads.set(r.threadId, [msg('r1', from)]);
    await poller().runOnce();
    expect(await replies(r.requestId)).toEqual([{ gmail_message_id: 'r1', sender_domain: domain, sender_match: match, automatic: false }]);
  });
});

describe('what it stores', () => {
  it('keeps no address, subject, snippet or text anywhere: only ids, times, a domain and flags', async () => {
    const r = await sentRequest('s1', { companyDomains: ['company.example'] });
    gmail.threads.set(r.threadId, [msg('reply-1', 'jane.person@company.example')]);
    await poller().runOnce();
    const everything = JSON.stringify([
      (await t.owner.query('SELECT * FROM request_replies WHERE request_id = $1', [r.requestId])).rows,
      (await t.owner.query('SELECT * FROM request_events WHERE request_id = $1', [r.requestId])).rows,
      (await t.owner.query('SELECT * FROM requests WHERE id = $1', [r.requestId])).rows,
      logs,
    ]);
    expect(everything).not.toMatch(/jane|person@|Jane Q/i);
    expect(everything).toContain('company.example'); // only as the domain column
    for (const rowOfReplies of await replies(r.requestId)) expect(JSON.stringify(rowOfReplies)).not.toContain('@');
  });

  it('logs counts only', async () => {
    const r = await sentRequest('s2');
    gmail.threads.set(r.threadId, [msg('r1', 'a@company.example')]);
    await poller().runOnce();
    for (const l of logs) for (const v of Object.values(l.o)) expect(typeof v, JSON.stringify(l)).toBe('number');
  });
});

describe('which requests are checked', () => {
  it('checks only sent or no_reply email requests that have a thread, are recent, and whose inbox is connected', async () => {
    const wanted = await sentRequest('q1');
    const others = [
      await sentRequest('q2', { status: 'reply_received' }),
      await sentRequest('q3', { status: 'replied_deleted' }),
      await sentRequest('q4', { status: 'replied_refused' }),
      await sentRequest('q5', { status: 'bounced' }),
      await sentRequest('q6', { channel: 'web_form' }),
      await sentRequest('q7', { sentDaysAgo: 200 }),
      await sentRequest('q8', { inboxStatus: 'disconnected' }),
      await sentRequest('q9', { inboxStatus: 'error' }),
    ];
    const { requestId: drafted } = await draftRequest(t.owner, await seedUser(t.owner, 'q10'));
    for (const o of [wanted, ...others]) gmail.threads.set(o.threadId, [msg('r', 'a@company.example')]);
    await poller().runOnce();
    expect(gmail.threadCalls.map((c) => c.threadId)).toContain(wanted.threadId);
    for (const o of others) expect(gmail.threadCalls.map((c) => c.threadId), o.requestId).not.toContain(o.threadId);
    expect((await row(drafted))?.status).toBe('drafted');
  });

  it('checks the longest-unchecked first, and no more than the batch size', async () => {
    const old = await sentRequest('o1', { checkedAt: new Date('2026-11-20T00:00:00Z') });
    const never = await sentRequest('o2', { checkedAt: null });
    const recent = await sentRequest('o3', { checkedAt: new Date('2026-11-24T11:00:00Z') });
    await poller({ maxAgeDays: 120, batchSize: 2 }).runOnce();
    // Never-checked first, then the oldest check; the most recently checked one waits for the next run.
    expect(gmail.threadCalls.map((c) => c.threadId)).toEqual([never.threadId, old.threadId]);
    expect(gmail.threadCalls.map((c) => c.threadId)).not.toContain(recent.threadId);
  });
});

describe('pausing for a person who asked to delete their data', () => {
  it('does not check their requests at all while the 7-day window runs', async () => {
    const paused = await sentRequest('d1', { userStatus: 'deleting' });
    const active = await sentRequest('d2');
    gmail.threads.set(paused.threadId, [msg('r1', 'a@company.example')]);
    gmail.threads.set(active.threadId, [msg('r1', 'a@company.example')]);
    await poller().runOnce();
    expect(gmail.threadCalls.map((c) => c.threadId)).toEqual([active.threadId]);
    expect((await row(paused.requestId))?.status).toBe('sent');
    expect(await replies(paused.requestId)).toEqual([]);
    expect((await row(paused.requestId))?.reply_checked_at).toBeNull();
  });

  it('records nothing for a person who went into deletion after the check began', async () => {
    const r = await sentRequest('d3');
    const repo = createTrackerRepository(handle.db);
    // The list was read while the person was active; they then asked to delete their data; the answer arrives.
    const [listed] = await repo.listPollable(NOW, 120, 10);
    expect(listed?.requestId).toBe(r.requestId);
    await t.owner.query(`UPDATE users SET status = 'deleting', deleted_at = now() WHERE id = $1`, [r.seed.userId]);
    const result = await repo.applyCheck(r.requestId, NOW, [{ gmailMessageId: 'late', receivedAt: NOW, senderDomain: 'company.example', senderMatch: 'company', automatic: false }]);
    expect(result).toEqual({ added: 0, addedAutomatic: 0, moved: false });
    expect(await replies(r.requestId)).toEqual([]);
    expect((await row(r.requestId))?.status).toBe('sent');
  });

  it('resumes when the person is active again', async () => {
    const r = await sentRequest('d4', { userStatus: 'deleting' });
    gmail.threads.set(r.threadId, [msg('r1', 'a@company.example')]);
    await poller().runOnce();
    expect(gmail.threadCalls).toHaveLength(0);
    await t.owner.query(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = $1`, [r.seed.userId]);
    await poller().runOnce();
    expect((await row(r.requestId))?.status).toBe('reply_received');
  });
});

describe('races with the person', () => {
  it('does not overwrite an outcome the person set while the check was running', async () => {
    const r = await sentRequest('c1');
    const repo = createTrackerRepository(handle.db);
    await t.owner.query(`UPDATE requests SET status = 'replied_refused' WHERE id = $1`, [r.requestId]);
    const result = await repo.applyCheck(r.requestId, NOW, [{ gmailMessageId: 'r1', receivedAt: NOW, senderDomain: 'company.example', senderMatch: 'company', automatic: false }]);
    expect(result).toMatchObject({ added: 1, moved: false });
    expect((await row(r.requestId))?.status).toBe('replied_refused');
    expect(await eventTypes(r.requestId)).toHaveLength(0);
  });

  it('records one reply once when two checks run at the same time', async () => {
    const r = await sentRequest('c2');
    const repo = createTrackerRepository(handle.db);
    const reply = { gmailMessageId: 'same', receivedAt: NOW, senderDomain: 'company.example', senderMatch: 'company' as const, automatic: false };
    const results = await Promise.all([repo.applyCheck(r.requestId, NOW, [reply]), repo.applyCheck(r.requestId, NOW, [reply])]);
    expect(results.map((x) => x.moved).sort()).toEqual([false, true]);
    expect(await replies(r.requestId)).toHaveLength(1);
    expect(await eventTypes(r.requestId)).toHaveLength(1);
  });
});

describe('when Gmail cannot be reached', () => {
  const countsOf = (c: PollCounts) => c;

  /** A second sent request for the same person and inbox, so one refused grant covers both. */
  async function secondRequestOnSameInbox(first: Made): Promise<{ requestId: string; threadId: string }> {
    const companyId = newId('company');
    const userCompanyId = newId('userCompany');
    await t.owner.query(
      `INSERT INTO companies (id, slug, name, category, grievance_email, grievance_source, grievance_verified_on, grievance_status, is_fictional)
       VALUES ($1, $2, 'Second Co', 'saas', 'privacy@example.com', 'https://example.com/privacy', '2026-01-01', 'verified', true)`,
      [companyId, `second-${companyId.slice(-8).toLowerCase()}`],
    );
    await t.owner.query(
      `INSERT INTO user_companies (id, user_id, company_id, inbox_id, first_seen, last_seen, signal_types)
       VALUES ($1, $2, $3, $4, now(), now(), ARRAY['welcome'])`,
      [userCompanyId, first.seed.userId, companyId, first.seed.inboxId],
    );
    const requestId = newId('request');
    await t.owner.query('INSERT INTO requests (id, user_id, user_company_id) VALUES ($1, $2, $3)', [requestId, first.seed.userId, userCompanyId]);
    const { addDraft } = await import('../../../test/db-helper.js');
    const hash = await addDraft(t.owner, requestId, 1, 'second draft');
    await addEvent(t.app, requestId, 'approved', 'user', hash);
    await markSent(t.app, requestId);
    const threadId = `thread-second-${requestId.slice(-6)}`;
    await t.owner.query('UPDATE requests SET thread_id = $2, sent_at = $3, sent_rfc_message_id = $4 WHERE id = $1', [requestId, threadId, new Date(NOW.getTime() - 86_400_000), OUR_RFC]);
    return { requestId, threadId };
  }

  it('stops checking an inbox whose grant is gone (its other requests wait), notes the failure, and carries on with other inboxes', async () => {
    const bad = await sentRequest('f1');
    const badToo = await secondRequestOnSameInbox(bad);
    const good = await sentRequest('f3');
    tokenFor = (inboxId) => (inboxId === bad.seed.inboxId ? Promise.reject(new GmailApiError('auth', { call: 'token.refresh' })) : Promise.resolve('ok'));
    gmail.threads.set(good.threadId, [msg('r1', 'a@company.example')]);
    const counts = countsOf(await poller().runOnce());
    expect(counts).toMatchObject({ inboxesStopped: 1, failed: 1, replied: 1 });
    expect((await row(bad.requestId))?.reply_check_failures).toBe(1);
    expect((await row(badToo.requestId))?.reply_check_failures).toBe(0); // left alone, not counted as failed
    expect((await row(badToo.requestId))?.reply_checked_at).toBeNull();
    expect((await row(bad.requestId))?.status).toBe('sent');
    expect((await row(good.requestId))?.status).toBe('reply_received');
    expect(gmail.threadCalls.map((c) => c.threadId)).toEqual([good.threadId]); // no Gmail call at all for the stopped inbox
  });

  it('counts a failed check, moves that request to the back of the queue, and clears the count on the next good check', async () => {
    const r = await sentRequest('f4');
    gmail.failThread.set(r.threadId, new GmailApiError('quota', { call: 'threads.get', httpStatus: 429 }));
    expect(await poller().runOnce()).toMatchObject({ failed: 1, checked: 0 });
    const failed = await row(r.requestId);
    expect(failed?.reply_check_failures).toBe(1);
    expect(failed?.reply_checked_at?.toISOString()).toBe(NOW.toISOString());
    gmail.threads.set(r.threadId, []);
    await poller().runOnce();
    expect((await row(r.requestId))?.reply_check_failures).toBe(0);
  });

  it('notes a thread that no longer exists without calling it a failure, and checks it again later', async () => {
    const r = await sentRequest('f5');
    expect(await poller().runOnce()).toMatchObject({ checked: 1, threadMissing: 1, failed: 0 });
    const after = await row(r.requestId);
    expect(after?.reply_check_failures).toBe(0);
    expect(after?.reply_checked_at?.toISOString()).toBe(NOW.toISOString());
    expect(after?.status).toBe('sent');
  });
});

describe('the app role', () => {
  it('can do exactly what polling needs and no more: add replies and events, update the request, never delete', async () => {
    const r = await sentRequest('g1');
    expect((await t.app.query('SELECT 1 FROM request_replies LIMIT 1')).rowCount).toBeGreaterThanOrEqual(0);
    await t.app.query(
      `INSERT INTO request_replies (id, request_id, gmail_message_id, received_at, sender_match) VALUES ($1, $2, 'g', now(), 'unknown')`,
      [newId('reply'), r.requestId],
    );
    await expect(t.app.query('DELETE FROM request_replies')).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query(`UPDATE request_replies SET automatic = true`)).rejects.toMatchObject({ code: '42501' });
  });
});
