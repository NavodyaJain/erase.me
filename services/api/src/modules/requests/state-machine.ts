import { AppError } from '../../common/errors.js';
import type { REQUEST_STATUSES } from '../../db/schema/enums.js';

export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type RequestEventType = 'drafted' | 'edited' | 'approved' | 'sent' | 'bounced' | 'reply_label' | 'closed';

/**
 * The request state machine (PRD F7), in one place. `drafted -> approved -> sent`, then a reply state or
 * `no_reply`, then `closed`; `bounced` ends a request that could not be delivered.
 * - An edit after approval moves `approved -> drafted`: the earlier approval no longer counts (F6-AC2).
 * - Phase 1 only moves a request as far as `sent`; the reply states exist here so later jobs use the same table.
 * - Only `closed` and `bounced` free the company for a new request (unique index in the schema).
 */
const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  drafted: ['approved', 'closed'],
  approved: ['drafted', 'sent', 'closed'],
  sent: ['replied_deleted', 'replied_info_requested', 'replied_refused', 'no_reply', 'bounced'],
  replied_deleted: ['closed'],
  replied_info_requested: ['closed'],
  replied_refused: ['closed'],
  no_reply: ['replied_deleted', 'replied_info_requested', 'replied_refused', 'closed'],
  closed: [],
  bounced: [],
};

/** States in which the draft can still change and the request can still be abandoned. */
export const PRE_SEND_STATUSES: readonly RequestStatus[] = ['drafted', 'approved'];

export const canTransition = (from: RequestStatus, to: RequestStatus): boolean => TRANSITIONS[from].includes(to);

/** The event a transition is recorded as (F7-AC1: every status change is an event). */
export function eventFor(from: RequestStatus, to: RequestStatus): RequestEventType {
  if (to === 'approved') return 'approved';
  if (to === 'drafted' && from === 'approved') return 'edited';
  if (to === 'sent') return 'sent';
  if (to === 'closed') return 'closed';
  if (to === 'bounced') return 'bounced';
  return 'reply_label';
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'invalid_transition', 'This request cannot move to that state', `A request that is ${from} cannot become ${to}.`);
  }
}
