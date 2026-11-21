import { describe, expect, it } from 'vitest';
import type { GmailMessageMeta } from './gmail.client.js';
import { aggregate, readSighting, registrableDomain, senderAddress } from './signals.js';

const msg = (over: Partial<GmailMessageMeta>): GmailMessageMeta => ({
  id: 'm1',
  receivedAt: new Date('2024-05-01T00:00:00Z'),
  from: '"Sample Shop" <hello@mail.sampleshop.example>',
  subject: 'Welcome to Sample Shop',
  hasListUnsubscribe: false,
  hasListId: false,
  ...over,
});

describe('senderAddress', () => {
  it('reads angle-bracket and bare forms, lowercased', () => {
    expect(senderAddress('"A B" <Hi@Shop.Example>')).toBe('hi@shop.example');
    expect(senderAddress('hi@shop.example')).toBe('hi@shop.example');
    expect(senderAddress('undisclosed-recipients')).toBeUndefined();
  });
});

describe('registrableDomain', () => {
  it.each([
    ['mail.sampleshop.example', 'sampleshop.example'],
    ['sampleshop.example', 'sampleshop.example'],
    ['news.shop.co.in', 'shop.co.in'],
    ['shop.com.au', 'shop.com.au'],
    ['a.b.c.bank.org.in', 'bank.org.in'],
  ])('%s -> %s', (host, expected) => expect(registrableDomain(host)).toBe(expected));

  it('rejects hosts that are not domains', () => {
    expect(registrableDomain('localhost')).toBeUndefined();
    expect(registrableDomain('bad_domain.example')).toBeUndefined();
  });
});

describe('readSighting', () => {
  it('turns a welcome mail into a company sighting without keeping the subject or sender name', () => {
    const s = readSighting(msg({}));
    expect(s).toEqual({ domain: 'sampleshop.example', seenAt: new Date('2024-05-01T00:00:00Z'), signals: ['welcome'] });
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/Welcome to Sample Shop|Sample Shop"|hello@/);
  });

  it('reads receipts, verification mail and list headers', () => {
    expect(readSighting(msg({ subject: 'Your invoice for May' }))?.signals).toEqual(['receipt']);
    expect(readSighting(msg({ subject: 'Please verify your email' }))?.signals).toEqual(['verify']);
    expect(readSighting(msg({ subject: 'Big sale', hasListUnsubscribe: true, hasListId: true }))?.signals).toEqual([
      'list_unsubscribe',
      'newsletter',
    ]);
  });

  it('skips one-time-code mail entirely', () => {
    expect(readSighting(msg({ subject: 'Your OTP is 123456', hasListUnsubscribe: true }))).toBeNull();
    expect(readSighting(msg({ subject: 'Your verification code' }))).toBeNull();
    expect(readSighting(msg({ subject: 'One-time password for login' }))).toBeNull();
  });

  it('skips people (mailbox providers) and mail with no signal', () => {
    expect(readSighting(msg({ from: 'friend@gmail.com', subject: 'Welcome home' }))).toBeNull();
    expect(readSighting(msg({ subject: 'lunch tomorrow?' }))).toBeNull();
    expect(readSighting(msg({ from: undefined }))).toBeNull();
  });
});

describe('aggregate', () => {
  it('merges per domain: widest dates, union of signals', () => {
    const out = aggregate([
      { domain: 'a.example', seenAt: new Date('2024-05-01'), signals: ['welcome'] },
      { domain: 'a.example', seenAt: new Date('2022-01-01'), signals: ['receipt'] },
      { domain: 'a.example', seenAt: new Date('2025-01-01'), signals: ['welcome'] },
      { domain: 'b.example', seenAt: new Date('2023-01-01'), signals: ['newsletter'] },
    ]);
    const a = out.get('a.example');
    expect(a?.firstSeen).toEqual(new Date('2022-01-01'));
    expect(a?.lastSeen).toEqual(new Date('2025-01-01'));
    expect([...(a?.signals ?? [])].sort()).toEqual(['receipt', 'welcome']);
    expect(out.size).toBe(2);
  });
});
