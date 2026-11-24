import { describe, expect, it } from 'vitest';
import { addressOf, GmailApiError, HttpGmailClient, isAutomatic, messageIdsIn, readGoogleError, resolveReceivedAt } from './gmail.client.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function client(responses: Array<Response | Error>) {
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const sleeps: number[] = [];
  const c = new HttpGmailClient({
    fetch: (url, init) => {
      requests.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      const next = responses.shift();
      if (!next) throw new Error('unexpected extra request');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  return { c, requests, sleeps };
}

describe('HttpGmailClient', () => {
  it('lists message ids with the query and page token', async () => {
    const { c, requests } = client([json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2', resultSizeEstimate: 250 })]);
    const page = await c.listMessageIds('tok', { query: 'category:updates', pageToken: 'p1', maxResults: 100 });
    expect(page).toEqual({ ids: ['a', 'b'], nextPageToken: 'p2', estimatedTotal: 250 });
    const url = new URL(requests[0]?.url ?? '');
    expect(url.pathname).toBe('/gmail/v1/users/me/messages');
    expect(url.searchParams.get('q')).toBe('category:updates');
    expect(url.searchParams.get('pageToken')).toBe('p1');
    expect(url.searchParams.get('includeSpamTrash')).toBe('false');
    expect(requests[0]?.auth).toBe('Bearer tok');
  });

  it('handles an empty page', async () => {
    const { c } = client([json({ resultSizeEstimate: 0 })]);
    expect(await c.listMessageIds('t', { query: 'q', maxResults: 10 })).toEqual({ ids: [], estimatedTotal: 0 });
  });

  it('fetches metadata only: format=metadata with an explicit header list, never format=full or raw', async () => {
    const { c, requests } = client([
      json({
        id: 'a',
        internalDate: '1714521600000',
        payload: {
          headers: [
            { name: 'From', value: 'Shop <hi@shop.example>' },
            { name: 'subject', value: 'Welcome' },
            { name: 'List-Unsubscribe', value: '<mailto:u@shop.example>' },
          ],
        },
        snippet: 'must be ignored',
      }),
    ]);
    const m = await c.getMessageMetadata('t', 'a');
    expect(m).toEqual({
      id: 'a',
      receivedAt: new Date(1714521600000),
      from: 'Shop <hi@shop.example>',
      subject: 'Welcome',
      hasListUnsubscribe: true,
      hasListId: false,
      replyTo: undefined,
      listUnsubscribeHosts: ['shop.example'],
    });
    expect(JSON.stringify(m)).not.toContain('must be ignored');
    const url = new URL(requests[0]?.url ?? '');
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.getAll('metadataHeaders').sort()).toEqual(['Date', 'From', 'List-Id', 'List-Unsubscribe', 'Reply-To', 'Subject']);
  });

  it('returns null for a message deleted since listing', async () => {
    const { c } = client([json({ error: {} }, 404)]);
    expect(await c.getMessageMetadata('t', 'gone')).toBeNull();
  });

  it('backs off exponentially on 429 and 5xx, honours Retry-After, then succeeds', async () => {
    const { c, sleeps } = client([
      json({}, 429),
      json({}, 503),
      json({}, 429, { 'retry-after': '3' }),
      json({ messages: [{ id: 'a' }] }),
    ]);
    expect((await c.listMessageIds('t', { query: 'q', maxResults: 1 })).ids).toEqual(['a']);
    expect(sleeps).toEqual([500, 1000, 3000]);
  });

  it('retries a network error and a 403 rate limit', async () => {
    const { c, sleeps } = client([new Error('socket hang up'), json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403), json({ messages: [] })]);
    await expect(c.listMessageIds('t', { query: 'q', maxResults: 1 })).resolves.toMatchObject({ ids: [] });
    expect(sleeps).toHaveLength(2);
  });

  it('gives up with a quota code after repeated 429s', async () => {
    const { c } = client(Array.from({ length: 6 }, () => json({}, 429)));
    await expect(c.listMessageIds('t', { query: 'q', maxResults: 1 })).rejects.toMatchObject({ code: 'quota' });
  });

  it('maps 401 and a non-rate-limit 403 to auth without retrying', async () => {
    const a = client([json({}, 401)]);
    await expect(a.c.listMessageIds('t', { query: 'q', maxResults: 1 })).rejects.toMatchObject({ code: 'auth' });
    expect(a.sleeps).toEqual([]);
    const b = client([json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, 403)]);
    await expect(b.c.listMessageIds('t', { query: 'q', maxResults: 1 })).rejects.toBeInstanceOf(GmailApiError);
  });

  it('does not put response content in errors', async () => {
    const { c } = client([json({ error: 'person@example.test secret subject' }, 400)]);
    const err = await c.listMessageIds('t', { query: 'q', maxResults: 1 }).then(
      () => new Error('expected a failure'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toBe('gmail api: unavailable');
  });
});

const msgBody = (internalDate: unknown, date?: string) => ({
  id: 'a',
  internalDate,
  snippet: 'ignored',
  payload: {
    headers: [
      { name: 'From', value: 'Shop <hi@shop.example>' },
      { name: 'Subject', value: 'Welcome' },
      ...(date ? [{ name: 'Date', value: date }] : []),
    ],
  },
});

describe('messages with an unusable internalDate (regression: one such message failed a whole scan)', () => {
  it.each([['-3600'], ['0'], ['abc'], ['']])('falls back to the Date header for internalDate %j', async (bad) => {
    const { c } = client([json(msgBody(bad, 'Tue, 05 Mar 2019 10:00:00 +0000'))]);
    const m = await c.getMessageMetadata('t', 'a');
    expect(m?.receivedAt).toEqual(new Date('2019-03-05T10:00:00Z'));
  });

  it('accepts a response with no internalDate at all', async () => {
    const { c } = client([json(msgBody(undefined, 'Tue, 05 Mar 2019 10:00:00 +0000'))]);
    expect((await c.getMessageMetadata('t', 'a'))?.receivedAt).toEqual(new Date('2019-03-05T10:00:00Z'));
  });

  it('skips (null) a message that cannot be placed in time, instead of failing', async () => {
    const { c } = client([json(msgBody('-3600')), json(msgBody('abc', 'not a date'))]);
    expect(await c.getMessageMetadata('t', 'a')).toBeNull();
    expect(await c.getMessageMetadata('t', 'a')).toBeNull();
  });

  it('still rejects a response that is not a message at all', async () => {
    const { c } = client([json({ unexpected: true })]);
    await expect(c.getMessageMetadata('t', 'a')).rejects.toMatchObject({ failure: { call: 'messages.get', cause: 'bad_response' } });
  });
});

describe('resolveReceivedAt', () => {
  const now = Date.UTC(2026, 10, 22);
  it('prefers a plausible internalDate, rejects the future and pre-1995', () => {
    expect(resolveReceivedAt('1714521600000', 'Thu, 01 Jan 2015 00:00:00 +0000', now)).toEqual(new Date(1714521600000));
    expect(resolveReceivedAt(String(now + 30 * 86_400_000), undefined, now)).toBeUndefined();
    expect(resolveReceivedAt('1000', undefined, now)).toBeUndefined();
  });
});

describe('failure detail for logs (which call, HTTP status, Google reason and status; never content)', () => {
  const googleError = (status: number, reason: string, googleStatus: string) =>
    json(
      {
        error: {
          code: status,
          message: 'Gmail API has not been used in project 123 person@example.test',
          status: googleStatus,
          errors: [{ message: 'secret subject text', reason }],
        },
      },
      status,
    );

  it('reports a disabled API as auth with reason and status, without the message text', async () => {
    const { c } = client([googleError(403, 'accessNotConfigured', 'PERMISSION_DENIED')]);
    const err = await c.listMessageIds('t', { query: 'q', maxResults: 1 }).then(
      () => new GmailApiError('unavailable'),
      (e: unknown) => e as GmailApiError,
    );
    expect(err.code).toBe('auth');
    expect(err.failure).toEqual({ call: 'messages.list', httpStatus: 403, reason: 'accessNotConfigured', googleStatus: 'PERMISSION_DENIED' });
    expect(JSON.stringify(err.failure)).not.toMatch(/person@|secret|project 123/);
  });

  it('reads reason from error.details (ErrorInfo) when errors[] is absent', () => {
    expect(
      readGoogleError(JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ '@type': 'x', reason: 'SERVICE_DISABLED' }] } })),
    ).toEqual({ reason: 'SERVICE_DISABLED', googleStatus: 'PERMISSION_DENIED' });
  });

  it('drops anything that is not an identifier, and bodies that are not JSON', () => {
    expect(
      readGoogleError(JSON.stringify({ error: { status: 'has spaces and an@address.test', errors: [{ reason: 'a long sentence with spaces' }] } })),
    ).toEqual({});
    expect(readGoogleError('<html>nope</html>')).toEqual({});
  });

  it('reports the call and status after retries are exhausted, and 4xx answers without retrying', async () => {
    const a = client(Array.from({ length: 6 }, () => json({ error: { status: "UNAVAILABLE" } }, 503)));
    await expect(a.c.getMessageMetadata('t', 'a')).rejects.toMatchObject({
      code: 'unavailable',
      failure: { call: 'messages.get', httpStatus: 503, googleStatus: 'UNAVAILABLE' },
    });
    const b = client([googleError(400, 'invalidArgument', 'INVALID_ARGUMENT')]);
    await expect(b.c.listMessageIds('t', { query: 'q', maxResults: 1 })).rejects.toMatchObject({
      code: 'unavailable',
      failure: { call: 'messages.list', httpStatus: 400, reason: 'invalidArgument', googleStatus: 'INVALID_ARGUMENT' },
    });
    expect(b.sleeps).toEqual([]);
  });

  it('reports a network failure as a cause, not a status', async () => {
    const { c } = client(Array.from({ length: 6 }, () => new Error("socket hang up")));
    await expect(c.listMessageIds('t', { query: 'q', maxResults: 1 })).rejects.toMatchObject({
      failure: { call: 'messages.list', cause: 'network' },
    });
  });
});

