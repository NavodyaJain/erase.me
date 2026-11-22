// banned-words:ignore-file  (this file defines the wording rules, so it contains the words)
/**
 * Wording rules for every string a person can read (PRD 4.4). The repo-wide lint checks source files; the tests that
 * use this check the copy module and the rendered screens, so a string built at run time is covered too.
 * This file defines the rules, so it contains the words.
 */
export interface Rule {
  id: string;
  re: RegExp;
  /** A hedge or a negation directly before the match makes it acceptable ("may have leaked"). */
  allowIfBefore?: RegExp;
}

const HEDGE = /\b(?:may|might|could|possibly|potentially)\b[^.!?\n]{0,24}$/i;

export const RULES: Rule[] = [
  { id: 'will-delete', re: /\bwill\s+(?:be\s+)?delete[d]?\b/i },
  { id: 'will-erase', re: /\bwill\s+(?:be\s+)?erase[d]?\b/i },
  { id: 'guaranteed', re: /\bguarantee[sd]?\b/i, allowIfBefore: /\b(?:not|never|no|cannot|can't|without)\b[^.!?\n]{0,24}$/i },
  { id: 'compliant', re: /\b(?:non-?compliant|compliant)\b/i },
  { id: 'legal-accusation', re: /\b(?:violating|violation|illegal|unlawful)\b/i },
  { id: 'data-safe', re: /\byour data is safe\b/i },
  { id: 'leaked', re: /\bleak(?:ed|s)?\b/i, allowIfBefore: HEDGE },
  { id: 'exclamation', re: /!/ },
  { id: 'emoji', re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
  { id: 'hype', re: /\b(?:amazing|incredible|revolutionary|magic(?:al)?|effortless(?:ly)?|instantly)\b/i },
  { id: 'certainty', re: /\b(?:definitely|certainly|for sure)\b/i },
];

export interface Violation {
  rule: string;
  match: string;
  context: string;
}

export function findViolations(text: string): Violation[] {
  const out: Violation[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`))) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
      if (rule.allowIfBefore?.test(before)) continue;
      out.push({ rule: rule.id, match: m[0], context: text.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + 30) });
    }
  }
  return out;
}

/** Every string value inside a nested object, so a whole copy module can be checked. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}
