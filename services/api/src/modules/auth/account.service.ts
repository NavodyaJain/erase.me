import { Problems } from '../../common/errors.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { AuthRepository } from './auth.repository.js';
import type { SessionService } from './session.service.js';

export interface InboxDisconnector {
  /** Revokes every Google token the user has granted and marks the inboxes disconnected. Counts only. */
  disconnectAllForUser(userId: string): Promise<{ inboxes: number; notRevoked: number }>;
}

export interface UserPurger {
  /** Removes one person's data through the purge functions. */
  purgeUserNow(userId: string): Promise<{ done: boolean }>;
}

export const GMAIL_COPIES_NOTE =
  'Copies of the requests you sent stay in your own Gmail. Erase.me does not delete them. Delete them in Gmail if you want them gone.';

export interface AccountDeletionView {
  status: 'active' | 'deleting' | 'deleted';
  requestedAt: Date | null;
  deleteAfter: Date | null;
  canUndo: boolean;
  paused: boolean;
  googleAccess: { notRevoked: number; message: string | null };
  gmailCopies: string;
  notice: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const revokeMessage = (n: number): string | null =>
  n > 0
    ? `Google did not confirm that access was removed for ${n} of your inboxes. To be sure, open your Google account settings, find Erase.me under third-party access, and remove it.`
    : null;

/**
 * Account deletion (F1). "Delete my data" starts an undo period (ACCOUNT_PURGE_AFTER_DAYS, 7 by default). At once: Google is asked to
 * remove access for each inbox (a failure is counted, never described), and reply checks, follow-ups and sending stop for this
 * person. Until the end the person can undo it. Then the purge job deletes the personal data and leaves a tombstone with none.
 * "Delete now" skips the wait. The person's own Gmail copies of sent requests are never touched.
 */
export class AccountService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly sessions: SessionService,
    private readonly inboxes: InboxDisconnector,
    private readonly purger: UserPurger,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly graceDays = 7,
  ) {}

  /** Idempotent: asking again keeps the first request and its end date. */
  async requestDeletion(userId: string, requestId: string): Promise<AccountDeletionView> {
    const now = this.now();
    const started = await this.repo.requestDeletion(userId, now, new Date(now.getTime() + this.graceDays * DAY_MS));
    // Safe to repeat: an inbox already disconnected is skipped, and a count is only written when something was revoked.
    const revoked = await this.inboxes.disconnectAllForUser(userId);
    if (revoked.inboxes > 0) await this.repo.setTokenRevokeFailed(userId, revoked.notRevoked);
    if (started) {
      await this.audit.record({
        actorType: 'user',
        actorId: userId,
        action: 'account.deletion_requested',
        targetType: 'user',
        targetId: userId,
        requestId,
      });
    }
    return this.status(userId);
  }

  /** Only inside the undo period. The inboxes were disconnected when deletion was asked for; the person connects them again. */
  async undo(userId: string, requestId: string): Promise<AccountDeletionView> {
    const undone = await this.repo.undoDeletion(userId, this.now());
    if (!undone) {
      const row = await this.repo.deletionRow(userId);
      if (!row || row.status !== 'deleting') {
        throw Problems.conflict('not_pending_deletion', 'No deletion is pending', 'There is nothing to undo.');
      }
      throw Problems.conflict('undo_window_closed', 'The undo period is over', 'The data is being or has been deleted, so it can no longer be undone.');
    }
    await this.audit.record({ actorType: 'user', actorId: userId, action: 'account.deletion_undone', targetType: 'user', targetId: userId, requestId });
    return this.status(userId);
  }

  /** Skips the undo period and deletes now. Also works for someone who has not asked for deletion yet. */
  async deleteNow(userId: string, requestId: string): Promise<AccountDeletionView> {
    const row = await this.repo.deletionRow(userId);
    if (row?.status === 'active') await this.requestDeletion(userId, requestId);
    await this.repo.deleteNow(userId);
    await this.sessions.revokeAll(userId);
    const { done } = await this.purger.purgeUserNow(userId);
    await this.audit.record({ actorType: 'user', actorId: userId, action: 'account.deleted_now', targetType: 'user', targetId: userId, requestId });
    const view = await this.status(userId);
    return done ? { ...view, status: 'deleted', canUndo: false, notice: 'Your data has been deleted.' } : view;
  }

  async status(userId: string): Promise<AccountDeletionView> {
    const row = await this.repo.deletionRow(userId);
    const base = {
      googleAccess: { notRevoked: row?.tokenRevokeFailed ?? 0, message: revokeMessage(row?.tokenRevokeFailed ?? 0) },
      gmailCopies: GMAIL_COPIES_NOTE,
    };
    if (!row || row.status !== 'deleting') {
      return { ...base, status: 'active', requestedAt: null, deleteAfter: null, canUndo: false, paused: false, notice: 'No deletion is pending.' };
    }
    if (row.purgedAt) {
      return { ...base, status: 'deleted', requestedAt: row.requestedAt, deleteAfter: row.dueAt, canUndo: false, paused: true, notice: 'Your data has been deleted.' };
    }
    const canUndo = row.dueAt !== null && row.dueAt.getTime() > this.now().getTime();
    return {
      ...base,
      status: 'deleting',
      requestedAt: row.requestedAt,
      deleteAfter: row.dueAt,
      canUndo,
      paused: true,
      notice: canUndo
        ? 'Your data will be removed after the undo period. Reply checks, follow-ups and sending are paused until then.'
        : 'Your data is being deleted. It can no longer be undone.',
    };
  }
}
