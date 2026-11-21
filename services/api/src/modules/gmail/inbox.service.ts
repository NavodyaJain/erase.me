import { newId } from '../../common/ids.js';
import { Problems } from '../../common/errors.js';
import type { TokenVault } from '../../crypto/token-vault.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { InboxDisconnector } from '../auth/account.service.js';
import { OAuthFlowError } from '../auth/auth.service.js';
import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GoogleOAuthError,
  type CodeExchangeResult,
  type GoogleOAuthClient,
} from '../auth/google-oauth.js';
import { GmailApiError } from './gmail.client.js';
import type { GmailRepository, InboxRow } from './gmail.repository.js';

export const MAX_INBOXES_PER_USER = 5; // F1-AC4
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // docs/OPEN-QUESTIONS.md: keep 30 days after disconnect
const ACCESS_TOKEN_SAFETY_MS = 60_000;

export interface InboxView {
  id: string;
  email: string;
  status: InboxRow['status'];
  connectedAt: Date;
  lastScanAt: Date | null;
}

export class InboxService implements InboxDisconnector {
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly repo: GmailRepository,
    private readonly vault: TokenVault | undefined,
    private readonly google: GoogleOAuthClient | undefined,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(userId: string): Promise<InboxView[]> {
    const rows = await this.repo.listInboxes(userId);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      status: r.status,
      connectedAt: r.connectedAt,
      lastScanAt: r.lastScanAt,
    }));
  }

  /** Called before sending the user to Google, so the limit is explained before consent, not after. */
  async assertCanAddInbox(userId: string): Promise<void> {
    if ((await this.repo.countConnected(userId)) >= MAX_INBOXES_PER_USER) {
      throw Problems.conflict('inbox_limit', 'Inbox limit reached', `You can connect up to ${MAX_INBOXES_PER_USER} inboxes.`);
    }
  }

  /**
   * Finishes an inbox connection after Google's consent (F1). Rejects a grant that is missing a scope,
   * and revokes it so nothing is left connected at Google that we will not use.
   */
  async connect(userId: string, result: CodeExchangeResult): Promise<void> {
    if (!this.vault) throw Problems.unavailable('encryption_not_configured', 'Token encryption is not configured');
    const granted = new Set(result.grantedScopes);
    const hasScopes = granted.has(GMAIL_READONLY_SCOPE) && granted.has(GMAIL_SEND_SCOPE);
    if (!hasScopes || !result.refreshToken) {
      await this.google?.revoke(result.refreshToken ?? result.accessToken);
      throw new OAuthFlowError(!hasScopes ? 'scopes_missing' : 'no_refresh_token');
    }

    const email = result.identity.email.toLowerCase();
    const existing = await this.repo.findInboxByEmail(userId, email);
    if (!existing || existing.status === 'disconnected') {
      const connected = await this.repo.countConnected(userId);
      if (connected >= MAX_INBOXES_PER_USER) {
        await this.google?.revoke(result.refreshToken);
        throw new OAuthFlowError('inbox_limit');
      }
    }

    const id = existing?.id ?? newId('inbox');
    const sealed = await this.vault.seal(result.refreshToken, id);
    const now = this.now();
    await this.repo.saveConnectedInbox({
      id,
      userId,
      email,
      tokenCiphertext: sealed.ciphertext,
      tokenKeyId: sealed.keyId,
      scopes: ['gmail.readonly', 'gmail.send'],
      now,
    });
    this.accessTokens.delete(id);
    await this.audit.record({ actorType: 'user', actorId: userId, action: 'inbox.connected', targetType: 'inbox', targetId: id });
  }

  /**
   * Disconnect (F1-AC3): revoke at Google, drop the stored token, stop scans, start the retention clock.
   * If Google cannot be reached the inbox is still disconnected locally, so no further calls are made;
   * the result says the revoke did not confirm.
   */
  async disconnect(userId: string, inboxId: string): Promise<{ revokedAtGoogle: boolean }> {
    const inbox = await this.repo.findOwnedInbox(userId, inboxId);
    if (!inbox) throw Problems.notFound();
    return this.disconnectRow(inbox);
  }

  async disconnectAllForUser(userId: string): Promise<void> {
    for (const inbox of await this.repo.listTokenHolders(userId)) await this.disconnectRow(inbox);
  }

  private async disconnectRow(inbox: InboxRow): Promise<{ revokedAtGoogle: boolean }> {
    if (inbox.status === 'disconnected') return { revokedAtGoogle: true };
    let revoked = false;
    if (this.vault && this.google && inbox.tokenCiphertext && inbox.tokenKeyId) {
      try {
        const refresh = await this.vault.open({ ciphertext: inbox.tokenCiphertext, keyId: inbox.tokenKeyId }, inbox.id);
        revoked = await this.google.revoke(refresh);
      } catch {
        revoked = false; // undecryptable or unreachable: still disconnect locally
      }
    }
    const now = this.now();
    await this.repo.failActiveScansForInbox(inbox.id, 'inbox_disconnected', now);
    await this.repo.markDisconnected(inbox.id, now, new Date(now.getTime() + RETENTION_MS));
    this.accessTokens.delete(inbox.id);
    await this.audit.record({
      actorType: 'user',
      actorId: inbox.userId,
      action: 'inbox.disconnected',
      targetType: 'inbox',
      targetId: inbox.id,
    });
    return { revokedAtGoogle: revoked };
  }

  /**
   * A short-lived access token for a connected inbox, kept in memory only. If Google says the grant is
   * gone (the user revoked it in their Google account) the inbox is marked `error` and no more calls are made.
   */
  async accessTokenFor(inbox: InboxRow): Promise<string> {
    if (inbox.status !== 'connected' || !inbox.tokenCiphertext || !inbox.tokenKeyId || !this.vault || !this.google) {
      throw new GmailApiError('auth');
    }
    const cached = this.accessTokens.get(inbox.id);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.token;
    try {
      const refresh = await this.vault.open({ ciphertext: inbox.tokenCiphertext, keyId: inbox.tokenKeyId }, inbox.id);
      const { accessToken, expiresInSec } = await this.google.refreshAccessToken(refresh);
      this.accessTokens.set(inbox.id, {
        token: accessToken,
        expiresAt: this.now().getTime() + expiresInSec * 1000 - ACCESS_TOKEN_SAFETY_MS,
      });
      return accessToken;
    } catch (err) {
      if (err instanceof GoogleOAuthError && err.code === 'invalid_grant') {
        await this.repo.markInboxError(inbox.id, this.now());
        throw new GmailApiError('auth', { call: 'token.refresh', ...err.detail });
      }
      if (err instanceof GoogleOAuthError) {
        throw new GmailApiError('unavailable', {
          call: 'token.refresh',
          ...(err.detail?.httpStatus ? { httpStatus: err.detail.httpStatus } : {}),
          ...(err.detail?.reason ? { reason: err.detail.reason } : {}),
          ...(err.detail?.cause ? { cause: err.detail.cause } : {}),
        });
      }
      throw new GmailApiError('auth', { call: 'token.refresh', cause: 'token_unreadable' }); // could not decrypt
    }
  }
}
