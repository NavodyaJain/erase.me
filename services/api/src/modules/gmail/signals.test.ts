import { describe, expect, it } from 'vitest';
import { ExcludeList, parseExcludeList } from './detection-rules.js';
import { unsubscribeHosts, type GmailMessageMeta } from './gmail.client.js';
import { aggregate, attributeBrand, readSighting, registrableDomain, senderAddress } from './signals.js';

const msg = (over: Partial<GmailMessageMeta>): GmailMessageMeta => ({
  id: 'm1',
  receivedAt: new Date('2024-05-01T00:00:00Z'),
  from: '"Sample Shop" <hello@mail.sampleshop.example>',
  subject: 'Welcome to Sample Shop',
  hasListUnsubscribe: false,
  hasListId: false,
  replyTo: undefined,
  listUnsubscribeHosts: [],
  ...over,
});

const exclude = (configured: string[] = [], own: string[] = []) => new ExcludeList(configured, own, registrableDomain);

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
    expect(JSON.stringify(s)).not.toMatch(/Welcome to Sample Shop|Sample Shop"|hello@/);
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

describe('transactional senders (item 7: headers only, no bodies)', () => {
  it.each([
    ['orders@shop.example', 'Thanks'],
    ['statements@bank.example', 'Your monthly mail'],
    ['no-reply@bank.example', 'Your e-statement is ready'],
    ['alerts@bank.example', 'Hello'],
    ['no-reply@shop.example', 'Your order has shipped'],
    ['support@travel.example', 'Booking confirmed: Delhi to Goa'],
    ['info@bank.example', 'Transaction alert for your account'],
  ])('%s with subject %j is transactional', (from, subject) => {
    expect(readSighting(msg({ from, subject }))?.signals).toContain('transactional');
  });

  it('does not call mailing-list mail transactional just because of its subject', () => {
    const s = readSighting(msg({ from: 'news@shop.example', subject: 'Your order of savings: shipped free!', hasListUnsubscribe: true }));
    expect(s?.signals).not.toContain('transactional');
  });

  it('does not match a plain no-reply sender with an ordinary subject', () => {
    expect(readSighting(msg({ from: 'no-reply@shop.example', subject: 'Hello there' }))).toBeNull();
  });
});

describe('email-delivery services (item 3)', () => {
  const via = (over: Partial<GmailMessageMeta>) =>
    msg({ from: '"Brand" <bounce-123@em.sendgrid.net>', subject: 'Welcome to the app', ...over });

  it.each(['elasticemail.com', 'sendgrid.net', 'mailchimp.com', 'amazonses.com', 'mailgun.org', 'mandrillapp.com', 'mcsv.net'])(
    '%s is never a company',
    (esp) => {
      expect(readSighting(msg({ from: `x@mail.${esp}`, subject: 'Welcome' }))).toBeNull();
    },
  );

  it('attributes to the brand in Reply-To first', () => {
    expect(readSighting(via({ replyTo: 'Support <help@brandco.example>' }))?.domain).toBe('brandco.example');
  });

  it('then to a List-Unsubscribe host, skipping delivery hosts', () => {
    expect(
      readSighting(via({ hasListUnsubscribe: true, listUnsubscribeHosts: ['unsub.sendgrid.net', 'list.brandco.example'] }))?.domain,
    ).toBe('brandco.example');
  });

  it('skips the message when nothing names a real brand', () => {
    expect(readSighting(via({}))).toBeNull();
    expect(readSighting(via({ replyTo: 'me@gmail.com', hasListUnsubscribe: true, listUnsubscribeHosts: ['x.mailchimp.com'] }))).toBeNull();
  });

  it('does not use Reply-To when the From domain is already the brand', () => {
    const s = readSighting(msg({ from: 'hi@realbrand.example', replyTo: 'x@other.example' }));
    expect(s?.domain).toBe('realbrand.example');
  });

  it('attributeBrand never returns a delivery domain', () => {
    expect(attributeBrand(via({ replyTo: 'x@sendgrid.net' }), exclude())).toBeUndefined();
  });
});

describe('unsubscribeHosts keeps hostnames only', () => {
  it('reads mailto and https targets and drops paths, tokens and query strings', () => {
    const hosts = unsubscribeHosts('<mailto:unsub@lists.brand.example?subject=remove>, <https://click.brand.example/u/SECRET-TOKEN-123?e=person@example.test>');
    expect(hosts).toEqual(['lists.brand.example', 'click.brand.example']);
    expect(JSON.stringify(hosts)).not.toMatch(/SECRET|person@|unsub@/);
  });

  it('handles missing and malformed values', () => {
    expect(unsubscribeHosts(undefined)).toEqual([]);
    expect(unsubscribeHosts('not a header')).toEqual([]);
    expect(unsubscribeHosts('<https://>')).toEqual([]);
  });
});

describe('own and employer senders (item 4)', () => {
  it('excludes the user\'s own addresses, whatever the subject', () => {
    const own = exclude([], ['me@gmail.com']);
    expect(readSighting(msg({ from: 'Me <me@gmail.com>', subject: 'Welcome' }), own)).toBeNull();
  });

  it('excludes the whole domain of a custom-domain inbox, but not gmail.com', () => {
    const own = exclude([], ['me@myfirm.example', 'me@gmail.com']);
    expect(readSighting(msg({ from: 'hr@mail.myfirm.example', subject: 'Welcome' }), own)).toBeNull();
    expect(readSighting(msg({ from: 'hi@realbrand.example', subject: 'Welcome' }), own)?.domain).toBe('realbrand.example');
  });

  it('excludes configured employer domains (and their subdomains) and exact addresses', () => {
    const cfg = exclude(parseExcludeList('Employer.example, boss@someone.example'));
    expect(readSighting(msg({ from: 'it@corp.employer.example' }), cfg)).toBeNull();
    expect(readSighting(msg({ from: 'boss@someone.example' }), cfg)).toBeNull();
    expect(readSighting(msg({ from: 'other@someone.example' }), cfg)?.domain).toBe('someone.example');
  });

  it('excludes an employer reached through a delivery service', () => {
    const cfg = exclude(['employer.example']);
    const via = msg({ from: 'x@em.sendgrid.net', replyTo: 'hr@employer.example', subject: 'Welcome' });
    expect(readSighting(via, cfg)).toBeNull();
  });
});

describe('parseExcludeList', () => {
  it('splits on commas, semicolons and spaces and lowercases', () => {
    expect(parseExcludeList(' A.example,B.example; c@d.example  e.example ')).toEqual(['a.example', 'b.example', 'c@d.example', 'e.example']);
    expect(parseExcludeList(undefined)).toEqual([]);
  });
});

describe('aggregate: the latest receipt or transactional date', () => {
  it('records the latest message with a receipt or transactional signal, and ignores newsletters', () => {
    const out = aggregate([
      { domain: 'a.example', seenAt: new Date('2024-01-01'), signals: ['receipt'] },
      { domain: 'a.example', seenAt: new Date('2025-03-01'), signals: ['transactional', 'list_unsubscribe'] },
      { domain: 'a.example', seenAt: new Date('2026-01-01'), signals: ['newsletter'] },
      { domain: 'b.example', seenAt: new Date('2026-01-01'), signals: ['newsletter', 'welcome', 'verify'] },
    ]);
    expect(out.get('a.example')?.lastTransactional).toEqual(new Date('2025-03-01'));
    expect(out.get('a.example')?.lastSeen).toEqual(new Date('2026-01-01'));
    expect(out.get('b.example')?.lastTransactional).toBeUndefined();
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
