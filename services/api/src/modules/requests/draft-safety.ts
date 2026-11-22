import { OPEN_MARKER } from './draft-citation.js';

/**
 * Rules-only guard for draft text (F6: "No ID numbers are put into requests"). It looks for government-ID-like
 * patterns and for an unresolved [OPEN] placeholder. It reports categories only, never the matched text, so the
 * result is safe to return and to log.
 */
export type SafetyFinding = 'aadhaar' | 'pan' | 'passport' | 'voter_id' | 'gstin' | 'card' | 'open_placeholder';

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

const digitsReversed = (s: string): number[] => [...s].map(Number).reverse();

/** True when the digit string passes the Verhoeff checksum (the check Aadhaar numbers use). */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  digitsReversed(digits).forEach((d, i) => {
    c = D[c]?.[P[i % 8]?.[d] ?? 0] ?? 0;
  });
  return c === 0;
}

/** The Verhoeff check digit for a digit string (tests use it to build valid numbers). */
export function verhoeffCheckDigit(digits: string): number {
  let c = 0;
  digitsReversed(digits).forEach((d, i) => {
    c = D[c]?.[P[(i + 1) % 8]?.[d] ?? 0] ?? 0;
  });
  return INV[c] ?? 0;
}

/** True when the digit string passes the Luhn checksum (payment cards). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  [...digits].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  });
  return sum % 10 === 0;
}

const AADHAAR = /(?<!\d)(\d{4})[ -]?(\d{4})[ -]?(\d{4})(?!\d)/g;
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const PAN = /(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/i;
const GSTIN = /(?<![A-Z0-9])\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z](?![A-Z0-9])/i;
const EPIC = /(?<![A-Z0-9])[A-Z]{3}\d{7}(?![A-Z0-9])/i;
const PASSPORT = /(?<![A-Z0-9])[A-PR-WY][1-9]\d{6}(?![A-Z0-9])/i;

export function findSafetyIssues(...texts: string[]): SafetyFinding[] {
  const text = texts.join('\n');
  const found = new Set<SafetyFinding>();

  // Only a 12-digit run that passes Verhoeff counts as an Aadhaar number, so order and reference numbers pass.
  for (const m of text.matchAll(AADHAAR)) {
    const digits = `${m[1]}${m[2]}${m[3]}`;
    if (/^[2-9]/.test(digits) && verhoeffValid(digits)) found.add('aadhaar');
  }
  for (const m of text.matchAll(CARD)) {
    if (luhnValid(m[0].replace(/\D/g, ''))) found.add('card');
  }
  if (GSTIN.test(text)) found.add('gstin');
  if (PAN.test(text)) found.add('pan');
  if (EPIC.test(text)) found.add('voter_id');
  if (PASSPORT.test(text)) found.add('passport');
  if (text.includes(OPEN_MARKER)) found.add('open_placeholder');
  return [...found];
}

/** Findings that mean the text carries an ID-like number. The placeholder is handled separately. */
export const ID_FINDINGS: readonly SafetyFinding[] = ['aadhaar', 'pan', 'passport', 'voter_id', 'gstin', 'card'];

const LABELS: Record<SafetyFinding, string> = {
  aadhaar: 'an Aadhaar-like number',
  pan: 'a PAN-like number',
  passport: 'a passport-like number',
  voter_id: 'a voter ID-like number',
  gstin: 'a GSTIN-like number',
  card: 'a payment card-like number',
  open_placeholder: 'an unresolved [OPEN] placeholder',
};

/** A sentence for the user. Names the kind of problem, never repeats the text. */
export function explainFindings(findings: readonly SafetyFinding[]): string {
  const ids = findings.filter((f) => f !== 'open_placeholder');
  const parts: string[] = [];
  if (ids.length) {
    parts.push(
      `The text looks like it contains ${ids.map((f) => LABELS[f]).join(', ')}. Erase.me does not put ID numbers in requests. Remove it and try again.`,
    );
  }
  if (findings.includes('open_placeholder')) {
    parts.push('The text still has an [OPEN] placeholder. Replace it with the wording you want to send, or remove the line.');
  }
  return parts.join(' ');
}
