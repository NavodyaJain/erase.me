import { z } from 'zod';
import { ID_PREFIXES, ULID_PATTERN, type IdKind } from '../common/ids.js';
import { COMPANY_CATEGORIES, INBOX_STATUSES, REPLY_SENDER_MATCHES, REQUEST_CHANNELS, REQUEST_EVENT_TYPES, REQUEST_STATUSES, SCAN_STATUSES } from '../db/schema/enums.js';
import { OUTCOME_VALUES } from '../modules/requests/outcomes.js';

/**
 * The API contract's schemas (backend brief rule 2: schema-first). Request schemas here are the ones the
 * controllers validate with; response schemas describe what the services return and are checked against real
 * responses by the contract tests. The OpenAPI document is generated from these, so a change here is a change to
 * the contract, and CI fails until `pnpm --filter @erase/api openapi:generate` is run.
 *
 * Nothing here is personal data. Examples elsewhere use fictional companies and example.com only.
 */

/** Schemas shared across operations. Each becomes `#/components/schemas/<id>` in the OpenAPI document. */
export const registry = z.registry<{ id: string }>();

function component<T extends z.ZodType>(id: string, schema: T): T {
  registry.add(schema, { id });
  return schema;
}

// ---------- primitives ----------

/** A prefixed ULID, for example `req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA`. */
export const idOf = (kind: IdKind) =>
  z
    .string()
    .regex(new RegExp(`^${ID_PREFIXES[kind]}_${ULID_PATTERN}$`))
    .describe(`Prefixed ULID (\`${ID_PREFIXES[kind]}_\` followed by 26 characters)`);

export const isoDateTime = z.iso.datetime().describe('UTC timestamp, ISO 8601');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Calendar date, YYYY-MM-DD');
export const draftHash = z.string().regex(/^[0-9a-f]{64}$/).describe('sha256 (hex) of the recipient, subject and body of a draft, exactly as shown');
export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/)
  .describe('A client-chosen key, 8 to 128 characters (letters, digits and . _ : -). Reuse the same key to retry the same send.');

export const SIGNALS = ['welcome', 'receipt', 'verify', 'transactional', 'list_unsubscribe', 'newsletter'] as const;
export const SAFETY_FINDINGS = ['aadhaar', 'pan', 'passport', 'voter_id', 'gstin', 'card', 'open_placeholder'] as const;

/** Reasons a request cannot move forward. Returned as `blockers` on a request and as the `code` of a refusal. */
export const BLOCKER_CODES = [
  'company_excluded',
  'must_keep',
  'kept',
  'no_contact',
  'contact_bounced',
  'contact_changed',
  'use_form',
  'draft_integrity',
  'draft_unsafe',
  'send_disabled',
  'real_send_blocked',
] as const;

// ---------- errors (RFC 9457 problem details) ----------

