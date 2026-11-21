import { describe, expect, it } from 'vitest';
import { GmailApiError, HttpGmailClient } from './gmail.client.js';

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
    });
    expect(JSON.stringify(m)).not.toContain('must be ignored');
    const url = new URL(requests[0]?.url ?? '');
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.getAll('metadataHeaders').sort()).toEqual(['Date', 'From', 'List-Id', 'List-Unsubscribe', 'Subject']);
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
    const { c } = client(Array.from({ length: 5 }, () => json({}, 429)));
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