describe('HttpGmailClient.getThreadMetadata (reply checks)', () => {
  const NOW = 1_714_521_600_000;
  const h = (name: string, value: string) => ({ name, value });
  const thread = (messages: unknown[]) => json({ id: 'thr1', messages });

  it('asks for headers only: format=metadata, a fixed header list without Subject, and a partial response', async () => {
    const { c, requests } = client([thread([])]);
    await c.getThreadMetadata('tok', 'thr1');
    const url = new URL(requests[0]?.url ?? '');
    expect(url.pathname).toBe('/gmail/v1/users/me/threads/thr1');
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.get('fields')).toBe('id,messages(id,internalDate,payload/headers)');
    expect(url.searchParams.getAll('metadataHeaders')).toEqual([
      'From', 'Message-ID', 'In-Reply-To', 'References', 'Date', 'Auto-Submitted', 'Precedence', 'X-Autoreply', 'X-Autorespond',
    ]);
    expect(url.searchParams.getAll('metadataHeaders').map((x) => x.toLowerCase())).not.toContain('subject');
    expect(url.searchParams.get('format')).not.toMatch(/full|raw/);
    expect(requests[0]?.auth).toBe('Bearer tok');
  });

  it('reads the sender, the ids and the date from headers', async () => {
    const { c } = client([
      thread([
        {
          id: 'm1',
          internalDate: String(NOW),
          payload: {
            headers: [
              h('From', 'Privacy Team <Privacy@Company.Example>'),
              h('Message-ID', '<Reply-1@Company.Example>'),
              h('In-Reply-To', '<our-message@erase.example>'),
              h('References', '<our-message@erase.example> <other@x.example>'),
            ],
          },
        },
      ]),
    ]);
    const t = await c.getThreadMetadata('t', 'thr1');
    expect(t).toEqual({
      id: 'thr1',
      messages: [
        {
          id: 'm1',
          receivedAt: new Date(NOW),
          fromAddress: 'privacy@company.example',
          messageId: 'reply-1@company.example',
          inReplyTo: 'our-message@erase.example',
          references: ['our-message@erase.example', 'other@x.example'],
          automatic: false,
        },
      ],
    });
  });

  it('drops a snippet, a body or a subject if Gmail ever sends one: none of it reaches the result', async () => {
    const { c } = client([
      thread([
        {
          id: 'm1',
          internalDate: String(NOW),
          snippet: 'SNIPPET-TEXT-must-not-survive',
          payload: {
            headers: [h('From', 'a@b.example'), h('Subject', 'SUBJECT-TEXT-must-not-survive')],
            body: { data: 'BODY-TEXT-must-not-survive' },
            parts: [{ body: { data: 'PART-TEXT-must-not-survive' } }],
          },
        },
      ]),
    ]);
    const text = JSON.stringify(await c.getThreadMetadata('t', 'thr1'));
    for (const secret of ['SNIPPET-TEXT', 'SUBJECT-TEXT', 'BODY-TEXT', 'PART-TEXT']) expect(text).not.toContain(secret);
  });

  it('marks automatic replies from headers, and a person as not automatic', async () => {
    const msg = (id: string, headers: Array<{ name: string; value: string }>) => ({ id, internalDate: String(NOW), payload: { headers } });
    const { c } = client([
      thread([
        msg('a', [h('From', 'x@y.example'), h('Auto-Submitted', 'auto-replied')]),
        msg('b', [h('From', 'x@y.example'), h('Auto-Submitted', 'no')]),
        msg('c', [h('From', 'x@y.example'), h('X-Autoreply', 'yes')]),
        msg('d', [h('From', 'x@y.example'), h('Precedence', 'bulk')]),
        msg('e', [h('From', 'x@y.example')]),
      ]),
    ]);
    const t = await c.getThreadMetadata('t', 'thr1');
    expect(t?.messages.map((m) => [m.id, m.automatic])).toEqual([['a', true], ['b', false], ['c', true], ['d', true], ['e', false]]);
  });

  it('skips a message that cannot be placed in time, and returns null for a thread that is gone', async () => {
    const { c } = client([thread([{ id: 'undated', payload: { headers: [h('From', 'a@b.example')] } }]), new Response('{}', { status: 404 })]);
    expect((await c.getThreadMetadata('t', 'thr1'))?.messages).toEqual([]);
    expect(await c.getThreadMetadata('t', 'gone')).toBeNull();
  });

  it('stops on a revoked or refused grant, and retries a server error with backoff', async () => {
    const denied = client([new Response('{"error":{"status":"PERMISSION_DENIED","errors":[{"reason":"forbidden"}]}}', { status: 403 })]);
    await expect(denied.c.getThreadMetadata('t', 'thr1')).rejects.toMatchObject({ code: 'auth', failure: { call: 'threads.get', httpStatus: 403 } });
    const unauthorised = client([new Response('', { status: 401 })]);
    await expect(unauthorised.c.getThreadMetadata('t', 'thr1')).rejects.toBeInstanceOf(GmailApiError);
    const flaky = client([new Response('', { status: 503 }), thread([])]);
    expect(await flaky.c.getThreadMetadata('t', 'thr1')).toEqual({ id: 'thr1', messages: [] });
    expect(flaky.sleeps).toHaveLength(1);
  });

  it('says so when the answer is not a thread', async () => {
    const { c } = client([json({ messages: 'nope' })]);
    await expect(c.getThreadMetadata('t', 'thr1')).rejects.toMatchObject({ code: 'unavailable', failure: { call: 'threads.get', cause: 'bad_response' } });
  });
});