/** Every stable `code` the API can return in a problem response. */
export const PROBLEM_CODES = [
  // 400
  'validation_failed',
  'malformed_request',
  'idempotency_key_required',
  'idempotency_key_invalid',
  // 401, 403, 404
  'unauthorized',
  'forbidden',
  'not_found',
  // 409
  'inbox_limit',
  'inbox_not_connected',
  'already_sent',
  'approval_required',
  'draft_changed',
  'fictional_company',
  'invalid_transition',
  'not_a_form_request',
  'request_not_closable',
  'request_not_editable',
  'send_in_progress',
  'company_excluded',
  'must_keep',
  'kept',
  'no_contact',
  'contact_bounced',
  'contact_changed',
  'use_form',
  'draft_integrity',
  // 422
  'draft_unsafe',
  'idempotency_key_reuse',
  // 429
  'rate_limited',
  'daily_cap_reached',
  // 5xx
  'internal_error',
  'send_failed',
  'send_outcome_unknown',
  'auth_not_configured',
  'encryption_not_configured',
  'send_disabled',
  'real_send_blocked',
  'not_ready',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const Problem = component(
  'Problem',
  z
    .object({
      type: z.string().describe('`urn:erase:problem:<code>`'),
      title: z.string(),
      status: z.number().int(),
      code: z.enum(PROBLEM_CODES).describe('A stable machine-readable code. Branch on this, not on `title` or `detail`.'),
      detail: z.string().optional().describe('A sentence a person can act on. Never contains draft text, addresses or tokens.'),
      instance: z.string().optional().describe('The request path, without the query string'),
      requestId: z.string().optional().describe('The `x-request-id` of this call, for support'),
    })
    .catchall(z.unknown())
    .describe(
      'RFC 9457 problem details. Some codes add fields: `use_form` adds `formUrl` and `selfServeUrl` (see ProblemUseForm), `draft_unsafe` adds `findings` (ProblemDraftUnsafe), `validation_failed` adds `errors` (ProblemValidation).',
    ),
);

export const ProblemUseForm = component(
  'ProblemUseForm',
  Problem.extend({
    code: z.literal('use_form'),
    formUrl: z.url().describe('The company’s web form. Copy the draft and submit it there.'),
    selfServeUrl: z.url().optional().describe('The company’s own account-deletion page, if the catalog has one'),
  }),
);

export const ProblemDraftUnsafe = component(
  'ProblemDraftUnsafe',
  Problem.extend({
    code: z.literal('draft_unsafe'),
    findings: z.array(z.enum(SAFETY_FINDINGS)).describe('Kinds of problem found, never the text itself'),
  }),
);

export const ProblemValidation = component(
  'ProblemValidation',
  Problem.extend({
    code: z.literal('validation_failed'),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).describe('Where and which rule failed. Submitted values are never echoed.'),
  }),
);

// ---------- account and inboxes ----------

export const Me = component(
  'Me',
  z.object({
    id: idOf('user'),
    email: z.string().describe('The sign-in address'),
    name: z.string(),
    csrfToken: z.string().describe('Send this in the `x-csrf-token` header on every POST, PUT, PATCH and DELETE'),
  }),
);

export const Inbox = component(
  'Inbox',
  z.object({
    id: idOf('inbox'),
    email: z.string().describe('The connected Gmail address'),
    status: z.enum(INBOX_STATUSES),
    connectedAt: isoDateTime,
    lastScanAt: isoDateTime.nullable(),
  }),
);
export const InboxList = component('InboxList', z.object({ inboxes: z.array(Inbox) }));

export const ConnectStart = component(
  'ConnectStart',
  z.object({ authorizationUrl: z.url().describe('Send the browser here. It is Google’s consent screen for Gmail read and send access.') }),
);

export const InboxDisconnected = component(
  'InboxDisconnected',
  z.object({
    status: z.literal('disconnected'),
    revokedAtGoogle: z.boolean().describe('False when Google could not be reached: the inbox is still disconnected here, so no further calls are made'),
  }),
);

export const Scan = component(
  'Scan',
  z.object({
    id: idOf('scan'),
    inboxId: idOf('inbox'),
    status: z.enum(SCAN_STATUSES),
    progressPct: z.number().int().min(0).max(100),
    foundCount: z.number().int().min(0).describe('Companies shown to the user, not counting hidden or "not mine" ones'),
    startedAt: isoDateTime.nullable(),
    finishedAt: isoDateTime.nullable(),
    errorCode: z.string().nullable().describe('For a failed scan, for example `gmail_quota`, `gmail_auth`, `inbox_disconnected`'),
  }),
);
export const ScanResponse = component('ScanResponse', z.object({ scan: Scan }));

export const AccountDeleting = component('AccountDeleting', z.object({ status: z.literal('deleting') }));

// ---------- companies ----------

