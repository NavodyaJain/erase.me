import { describe, expect, it } from 'vitest';
import { HttpGmailClient } from './gmail.client.js';

const ok = () => new Response(JSON.stringify({ id: 'a', internalDate: '1714521600000', payload: { headers: [] } }), { status: 200 });
const rateLimited = (retryAfter?: string) =>
  new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'rateLimitExceeded' }] } }), {
    status: 403,
    ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}),
  });

/** A frozen clock. Sleeps are recorded, not waited, so the reserved slots can be read back. */
function setup(responses: Response[], maxRequestsPerSecond: number) {
  const sleeps: number[] = [];
  const c = new HttpGmailClient({
    fetch: () => Promise.resolve(responses.shift() ?? ok()),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => 1_000_000,
    random: () => 0,
    maxRequestsPerSecond,
  });
  return { c, sleeps };
}

describe('request pacing (regression: unpaced parallel messages.get hit 403 rateLimitExceeded)', () => {
  it('reserves evenly spaced slots for parallel calls', async () => {
    const { c, sleeps } = setup([], 10); // one call per 100 ms
    await Promise.all(Array.from({ length: 5 }, () => c.getMessageMetadata('t', 'a')));
    // The first call goes at once; the others wait for slots 100, 200, 300 and 400 ms later.
    expect(sleeps).toEqual([100, 200, 300, 400]);
  });

  it('is unlimited by default', async () => {
    const { c, sleeps } = setup([], 0);
    await Promise.all(Array.from({ length: 5 }, () => c.getMessageMetadata('t', 'a')));
    expect(sleeps).toEqual([]);
  });

  it('after a rate-limit answer: honours Retry-After, pauses every caller, and widens the spacing', async () => {
    const { c, sleeps } = setup([rateLimited('2')], 10);
    await c.getMessageMetadata('t', 'a'); // throttled once, then the retry succeeds
    expect(sleeps).toContain(2000); // the caller's own Retry-After wait
    const pauseWait = sleeps.at(-1) ?? 0; // the retry waited for the shared pause
    expect(pauseWait).toBeGreaterThanOrEqual(2000);

    sleeps.length = 0;
    await Promise.all(Array.from({ length: 3 }, () => c.getMessageMetadata('t', 'a')));
    const spacing = sleeps.slice(1).map((s, i) => s - (sleeps[i] as number));
    expect(spacing.every((g) => g > 100)).toBe(true); // wider than the starting 100 ms
  });

  it('retries a rate limit six times, then gives up with a quota code and the failure detail', async () => {
    const { c } = setup(Array.from({ length: 6 }, () => rateLimited()), 10);
    await expect(c.getMessageMetadata('t', 'a')).rejects.toMatchObject({
      code: 'quota',
      failure: { call: 'messages.get', httpStatus: 403, reason: 'rateLimitExceeded', googleStatus: 'PERMISSION_DENIED' },
    });
  });
});
