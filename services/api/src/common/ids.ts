import { ulid } from 'ulid';

/** Prefixed ULIDs (TRD 6.2). usr_, req_, cmp_ come from the TRD; the rest follow the same shape. */
export const ID_PREFIXES = {
  user: 'usr',
  inbox: 'inb',
  scan: 'scn',
  company: 'cmp',
  userCompany: 'ucm',
  request: 'req',
  draft: 'drf',
  event: 'evt',
  replyLabel: 'rlb',
  reply: 'rpl',
  audit: 'aud',
  session: 'ses',
  oauthState: 'ost',
  idempotencyKey: 'idk',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Crockford base32 ULID body. The database enforces the same pattern with CHECK constraints. */
export const ULID_PATTERN = '[0-9A-HJKMNP-TV-Z]{26}';

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${ID_PREFIXES[kind]}_${ULID_PATTERN}$`).test(value);
}
