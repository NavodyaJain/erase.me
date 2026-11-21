import type { GmailMessageMeta } from './gmail.client.js';

export type SignalType = 'welcome' | 'receipt' | 'verify' | 'list_unsubscribe' | 'newsletter';

export interface Sighting {
  /** Registrable domain of the sender, for example `shop.example`. */
  domain: string;
  seenAt: Date;
  signals: SignalType[];
}

/** Consumer mailbox providers: mail from them is a person, not a company that holds your data. */
const MAILBOX_PROVIDERS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'aol.com',
]);

/** Second-level labels under which the registrable domain has three parts (co.in, com.au, ...). */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'nic', 'res']);

// Account OTP and login-code mail is skipped entirely (PRD F2: "OTP-free account emails").
const OTP = /\botp\b|one[- ]time (password|passcode|code|pin)|verification code|security code|login code|sign[- ]in code|passcode/i;
const VERIFY = /verify your|confirm your (email|account|address)|activate your account|verify (this )?email/i;
const WELCOME = /\bwelcome\b|getting started|thanks for (signing up|joining|registering|creating)|your new account|account (has been )?created/i;
const RECEIPT = /\breceipt\b|\binvoice\b|your order|order (confirmation|confirmed|#)|payment (received|successful|confirmation)|subscription|billing|statement/i;

/** The address in a From header, lowercased: `"Name" <a@b.example>` or `a@b.example`. */
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

/**
 * Turns one message's headers into a sighting, or null if it is not a company signal.
 * The subject is matched in memory and not returned. Nothing here is kept beyond domain, date and signal names.
 */
export function readSighting(m: GmailMessageMeta): Sighting | null {
  if (!m.from) return null;
  const address = senderAddress(m.from);
  const host = address?.split('@')[1];
  const domain = host ? registrableDomain(host) : undefined;
  if (!domain || MAILBOX_PROVIDERS.has(domain)) return null;

  const subject = m.subject ?? '';
  if (OTP.test(subject)) return null;

  const signals: SignalType[] = [];
  if (WELCOME.test(subject)) signals.push('welcome');
  if (RECEIPT.test(subject)) signals.push('receipt');
  if (VERIFY.test(subject)) signals.push('verify');
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
