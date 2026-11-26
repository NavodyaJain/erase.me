import { CONNECT_SCOPES, SIGNIN_SCOPES, type AuthorizationParams, type CodeExchangeResult, type GoogleOAuthClient } from '../src/modules/auth/google-oauth.js';
import type { GmailClient, GmailMessageMeta, GmailThread, GmailThreadMessage, MessagePage } from '../src/modules/gmail/gmail.client.js';

/** The people the e2e tests sign in as. Fictional, on example.com. The first is the default; the second is for cross-user checks. */
export const E2E_IDENTITIES = {
  first: { sub: 'e2e-sub-0001', email: 'e2e.user@example.com', name: 'E2E User', refreshToken: 'e2e-refresh-token' },
  second: { sub: 'e2e-sub-0002', email: 'e2e.other@example.com', name: 'E2E Other', refreshToken: 'e2e-refresh-token-second' },
} as const;
export type E2eWho = keyof typeof E2E_IDENTITIES;

/**
 * A stand-in for Google. `authorizationUrl` points at a page on the e2e server that bounces straight back to the real
 * callback, so the real state, PKCE and nonce checks still run. Nothing here talks to Google.
 */
export class FakeGoogle implements GoogleOAuthClient {
  /** Every token it was asked to revoke. */
  readonly revoked: string[] = [];
  private who: E2eWho = 'first';

  constructor(private readonly publicUrl: string) {}

  use(who: E2eWho): void {
    this.who = who;
  }

  reset(): void {
    this.who = 'first';
    this.revoked.length = 0;
  }

  /** The code the consent page returns: it says who approved, so a later change of person cannot alter it. */
  codeFor(purpose: 'signin' | 'connect'): string {
    return `e2e-code-${purpose}-${this.who}`;
  }

  authorizationUrl(p: AuthorizationParams): string {
    const u = new URL('/e2e/google/authorize', this.publicUrl);
    u.searchParams.set('state', p.state);
    u.searchParams.set('purpose', p.purpose);
    return u.toString();
  }

  exchangeCode(code: string): Promise<CodeExchangeResult> {
    const m = /^e2e-code-(signin|connect)-(first|second)$/.exec(code);
    if (!m) return Promise.reject(new Error('unknown code'));
    const connect = m[1] === 'connect';
    const { refreshToken, ...identity } = E2E_IDENTITIES[m[2] as E2eWho];
    return Promise.resolve({
      identity: { ...identity },
      grantedScopes: [...(connect ? CONNECT_SCOPES : SIGNIN_SCOPES)],
      ...(connect ? { refreshToken } : {}),
      accessToken: 'e2e-access-token',
    });
  }

  refreshAccessToken(): Promise<{ accessToken: string; expiresInSec: number }> {
    return Promise.resolve({ accessToken: 'e2e-access-token', expiresInSec: 3600 });
  }

  revoke(token: string): Promise<boolean> {
    this.revoked.push(token);
    return Promise.resolve(true);
  }
}

export interface FakeMessage {
  from: string;
  subject: string;
  daysAgo: number;
}

/** Fictional mail from fictional senders, as header metadata only. No bodies exist anywhere in the fake. */
export const E2E_MAILBOX: FakeMessage[] = [
  { from: 'E2E Bank <no-reply@e2ebank.example>', subject: 'Welcome to E2E Bank', daysAgo: 700 },
  { from: 'E2E Bank <no-reply@e2ebank.example>', subject: 'Your receipt for order 1001', daysAgo: 30 },
  { from: 'E2E Bank <no-reply@e2ebank.example>', subject: 'Your receipt for order 1002', daysAgo: 12 },
  { from: 'E2E Forms <hello@e2eforms.example>', subject: 'Welcome to E2E Forms', daysAgo: 500 },
  { from: 'E2E Forms <hello@e2eforms.example>', subject: 'Your receipt for invoice 77', daysAgo: 20 },
  { from: 'E2E Orphan <hello@e2eorphan.example>', subject: 'Welcome to E2E Orphan', daysAgo: 400 },
  { from: 'E2E Orphan <hello@e2eorphan.example>', subject: 'Your receipt for order 5', daysAgo: 40 },
  { from: 'E2E Login <noreply@e2elogin.example>', subject: 'Welcome to E2E Login', daysAgo: 900 },
  { from: 'E2E Login <noreply@e2elogin.example>', subject: 'Your receipt for plan 9', daysAgo: 9 },
];

/** Serves E2E_MAILBOX as message metadata. Message ids are positions, so every scan is repeatable. */
export class FakeGmail implements GmailClient {
  private readonly replies = new Map<string, GmailThreadMessage[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Puts a reply on a thread, as headers only. */
  addReply(threadId: string, reply: { from: string; inReplyTo: string; receivedAt: Date; automatic: boolean }): void {
    const list = this.replies.get(threadId) ?? [];
    const n = list.length + 1;
    list.push({
      id: `e2e-reply-${threadId.slice(-12)}-${n}`,
      receivedAt: reply.receivedAt,
      fromAddress: reply.from.toLowerCase(),
      messageId: `e2e-reply-${n}@mail.example`,
      inReplyTo: reply.inReplyTo,
      references: [reply.inReplyTo],
      automatic: reply.automatic,
    });
    this.replies.set(threadId, list);
  }

  reset(): void {
    this.replies.clear();
  }

  listMessageIds(_token: string, q: { maxResults: number; pageToken?: string }): Promise<MessagePage> {
    const start = q.pageToken ? Number(q.pageToken) : 0;
    const end = Math.min(start + q.maxResults, E2E_MAILBOX.length);
    const ids = E2E_MAILBOX.slice(start, end).map((_m, i) => `e2e-msg-${start + i}`);
    return Promise.resolve({ ids, ...(end < E2E_MAILBOX.length ? { nextPageToken: String(end) } : {}), estimatedTotal: E2E_MAILBOX.length });
  }

  /** A sent thread is empty until a test adds a reply through the control route. */
  getThreadMetadata(_token: string, threadId: string): Promise<GmailThread | null> {
    return Promise.resolve({ id: threadId, messages: [...(this.replies.get(threadId) ?? [])] });
  }

  getMessageMetadata(_token: string, id: string): Promise<GmailMessageMeta | null> {
    const m = E2E_MAILBOX[Number(id.replace('e2e-msg-', ''))];
    if (!m) return Promise.resolve(null);
    return Promise.resolve({
      id,
      receivedAt: new Date(this.now() - m.daysAgo * 86_400_000),
      from: m.from,
      subject: m.subject,
      hasListUnsubscribe: false,
      hasListId: false,
      replyTo: undefined,
      listUnsubscribeHosts: [],
    });
  }
}
