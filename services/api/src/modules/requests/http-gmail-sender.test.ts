import { describe, expect, it } from 'vitest';
import { buildRawMessage, HttpGmailSender } from './http-gmail-sender.js';
import { SenderOutcomeUnknownError, SenderRejectedError, type OutgoingMessage } from './sender.js';

const message: OutgoingMessage = {
  inboxId: 'inb_x',
  from: 'me@example.test',
  to: 'privacy@brand.example',
  subject: 'Request to erase my personal data',
  body: 'Line one\nLine two with ünïcode',
  requestId: 'req_x',
};

const decodeRaw = (raw: string): string => Buffer.from(raw, 'base64url').toString('utf8');

describe('buildRawMessage', () => {
  const raw = buildRawMessage(message);

  it('has the headers Gmail needs and carries subject and body as base64 UTF-8', () => {
    const [head, ...rest] = raw.split('\r\n\r\n');
    expect(head).toContain('From: me@example.test');
    expect(head).toContain('To: privacy@brand.example');
    expect(head).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(head).toContain('Content-Transfer-Encoding: base64');
    const subject = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(head ?? '')?.[1] ?? '';
    expect(Buffer.from(subject, 'base64').toString('utf8')).toBe(message.subject);
    expect(Buffer.from(rest.join('').replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Line one\r\nLine two with ünïcode');
  });

  it.each([
    ['a line break in the recipient', { to: 'a@brand.example\r\nBcc: x@evil.example' }],
    ['a line break in the sender', { from: 'me@example.test\nBcc: x@evil.example' }],
    ['a line break in the subject', { subject: 'Hi\r\nBcc: x@evil.example' }],
    ['a second recipient', { to: 'a@brand.example, b@evil.example' }],
    ['an angle-bracket address', { to: 'Name <a@brand.example>' }],
  ])('refuses %s', (_label, over) => {
    expect(() => buildRawMessage({ ...message, ...over })).toThrow(SenderRejectedError);
  });

  it('adds no threading headers to a first request', () => {
    expect(raw).not.toMatch(/In-Reply-To|References/i);
  });

  it('answers the first message in a follow-up: In-Reply-To and References name its Message-ID, and the subject carries "Re:"', () => {
    const followUp = buildRawMessage({ ...message, subject: 'Re: Request to erase my personal data', inReplyTo: 'cab123+x@mail.example.com' });
    const head = followUp.split('\r\n\r\n')[0] ?? '';
    expect(head).toContain('In-Reply-To: <cab123+x@mail.example.com>');
    expect(head).toContain('References: <cab123+x@mail.example.com>');
  });

  it.each([
    ['a line break (a way to add a header)', 'x@y.example\r\nBcc: z@evil.example'],
    ['angle brackets', '<x@y.example>'],
    ['a space', 'x y@z.example'],
    ['nothing', ''],
    ['a control character', 'x\u0000y@z.example'],
  ])('refuses an In-Reply-To with %s', (_label, inReplyTo) => {
    expect(() => buildRawMessage({ ...message, inReplyTo })).toThrow(SenderRejectedError);
  });

  it('keeps a body line that looks like a header from becoming one', () => {
    const tricky = buildRawMessage({ ...message, body: 'Bcc: x@evil.example\nHello' });
    const head = tricky.split('\r\n\r\n')[0] ?? '';
    expect(head).not.toContain('Bcc:');
  });
});

describe('HttpGmailSender', () => {
  // The first call is the send. After a successful send the sender makes one more, headers-only call for the Message-ID.
  const sender = (res: Response | Error, seen: { url?: string; init?: RequestInit; urls?: string[] } = {}, lookup: Response | Error = new Response('{}', { status: 404 })) => {
    let calls = 0;
    return new HttpGmailSender({
      getAccessToken: () => Promise.resolve('access-token-value'),
      fetch: (url, init) => {
        calls += 1;
        (seen.urls ??= []).push(String(url));
        const answer = calls === 1 ? res : lookup;
        if (calls === 1) {
          seen.url = String(url);
          seen.init = init;
        }
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    });
  };
  const ok = () => new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 });

  it('posts the raw message with the bearer token and returns the thread id, labelled real', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const sent = await sender(ok(), seen).send(message);
    expect(sent).toEqual({ threadId: 't1', messageId: 'm1', delivery: 'real' });
    expect(seen.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer access-token-value');
    const raw = (JSON.parse(String(seen.init?.body)) as { raw: string }).raw;
    expect(decodeRaw(raw)).toContain('To: privacy@brand.example');
  });

  it('sends a follow-up into the same Gmail thread, and does not add a thread id to a first request', async () => {
    const followUp = { ...message, threadId: 'thread-1', inReplyTo: 'first@mail.example.com' };
    const seen: { init?: RequestInit } = {};
    await sender(new Response(JSON.stringify({ id: 'm2', threadId: 'thread-1' }), { status: 200 }), seen).send(followUp);
    const posted = JSON.parse(String(seen.init?.body)) as { raw: string; threadId?: string };
    expect(posted.threadId).toBe('thread-1');
    expect(decodeRaw(posted.raw)).toContain('In-Reply-To: <first@mail.example.com>');

    const first: { init?: RequestInit } = {};
    await sender(ok(), first).send(message);
    expect(JSON.parse(String(first.init?.body))).not.toHaveProperty('threadId');
  });

  it('refuses a follow-up whose In-Reply-To is not a plain id, before anything is sent', async () => {
    const noFetch = new HttpGmailSender({ getAccessToken: () => Promise.resolve('t'), fetch: () => Promise.reject(new Error('must not be called')) });
    await expect(noFetch.send({ ...message, threadId: 'thread-1', inReplyTo: 'a b' })).rejects.toBeInstanceOf(SenderRejectedError);
  });

  it('reads the Message-ID header of the sent message with one headers-only call, so a reply can be matched to it', async () => {
    const seen: { urls?: string[] } = {};
    const lookup = new Response(JSON.stringify({ payload: { headers: [{ name: 'Message-ID', value: '<CAB123+x@mail.Example.COM>' }] } }), { status: 200 });
    const sent = await sender(ok(), seen, lookup).send(message);
    expect(sent).toEqual({ threadId: 't1', messageId: 'm1', rfcMessageId: 'cab123+x@mail.example.com', delivery: 'real' });
    const url = new URL(seen.urls?.[1] ?? '');
    expect(url.pathname).toBe('/gmail/v1/users/me/messages/m1');
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.getAll('metadataHeaders')).toEqual(['Message-ID']);
    expect(url.searchParams.get('fields')).toBe('payload/headers');
  });

  it.each([
    ['a refused lookup', new Response('', { status: 403 })],
    ['a missing message', new Response('{}', { status: 404 })],
    ['an unreadable answer', new Response('not json', { status: 200 })],
    ['an answer with no Message-ID', new Response(JSON.stringify({ payload: { headers: [] } }), { status: 200 })],
    ['a network failure', new Error('socket hang up')],
  ])('still reports the request as sent when the Message-ID lookup gives %s, with no Message-ID', async (_name, lookup) => {
    const sent = await sender(ok(), {}, lookup).send(message);
    expect(sent).toEqual({ threadId: 't1', messageId: 'm1', delivery: 'real' });
  });

  it.each([400, 401, 403, 404, 429])('treats a %s answer as a refusal: nothing was sent', async (status) => {
    await expect(sender(new Response('{"error":{"message":"secret@example.test"}}', { status })).send(message)).rejects.toBeInstanceOf(SenderRejectedError);
  });

  it.each([500, 502, 503])('treats a %s answer as an unknown outcome', async (status) => {
    await expect(sender(new Response('x', { status })).send(message)).rejects.toBeInstanceOf(SenderOutcomeUnknownError);
  });

  it('treats a network failure, a timeout and an unreadable success as an unknown outcome', async () => {
    await expect(sender(new Error('socket hang up')).send(message)).rejects.toBeInstanceOf(SenderOutcomeUnknownError);
    await expect(sender(new Response('not json', { status: 200 })).send(message)).rejects.toBeInstanceOf(SenderOutcomeUnknownError);
    await expect(sender(new Response('{"unexpected":true}', { status: 200 })).send(message)).rejects.toBeInstanceOf(SenderOutcomeUnknownError);
  });

  it('treats a missing access token as a refusal: nothing was sent', async () => {
    const noToken = new HttpGmailSender({ getAccessToken: () => Promise.reject(new Error('no token')), fetch: () => Promise.reject(new Error('must not be called')) });
    await expect(noToken.send(message)).rejects.toBeInstanceOf(SenderRejectedError);
  });

  it('puts no message text or token in an error', async () => {
    const err = await sender(new Response('{"error":"body text and token"}', { status: 400 })).send(message).then(
      () => new Error('no failure'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toBe('sender rejected the message');
    expect(err.message + String(err.stack)).not.toMatch(/access-token-value|privacy@brand|Line one/);
  });
});
