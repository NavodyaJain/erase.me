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

  it('keeps a body line that looks like a header from becoming one', () => {
    const tricky = buildRawMessage({ ...message, body: 'Bcc: x@evil.example\nHello' });
    const head = tricky.split('\r\n\r\n')[0] ?? '';
    expect(head).not.toContain('Bcc:');
  });
});

describe('HttpGmailSender', () => {
  const sender = (res: Response | Error, seen: { url?: string; init?: RequestInit } = {}) =>
    new HttpGmailSender({
      getAccessToken: () => Promise.resolve('access-token-value'),
      fetch: (url, init) => {
        seen.url = String(url);
        seen.init = init;
        return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
      },
    });
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
