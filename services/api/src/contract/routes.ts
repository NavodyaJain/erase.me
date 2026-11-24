import type { z } from 'zod';
import { ID_PREFIXES, type IdKind } from '../common/ids.js';
import { hashDraft } from '../modules/requests/draft-hash.js';
import { renderDraft } from '../modules/requests/draft-template.js';
import { renderFollowup } from '../modules/requests/followup-template.js';
import {
  AccountDeletion,
  ApproveBody,
  CallbackQuery,
  CompanyList,
  CompanyParams,
  CompanyResponse,
  ConnectStart,
  CreateDraftsBody,
  CreateDraftsResponse,
  EditDraftBody,
  FollowupSendResponse,
  InboxDisconnected,
  InboxList,
  InboxParams,
  Me,
  OutcomeBody,
  RequestList,
  RequestParams,
  RequestView,
  ScanResponse,
  SendHeaders,
  SendResponse,
  SubmittedBody,
  type ProblemCode,
} from './schemas.js';

/**
 * Every `/v1` operation, in one place: the OpenAPI document is generated from this table, and a test fails if a
 * Fastify route is missing here or listed here but not served. All example values are fictional: a made-up company,
 * example.com addresses, and no real person, token or message.
 */

export interface ProblemDoc {
  code: ProblemCode;
  title: string;
  detail: string;
  /** Extra fields this code carries (for example `formUrl`). */
  extra?: Record<string, unknown>;
}

export interface ResponseDoc {
  description: string;
  schema?: z.ZodType;
  example?: unknown;
  /** A browser redirect: documents the `Location` and `Set-Cookie` headers. */
  redirect?: boolean;
  problems?: ProblemDoc[];
}

export interface OperationDoc {
  operationId: string;
  method: 'get' | 'put' | 'post' | 'patch' | 'delete';
  /** Fastify style: `/v1/requests/:id/send`. */
  path: string;
  tag: 'Auth' | 'Account' | 'Inboxes' | 'Companies' | 'Requests';
  summary: string;
  description?: string;
  /** Needs the session cookie. State-changing calls also need the CSRF header. */
  auth: boolean;
  /** Works while the person's deletion is pending. Every other signed-in route answers 403 `deletion_pending` then. */
  allowsPendingDeletion?: boolean;
  /** The auth start and callback routes are rate limited per client. */
  rateLimited?: boolean;
  params?: z.ZodObject;
  query?: z.ZodObject;
  headers?: z.ZodObject;
  body?: z.ZodType;
  bodyExample?: unknown;
  responses: Record<number, ResponseDoc>;
}

// ---------- fictional example data ----------

const ULID = '01J8Z3K9M2Q7R6T5V4W3X2Y1Z';
export const exId = (kind: IdKind, n = 'A'): string => `${ID_PREFIXES[kind]}_${ULID}${n}`;
const T0 = '2026-11-20T09:30:00.000Z';

const deletionExample = {
  status: 'deleting',
  requestedAt: T0,
  deleteAfter: '2026-11-27T09:30:00.000Z',
  canUndo: true,
  paused: true,
  googleAccess: { notRevoked: 0, message: null },
  gmailCopies: 'Copies of the requests you sent stay in your own Gmail. Erase.me does not delete them.',
  notice: 'Your data will be removed after the undo period. Reply checks, follow-ups and sending are paused until then.',
};
const T1 = '2026-11-22T10:00:00.000Z';
const DUE = '2026-12-22T10:00:00.000Z';
const FORM = 'https://example.com/privacy/request';
const SELF_SERVE = 'https://example.com/account/delete';

const draftText = renderDraft({ userName: 'Asha Rao', userEmail: 'asha@example.com', companyName: 'Sample Shop', signals: ['welcome', 'receipt'] });
const DRAFT_HASH = hashDraft({ to: 'grievance@example.com', subject: draftText.subject, body: draftText.body });
const OTHER_HASH = 'cd'.repeat(32);

const companyExample = {
  id: exId('userCompany'),
  company: 'Sample Shop',
  domain: 'sampleshop.example',
  firstSeen: '2025-01-11',
  lastSeen: '2026-11-18',
  signals: ['receipt', 'welcome'],
  confidence: 'high',
  mustKeep: false,
  category: 'ecommerce',
  selfServeUrl: SELF_SERVE,
  kept: false,
  activity: 'looks_in_use',
  openRequest: null,
};

const requestViewExample = {
  request: { id: exId('request'), status: 'drafted', channel: 'email', createdAt: T1, updatedAt: T1, sentAt: null, dueAt: null },
  company: { id: exId('company'), name: 'Sample Shop', mustKeep: false, kept: false, selfServeUrl: SELF_SERVE },
  contact: { channel: 'email', formUrl: null },
  useForm: false,
  draft: {
    version: 1,
    to: 'grievance@example.com',
    subject: draftText.subject,
    body: draftText.body,
    hash: DRAFT_HASH,
    createdBy: 'template',
    createdAt: T1,
  },
  approved: false,
  events: [{ type: 'drafted', actor: 'system', at: T1, payload: { version: 1, createdBy: 'template' } }],
  canSend: false,
  blockers: [
    {
      code: 'draft_unsafe',
      message: 'The text still has an [OPEN] placeholder. Replace it with the wording you want to send, or remove the line.',
      findings: ['open_placeholder'],
    },
  ],
  replies: { count: 0, automaticCount: 0, firstAt: null, lastAt: null, senderMatch: null },
  outcome: null,
  canSetOutcome: false,
  canMarkSubmitted: false,
  followup: { state: 'none', dueAt: null, remaining: 1, sequence: null, sentAt: null, draft: null, approved: false, canCreate: false, canSend: false, canMarkSubmitted: false, blockers: [] },
};

