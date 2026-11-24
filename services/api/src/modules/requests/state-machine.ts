import { AppError } from '../../common/errors.js';
import type { REQUEST_STATUSES } from '../../db/schema/enums.js';

export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type RequestEventType =
  | 'drafted'
  | 'edited'
  | 'approved'
  | 'sent'
  | 'bounced'
  | 'reply_label'
  | 'closed'
  | 'reply_received'
  | 'outcome_set'
  | 'followup_approved'
  | 'followup_sent'
  | 'submitted';

/**
 * The request state machine (PRD F7), in one place.
 *
 *   drafted -> approved -> sent -> reply_received -> (replied_*) -> closed
 *
 * - `reply_received` is set by the system when a message from someone else is found on the sent thread. It is never an
 *   outcome. `no_reply` is set by the system once the follow-up day has passed with nothing received.
 * - The `replied_*` states are the outcome the user reports (confirmed erased, refused, needs more info). Nothing infers
 *   them. The user can also go back to "no answer yet" (`sent`, or `no_reply` once overdue) or correct an outcome, and
 *   can set one without any reply having been detected, so each of `sent`, `reply_received`, `no_reply` and the outcomes
 *   can move to any other of those. An answered or unanswered request can then be closed; a sent one cannot be closed directly.
 * - An edit after approval moves `approved -> drafted`: the earlier approval no longer counts (F6-AC2).
 * - Only `closed` and `bounced` free the company for a new request (unique index in the schema).
 */
const OUTCOME_STATES = ['replied_deleted', 'replied_info_requested', 'replied_refused'] as const;
/** The states a sent request moves between while it is waiting for, or has received, an answer. */
const TRACKING_STATES = ['sent', 'reply_received', 'no_reply', ...OUTCOME_STATES] as const;
const trackingFrom = (self: RequestStatus): RequestStatus[] => TRACKING_STATES.filter((s) => s !== self);

const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  drafted: ['approved', 'closed'],
  approved: ['drafted', 'sent', 'closed'],
  // A sent request is not closed directly (Phase 1 rule). It is closed once it has an outcome or has gone unanswered.
  sent: [...trackingFrom('sent'), 'bounced'],
  reply_received: trackingFrom('reply_received'),
  no_reply: [...trackingFrom('no_reply'), 'closed'],
  replied_deleted: [...trackingFrom('replied_deleted'), 'closed'],
  replied_info_requested: [...trackingFrom('replied_info_requested'), 'closed'],
  replied_refused: [...trackingFrom('replied_refused'), 'closed'],
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
  if (to === 'sent' && (from === 'approved')) return 'sent';
  if (to === 'closed') return 'closed';
  if (to === 'bounced') return 'bounced';
  if (to === 'reply_received') return 'reply_received';
  if (to === 'no_reply') return 'reply_label';
  // An outcome the user reports, or the user stepping back to "no answer yet".
  return 'outcome_set';
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'invalid_transition', 'This request cannot move to that state', `A request that is ${from} cannot become ${to}.`);
  }
}
