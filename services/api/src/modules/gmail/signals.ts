import type { GmailMessageMeta } from './gmail.client.js';
import { ExcludeList, isDeliveryDomain, MAILBOX_PROVIDERS, type SignalType } from './detection-rules.js';

export type { SignalType } from './detection-rules.js';

export interface Sighting {
  /** Registrable domain of the brand that sent the message (never an email-delivery service). */
  domain: string;
  seenAt: Date;
  signals: SignalType[];
}

/** Second-level labels under which the registrable domain has three parts (co.in, com.au, ...). */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'nic', 'res']);

// Account OTP and login-code mail is skipped entirely (PRD F2: "OTP-free account emails").
const OTP = /\botp\b|one[- ]time (password|passcode|code|pin)|verification code|security code|login code|sign[- ]in code|passcode/i;
const VERIFY = /verify your|confirm your (email|account|address)|activate your account|verify (this )?email/i;
const WELCOME = /\bwelcome\b|getting started|thanks for (signing up|joining|registering|creating)|your new account|account (has been )?created/i;
const RECEIPT = /\breceipt\b|\binvoice\b|your order|order (confirmation|confirmed|#)|payment (received|successful|confirmation)|subscription|billing|statement/i;

// Transactional senders, from headers only (sender local part and subject line). A message from an address like
// orders@ or statements@, or one whose subject reads like an order, delivery, booking or account statement and
// carries no mailing-list headers, is one a company sends because of something the user did or holds.
const TRANSACTIONAL_LOCAL =
  /^(orders?|receipts?|invoices?|billing|payments?|statements?|estatements?|transactions?|alerts?|bookings?|reservations?|tickets?|shipping|delivery)([._-].*)?$/;
const TRANSACTIONAL_SUBJECT =
  /\b(e-?statement|account statement|statement (is )?(ready|available)|transaction alert|(debit|credit) alert|payment (due|reminder)|(has|have) (shipped|been (dispatched|delivered|shipped))|out for delivery|order (shipped|dispatched|delivered|placed)|booking (confirmed|confirmation)|e-?ticket|itinerary|your (ticket|trip|ride)|bill (is )?(due|generated)|account (summary|balance))\b/i;

/** The address in a From or Reply-To header, lowercased: `"Name" <a@b.example>` or `a@b.example`. */
export function senderAddress(from: string): string | undefined {
  const angle = /<([^<>]+)>/.exec(from);
  const candidate = (angle?.[1] ?? from).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : undefined;
}

/** Heuristic registrable domain without a public-suffix list: `mail.shop.co.in` -> `shop.co.in`. */
export function registrableDomain(host: string): string | undefined {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9-]{1,63}$/.test(l))) return undefined;
  const last = labels.at(-1) as string;
  const second = labels.at(-2) as string;
  const threePart = labels.length >= 3 && last.length === 2 && SECOND_LEVEL.has(second);
  return labels.slice(threePart ? -3 : -2).join('.');
}

const registrableOfAddress = (address: string | undefined): string | undefined => {
  const host = address?.split('@')[1];
  return host ? registrableDomain(host) : undefined;
};

/** An empty exclude list, for callers and tests that have none. */
export const NO_EXCLUSIONS = new ExcludeList([], [], registrableDomain);

/**
 * Which brand sent this message. Normally the From domain. When the From domain is an email-delivery service
 * (SendGrid, Mailchimp, Amazon SES and so on) the brand is taken from Reply-To, then from the hosts in the
 * List-Unsubscribe header; if none of them names a real brand the message is skipped.
 */
export function attributeBrand(m: GmailMessageMeta, exclude: ExcludeList): string | undefined {
  const address = m.from ? senderAddress(m.from) : undefined;
  if (address && exclude.matchesAddress(address)) return undefined;
  const fromDomain = registrableOfAddress(address);
  if (!fromDomain) return undefined;

  const usable = (d: string | undefined): d is string =>
    d !== undefined && !isDeliveryDomain(d) && !MAILBOX_PROVIDERS.has(d) && !exclude.matchesDomain(d);

  if (!isDeliveryDomain(fromDomain)) return usable(fromDomain) ? fromDomain : undefined;

  const candidates = [
    registrableOfAddress(m.replyTo ? senderAddress(m.replyTo) : undefined),
    ...m.listUnsubscribeHosts.map((h) => registrableDomain(h)),
  ];
  return candidates.find(usable);
}

/**
 * Turns one message's headers into a sighting, or null if it is not a company signal.
 * The subject is matched in memory and not returned. Nothing here is kept beyond domain, date and signal names.
 */
export function readSighting(m: GmailMessageMeta, exclude: ExcludeList = NO_EXCLUSIONS): Sighting | null {
  const domain = attributeBrand(m, exclude);
  if (!domain) return null;

  const subject = m.subject ?? '';
  if (OTP.test(subject)) return null;

  const address = m.from ? senderAddress(m.from) : undefined;
  const localPart = address?.split('@')[0] ?? '';
  const signals: SignalType[] = [];
  if (WELCOME.test(subject)) signals.push('welcome');
  if (RECEIPT.test(subject)) signals.push('receipt');
  if (VERIFY.test(subject)) signals.push('verify');
  if (TRANSACTIONAL_LOCAL.test(localPart) || (TRANSACTIONAL_SUBJECT.test(subject) && !m.hasListUnsubscribe && !m.hasListId)) {
    signals.push('transactional');
  }
  if (m.hasListUnsubscribe) signals.push('list_unsubscribe');
  if (m.hasListId) signals.push('newsletter');
  if (signals.length === 0) return null;
  return { domain, seenAt: m.receivedAt, signals };
}

/** Merges sightings by domain: earliest and latest date, union of signals. */
export function aggregate(sightings: Sighting[]): Map<string, { firstSeen: Date; lastSeen: Date; signals: Set<SignalType> }> {
  const out = new Map<string, { firstSeen: Date; lastSeen: Date; signals: Set<SignalType> }>();
  for (const s of sightings) {
    const cur = out.get(s.domain);
    if (!cur) {
      out.set(s.domain, { firstSeen: s.seenAt, lastSeen: s.seenAt, signals: new Set(s.signals) });
      continue;
    }
    if (s.seenAt < cur.firstSeen) cur.firstSeen = s.seenAt;
    if (s.seenAt > cur.lastSeen) cur.lastSeen = s.seenAt;
    for (const t of s.signals) cur.signals.add(t);
  }
  return out;
}