export const CompanyItem = component(
  'CompanyItem',
  z.object({
    id: idOf('userCompany').describe('The detected-company id. Use it for keep and for creating a request.'),
    company: z.string().describe('Display name, from the catalog or cleaned from the sender domain'),
    domain: z.string(),
    firstSeen: isoDate,
    lastSeen: isoDate,
    signals: z.array(z.enum(SIGNALS)).describe('The header signals this result is based on'),
    confidence: z.enum(['high', 'low']).describe('`high` means the company likely holds data about the user; `low` means it may. Never certainty.'),
    mustKeep: z.boolean().describe('Needed to keep an account working (for example the account provider). No deletion request is offered.'),
    category: z.enum(COMPANY_CATEGORIES),
    selfServeUrl: z.url().nullable().describe('The company’s own account-deletion page, shown before a request by email. Never set for a must-keep company.'),
    kept: z.boolean().describe('The user chose "keep": no request is offered, and a drafted or approved one is refused at approve and send until cleared'),
    activity: z
      .enum(['looks_in_use', 'looks_unused'])
      .nullable()
      .describe('A hint from message dates: a receipt or similar lately, or nothing for a long time. Null when neither. A hint, never a decision.'),
    openRequest: z.object({ id: idOf('request'), status: z.enum(REQUEST_STATUSES) }).nullable().describe('The request that is not yet closed or bounced, if any'),
  }),
);
export const CompanyList = component('CompanyList', z.object({ companies: z.array(CompanyItem) }));
export const CompanyResponse = component('CompanyResponse', z.object({ company: CompanyItem }));

// ---------- requests ----------

export const DraftOutcome = component(
  'DraftOutcome',
  z.object({
    userCompanyId: idOf('userCompany'),
    outcome: z
      .enum(['created', 'existing', 'use_form', 'kept', 'blocked'])
      .describe(
        '`created` and `existing`: an email request. `use_form`: the company takes requests through a web form, so the request holds a draft to copy and `formUrl` says where to paste it. `kept`: the user chose to keep this company, so no request is made. `blocked`: see `reason`.',
      ),
    requestId: idOf('request').optional(),
    reason: z.enum([...BLOCKER_CODES, 'not_found']).optional().describe('Why a request was not made, when `outcome` is `blocked`'),
    message: z.string().optional().describe('A sentence for the person: why it was blocked, kept or needs the form. Makes no promise about deletion.'),
    formUrl: z.url().optional(),
    selfServeUrl: z.url().optional().describe('The company’s own account-deletion page, when it has one'),
  }),
);
export const CreateDraftsResponse = component('CreateDraftsResponse', z.object({ results: z.array(DraftOutcome) }));

export const RequestListItem = component(
  'RequestListItem',
  z.object({
    id: idOf('request'),
    status: z.enum(REQUEST_STATUSES),
    company: z.object({ name: z.string(), mustKeep: z.boolean() }),
    channel: z.enum(REQUEST_CHANNELS).describe('`email`: sent from the person’s Gmail. `web_form`: the person pasted it into the company’s web form.'),
    outcome: z.enum(OUTCOME_VALUES).nullable().describe('What the person reported (never inferred). `no_answer_yet` while waiting. Null before the request is sent.'),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    sentAt: isoDateTime.nullable(),
    dueAt: isoDateTime.nullable(),
  }),
);
export const RequestList = component('RequestList', z.object({ requests: z.array(RequestListItem) }));

