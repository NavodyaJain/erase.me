import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import { scrub, scrubString } from './scrub.js';

describe('scrubString', () => {
  it('removes email addresses', () => {
    expect(scrubString('sent to riya.s@gmail.com today')).toBe('sent to [email] today');
  });

  it('removes tokens', () => {
    expect(scrubString('Authorization: Bearer abc.def-123_x')).toContain('Bearer [token]');
    expect(scrubString('t=ya29.a0AfH6SMBxyz-123')).toBe('t=[token]');
    expect(scrubString('r=1//0gAbCdEfGhIjKlMnOpQrStUv')).toBe('r=[token]');
    expect(scrubString('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4')).toBe('jwt [token]');
  });

  it('removes ID numbers and phone numbers', () => {
    expect(scrubString('pan ABCDE1234F')).toBe('pan [id-number]');
    expect(scrubString('aadhaar 1234 5678 9012')).toBe('aadhaar [id-number]');
    expect(scrubString('aadhaar 123456789012')).toBe('aadhaar [id-number]');
    expect(scrubString('call 9876543210')).toBe('call [number]');
    expect(scrubString('call +91 98765 43210')).toBe('call +91 [number]');
  });

  it('removes IPv4 addresses', () => {
    expect(scrubString('from 203.0.113.42:5432')).toBe('from [ip]:5432');
  });

  it('leaves ids, timestamps and ordinary text alone', () => {
    const samples = [
      randomUUID(),
      '11111111-2222-3333-4444-555555555555',
      newId('request'),
      '2026-11-21T10:15:30.123Z',
      '2026-11-21 10:15',
      'request completed',
      'HTTP 200 in 12 ms',
    ];
    for (const s of samples) expect(scrubString(s)).toBe(s);
  });
});

describe('scrub', () => {
  it('redacts sensitive keys wholesale', () => {
    const out = scrub({
      email: 'a@b.com',
      to: 'privacy@company.example',
      subject: 'Request to delete my data',
      body: 'Dear company',
      draftBody: 'text',
      replyText: 'text',
      refresh_token: 'x',
      authorization: 'Bearer x',
      cookie: 'sid=1',
      googleSub: '123',
      grievanceEmail: 'g@c.example',
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) expect(v).toBe('[redacted]');
  });

  it('keeps operational fields', () => {
    const input = { method: 'GET', route: '/healthz', statusCode: 200, durationMs: 4, requestId: randomUUID(), draftHash: 'a'.repeat(64) };
    expect(scrub(input)).toEqual(input);
  });

  it('scrubs strings inside nested objects and arrays', () => {
    const out = scrub({ a: { b: ['mail a@b.com', { c: 'ip 10.1.2.3' }] } });
    expect(JSON.stringify(out)).not.toMatch(/a@b\.com|10\.1\.2\.3/);
  });

  it('turns errors into plain scrubbed objects', () => {
    const err = Object.assign(new Error('connect to a@b.com failed'), { code: 'ECONNREFUSED' });
    const out = scrub(err) as { type: string; message: string; code: string; stack: string };
    expect(out.type).toBe('Error');
    expect(out.code).toBe('ECONNREFUSED');
    expect(out.message).toBe('connect to [email] failed');
    expect(out.stack).not.toContain('a@b.com');
  });

  it('does not walk class instances or unbounded depth', () => {
    class Thing {
      secret = 'a@b.com';
    }
    expect(scrub({ t: new Thing() })).toEqual({ t: '[object]' });
    let deep: Record<string, unknown> = { v: 'a@b.com' };
    for (let i = 0; i < 10; i++) deep = { n: deep };
    expect(JSON.stringify(scrub(deep))).toContain('[truncated]');
    expect(JSON.stringify(scrub(deep))).not.toContain('a@b.com');
  });

  it('passes numbers, booleans and null through', () => {
    expect(scrub({ n: 1, ok: true, none: null })).toEqual({ n: 1, ok: true, none: null });
  });
});
