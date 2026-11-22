import { createHash } from 'node:crypto';

export interface DraftText {
  to: string;
  subject: string;
  body: string;
}

/** Line endings are normalised so a browser sending CRLF cannot change a hash. */
export const normaliseText = (s: string): string => s.replace(/\r\n?/g, '\n');

/**
 * The hash an approval is bound to (F6-AC1, F6-AC2): sha256 over the recipient, subject and body exactly as the
 * user sees them. Any change to any of the three changes the hash, so an edit always needs a fresh approval.
 */
export function hashDraft(d: DraftText): string {
  return createHash('sha256')
    .update(JSON.stringify([normaliseText(d.to), normaliseText(d.subject), normaliseText(d.body)]))
    .digest('hex');
}

export const isDraftHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
