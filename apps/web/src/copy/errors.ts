import type { ProblemCode } from '@erase/contracts';
import { isApiError, type ApiError } from '@erase/api-client';

type Known = ProblemCode | 'network_error' | 'unreadable_response';

/**
 * One message per error code the API can return (plus two client-side ones). The `Record` type makes this list
 * exhaustive: adding a code to the contract fails the build until a message is written for it. Wording follows
 * PRD 4.4: no promise about what a company will do, and nothing about private text.
 */
export const ERROR_MESSAGES: Record<Known, string> = {
  validation_failed: 'Something in that request was not valid. Check what you entered and try again.',
  malformed_request: 'That request could not be read. Reload the page and try again.',
  idempotency_key_required: 'That action could not be completed safely. Reload the page and try again.',
  idempotency_key_invalid: 'That action could not be completed safely. Reload the page and try again.',
  idempotency_key_reuse: 'That action could not be completed safely. Reload the page and try again.',
  unauthorized: 'Sign in to continue.',
  forbidden: 'That was blocked as a safety check. Reload the page and try again.',
  not_found: 'We could not find that. It may have been removed.',
  inbox_limit: 'You can connect up to 5 inboxes.',
  inbox_not_connected: 'That inbox is not connected. Reconnect it to continue.',
  already_sent: 'This request was already sent.',
  approval_required: 'Review the draft and approve it before sending. Nothing is sent without your approval.',
  draft_changed: 'The draft changed since you read it. Review the latest version before approving.',
  fictional_company: 'This is a sample company, so it cannot be sent for real.',
  invalid_transition: 'This request cannot move to that step. Reload to see where it is.',
  request_not_closable: 'This request has already been sent, so it cannot be closed here.',
  request_not_editable: 'This request can no longer be edited.',
  send_in_progress: 'A send for this request is already running, or its result is not known. Check the Sent folder in Gmail before trying again.',
  company_excluded: 'You marked this company as not yours, so no request can be made for it.',
  must_keep: 'This company is needed to keep your account working, so Erase.me does not offer a deletion request for it.',
  kept: 'You chose to keep this company, so no request is made for it. Turn off “Keep this” to continue.',
  no_contact: 'We do not have a verified contact for this company yet, so this request is blocked. Nothing is sent without one.',
  contact_bounced: 'The contact we have for this company did not accept earlier mail, so this request is blocked until it is checked.',
  contact_changed: 'The contact for this company changed after the draft was made. Close this request and create a new one.',
  use_form: 'This company takes requests through a web form, so it cannot be sent by email. Copy the draft and submit it in the form.',
  draft_integrity: 'This draft does not match its saved fingerprint. Close this request and create a new one.',
  draft_unsafe: 'The text looks like it contains an ID number or an unfinished placeholder, so it cannot be used yet. Edit it and try again.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  daily_cap_reached: 'You have reached today’s limit for sent requests. Try again tomorrow.',
  internal_error: 'Something went wrong on our side. Try again in a moment.',
  send_failed: 'Gmail did not accept the message, so nothing was sent. You can try again.',
  send_outcome_unknown:
    'We could not confirm whether the message was sent. Check the Sent folder in Gmail before doing anything else. Erase.me has not marked this request as sent and does not retry it on its own.',
  auth_not_configured: 'Sign-in is not set up in this environment.',
  encryption_not_configured: 'Connecting an inbox is not set up in this environment.',
  send_disabled: 'Sending is switched off in this environment. You can still edit and approve drafts.',
  real_send_blocked: 'Real sending is off until the request wording has been verified. You can still edit and approve drafts.',
  not_ready: 'The service is starting up. Try again in a moment.',
  network_error: 'Could not reach Erase.me. Check your connection and try again.',
  unreadable_response: 'Something unexpected came back. Try again in a moment.',
};

/** What to show for any failure. Never shows a server-supplied sentence: only the messages above. */
export function describeError(error: unknown): { code: string; message: string } {
  if (isApiError(error)) {
    const known = (ERROR_MESSAGES as Record<string, string>)[error.code];
    return { code: error.code, message: known ?? ERROR_MESSAGES.unreadable_response };
  }
  return { code: 'network_error', message: ERROR_MESSAGES.network_error };
}

export const errorCodeOf = (error: unknown): string | undefined => (isApiError(error) ? (error as ApiError).code : undefined);

/** Why a sign-in or inbox connection came back with `?auth_error=`. */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled. You can try again when you are ready.',
  invalid_state: 'That sign-in link expired or came from another browser. Try again.',
  exchange_failed: 'Google did not accept the sign-in. Try again.',
  scopes_missing: 'Erase.me needs both Gmail permissions to scan and, later, to send an approved request. Try again and keep both ticked.',
  no_refresh_token: 'Google did not allow ongoing access. Remove Erase.me at myaccount.google.com/permissions, then connect again.',
  inbox_limit: 'You can connect up to 5 inboxes.',
  account_unavailable: 'This account is being closed, so it cannot sign in.',
};

export const authErrorMessage = (reason: string): string => AUTH_ERROR_MESSAGES[reason] ?? 'Sign-in did not complete. Try again.';
