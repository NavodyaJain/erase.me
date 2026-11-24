import type { RequestStatus } from './state-machine.js';

/**
 * What the person reports about a request they have sent (PRD F7). Erase.me never works this out itself: a reply we
 * detect only says "a message arrived", and the outcome is set by the person and shown as "Reported by you".
 */
export const OUTCOME_VALUES = ['confirmed_erased', 'refused', 'needs_more_info', 'no_answer_yet'] as const;
export type OutcomeValue = (typeof OUTCOME_VALUES)[number];

/** The three outcomes that are a statement about what the company said. "No answer yet" is the absence of one. */
export type ReportedOutcome = Exclude<OutcomeValue, 'no_answer_yet'>;
export const REPORTED_OUTCOMES: readonly ReportedOutcome[] = ['confirmed_erased', 'refused', 'needs_more_info'];

const STATUS_OF_OUTCOME: Record<ReportedOutcome, RequestStatus> = {
  confirmed_erased: 'replied_deleted',
  refused: 'replied_refused',
  needs_more_info: 'replied_info_requested',
};

const OUTCOME_OF_STATUS: Partial<Record<RequestStatus, ReportedOutcome>> = {
  replied_deleted: 'confirmed_erased',
  replied_refused: 'refused',
  replied_info_requested: 'needs_more_info',
};

/** The states in which a sent request waits for, or has, an answer. Only these can take an outcome. */
export const TRACKING_STATUSES: readonly RequestStatus[] = ['sent', 'reply_received', 'no_reply', 'replied_deleted', 'replied_info_requested', 'replied_refused'];
/** The states that mean "no answer yet", whatever the reason. */
const WAITING_STATUSES: readonly RequestStatus[] = ['sent', 'reply_received', 'no_reply'];

/**
 * The status an outcome puts a request in. "No answer yet" returns it to `sent`, or to `no_reply` once the follow-up day
 * has passed, so a request that is already overdue is not shown as brand new.
 */
export function statusForOutcome(outcome: OutcomeValue, overdue: boolean): RequestStatus {
  return outcome === 'no_answer_yet' ? (overdue ? 'no_reply' : 'sent') : STATUS_OF_OUTCOME[outcome];
}

export const isWaiting = (status: RequestStatus): boolean => WAITING_STATUSES.includes(status);
export const reportedOutcomeOf = (status: RequestStatus): ReportedOutcome | undefined => OUTCOME_OF_STATUS[status];
export const isReportedOutcome = (value: unknown): value is ReportedOutcome => typeof value === 'string' && (REPORTED_OUTCOMES as readonly string[]).includes(value);

/** The answer shown for a request in this status: a reported outcome, "no answer yet" while waiting, or nothing. */
export function outcomeOfStatus(status: RequestStatus): OutcomeValue | null {
  return OUTCOME_OF_STATUS[status] ?? (isWaiting(status) ? 'no_answer_yet' : null);
}
