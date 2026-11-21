import type { JobQueue } from '../../jobs/queue.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { AuthRepository } from './auth.repository.js';
import type { SessionService } from './session.service.js';

export const DELETE_ACCOUNT_JOB = 'delete-account';

export interface InboxDisconnector {
  /** Revokes every Google token the user has granted and marks the inboxes disconnected. */
  disconnectAllForUser(userId: string): Promise<void>;
}

/**
 * Account deletion (F1, TRD 8.4). The request is immediate: sign-in stops working and every session ends.
 * The job then revokes Gmail tokens and replaces the personal fields. Deleting the remaining rows
 * (detected companies, requests) is the Phase 2 owner-role purge job, because the app role has no DELETE.
 */
export class AccountService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly sessions: SessionService,
    private readonly inboxes: InboxDisconnector,
    private readonly queue: JobQueue,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestDeletion(userId: string, requestId: string): Promise<void> {
    const marked = await this.repo.markUserDeleting(userId);
    await this.sessions.revokeAll(userId);
    if (marked) {
      await this.audit.record({
        actorType: 'user',
        actorId: userId,
        action: 'account.deletion_requested',
        targetType: 'user',
        targetId: userId,
        requestId,
      });
    }
    // Enqueued even when already marked, so a deletion interrupted by a restart can be retried.
    this.queue.enqueue(DELETE_ACCOUNT_JOB, { userId });
  }

  /** Idempotent. */
  async runDeletion(userId: string): Promise<void> {
    await this.inboxes.disconnectAllForUser(userId);
    await this.sessions.revokeAll(userId);
    await this.repo.anonymiseUser(userId, this.now());
    await this.audit.record({
      actorType: 'system',
      action: 'account.deletion_completed',
      targetType: 'user',
      targetId: userId,
    });
  }
}
