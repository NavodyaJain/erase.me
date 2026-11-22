import { describe, expect, it } from 'vitest';
import { GmailApiError, HttpGmailClient, readGoogleError, resolveReceivedAt } from './gmail.client.js';

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
