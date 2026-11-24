import { pgEnum } from 'drizzle-orm/pg-core';

export const USER_STATUSES = ['active', 'suspended', 'deleting'] as const;
export const INBOX_STATUSES = ['connected', 'disconnected', 'error'] as const;
export const SCAN_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export const COMPANY_CATEGORIES = [
  'loan_app',
  'wallet_payments',
  'broker_investing',
  'credit',
  'ecommerce',
  'travel',
  'streaming',
  'education',
  'social',
  'saas',
  'account_provider',
  'games',
  'other',
] as const;
export const GRIEVANCE_STATUSES = ['unknown', 'verified', 'bounced'] as const;
export const USER_COMPANY_STATUSES = ['active', 'not_mine', 'requested'] as const;
export const RISK_LEVELS = ['high', 'medium', 'low', 'must_keep'] as const;

/**
 * PRD F7 state machine: drafted -> approved -> sent -> reply_received -> (replied_*) -> closed, with no_reply when nothing
 * has arrived by the follow-up day, plus bounced. `reply_received` is found by the system from message headers. The
 * `replied_*` states are the outcome the user reports; they are never inferred.
 */
export const REQUEST_STATUSES = [
  'drafted',
  'approved',
  'sent',
  'reply_received',
  'replied_deleted',
  'replied_info_requested',
  'replied_refused',
  'no_reply',
  'closed',
  'bounced',
] as const;
export const DRAFT_AUTHORS = ['template', 'ai', 'user'] as const;
export const REQUEST_EVENT_TYPES = [
  'drafted',
  'edited',
  'approved',
  'sent',
  'bounced',
  'reply_label',
  'followup_drafted',
  'closed',
  // Phase 2
  'reply_received',
  'outcome_set',
  'followup_approved',
  'followup_sent',
  'submitted',
] as const;
export const ACTOR_TYPES = ['user', 'system', 'admin'] as const;
export const REPLY_LABELS = ['deleted', 'info_requested', 'refused', 'other'] as const;
export const REPLY_LABEL_SOURCES = ['model', 'admin'] as const;
/** Whether a reply came from an address at the company's own domain, another domain, or could not be compared. */
export const REPLY_SENDER_MATCHES = ['company', 'other', 'unknown'] as const;
/** How a request reached the company: sent by email from the person's Gmail, or copied into the company's web form. */
export const REQUEST_CHANNELS = ['email', 'web_form'] as const;
/** A follow-up: drafted, approved, then sent by email or (for a web form) marked as submitted by the person. */
export const FOLLOWUP_STATUSES = ['drafted', 'approved', 'sent', 'submitted', 'cancelled'] as const;

export const userStatus = pgEnum('user_status', USER_STATUSES);
export const inboxStatus = pgEnum('inbox_status', INBOX_STATUSES);
export const scanStatus = pgEnum('scan_status', SCAN_STATUSES);
export const companyCategory = pgEnum('company_category', COMPANY_CATEGORIES);
export const grievanceStatus = pgEnum('grievance_status', GRIEVANCE_STATUSES);
export const userCompanyStatus = pgEnum('user_company_status', USER_COMPANY_STATUSES);
export const riskLevel = pgEnum('risk_level', RISK_LEVELS);
export const requestStatus = pgEnum('request_status', REQUEST_STATUSES);
export const draftAuthor = pgEnum('draft_author', DRAFT_AUTHORS);
export const requestEventType = pgEnum('request_event_type', REQUEST_EVENT_TYPES);
export const actorType = pgEnum('actor_type', ACTOR_TYPES);
export const replyLabel = pgEnum('reply_label', REPLY_LABELS);
export const replyLabelSource = pgEnum('reply_label_source', REPLY_LABEL_SOURCES);
export const replySenderMatch = pgEnum('reply_sender_match', REPLY_SENDER_MATCHES);
export const requestChannel = pgEnum('request_channel', REQUEST_CHANNELS);
export const followupStatus = pgEnum('followup_status', FOLLOWUP_STATUSES);