export const RequestView = component(
  'RequestView',
  z.object({
    request: z.object({
      id: idOf('request'),
      status: z.enum(REQUEST_STATUSES),
      channel: z.enum(REQUEST_CHANNELS),
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
      sentAt: isoDateTime.nullable(),
      dueAt: isoDateTime.nullable(),
    }),
    company: z.object({
      id: idOf('company'),
      name: z.string(),
      mustKeep: z.boolean(),
      kept: z.boolean(),
      selfServeUrl: z.url().nullable(),
    }),
    contact: z
      .object({ channel: z.enum(['email', 'web_form']), formUrl: z.url().nullable() })
      .describe('How the company takes requests. For `web_form` the draft is for copy and paste and cannot be sent by email.'),
    useForm: z.boolean(),
    draft: z.object({
      version: z.number().int().min(1),
      to: z.string().describe('The verified grievance address, or the form URL for a web-form company. Fixed: it cannot be edited.'),
      subject: z.string(),
      body: z.string(),
      hash: draftHash,
      createdBy: z.enum(['template', 'ai', 'user']),
      createdAt: isoDateTime,
    }),
    approved: z.boolean().describe('True when the user has approved exactly this version of the draft'),
    events: z.array(
      z.object({
        type: z.enum(REQUEST_EVENT_TYPES),
        actor: z.enum(['user', 'system', 'admin']),
        at: isoDateTime,
        payload: z.record(z.string(), z.unknown()).describe('Codes and counts only: never draft text or addresses'),
      }),
    ),
    canSend: z.boolean(),
    blockers: z
      .array(
        z.object({
          code: z.enum(BLOCKER_CODES),
          message: z.string(),
          findings: z.array(z.enum(SAFETY_FINDINGS)).optional(),
          formUrl: z.url().optional(),
        }),
      )
      .describe('Everything stopping this draft from being approved or sent right now'),
    replies: z
      .object({
        count: z.number().int().min(0).describe('Replies from a person that were found on the sent thread'),
        automaticCount: z.number().int().min(0).describe('Automatic replies (out of office and similar). They do not change the status or stop the follow-up clock.'),
        firstAt: isoDateTime.nullable(),
        lastAt: isoDateTime.nullable(),
        senderMatch: z.enum(REPLY_SENDER_MATCHES).nullable().describe('Whether the first reply from a person came from the company’s own domain. Null until there is one.'),
      })
      .describe('Found from message headers only. Erase.me never reads or stores what a reply says; open it in Gmail.'),
    outcome: z
      .object({
        value: z.enum(OUTCOME_VALUES),
        setByUser: z.boolean().describe('True when the person reported it. Always shown as "Reported by you", never as a verified fact.'),
        at: isoDateTime.nullable(),
      })
      .nullable()
      .describe('What the person reports the company answered. Never inferred from a reply. `no_answer_yet` while waiting. Null before the request is sent, and after it bounced.'),
    canSetOutcome: z.boolean().describe('True once the request is sent'),
    canMarkSubmitted: z.boolean().describe('True for a web-form request whose draft is ready: the person can say they pasted it into the form'),
  }),
);

export const SendResponse = component(
  'SendResponse',
  z.object({
    request: z.object({ id: idOf('request'), status: z.literal('sent'), sentAt: isoDateTime, dueAt: isoDateTime }),
    delivery: z.enum(['fake', 'real']).describe('`fake` in development and test: nothing left the machine'),
    notice: z.string().optional().describe('Present when nothing really left the machine'),
  }),
);

// ---------- request bodies, parameters and headers (the controllers validate with these) ----------

export const CreateDraftsBody = z.object({ userCompanyIds: z.array(idOf('userCompany')).min(1).max(10) }).strict();
export const EditDraftBody = z
  .object({
    baseHash: draftHash.describe('The hash of the version being edited. If it is no longer the latest the edit is refused (409 `draft_changed`).'),
    subject: z.string().min(1).max(200).regex(/^[^\r\n]+$/, 'must be one line'),
    body: z.string().min(1).max(20_000),
  })
  .strict();
export const ApproveBody = z.object({ draftHash: draftHash.describe('The hash of the version the user was shown') }).strict();
export const OutcomeBody = z
  .object({ outcome: z.enum(OUTCOME_VALUES).describe('What the company answered, as the person reports it. `no_answer_yet` takes it back.') })
  .strict();
export const SubmittedBody = z
  .object({ draftHash: draftHash.describe('The hash of the version the person copied into the form. If it is no longer the latest the call is refused (409 `draft_changed`).') })
  .strict();

export const RequestParams = z.object({ id: idOf('request') });
export const InboxParams = z.object({ id: idOf('inbox') });
export const CompanyParams = z.object({ id: idOf('userCompany') });
export const SendHeaders = z.object({ 'idempotency-key': idempotencyKey });
export const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});
