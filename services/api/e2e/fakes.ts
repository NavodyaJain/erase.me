import { CONNECT_SCOPES, SIGNIN_SCOPES, type AuthorizationParams, type CodeExchangeResult, type GoogleOAuthClient } from '../src/modules/auth/google-oauth.js';
import type { GmailClient, GmailMessageMeta, GmailThread, MessagePage } from '../src/modules/gmail/gmail.client.js';

/** The person every e2e test signs in as. Fictional, on example.com. */
export const E2E_IDENTITY = { sub: 'e2e-sub-0001', email: 'e2e.user@example.com', name: 'E2E User' } as const;

/**
 * A stand-in for Google. `authorizationUrl` points at a page on the e2e server that bounces straight back to the real
 * callback, so the real state, PKCE and nonce checks still run. Nothing here talks to Google.
 */
export class FakeGoogle implements GoogleOAuthClient {
  constructor(private readonly publicUrl: string) {}

  authorizationUrl(p: AuthorizationParams): string {
    const u = new URL('/e2e/google/authorize', this.publicUrl);
    u.searchParams.set('state', p.state);
    u.searchParams.set('purpose', p.purpose);
    return u.toString();
  }

  exchangeCode(code: string): Promise<CodeExchangeResult> {
    if (!code.startsWith('e2e-code-')) return Promise.reject(new Error('unknown code'));
    const connect = code === 'e2e-code-connect';
    return Promise.resolve({
      identity: { ...E2E_IDENTITY },
      grantedScopes: [...(connect ? CONNECT_SCOPES : SIGNIN_SCOPES)],
      ...(connect ? { refreshToken: 'e2e-refresh-token' } : {}),
      accessToken: 'e2e-access-token',
    });
  }

  refreshAccessToken(): Promise<{ accessToken: string; expiresInSec: number }> {
    return Promise.resolve({ accessToken: 'e2e-access-token', expiresInSec: 3600 });
  }

  revoke(): Promise<boolean> {
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
  constructor(private readonly now: () => number = Date.now) {}

  listMessageIds(_token: string, q: { maxResults: number; pageToken?: string }): Promise<MessagePage> {
    const start = q.pageToken ? Number(q.pageToken) : 0;
    const end = Math.min(start + q.maxResults, E2E_MAILBOX.length);
    const ids = E2E_MAILBOX.slice(start, end).map((_m, i) => `e2e-msg-${start + i}`);
    return Promise.resolve({ ids, ...(end < E2E_MAILBOX.length ? { nextPageToken: String(end) } : {}), estimatedTotal: E2E_MAILBOX.length });
  }

  /** No replies exist in the e2e mailbox yet: every sent thread is empty. (Later e2e tests add replies through a control route.) */
  getThreadMetadata(_token: string, threadId: string): Promise<GmailThread | null> {
    return Promise.resolve({ id: threadId, messages: [] });
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
