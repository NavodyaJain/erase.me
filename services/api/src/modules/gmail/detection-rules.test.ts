import { describe, expect, it } from 'vitest';
import { confidenceFor, DELIVERY_DOMAINS, MAILBOX_PROVIDERS } from './detection-rules.js';
import { toDetectionViews } from './detections.js';
import type { DetectedCompany } from './gmail.repository.js';
import { ExcludeList } from './detection-rules.js';
import { registrableDomain } from './signals.js';

describe('confidenceFor (item 1)', () => {
  it.each([
    [['list_unsubscribe'], 'low'],
    [['newsletter'], 'low'],
    [['list_unsubscribe', 'newsletter'], 'low'], // both are bulk-mail evidence: one kind, not two
    [['verify'], 'low'],
    [['welcome'], 'high'],
    [['receipt'], 'high'],
    [['transactional'], 'high'],
    [['list_unsubscribe', 'welcome'], 'high'],
    [['list_unsubscribe', 'verify'], 'high'],
    [['newsletter', 'verify'], 'high'],
    [['list_unsubscribe', 'newsletter', 'verify'], 'high'],
    [[], 'low'],
  ])('%j -> %s', (signals, expected) => expect(confidenceFor(signals)).toBe(expected));
});

describe('domain lists', () => {
  it('keep delivery infrastructure and mailbox providers apart', () => {
    for (const d of DELIVERY_DOMAINS) expect(MAILBOX_PROVIDERS.has(d), d).toBe(false);
    for (const d of ['elasticemail.com', 'sendgrid.net', 'mailchimp.com', 'amazonses.com', 'mailgun.org']) {
      expect(DELIVERY_DOMAINS.has(d), d).toBe(true);
    }
  });
});

describe('toDetectionViews', () => {
  const row = (over: Partial<DetectedCompany>): DetectedCompany => ({
    company: 'Brand',
    domain: 'brand.example',
    firstSeen: new Date('2025-01-02T10:00:00Z'),
    lastSeen: new Date('2025-06-01T10:00:00Z'),
    signals: ['welcome'],
    status: 'active',
    mustKeep: false,
    category: 'other',
    id: 'ucm_x',
    inboxId: 'inb_x',
    selfServeUrl: null,
    keptAt: null,
    ...over,
  });
  const none = new ExcludeList([], [], registrableDomain);

  it('shows name, dates, signals used, confidence and the must-keep flag', () => {
    const [v] = toDetectionViews([row({ signals: ['receipt', 'list_unsubscribe'], mustKeep: true })], none);
    expect(v).toEqual({
      id: 'ucm_x',
      kept: false,
      company: 'Brand',
      domain: 'brand.example',
      firstSeen: '2025-01-02',
      lastSeen: '2025-06-01',
      signals: ['list_unsubscribe', 'receipt'],
      confidence: 'high',
      mustKeep: true,
      category: 'other',
      selfServeUrl: null,
    });
  });

  it('drops delivery services recorded by an earlier scan, mailbox providers, "not mine" and excluded domains', () => {
    const views = toDetectionViews(
      [
        row({ domain: 'elasticemail.com', company: 'Elasticemail' }),
        row({ domain: 'gmail.com', company: 'Gmail' }),
        row({ domain: 'gone.example', company: 'Gone', status: 'not_mine' }),
        row({ domain: 'employer.example', company: 'Employer' }),
        row({ domain: 'keep.example', company: 'Keep' }),
      ],
      new ExcludeList(['employer.example'], [], registrableDomain),
    );
    expect(views.map((v) => v.company)).toEqual(['Keep']);
  });

  it('carries the self-serve link, but never for a must-keep company', () => {
    const link = 'https://brand.example/account/delete';
    const [a, b] = toDetectionViews([row({ company: 'A', selfServeUrl: link }), row({ company: 'B', domain: 'b.example', selfServeUrl: link, mustKeep: true })], none);
    expect(a?.selfServeUrl).toBe(link);
    expect(b?.selfServeUrl).toBeNull();
  });

  it('marks a company the user chose to keep', () => {
    const [kept, plain] = toDetectionViews([row({ company: 'Kept', keptAt: new Date('2026-01-01') }), row({ company: 'Plain', domain: 'plain.example' })], none);
    expect(kept?.kept).toBe(true);
    expect(plain?.kept).toBe(false);
  });

  it('lists likely companies before possible ones, then newest first', () => {
    const views = toDetectionViews(
      [
        row({ company: 'Low new', signals: ['newsletter'], lastSeen: new Date('2026-01-01') }),
        row({ company: 'High old', signals: ['welcome'], lastSeen: new Date('2024-01-01') }),
        row({ company: 'High new', signals: ['receipt'], lastSeen: new Date('2026-01-01') }),
      ],
      none,
    );
    expect(views.map((v) => v.company)).toEqual(['High new', 'High old', 'Low new']);
  });
});