/** A request that was sent and is waiting for an answer. */
const sentViewExample = {
  ...requestViewExample,
  request: { ...requestViewExample.request, status: 'sent', sentAt: T1, dueAt: T1 },
  approved: true,
  blockers: [],
  events: [
    ...requestViewExample.events,
    { type: 'approved', actor: 'user', at: T1, payload: { version: 1 } },
    { type: 'sent', actor: 'user', at: T1, payload: { version: 1, delivery: 'fake' } },
  ],
  outcome: { value: 'no_answer_yet', setByUser: false, at: null },
  canSetOutcome: true,
};

/** A request with no reply by the follow-up day, with its follow-up drafted. */
const followupText = renderFollowup({ userName: 'Asha Rao', userEmail: 'asha.rao@example.com', companyName: 'Sample Shop', signals: ['welcome', 'receipt'], sentAt: new Date(T1) });
const followupDraftExample = { version: 1, to: 'grievance@example.com', subject: followupText.subject, body: followupText.body, hash: OTHER_HASH, createdBy: 'template', createdAt: T1 };
const followupViewExample = {
  ...sentViewExample,
  request: { ...sentViewExample.request, status: 'no_reply' },
  followup: {
    state: 'drafted',
    dueAt: T1,
    remaining: 0,
    sequence: 1,
    sentAt: null,
    draft: followupDraftExample,
    approved: false,
    canCreate: false,
    canSend: false,
    canMarkSubmitted: false,
    blockers: [{ code: 'draft_unsafe', message: 'The text still has an [OPEN] placeholder. Replace it with the wording you want to send, or remove the line.', findings: ['open_placeholder'] }],
  },
};

// ---------- problem examples used by several operations ----------

const prob = (code: ProblemCode, title: string, detail: string, extra?: Record<string, unknown>): ProblemDoc => ({ code, title, detail, ...(extra ? { extra } : {}) });

const NOT_FOUND = prob('not_found', 'Not found', 'No such resource for this user. Another user’s resource looks the same.');

const MUST_KEEP = prob('must_keep', 'No deletion request is offered for this company', 'Sample Account Provider is needed to keep your account working, so Erase.me does not offer a deletion request for it. If you stop using it, you can close the account with the company directly.');
const KEPT = prob('kept', 'You chose to keep this company', 'You chose to keep Sample Shop, so Erase.me makes no request for it. Undo "keep" to continue.');
const NO_CONTACT = prob('no_contact', 'No verified contact for this company', 'We do not have a verified grievance contact for Sample Bank yet, so this request is blocked. We have noted it so the contact can be found. Nothing is sent without one.');
const USE_FORM = prob('use_form', 'Use the company’s web form', 'Sample Forms Co takes requests through a web form, so Erase.me cannot send this by email. Copy the draft into the form. It is shown here for that.', { formUrl: FORM, selfServeUrl: SELF_SERVE });
const DRAFT_UNSAFE = prob('draft_unsafe', 'The draft cannot be used yet', 'The text looks like it contains a PAN-like number. Erase.me does not put ID numbers in requests. Remove it and try again.', { findings: ['pan'] });
const DRAFT_CHANGED = prob('draft_changed', 'The draft changed', 'The text you approved is not the latest version. Review it again.');

/** Why a follow-up cannot be made or sent for this company: the first request's rules, run again. */
const FOLLOWUP_GUARDS = [
  MUST_KEEP,
  KEPT,
  NO_CONTACT,
  prob('company_excluded', 'Company excluded', 'You marked this company as not yours, so no request can be made for it.'),
  prob('contact_bounced', 'No verified contact for this company', 'The contact we have for this company did not accept earlier mail, so this request is blocked until it is checked.'),
  prob('contact_changed', 'The request cannot move forward', 'The grievance contact for Sample Shop changed since the first message was sent. A follow-up would not reach the same place.'),
  prob('draft_integrity', 'The request cannot move forward', 'This draft does not match its saved fingerprint. Close this follow-up and start again.'),
];
const NO_FOLLOWUP_NEEDED = prob('invalid_transition', 'No follow-up is needed', 'A reply has arrived on this request, so no follow-up is sent. Open it in Gmail to read it, then report what it says.');
const ALREADY_SENT_FOLLOWUP = prob('already_sent', 'Already sent', 'This follow-up was already sent.');

// ---------- operations ----------

