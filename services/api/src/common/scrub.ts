/**
 * Log scrubber (AGENTS rule: no personal data in logs). Two layers:
 *  1. keys that name sensitive fields are replaced wholesale;
 *  2. every string is pattern-scrubbed for emails, tokens, ID numbers and IP addresses.
 * Logging code should still avoid passing personal data at all; this is the safety net.
 */

const SENSITIVE_KEY =
  /(authorization|cookie|password|passwd|secret|token|email|subject|body|draft|reply|html|snippet|google_?sub|grievance|phone|address|api_?key|credential)/i;
const SENSITIVE_EXACT = new Set(['to', 'from', 'cc', 'bcc', 'name', 'text', 'state']);
const SAFE_KEYS = new Set(['draftHash', 'draft_hash']);

const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '[token]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id-number]'],
  [/(?<![\w-])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\w-])/g, '[id-number]'],
  [/(?<![\w.-])\d{10,}(?![\w.-])/g, '[number]'],
  [/(?<![\w-])\d{5}[ -]\d{5}(?![\w-])/g, '[number]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
];

const MAX_DEPTH = 6;

export function scrubString(value: string): string {
  let out = value;
  for (const [re, replacement] of STRING_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function isSensitiveKey(key: string): boolean {
  if (SAFE_KEYS.has(key)) return false;
  return SENSITIVE_EXACT.has(key.toLowerCase()) || SENSITIVE_KEY.test(key);
}

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      type: value.name,
      message: scrubString(value.message),
      ...(typeof code === 'string' ? { code } : {}),
      stack: value.stack === undefined ? undefined : scrubString(value.stack),
    };
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return '[object]';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = isSensitiveKey(k) ? '[redacted]' : scrub(v, depth + 1);
  return out;
}