describe('header helpers for reply checks', () => {
  it('takes the address out of a From header, in lower case, or nothing', () => {
    expect(addressOf('Some One <Some.One@Example.COM>')).toBe('some.one@example.com');
    expect(addressOf('plain@example.com')).toBe('plain@example.com');
    expect(addressOf('"Name, With Comma" <n@example.com>')).toBe('n@example.com');
    expect(addressOf('no address here')).toBeUndefined();
    expect(addressOf(undefined)).toBeUndefined();
  });

  it('lists the ids inside angle brackets, in lower case', () => {
    expect(messageIdsIn('<A@x.example> <B@y.example>')).toEqual(['a@x.example', 'b@y.example']);
    expect(messageIdsIn(undefined)).toEqual([]);
    expect(messageIdsIn('not an id')).toEqual([]);
  });

  it('judges automatic mail from headers alone', () => {
    const of = (headers: Record<string, string>) => (name: string) => headers[name];
    expect(isAutomatic(of({ 'Auto-Submitted': 'auto-generated' }))).toBe(true);
    expect(isAutomatic(of({ 'Auto-Submitted': 'no' }))).toBe(false);
    expect(isAutomatic(of({ Precedence: 'auto_reply' }))).toBe(true);
    expect(isAutomatic(of({ Precedence: 'first-class' }))).toBe(false);
    expect(isAutomatic(of({ 'X-Autorespond': '1' }))).toBe(true);
    expect(isAutomatic(of({}))).toBe(false);
  });
});