export const operations: OperationDoc[] = [
  // ----- auth -----
  {
    operationId: 'startSignIn',
    method: 'get',
    path: '/v1/auth/google/start',
    tag: 'Auth',
    summary: 'Start Google sign-in',
    description:
      'Redirects the browser to Google (scopes `openid email profile`, PKCE, a one-time state). Sets a short-lived `erase_oauth_state` cookie that the callback checks. Sign-in only identifies the user: connecting an inbox is a separate consent.',
    auth: false,
    rateLimited: true,
    responses: {
      302: { description: 'Redirect to Google', redirect: true },
      503: { description: 'Google sign-in is not configured', problems: [prob('auth_not_configured', 'Google sign-in is not configured', 'Sign-in is switched off in this environment.')] },
    },
  },
  {
    operationId: 'finishGoogleAuth',
    method: 'get',
    path: '/v1/auth/google/callback',
    tag: 'Auth',
    summary: 'Google redirects back here',
    description:
      'The one callback registered with Google, for both sign-in and inbox connect (told apart by server-side state). Always answers with a redirect to the web app: on success to the app, on failure to `/?auth_error=<reason>` (reasons: `access_denied`, `invalid_state`, `exchange_failed`, `scopes_missing`, `no_refresh_token`, `inbox_limit`, `account_unavailable`) and, after connecting an inbox, `/?inbox=connected`. A successful sign-in sets the `erase_session` cookie.',
    auth: false,
    rateLimited: true,
    query: CallbackQuery,
    responses: {
      302: { description: 'Redirect to the web app', redirect: true },
      503: { description: 'Token encryption is not configured (inbox connect only)', problems: [prob('encryption_not_configured', 'Token encryption is not configured', 'Inboxes cannot be connected in this environment.')] },
    },
  },
  {
    operationId: 'logout',
    method: 'post',
    path: '/v1/auth/logout',
    tag: 'Auth',
    summary: 'Sign out',
    description: 'Revokes the session on the server and clears the cookie.',
    auth: true,
    responses: { 204: { description: 'Signed out' } },
  },
  // ----- account -----
  {
    operationId: 'getMe',
    method: 'get',
    path: '/v1/me',
    tag: 'Account',
    summary: 'The signed-in user, and the CSRF token',
    description: 'Call this after sign-in and keep `csrfToken`: every state-changing call must send it in `x-csrf-token`.',
    auth: true,
    responses: { 200: { description: 'The user', schema: Me, example: { id: exId('user'), email: 'asha@example.com', name: 'Asha Rao', csrfToken: 'example-csrf-token-not-a-real-token' } } },
  },
  {
    operationId: 'deleteMe',
    method: 'delete',
    path: '/v1/me',
    tag: 'Account',
    summary: 'Ask to delete the account',
    description:
      'Starts the undo period (7 days by default). Gmail access is asked to be revoked for every inbox now, and reply checks, follow-ups and sending stop for this person. After the undo period the personal data is deleted and only a tombstone with no personal data stays. `POST /v1/me/deletion/undo` cancels it; `POST /v1/me/deletion/now` skips the wait. The copies of sent requests in the person’s own Gmail are not touched. Asking again keeps the first end date.',
    auth: true,
    allowsPendingDeletion: true,
    responses: { 202: { description: 'Deletion asked for', schema: AccountDeletion, example: deletionExample } },
  },
  {
    operationId: 'getDeletion',
    method: 'get',
    path: '/v1/me/deletion',
    tag: 'Account',
    summary: 'Where deletion stands',
    description: 'For the “Your data” screen. While deletion is pending it says when the data is deleted, that sending and checking are paused, and whether the person must remove Google access themselves.',
    auth: true,
    allowsPendingDeletion: true,
    responses: { 200: { description: 'The state of deletion', schema: AccountDeletion, example: deletionExample } },
  },
  {
    operationId: 'undoDeletion',
    method: 'post',
    path: '/v1/me/deletion/undo',
    tag: 'Account',
    summary: 'Undo the deletion',
    description:
      'Only inside the undo period. Everything the person had is still there. Their Gmail inboxes were disconnected when deletion was asked for, so they connect them again to scan or follow up.',
    auth: true,
    allowsPendingDeletion: true,
    responses: {
      200: { description: 'Deletion cancelled', schema: AccountDeletion, example: { ...deletionExample, status: 'active', requestedAt: null, deleteAfter: null, canUndo: false, paused: false } },
      409: {
        description: 'Nothing to undo, or the undo period is over',
        problems: [
          prob('not_pending_deletion', 'No deletion is pending', 'There is nothing to undo.'),
          prob('undo_window_closed', 'The undo period is over', 'The data is being or has been deleted, so it can no longer be undone.'),
        ],
      },
    },
  },
  {
    operationId: 'deleteNow',
    method: 'post',
    path: '/v1/me/deletion/now',
    tag: 'Account',
    summary: 'Delete now',
    description:
      'Skips the undo period. Works whether or not deletion was asked for before. The personal data is deleted at once (a very large account may take a few runs, then `status` is `deleting` with `canUndo` false). Every session ends and the session cookie is cleared. The copies of sent requests in the person’s own Gmail are not touched.',
    auth: true,
    allowsPendingDeletion: true,
    responses: { 200: { description: 'Deleted, or being deleted', schema: AccountDeletion, example: { ...deletionExample, status: 'deleted', canUndo: false, deleteAfter: T0 } } },
  },
  // ----- inboxes and scans -----
  {
    operationId: 'listInboxes',
    method: 'get',
    path: '/v1/inboxes',
    tag: 'Inboxes',
    summary: 'The user’s inboxes',
    auth: true,
    responses: {
      200: {
        description: 'Inboxes, oldest first',
        schema: InboxList,
        example: { inboxes: [{ id: exId('inbox'), email: 'asha.mail@example.com', status: 'connected', connectedAt: T0, lastScanAt: T1 }] },
      },
    },
  },
  {
    operationId: 'startInboxConnect',
    method: 'post',
    path: '/v1/inboxes/connect/start',
    tag: 'Inboxes',
    summary: 'Start connecting an inbox',
    description:
      'Show the "what we read, what we keep, what we never do" panel first, then call this and send the browser to `authorizationUrl`. Asks Google for Gmail read-only (header metadata for the scan) and send (used only after the user approves a request). Sets the `erase_oauth_state` cookie. Up to 5 inboxes per user.',
    auth: true,
    responses: {
      200: { description: 'Where to send the browser', schema: ConnectStart, example: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=example&state=example' } },
      409: { description: 'Inbox limit reached', problems: [prob('inbox_limit', 'Inbox limit reached', 'You can connect up to 5 inboxes.')] },
    },
  },
  {
    operationId: 'disconnectInbox',
    method: 'delete',
    path: '/v1/inboxes/:id',
    tag: 'Inboxes',
    summary: 'Disconnect an inbox',
    description: 'Revokes the Google token, drops the stored token, stops scans and starts the 30-day retention clock.',
    auth: true,
    params: InboxParams,
    responses: { 200: { description: 'Disconnected', schema: InboxDisconnected, example: { status: 'disconnected', revokedAtGoogle: true } }, 404: { description: 'No such inbox', problems: [NOT_FOUND] } },
  },
  {
    operationId: 'startScan',
    method: 'post',
    path: '/v1/inboxes/:id/scan',
    tag: 'Inboxes',
    summary: 'Scan an inbox for companies',
    description:
      'Reads message headers only (never bodies) in the background. Idempotent: while a scan is active, the same call returns it (200) instead of starting another (202). Poll `GET /v1/inboxes/{id}/scan` for progress.',
    auth: true,
    params: InboxParams,
    responses: {
      200: { description: 'A scan is already running', schema: ScanResponse, example: { scan: { id: exId('scan'), inboxId: exId('inbox'), status: 'running', progressPct: 40, foundCount: 12, startedAt: T1, finishedAt: null, errorCode: null } } },
      202: { description: 'Scan started', schema: ScanResponse, example: { scan: { id: exId('scan'), inboxId: exId('inbox'), status: 'queued', progressPct: 0, foundCount: 0, startedAt: null, finishedAt: null, errorCode: null } } },
      404: { description: 'No such inbox', problems: [NOT_FOUND] },
      409: { description: 'The inbox is not connected', problems: [prob('inbox_not_connected', 'Inbox is not connected', 'Reconnect this inbox to scan it.')] },
    },
  },
  {
    operationId: 'getScan',
    method: 'get',
    path: '/v1/inboxes/:id/scan',
    tag: 'Inboxes',
    summary: 'The latest scan of an inbox',
    auth: true,
    params: InboxParams,
    responses: {
      200: { description: 'The latest scan', schema: ScanResponse, example: { scan: { id: exId('scan'), inboxId: exId('inbox'), status: 'done', progressPct: 100, foundCount: 28, startedAt: T0, finishedAt: T1, errorCode: null } } },
      404: { description: 'No such inbox, or no scan yet', problems: [NOT_FOUND] },
    },
  },
  // ----- companies -----
  {
    operationId: 'listCompanies',
    method: 'get',
    path: '/v1/companies',
    tag: 'Companies',
    summary: 'Companies that may hold the user’s data',
    description:
      'The user’s detected companies, as shown to them: sending services, mailbox providers, the user’s own and employer domains, and companies marked "not mine" are left out. Every result is a hint from header metadata (company, dates and signal names), never a statement of fact. No pagination yet.',
    auth: true,
    responses: { 200: { description: 'Detected companies, likely ones first', schema: CompanyList, example: { companies: [companyExample] } } },
  },
  {
    operationId: 'keepCompany',
    method: 'put',
    path: '/v1/companies/:id/keep',
    tag: 'Companies',
    summary: 'Keep this company',
    description:
      'Marks a company as one the user wants to keep. No request is offered for it: creating one answers outcome `kept`, and a drafted or approved request is refused at approve and send (409 `kept`) until this is cleared. Editing and closing still work, and a request already sent is unaffected. Idempotent.',
    auth: true,
    params: CompanyParams,
    responses: {
      200: { description: 'Kept', schema: CompanyResponse, example: { company: { ...companyExample, kept: true } } },
      404: { description: 'No such company for this user', problems: [NOT_FOUND] },
      409: {
        description: 'Keeping makes no sense for this company',
        problems: [
          prob('must_keep', 'Already kept', 'This company is needed to keep your account working, so it is already kept: no deletion request is offered for it.'),
          prob('company_excluded', 'Company excluded', 'You marked this company as not yours, so there is nothing to keep.'),
        ],
      },
    },
  },
  {
    operationId: 'unkeepCompany',
    method: 'delete',
    path: '/v1/companies/:id/keep',
    tag: 'Companies',
    summary: 'Undo "keep this"',
    description: 'Clears the flag, so requests can be made for the company again and a refused request can go on. Idempotent.',
    auth: true,
    params: CompanyParams,
    responses: {
      200: { description: 'No longer kept', schema: CompanyResponse, example: { company: companyExample } },
      404: { description: 'No such company for this user', problems: [NOT_FOUND] },
      409: {
        description: 'Not applicable to this company',
        problems: [
          prob('must_keep', 'Already kept', 'This company is needed to keep your account working, so it is already kept: no deletion request is offered for it.'),
          prob('company_excluded', 'Company excluded', 'You marked this company as not yours, so there is nothing to keep.'),
        ],
      },
    },
  },
  // ----- requests -----
  {
    operationId: 'createRequestDrafts',
    method: 'post',
    path: '/v1/requests/drafts',
    tag: 'Requests',
    summary: 'Draft requests for companies',
    description:
      'Makes a draft request for each company, from a fixed template. Always 200: each company has its own outcome. `created` and `existing` are email requests; `use_form` is a web-form company (the draft is for copy and paste, with `formUrl`); `kept` means the user chose to keep it; `blocked` has a `reason` (`must_keep`, `no_contact`, `company_excluded`, `not_found`...). Nothing is sent and no deletion is promised: a draft is a polite request.',
    auth: true,
    body: CreateDraftsBody,
    bodyExample: { userCompanyIds: [exId('userCompany'), exId('userCompany', 'B'), exId('userCompany', 'C')] },
    responses: {
      200: {
        description: 'One outcome per company',
        schema: CreateDraftsResponse,
        example: {
          results: [
            { userCompanyId: exId('userCompany'), outcome: 'created', requestId: exId('request'), selfServeUrl: SELF_SERVE },
            { userCompanyId: exId('userCompany', 'B'), outcome: 'use_form', requestId: exId('request', 'B'), formUrl: FORM, message: USE_FORM.detail },
            { userCompanyId: exId('userCompany', 'C'), outcome: 'kept', message: KEPT.detail },
            { userCompanyId: exId('userCompany', 'D'), outcome: 'blocked', reason: 'must_keep', message: MUST_KEEP.detail },
            { userCompanyId: exId('userCompany', 'E'), outcome: 'blocked', reason: 'no_contact', message: NO_CONTACT.detail },
          ],
        },
      },
    },
  },
  {
    operationId: 'listRequests',
    method: 'get',
    path: '/v1/requests',
    tag: 'Requests',
    summary: 'The user’s requests',
    auth: true,
    responses: {
      200: {
        description: 'Requests, most recently changed first',
        schema: RequestList,
        example: { requests: [{ id: exId('request'), status: 'drafted', company: { name: 'Sample Shop', mustKeep: false }, channel: 'email', outcome: null, createdAt: T1, updatedAt: T1, sentAt: null, dueAt: null }] },
      },
    },
  },
  {
    operationId: 'getRequest',
    method: 'get',
    path: '/v1/requests/:id',
    tag: 'Requests',
    summary: 'A request with its current draft',
    description: 'Includes the draft the user would approve, the event history, whether it can be sent, and everything blocking it.',
    auth: true,
    params: RequestParams,
    responses: { 200: { description: 'The request', schema: RequestView, example: requestViewExample }, 404: { description: 'No such request for this user', problems: [NOT_FOUND] } },
  },
  {
    operationId: 'editRequestDraft',
    method: 'patch',
    path: '/v1/requests/:id/draft',
    tag: 'Requests',
    summary: 'Edit the draft',
    description:
      'Creates a new draft version with a new hash and puts an approved request back to `drafted`: the earlier approval no longer counts. The recipient cannot be edited. Text containing an ID-like number is refused and not stored. Refused while a send is running or after it was sent.',
    auth: true,
    params: RequestParams,
    body: EditDraftBody,
    bodyExample: { baseHash: DRAFT_HASH, subject: draftText.subject, body: 'I would like to ask Sample Shop to erase the personal data it holds about me.' },
    responses: {
      200: { description: 'The request with its new draft version', schema: RequestView, example: { ...requestViewExample, draft: { ...requestViewExample.draft, version: 2, hash: OTHER_HASH, createdBy: 'user' } } },
      404: { description: 'No such request for this user', problems: [NOT_FOUND] },
      409: {
        description: 'The draft cannot be edited now',
        problems: [
          DRAFT_CHANGED,
          prob('request_not_editable', 'This request can no longer be edited', 'A request that is sent cannot be edited.'),
          prob('send_in_progress', 'This request is being sent', 'It cannot be edited while it is being sent or after it was sent.'),
        ],
      },
      422: { description: 'The text looks like it contains an ID number', problems: [DRAFT_UNSAFE] },
    },
  },
  {
    operationId: 'approveRequest',
    method: 'post',
    path: '/v1/requests/:id/approve',
    tag: 'Requests',
    summary: 'Approve the draft',
    description:
      'Records the user’s approval of exactly the draft version they were shown (`draftHash`). The guards run again: a must-keep or kept company, a missing contact, a web-form company, an ID-like number or an unresolved [OPEN] placeholder all refuse it.',
    auth: true,
    params: RequestParams,
    body: ApproveBody,
    bodyExample: { draftHash: DRAFT_HASH },
    responses: {
      200: { description: 'Approved (or already approved)', schema: RequestView, example: { ...requestViewExample, request: { ...requestViewExample.request, status: 'approved' }, approved: true, canSend: true, blockers: [] } },
      404: { description: 'No such request for this user', problems: [NOT_FOUND] },
      409: { description: 'Not approvable now', problems: [DRAFT_CHANGED, MUST_KEEP, KEPT, NO_CONTACT, USE_FORM, prob('invalid_transition', 'This request cannot move to that state', 'A request that is closed cannot become approved.')] },
      422: { description: 'The draft cannot be used yet', problems: [DRAFT_UNSAFE] },
    },
  },
  {
    operationId: 'closeRequest',
    method: 'post',
    path: '/v1/requests/:id/close',
    tag: 'Requests',
    summary: 'Close a request before it is sent',
    description: 'Discards a drafted or approved request and frees the company for a new one.',
    auth: true,
    params: RequestParams,
    responses: {
      200: { description: 'Closed', schema: RequestView, example: { ...requestViewExample, request: { ...requestViewExample.request, status: 'closed' } } },
      404: { description: 'No such request for this user', problems: [NOT_FOUND] },
      409: { description: 'Cannot be closed now', problems: [prob('request_not_closable', 'This request cannot be closed here', 'A request that is sent cannot be closed before sending.'), prob('send_in_progress', 'This request is being sent', 'It cannot be closed while it is being sent.')] },
    },
  },
  {
    operationId: 'setRequestOutcome',
    method: 'put',
    path: '/v1/requests/:id/outcome',
    tag: 'Requests',
    summary: 'Report what the company answered',
    description:
      'The person reports the outcome: `confirmed_erased`, `refused`, `needs_more_info`, or `no_answer_yet` to take a report back. Erase.me never infers it, not from a reply it found and not from who sent it, and it always shows as "Reported by you", never as a verified fact. It can be set whether or not a reply was detected (the answer may have come by phone or through the form), and changed later. `no_answer_yet` returns the request to `sent`, or to `no_reply` once the follow-up day has passed. Saying the same thing again changes nothing. Only a sent request has an outcome: a draft, a closed or a bounced request answers 409 `invalid_transition`.',
    auth: true,
    params: RequestParams,
    body: OutcomeBody,
    bodyExample: { outcome: 'refused' },
    responses: {
      200: {
        description: 'The request with the reported outcome',
        schema: RequestView,
        example: {
          ...sentViewExample,
          request: { ...sentViewExample.request, status: 'replied_refused' },
          events: [...sentViewExample.events, { type: 'outcome_set', actor: 'user', at: T1, payload: { from: 'sent', to: 'replied_refused', outcome: 'refused' } }],
          outcome: { value: 'refused', setByUser: true, at: T1 },
        },
      },
      404: { description: 'No such request for this user', problems: [NOT_FOUND] },
      409: {
        description: 'There is no outcome to report for this request yet',
        problems: [prob('invalid_transition', 'There is no outcome to report yet', 'This request has not been sent yet, so there is nothing to report. Send it, or mark it as submitted if it uses a web form.')],
      },
    },
  },
  {
    operationId: 'markRequestSubmitted',
    method: 'post',
    path: '/v1/requests/:id/submitted',
    tag: 'Requests',
    summary: 'Say the draft was pasted into the company’s web form',
    description:
      'For a company that takes requests through a web form. Nothing is sent from here: the person copied the draft into the form and says so. It is recorded like a send: the person approves the exact draft they copied (`draftHash`), the guards run again (a must-keep or kept company, a verified form contact, ID-like numbers and the unresolved [OPEN] line), and the request becomes `sent` with channel `web_form`, which starts the clock for a reply. There is no Gmail thread to follow, so reply checks do not apply and the person reports the outcome. Saying it again changes nothing. An email company answers 409 `not_a_form_request`.',
    auth: true,
    params: RequestParams,
    body: SubmittedBody,
    bodyExample: { draftHash: DRAFT_HASH },
    responses: {
      200: {
        description: 'The request, now sent (or already marked)',
        schema: RequestView,
        example: {
          ...sentViewExample,
          request: { ...sentViewExample.request, channel: 'web_form' },
          contact: { channel: 'web_form', formUrl: FORM },
          useForm: true,
          draft: { ...sentViewExample.draft, to: FORM },
          events: [...sentViewExample.events.slice(0, 2), { type: 'submitted', actor: 'user', at: T1, payload: { version: 1 } }],
        },
      },
      404: { description: 'No such request for this user', problems: [NOT_FOUND] },
      409: {
        description: 'Cannot be marked as submitted',
        problems: [
          prob('not_a_form_request', 'This company does not use a web form', 'Sample Shop takes requests by email. Review the draft, approve it and send it instead.'),
          DRAFT_CHANGED,
          MUST_KEEP,
          KEPT,
          NO_CONTACT,
          prob('company_excluded', 'Company excluded', 'You marked this company as not yours, so no request can be made for it.'),
          prob('contact_bounced', 'No verified contact for this company', 'The contact we have for this company did not accept earlier mail, so this request is blocked until it is checked.'),
          prob('contact_changed', 'The request cannot move forward', 'The contact for this company changed since this draft was made. Close this request and create a new one.'),
          prob('draft_integrity', 'The request cannot move forward', 'This draft does not match its saved fingerprint. Create a new request.'),
          prob('already_sent', 'Already sent', 'This request was already sent by email.'),
          prob('invalid_transition', 'This request cannot move to that state', 'A request that is closed cannot become approved.'),
        ],
      },
      422: { description: 'The draft cannot be used yet', problems: [DRAFT_UNSAFE] },
    },
  },
  {
    operationId: 'createFollowup',
    method: 'post',
    path: '/v1/requests/:id/followup',
    tag: 'Requests',
    summary: 'Prepare the follow-up to a request with no reply',
    description:
      'Offered once `FOLLOWUP_AFTER_DAYS` (30 by default) have passed since the message was sent, and no reply from a person has arrived. An automatic reply (out of office and similar) does not stop the clock; a reply from a person or an outcome the person reported ends the wait. One follow-up per request (`FOLLOWUP_MAX`). Makes the draft from a fixed, polite template that asks for a reply and claims no deadline was missed; the statute paragraph stays behind the same verified-citation gate as the first message. The request moves from `sent` to `no_reply`. Asking again returns the draft that exists. The guards of the first request run again: a must-keep or kept company, a verified contact that has not changed. Nothing is sent. For a web-form request the follow-up is copy-only.',
    auth: true,
    params: RequestParams,
    responses: {
      200: { description: 'The request, with its follow-up draft', schema: RequestView, example: followupViewExample },
      404: { description: 'No such request for this user', problems: [NOT_FOUND] },
      409: {
        description: 'No follow-up can be prepared now',
        problems: [
          prob('followup_not_due', 'Too early for a follow-up', 'A follow-up is offered 30 days after the last message, on 2026-12-22. Replies can be slow.'),
          prob('followup_limit_reached', 'No more follow-ups for this request', 'A request has at most 1 follow-up, and it has had them.'),
          NO_FOLLOWUP_NEEDED,
          ...FOLLOWUP_GUARDS,
        ],
      },
    },
  },
  {
    operationId: 'editFollowupDraft',
    method: 'patch',
    path: '/v1/requests/:id/followup/draft',
    tag: 'Requests',
    summary: 'Edit the follow-up draft',
    description:
      'Creates a new version of the follow-up draft with a new hash and puts an approved follow-up back to `drafted`: the earlier approval no longer counts. The recipient cannot be edited. Text containing an ID-like number is refused and not stored. If the draft changed since the person saw it (`baseHash` is not the latest) the edit is refused with `draft_changed` and not retried.',
    auth: true,
    params: RequestParams,
    body: EditDraftBody,
    bodyExample: { baseHash: OTHER_HASH, subject: followupText.subject, body: 'I am following up on my email. I would be grateful for a short reply.' },
    responses: {
      200: { description: 'The request with its new follow-up draft version', schema: RequestView, example: followupViewExample },
      404: { description: 'No follow-up for this request for this user', problems: [NOT_FOUND] },
      409: {
        description: 'The follow-up cannot be edited now',
        problems: [
          DRAFT_CHANGED,
          prob('request_not_editable', 'This follow-up can no longer be edited', 'It was already sent.'),
          prob('send_in_progress', 'This follow-up is being sent', 'It cannot be edited while it is being sent.'),
          NO_FOLLOWUP_NEEDED,
        ],
      },
      422: { description: 'The text looks like it contains an ID number', problems: [DRAFT_UNSAFE] },
    },
  },
  {
    operationId: 'approveFollowup',
    method: 'post',
    path: '/v1/requests/:id/followup/approve',
    tag: 'Requests',
    summary: 'Approve the follow-up draft',
    description:
      'Records the person’s approval of exactly the follow-up version they were shown (`draftHash`). A changed draft answers 409 `draft_changed`, and the call is never retried by itself. The guards run again, including the unresolved [OPEN] line. A web-form follow-up is not approved here: it answers 409 `use_form`; copy it and use `/followup/submitted`.',
    auth: true,
    params: RequestParams,
    body: ApproveBody,
    bodyExample: { draftHash: OTHER_HASH },
    responses: {
      200: { description: 'Approved (or already approved)', schema: RequestView, example: { ...followupViewExample, followup: { ...followupViewExample.followup, state: 'approved', approved: true, blockers: [] } } },
      404: { description: 'No follow-up for this request for this user', problems: [NOT_FOUND] },
      409: { description: 'Not approvable now', problems: [DRAFT_CHANGED, USE_FORM, ALREADY_SENT_FOLLOWUP, NO_FOLLOWUP_NEEDED, ...FOLLOWUP_GUARDS] },
      422: { description: 'The draft cannot be used yet', problems: [DRAFT_UNSAFE] },
    },
  },
  {
    operationId: 'markFollowupSubmitted',
    method: 'post',
    path: '/v1/requests/:id/followup/submitted',
    tag: 'Requests',
    summary: 'Say the follow-up was pasted into the company’s web form',
    description:
      'For a web-form request only. Nothing is sent from here: the person copied the follow-up into the form and says so, naming the exact draft they copied (`draftHash`). It is recorded like an approval and a send: the guards run again and the follow-up becomes `submitted`. Saying it again changes nothing. An email request answers 409 `not_a_form_request`.',
    auth: true,
    params: RequestParams,
    body: SubmittedBody,
    bodyExample: { draftHash: OTHER_HASH },
    responses: {
      200: { description: 'The request, with its follow-up marked as submitted (or already marked)', schema: RequestView, example: { ...followupViewExample, followup: { ...followupViewExample.followup, state: 'submitted', sentAt: T1, blockers: [] } } },
      404: { description: 'No follow-up for this request for this user', problems: [NOT_FOUND] },
      409: {
        description: 'Cannot be marked as submitted',
        problems: [
          prob('not_a_form_request', 'This company does not use a web form', 'Sample Shop takes requests by email. Review the follow-up, approve it and send it instead.'),
          DRAFT_CHANGED,
          ALREADY_SENT_FOLLOWUP,
          NO_FOLLOWUP_NEEDED,
          ...FOLLOWUP_GUARDS,
        ],
      },
      422: { description: 'The draft cannot be used yet', problems: [DRAFT_UNSAFE] },
    },
  },
  {
    operationId: 'sendFollowup',
    method: 'post',
    path: '/v1/requests/:id/followup/send',
    tag: 'Requests',
    summary: 'Send an approved follow-up, in the same Gmail conversation',
    description:
      'Needs an `Idempotency-Key`: a repeat with the same key returns the first answer and never sends twice. Needs the person’s approval of the exact current follow-up draft (also enforced in the database), the first request’s guards, and the same real-send gates as the first message. Real sending also stays off until the follow-up wording has been signed off. In development and test the fake sender answers `delivery: "fake"` and nothing leaves the machine. A reply or a reported outcome since the draft was made stops it. An unknown outcome (a timeout) leaves the follow-up unsent and is not retried automatically.',
    auth: true,
    params: RequestParams,
    headers: SendHeaders,
    responses: {
      200: { description: 'Sent (or the stored answer for a repeated key)', schema: FollowupSendResponse, example: { followup: { sequence: 1, status: 'sent', sentAt: T1 }, delivery: 'fake', notice: 'No email was sent. This is a development send to the fake sender.' } },
      404: { description: 'No follow-up for this request for this user', problems: [NOT_FOUND] },
      409: {
        description: 'Not sendable now',
        problems: [
          prob('approval_required', 'Approval needed', 'Review the follow-up and approve it before sending. Nothing is sent without your approval.'),
          USE_FORM,
          ALREADY_SENT_FOLLOWUP,
          prob('send_in_progress', 'This follow-up is being sent', 'A send with this key is already running or its result is unknown. Check the Sent folder in Gmail.'),
          prob('inbox_not_connected', 'Inbox not connected', 'The inbox this company was found in is not connected. Reconnect it to send.'),
          prob('fictional_company', 'Sample company', 'This is a sample company. It cannot be sent for real.'),
          NO_FOLLOWUP_NEEDED,
          ...FOLLOWUP_GUARDS,
        ],
      },
      422: { description: 'Unsafe draft, or a reused key', problems: [DRAFT_UNSAFE, prob('idempotency_key_reuse', 'Idempotency key already used', 'This key was used for a different request. Use a new key.')] },
      429: { description: 'Daily limit reached', problems: [prob('daily_cap_reached', 'Daily limit reached', 'You have reached the daily limit for sent requests. Try again tomorrow.')] },
      502: {
        description: 'The message was not sent, or the outcome is unknown',
        problems: [
          prob('send_failed', 'The message was not sent', 'Gmail did not accept the message, so nothing was sent. You can try again.'),
          prob('send_outcome_unknown', 'We could not confirm the message was sent', 'Check the Sent folder in Gmail before doing anything else. Erase.me has not marked this follow-up as sent and will not retry it on its own.'),
        ],
      },
      503: {
        description: 'Sending is not available',
        problems: [
          prob('real_send_blocked', 'Sending is not available', 'Real sending stays off until the statute citation in the draft template has been verified, and real follow-ups also until their wording has been signed off.'),
          prob('send_disabled', 'Sending is not available', 'Sending is not switched on in this environment.'),
        ],
      },
    },
  },
  {
    operationId: 'sendRequest',
    method: 'post',
    path: '/v1/requests/:id/send',
    tag: 'Requests',
    summary: 'Send an approved request from the user’s Gmail',
    description:
      'Needs an `Idempotency-Key` header: a repeat with the same key returns the first answer and never sends twice. Needs a user approval of the exact current draft (also enforced in the database), a verified contact, a company that is neither must-keep nor kept, and text without ID-like numbers or an [OPEN] placeholder. In development and test the sender is fake and the response says so (`delivery: "fake"`, with a `notice`); real sending stays off until it is explicitly enabled. If Gmail does not confirm, the request is left unsent and the user is told to check the Sent folder: it is never retried automatically (`send_outcome_unknown`).',
    auth: true,
    params: RequestParams,
    headers: SendHeaders,
    responses: {
      200: { description: 'Sent (or the stored answer for a repeated key)', schema: SendResponse, example: { request: { id: exId('request'), status: 'sent', sentAt: T1, dueAt: DUE }, delivery: 'fake', notice: 'No email was sent. This is a development send to the fake sender.' } },
      404: { description: 'No such request for this user', problems: [NOT_FOUND] },
      409: {
        description: 'Not sendable now',
        problems: [
          prob('approval_required', 'Approval needed', 'Review the draft and approve it before sending. Nothing is sent without your approval.'),
          USE_FORM,
          MUST_KEEP,
          KEPT,
          NO_CONTACT,
          prob('already_sent', 'Already sent', 'This request was already sent.'),
          prob('send_in_progress', 'This request is being sent', 'A send with this key is already running or its result is unknown. Check the Sent folder in Gmail.'),
          prob('inbox_not_connected', 'Inbox not connected', 'The inbox this company was found in is not connected. Reconnect it to send.'),
        ],
      },
      422: { description: 'Unsafe draft, or a reused key', problems: [DRAFT_UNSAFE, prob('idempotency_key_reuse', 'Idempotency key already used', 'This key was used for a different request. Use a new key.')] },
      429: { description: 'Daily limit reached', problems: [prob('daily_cap_reached', 'Daily limit reached', 'You have reached the daily limit for sent requests. Try again tomorrow.')] },
      502: {
        description: 'The message was not sent, or the outcome is unknown',
        problems: [
          prob('send_failed', 'The message was not sent', 'Gmail did not accept the message, so nothing was sent. You can try again.'),
          prob('send_outcome_unknown', 'We could not confirm the message was sent', 'Check the Sent folder in Gmail before doing anything else. Erase.me has not marked this request as sent and will not retry it on its own.'),
        ],
      },
      503: {
        description: 'Sending is not available',
        problems: [
          prob('real_send_blocked', 'Sending is not available', 'Real sending stays off until the statute citation in the draft template has been verified.'),
          prob('send_disabled', 'Sending is not available', 'Sending is not switched on in this environment.'),
        ],
      },
    },
  },
];
