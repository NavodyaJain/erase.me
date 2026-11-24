/* Generated from services/api/openapi/openapi.json by `pnpm --filter @erase/contracts generate`. Do not edit. */

export interface paths {
    "/v1/auth/google/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Google redirects back here
         * @description The one callback registered with Google, for both sign-in and inbox connect (told apart by server-side state). Always answers with a redirect to the web app: on success to the app, on failure to `/?auth_error=<reason>` (reasons: `access_denied`, `invalid_state`, `exchange_failed`, `scopes_missing`, `no_refresh_token`, `inbox_limit`, `account_unavailable`) and, after connecting an inbox, `/?inbox=connected`. A successful sign-in sets the `erase_session` cookie.
         */
        get: operations["finishGoogleAuth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/google/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Start Google sign-in
         * @description Redirects the browser to Google (scopes `openid email profile`, PKCE, a one-time state). Sets a short-lived `erase_oauth_state` cookie that the callback checks. Sign-in only identifies the user: connecting an inbox is a separate consent.
         */
        get: operations["startSignIn"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign out
         * @description Revokes the session on the server and clears the cookie.
         */
        post: operations["logout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/companies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Companies that may hold the user’s data
         * @description The user’s detected companies, as shown to them: sending services, mailbox providers, the user’s own and employer domains, and companies marked "not mine" are left out. Every result is a hint from header metadata (company, dates and signal names), never a statement of fact. No pagination yet.
         */
        get: operations["listCompanies"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/companies/{id}/keep": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Keep this company
         * @description Marks a company as one the user wants to keep. No request is offered for it: creating one answers outcome `kept`, and a drafted or approved request is refused at approve and send (409 `kept`) until this is cleared. Editing and closing still work, and a request already sent is unaffected. Idempotent.
         */
        put: operations["keepCompany"];
        post?: never;
        /**
         * Undo "keep this"
         * @description Clears the flag, so requests can be made for the company again and a refused request can go on. Idempotent.
         */
        delete: operations["unkeepCompany"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inboxes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The user’s inboxes */
        get: operations["listInboxes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inboxes/connect/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start connecting an inbox
         * @description Show the "what we read, what we keep, what we never do" panel first, then call this and send the browser to `authorizationUrl`. Asks Google for Gmail read-only (header metadata for the scan) and send (used only after the user approves a request). Sets the `erase_oauth_state` cookie. Up to 5 inboxes per user.
         */
        post: operations["startInboxConnect"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inboxes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Disconnect an inbox
         * @description Revokes the Google token, drops the stored token, stops scans and starts the 30-day retention clock.
         */
        delete: operations["disconnectInbox"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inboxes/{id}/scan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The latest scan of an inbox */
        get: operations["getScan"];
        put?: never;
        /**
         * Scan an inbox for companies
         * @description Reads message headers only (never bodies) in the background. Idempotent: while a scan is active, the same call returns it (200) instead of starting another (202). Poll `GET /v1/inboxes/{id}/scan` for progress.
         */
        post: operations["startScan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The signed-in user, and the CSRF token
         * @description Call this after sign-in and keep `csrfToken`: every state-changing call must send it in `x-csrf-token`.
         */
        get: operations["getMe"];
        put?: never;
        post?: never;
        /**
         * Delete the account
         * @description Starts account deletion: every session ends at once, Gmail access is revoked and dropped, and the personal fields are replaced. Rows that refer to the user are removed by a later purge job.
         */
        delete: operations["deleteMe"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The user’s requests */
        get: operations["listRequests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/drafts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Draft requests for companies
         * @description Makes a draft request for each company, from a fixed template. Always 200: each company has its own outcome. `created` and `existing` are email requests; `use_form` is a web-form company (the draft is for copy and paste, with `formUrl`); `kept` means the user chose to keep it; `blocked` has a `reason` (`must_keep`, `no_contact`, `company_excluded`, `not_found`...). Nothing is sent and no deletion is promised: a draft is a polite request.
         */
        post: operations["createRequestDrafts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A request with its current draft
         * @description Includes the draft the user would approve, the event history, whether it can be sent, and everything blocking it.
         */
        get: operations["getRequest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve the draft
         * @description Records the user’s approval of exactly the draft version they were shown (`draftHash`). The guards run again: a must-keep or kept company, a missing contact, a web-form company, an ID-like number or an unresolved [OPEN] placeholder all refuse it.
         */
        post: operations["approveRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close a request before it is sent
         * @description Discards a drafted or approved request and frees the company for a new one.
         */
        post: operations["closeRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Edit the draft
         * @description Creates a new draft version with a new hash and puts an approved request back to `drafted`: the earlier approval no longer counts. The recipient cannot be edited. Text containing an ID-like number is refused and not stored. Refused while a send is running or after it was sent.
         */
        patch: operations["editRequestDraft"];
        trace?: never;
    };
    "/v1/requests/{id}/followup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Prepare the follow-up to a request with no reply
         * @description Offered once `FOLLOWUP_AFTER_DAYS` (30 by default) have passed since the message was sent, and no reply from a person has arrived. An automatic reply (out of office and similar) does not stop the clock; a reply from a person or an outcome the person reported ends the wait. One follow-up per request (`FOLLOWUP_MAX`). Makes the draft from a fixed, polite template that asks for a reply and claims no deadline was missed; the statute paragraph stays behind the same verified-citation gate as the first message. The request moves from `sent` to `no_reply`. Asking again returns the draft that exists. The guards of the first request run again: a must-keep or kept company, a verified contact that has not changed. Nothing is sent. For a web-form request the follow-up is copy-only.
         */
        post: operations["createFollowup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/followup/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve the follow-up draft
         * @description Records the person’s approval of exactly the follow-up version they were shown (`draftHash`). A changed draft answers 409 `draft_changed`, and the call is never retried by itself. The guards run again, including the unresolved [OPEN] line. A web-form follow-up is not approved here: it answers 409 `use_form`; copy it and use `/followup/submitted`.
         */
        post: operations["approveFollowup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/followup/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Edit the follow-up draft
         * @description Creates a new version of the follow-up draft with a new hash and puts an approved follow-up back to `drafted`: the earlier approval no longer counts. The recipient cannot be edited. Text containing an ID-like number is refused and not stored. If the draft changed since the person saw it (`baseHash` is not the latest) the edit is refused with `draft_changed` and not retried.
         */
        patch: operations["editFollowupDraft"];
        trace?: never;
    };
    "/v1/requests/{id}/followup/send": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send an approved follow-up, in the same Gmail conversation
         * @description Needs an `Idempotency-Key`: a repeat with the same key returns the first answer and never sends twice. Needs the person’s approval of the exact current follow-up draft (also enforced in the database), the first request’s guards, and the same real-send gates as the first message. Real sending also stays off until the follow-up wording has been signed off. In development and test the fake sender answers `delivery: "fake"` and nothing leaves the machine. A reply or a reported outcome since the draft was made stops it. An unknown outcome (a timeout) leaves the follow-up unsent and is not retried automatically.
         */
        post: operations["sendFollowup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/followup/submitted": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Say the follow-up was pasted into the company’s web form
         * @description For a web-form request only. Nothing is sent from here: the person copied the follow-up into the form and says so, naming the exact draft they copied (`draftHash`). It is recorded like an approval and a send: the guards run again and the follow-up becomes `submitted`. Saying it again changes nothing. An email request answers 409 `not_a_form_request`.
         */
        post: operations["markFollowupSubmitted"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/outcome": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Report what the company answered
         * @description The person reports the outcome: `confirmed_erased`, `refused`, `needs_more_info`, or `no_answer_yet` to take a report back. Erase.me never infers it, not from a reply it found and not from who sent it, and it always shows as "Reported by you", never as a verified fact. It can be set whether or not a reply was detected (the answer may have come by phone or through the form), and changed later. `no_answer_yet` returns the request to `sent`, or to `no_reply` once the follow-up day has passed. Saying the same thing again changes nothing. Only a sent request has an outcome: a draft, a closed or a bounced request answers 409 `invalid_transition`.
         */
        put: operations["setRequestOutcome"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/send": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send an approved request from the user’s Gmail
         * @description Needs an `Idempotency-Key` header: a repeat with the same key returns the first answer and never sends twice. Needs a user approval of the exact current draft (also enforced in the database), a verified contact, a company that is neither must-keep nor kept, and text without ID-like numbers or an [OPEN] placeholder. In development and test the sender is fake and the response says so (`delivery: "fake"`, with a `notice`); real sending stays off until it is explicitly enabled. If Gmail does not confirm, the request is left unsent and the user is told to check the Sent folder: it is never retried automatically (`send_outcome_unknown`).
         */
        post: operations["sendRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/requests/{id}/submitted": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Say the draft was pasted into the company’s web form
         * @description For a company that takes requests through a web form. Nothing is sent from here: the person copied the draft into the form and says so. It is recorded like a send: the person approves the exact draft they copied (`draftHash`), the guards run again (a must-keep or kept company, a verified form contact, ID-like numbers and the unresolved [OPEN] line), and the request becomes `sent` with channel `web_form`, which starts the clock for a reply. There is no Gmail thread to follow, so reply checks do not apply and the person reports the outcome. Saying it again changes nothing. An email company answers 409 `not_a_form_request`.
         */
        post: operations["markRequestSubmitted"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        AccountDeleting: {
            /** @constant */
            status: "deleting";
        };
        CompanyItem: {
            /** @description The detected-company id. Use it for keep and for creating a request. */
            id: string;
            /** @description Display name, from the catalog or cleaned from the sender domain */
            company: string;
            domain: string;
            /** @description Calendar date, YYYY-MM-DD */
            firstSeen: string;
            /** @description Calendar date, YYYY-MM-DD */
            lastSeen: string;
            /** @description The header signals this result is based on */
            signals: ("welcome" | "receipt" | "verify" | "transactional" | "list_unsubscribe" | "newsletter")[];
            /**
             * @description `high` means the company likely holds data about the user; `low` means it may. Never certainty.
             * @enum {string}
             */
            confidence: "high" | "low";
            /** @description Needed to keep an account working (for example the account provider). No deletion request is offered. */
            mustKeep: boolean;
            /** @enum {string} */
            category: "loan_app" | "wallet_payments" | "broker_investing" | "credit" | "ecommerce" | "travel" | "streaming" | "education" | "social" | "saas" | "account_provider" | "games" | "other";
            /** @description The company’s own account-deletion page, shown before a request by email. Never set for a must-keep company. */
            selfServeUrl: string | null;
            /** @description The user chose "keep": no request is offered, and a drafted or approved one is refused at approve and send until cleared */
            kept: boolean;
            /** @description A hint from message dates: a receipt or similar lately, or nothing for a long time. Null when neither. A hint, never a decision. */
            activity: ("looks_in_use" | "looks_unused") | null;
            /** @description The request that is not yet closed or bounced, if any */
            openRequest: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
                /** @enum {string} */
                status: "drafted" | "approved" | "sent" | "reply_received" | "replied_deleted" | "replied_info_requested" | "replied_refused" | "no_reply" | "closed" | "bounced";
            } | null;
        };
        CompanyList: {
            companies: components["schemas"]["CompanyItem"][];
        };
        CompanyResponse: {
            company: components["schemas"]["CompanyItem"];
        };
        ConnectStart: {
            /**
             * Format: uri
             * @description Send the browser here. It is Google’s consent screen for Gmail read and send access.
             */
            authorizationUrl: string;
        };
        CreateDraftsResponse: {
            results: components["schemas"]["DraftOutcome"][];
        };
        DraftOutcome: {
            /** @description Prefixed ULID (`ucm_` followed by 26 characters) */
            userCompanyId: string;
            /**
             * @description `created` and `existing`: an email request. `use_form`: the company takes requests through a web form, so the request holds a draft to copy and `formUrl` says where to paste it. `kept`: the user chose to keep this company, so no request is made. `blocked`: see `reason`.
             * @enum {string}
             */
            outcome: "created" | "existing" | "use_form" | "kept" | "blocked";
            /** @description Prefixed ULID (`req_` followed by 26 characters) */
            requestId?: string;
            /**
             * @description Why a request was not made, when `outcome` is `blocked`
             * @enum {string}
             */
            reason?: "company_excluded" | "must_keep" | "kept" | "no_contact" | "contact_bounced" | "contact_changed" | "use_form" | "draft_integrity" | "draft_unsafe" | "send_disabled" | "real_send_blocked" | "not_found";
            /** @description A sentence for the person: why it was blocked, kept or needs the form. Makes no promise about deletion. */
            message?: string;
            /** Format: uri */
            formUrl?: string;
            /**
             * Format: uri
             * @description The company’s own account-deletion page, when it has one
             */
            selfServeUrl?: string;
        };
        FollowupSendResponse: {
            followup: {
                sequence: number;
                /** @constant */
                status: "sent";
                /**
                 * Format: date-time
                 * @description UTC timestamp, ISO 8601
                 */
                sentAt: string;
            };
            /**
             * @description `fake` in development and test: nothing left the machine
             * @enum {string}
             */
            delivery: "fake" | "real";
            /** @description Present when nothing really left the machine */
            notice?: string;
        };
        Inbox: {
            /** @description Prefixed ULID (`inb_` followed by 26 characters) */
            id: string;
            /** @description The connected Gmail address */
            email: string;
            /** @enum {string} */
            status: "connected" | "disconnected" | "error";
            /**
             * Format: date-time
             * @description UTC timestamp, ISO 8601
             */
            connectedAt: string;
            lastScanAt: string | null;
        };
        InboxDisconnected: {
            /** @constant */
            status: "disconnected";
            /** @description False when Google could not be reached: the inbox is still disconnected here, so no further calls are made */
            revokedAtGoogle: boolean;
        };
        InboxList: {
            inboxes: components["schemas"]["Inbox"][];
        };
        Me: {
            /** @description Prefixed ULID (`usr_` followed by 26 characters) */
            id: string;
            /** @description The sign-in address */
            email: string;
            name: string;
            /** @description Send this in the `x-csrf-token` header on every POST, PUT, PATCH and DELETE */
            csrfToken: string;
        };
        /** @description RFC 9457 problem details. Some codes add fields: `use_form` adds `formUrl` and `selfServeUrl` (see ProblemUseForm), `draft_unsafe` adds `findings` (ProblemDraftUnsafe), `validation_failed` adds `errors` (ProblemValidation). */
        Problem: {
            /** @description `urn:erase:problem:<code>` */
            type: string;
            title: string;
            status: number;
            /**
             * @description A stable machine-readable code. Branch on this, not on `title` or `detail`.
             * @enum {string}
             */
            code: "validation_failed" | "malformed_request" | "idempotency_key_required" | "idempotency_key_invalid" | "unauthorized" | "forbidden" | "not_found" | "inbox_limit" | "inbox_not_connected" | "already_sent" | "approval_required" | "draft_changed" | "fictional_company" | "invalid_transition" | "not_a_form_request" | "followup_not_due" | "followup_limit_reached" | "request_not_closable" | "request_not_editable" | "send_in_progress" | "company_excluded" | "must_keep" | "kept" | "no_contact" | "contact_bounced" | "contact_changed" | "use_form" | "draft_integrity" | "draft_unsafe" | "idempotency_key_reuse" | "rate_limited" | "daily_cap_reached" | "internal_error" | "send_failed" | "send_outcome_unknown" | "auth_not_configured" | "encryption_not_configured" | "send_disabled" | "real_send_blocked" | "not_ready";
            /** @description A sentence a person can act on. Never contains draft text, addresses or tokens. */
            detail?: string;
            /** @description The request path, without the query string */
            instance?: string;
            /** @description The `x-request-id` of this call, for support */
            requestId?: string;
        } & {
            [key: string]: unknown;
        };
        ProblemDraftUnsafe: {
            /** @description `urn:erase:problem:<code>` */
            type: string;
            title: string;
            status: number;
            /** @constant */
            code: "draft_unsafe";
            /** @description A sentence a person can act on. Never contains draft text, addresses or tokens. */
            detail?: string;
            /** @description The request path, without the query string */
            instance?: string;
            /** @description The `x-request-id` of this call, for support */
            requestId?: string;
            /** @description Kinds of problem found, never the text itself */
            findings: ("aadhaar" | "pan" | "passport" | "voter_id" | "gstin" | "card" | "open_placeholder")[];
        } & {
            [key: string]: unknown;
        };
        ProblemUseForm: {
            /** @description `urn:erase:problem:<code>` */
            type: string;
            title: string;
            status: number;
            /** @constant */
            code: "use_form";
            /** @description A sentence a person can act on. Never contains draft text, addresses or tokens. */
            detail?: string;
            /** @description The request path, without the query string */
            instance?: string;
            /** @description The `x-request-id` of this call, for support */
            requestId?: string;
            /**
             * Format: uri
             * @description The company’s web form. Copy the draft and submit it there.
             */
            formUrl: string;
            /**
             * Format: uri
             * @description The company’s own account-deletion page, if the catalog has one
             */
            selfServeUrl?: string;
        } & {
            [key: string]: unknown;
        };
        ProblemValidation: {
            /** @description `urn:erase:problem:<code>` */
            type: string;
            title: string;
            status: number;
            /** @constant */
            code: "validation_failed";
            /** @description A sentence a person can act on. Never contains draft text, addresses or tokens. */
            detail?: string;
            /** @description The request path, without the query string */
            instance?: string;
            /** @description The `x-request-id` of this call, for support */
            requestId?: string;
            /** @description Where and which rule failed. Submitted values are never echoed. */
            errors: {
                path: string;
                message: string;
            }[];
        } & {
            [key: string]: unknown;
        };
        RequestList: {
            requests: components["schemas"]["RequestListItem"][];
        };
        RequestListItem: {
            /** @description Prefixed ULID (`req_` followed by 26 characters) */
            id: string;
            /** @enum {string} */
            status: "drafted" | "approved" | "sent" | "reply_received" | "replied_deleted" | "replied_info_requested" | "replied_refused" | "no_reply" | "closed" | "bounced";
            company: {
                name: string;
                mustKeep: boolean;
            };
            /**
             * @description `email`: sent from the person’s Gmail. `web_form`: the person pasted it into the company’s web form.
             * @enum {string}
             */
            channel: "email" | "web_form";
            /** @description What the person reported (never inferred). `no_answer_yet` while waiting. Null before the request is sent. */
            outcome: ("confirmed_erased" | "refused" | "needs_more_info" | "no_answer_yet") | null;
            /**
             * Format: date-time
             * @description UTC timestamp, ISO 8601
             */
            createdAt: string;
            /**
             * Format: date-time
             * @description UTC timestamp, ISO 8601
             */
            updatedAt: string;
            sentAt: string | null;
            dueAt: string | null;
        };
        RequestView: {
            request: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
                /** @enum {string} */
                status: "drafted" | "approved" | "sent" | "reply_received" | "replied_deleted" | "replied_info_requested" | "replied_refused" | "no_reply" | "closed" | "bounced";
                /** @enum {string} */
                channel: "email" | "web_form";
                /**
                 * Format: date-time
                 * @description UTC timestamp, ISO 8601
                 */
                createdAt: string;
                /**
                 * Format: date-time
                 * @description UTC timestamp, ISO 8601
                 */
                updatedAt: string;
                sentAt: string | null;
                dueAt: string | null;
            };
            company: {
                /** @description Prefixed ULID (`cmp_` followed by 26 characters) */
                id: string;
                name: string;
                mustKeep: boolean;
                kept: boolean;
                selfServeUrl: string | null;
            };
            /** @description How the company takes requests. For `web_form` the draft is for copy and paste and cannot be sent by email. */
            contact: {
                /** @enum {string} */
                channel: "email" | "web_form";
                formUrl: string | null;
            };
            useForm: boolean;
            draft: {
                version: number;
                /** @description The verified grievance address, or the form URL for a web-form company. Fixed: it cannot be edited. */
                to: string;
                subject: string;
                body: string;
                /** @description sha256 (hex) of the recipient, subject and body of a draft, exactly as shown */
                hash: string;
                /** @enum {string} */
                createdBy: "template" | "ai" | "user";
                /**
                 * Format: date-time
                 * @description UTC timestamp, ISO 8601
                 */
                createdAt: string;
            };
            /** @description True when the user has approved exactly this version of the draft */
            approved: boolean;
            events: {
                /** @enum {string} */
                type: "drafted" | "edited" | "approved" | "sent" | "bounced" | "reply_label" | "followup_drafted" | "closed" | "reply_received" | "outcome_set" | "followup_approved" | "followup_sent" | "submitted";
                /** @enum {string} */
                actor: "user" | "system" | "admin";
                /**
                 * Format: date-time
                 * @description UTC timestamp, ISO 8601
                 */
                at: string;
                /** @description Codes and counts only: never draft text or addresses */
                payload: {
                    [key: string]: unknown;
                };
            }[];
            canSend: boolean;
            /** @description Everything stopping this draft from being approved or sent right now */
            blockers: {
                /** @enum {string} */
                code: "company_excluded" | "must_keep" | "kept" | "no_contact" | "contact_bounced" | "contact_changed" | "use_form" | "draft_integrity" | "draft_unsafe" | "send_disabled" | "real_send_blocked";
                message: string;
                findings?: ("aadhaar" | "pan" | "passport" | "voter_id" | "gstin" | "card" | "open_placeholder")[];
                /** Format: uri */
                formUrl?: string;
            }[];
            /** @description Found from message headers only. Erase.me never reads or stores what a reply says; open it in Gmail. */
            replies: {
                /** @description Replies from a person that were found on the sent thread */
                count: number;
                /** @description Automatic replies (out of office and similar). They do not change the status or stop the follow-up clock. */
                automaticCount: number;
                firstAt: string | null;
                lastAt: string | null;
                /** @description Whether the first reply from a person came from the company’s own domain. Null until there is one. */
                senderMatch: ("company" | "other" | "unknown") | null;
            };
            /** @description What the person reports the company answered. Never inferred from a reply. `no_answer_yet` while waiting. Null before the request is sent, and after it bounced. */
            outcome: {
                /** @enum {string} */
                value: "confirmed_erased" | "refused" | "needs_more_info" | "no_answer_yet";
                /** @description True when the person reported it. Always shown as "Reported by you", never as a verified fact. */
                setByUser: boolean;
                at: string | null;
            } | null;
            /** @description True once the request is sent */
            canSetOutcome: boolean;
            /** @description True for a web-form request whose draft is ready: the person can say they pasted it into the form */
            canMarkSubmitted: boolean;
            /** @description The follow-up to a request that has had no reply by the follow-up day. One per request. An automatic reply does not stop the clock; a reply from a person or a reported outcome ends the wait. */
            followup: {
                /**
                 * @description `none`: no follow-up applies (not sent, a reply arrived, an outcome was reported, or follow-ups are off). `not_due`: waiting. `due`: "Follow up?" can be offered. Then `drafted`, `approved`, and `sent` (email) or `submitted` (web form, copied by the person).
                 * @enum {string}
                 */
                state: "none" | "not_due" | "due" | "drafted" | "approved" | "sent" | "submitted";
                /** @description When a follow-up becomes due. Null when none can be. */
                dueAt: string | null;
                /** @description How many more follow-ups this request may have */
                remaining: number;
                sequence: number | null;
                /** @description When it was sent, or when the person said they pasted it into the form */
                sentAt: string | null;
                /** @description The follow-up the person reviews and approves. The recipient is fixed: the same place as the first message. */
                draft: {
                    version: number;
                    to: string;
                    subject: string;
                    body: string;
                    /** @description sha256 (hex) of the recipient, subject and body of a draft, exactly as shown */
                    hash: string;
                    /** @enum {string} */
                    createdBy: "template" | "ai" | "user";
                    /**
                     * Format: date-time
                     * @description UTC timestamp, ISO 8601
                     */
                    createdAt: string;
                } | null;
                /** @description True when the person approved exactly this version of the follow-up */
                approved: boolean;
                /** @description True when "Follow up?" can be offered */
                canCreate: boolean;
                /** @description True for an approved email follow-up that nothing blocks */
                canSend: boolean;
                /** @description True for a web-form follow-up that is ready: copy it into the form, then say so. Nothing is sent. */
                canMarkSubmitted: boolean;
                /** @description Everything stopping this follow-up right now */
                blockers: {
                    /** @enum {string} */
                    code: "company_excluded" | "must_keep" | "kept" | "no_contact" | "contact_bounced" | "contact_changed" | "use_form" | "draft_integrity" | "draft_unsafe" | "send_disabled" | "real_send_blocked";
                    message: string;
                    findings?: ("aadhaar" | "pan" | "passport" | "voter_id" | "gstin" | "card" | "open_placeholder")[];
                    /** Format: uri */
                    formUrl?: string;
                }[];
            };
        };
        Scan: {
            /** @description Prefixed ULID (`scn_` followed by 26 characters) */
            id: string;
            /** @description Prefixed ULID (`inb_` followed by 26 characters) */
            inboxId: string;
            /** @enum {string} */
            status: "queued" | "running" | "done" | "failed";
            progressPct: number;
            /** @description Companies shown to the user, not counting hidden or "not mine" ones */
            foundCount: number;
            startedAt: string | null;
            finishedAt: string | null;
            /** @description For a failed scan, for example `gmail_quota`, `gmail_auth`, `inbox_disconnected` */
            errorCode: string | null;
        };
        ScanResponse: {
            scan: components["schemas"]["Scan"];
        };
        SendResponse: {
            request: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
                /** @constant */
                status: "sent";
                /**
                 * Format: date-time
                 * @description UTC timestamp, ISO 8601
                 */
                sentAt: string;
                /**
                 * Format: date-time
                 * @description UTC timestamp, ISO 8601
                 */
                dueAt: string;
            };
            /**
             * @description `fake` in development and test: nothing left the machine
             * @enum {string}
             */
            delivery: "fake" | "real";
            /** @description Present when nothing really left the machine */
            notice?: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    finishGoogleAuth: {
        parameters: {
            query?: {
                code?: string;
                state?: string;
                error?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redirect to the web app */
            302: {
                headers: {
                    /** @description Where the browser goes next */
                    Location?: string;
                    /** @description The `erase_oauth_state` cookie (start, connect) or the `erase_session` cookie (after sign-in) */
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Token encryption is not configured (inbox connect only) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    startSignIn: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redirect to Google */
            302: {
                headers: {
                    /** @description Where the browser goes next */
                    Location?: string;
                    /** @description The `erase_oauth_state` cookie (start, connect) or the `erase_session` cookie (after sign-in) */
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Too many requests */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Google sign-in is not configured */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    logout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Signed out */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCompanies: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Detected companies, likely ones first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "companies": [
                     *         {
                     *           "id": "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *           "company": "Sample Shop",
                     *           "domain": "sampleshop.example",
                     *           "firstSeen": "2025-01-11",
                     *           "lastSeen": "2026-11-18",
                     *           "signals": [
                     *             "receipt",
                     *             "welcome"
                     *           ],
                     *           "confidence": "high",
                     *           "mustKeep": false,
                     *           "category": "ecommerce",
                     *           "selfServeUrl": "https://example.com/account/delete",
                     *           "kept": false,
                     *           "activity": "looks_in_use",
                     *           "openRequest": null
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["CompanyList"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    keepCompany: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`ucm_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Kept */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "company": {
                     *         "id": "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "company": "Sample Shop",
                     *         "domain": "sampleshop.example",
                     *         "firstSeen": "2025-01-11",
                     *         "lastSeen": "2026-11-18",
                     *         "signals": [
                     *           "receipt",
                     *           "welcome"
                     *         ],
                     *         "confidence": "high",
                     *         "mustKeep": false,
                     *         "category": "ecommerce",
                     *         "selfServeUrl": "https://example.com/account/delete",
                     *         "kept": true,
                     *         "activity": "looks_in_use",
                     *         "openRequest": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CompanyResponse"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such company for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Keeping makes no sense for this company */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unkeepCompany: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`ucm_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No longer kept */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "company": {
                     *         "id": "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "company": "Sample Shop",
                     *         "domain": "sampleshop.example",
                     *         "firstSeen": "2025-01-11",
                     *         "lastSeen": "2026-11-18",
                     *         "signals": [
                     *           "receipt",
                     *           "welcome"
                     *         ],
                     *         "confidence": "high",
                     *         "mustKeep": false,
                     *         "category": "ecommerce",
                     *         "selfServeUrl": "https://example.com/account/delete",
                     *         "kept": false,
                     *         "activity": "looks_in_use",
                     *         "openRequest": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CompanyResponse"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such company for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not applicable to this company */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listInboxes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Inboxes, oldest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "inboxes": [
                     *         {
                     *           "id": "inb_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *           "email": "asha.mail@example.com",
                     *           "status": "connected",
                     *           "connectedAt": "2026-11-20T09:30:00.000Z",
                     *           "lastScanAt": "2026-11-22T10:00:00.000Z"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["InboxList"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    startInboxConnect: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Where to send the browser */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=example&state=example"
                     *     }
                     */
                    "application/json": components["schemas"]["ConnectStart"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Inbox limit reached */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    disconnectInbox: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`inb_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Disconnected */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "status": "disconnected",
                     *       "revokedAtGoogle": true
                     *     }
                     */
                    "application/json": components["schemas"]["InboxDisconnected"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such inbox */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getScan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`inb_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The latest scan */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "scan": {
                     *         "id": "scn_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "inboxId": "inb_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "done",
                     *         "progressPct": 100,
                     *         "foundCount": 28,
                     *         "startedAt": "2026-11-20T09:30:00.000Z",
                     *         "finishedAt": "2026-11-22T10:00:00.000Z",
                     *         "errorCode": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["ScanResponse"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such inbox, or no scan yet */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    startScan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`inb_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A scan is already running */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "scan": {
                     *         "id": "scn_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "inboxId": "inb_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "running",
                     *         "progressPct": 40,
                     *         "foundCount": 12,
                     *         "startedAt": "2026-11-22T10:00:00.000Z",
                     *         "finishedAt": null,
                     *         "errorCode": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["ScanResponse"];
                };
            };
            /** @description Scan started */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "scan": {
                     *         "id": "scn_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "inboxId": "inb_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "queued",
                     *         "progressPct": 0,
                     *         "foundCount": 0,
                     *         "startedAt": null,
                     *         "finishedAt": null,
                     *         "errorCode": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["ScanResponse"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such inbox */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The inbox is not connected */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The user */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "usr_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *       "email": "asha@example.com",
                     *       "name": "Asha Rao",
                     *       "csrfToken": "example-csrf-token-not-a-real-token"
                     *     }
                     */
                    "application/json": components["schemas"]["Me"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deletion started */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "status": "deleting"
                     *     }
                     */
                    "application/json": components["schemas"]["AccountDeleting"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listRequests: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Requests, most recently changed first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "requests": [
                     *         {
                     *           "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *           "status": "drafted",
                     *           "company": {
                     *             "name": "Sample Shop",
                     *             "mustKeep": false
                     *           },
                     *           "channel": "email",
                     *           "outcome": null,
                     *           "createdAt": "2026-11-22T10:00:00.000Z",
                     *           "updatedAt": "2026-11-22T10:00:00.000Z",
                     *           "sentAt": null,
                     *           "dueAt": null
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["RequestList"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createRequestDrafts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "userCompanyIds": [
                 *         "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                 *         "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZB",
                 *         "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZC"
                 *       ]
                 *     }
                 */
                "application/json": {
                    userCompanyIds: string[];
                };
            };
        };
        responses: {
            /** @description One outcome per company */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "results": [
                     *         {
                     *           "userCompanyId": "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *           "outcome": "created",
                     *           "requestId": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *           "selfServeUrl": "https://example.com/account/delete"
                     *         },
                     *         {
                     *           "userCompanyId": "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZB",
                     *           "outcome": "use_form",
                     *           "requestId": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZB",
                     *           "formUrl": "https://example.com/privacy/request",
                     *           "message": "Sample Forms Co takes requests through a web form, so Erase.me cannot send this by email. Copy the draft into the form. It is shown here for that."
                     *         },
                     *         {
                     *           "userCompanyId": "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZC",
                     *           "outcome": "kept",
                     *           "message": "You chose to keep Sample Shop, so Erase.me makes no request for it. Undo \"keep\" to continue."
                     *         },
                     *         {
                     *           "userCompanyId": "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZD",
                     *           "outcome": "blocked",
                     *           "reason": "must_keep",
                     *           "message": "Sample Account Provider is needed to keep your account working, so Erase.me does not offer a deletion request for it. If you stop using it, you can close the account with the company directly."
                     *         },
                     *         {
                     *           "userCompanyId": "ucm_01J8Z3K9M2Q7R6T5V4W3X2Y1ZE",
                     *           "outcome": "blocked",
                     *           "reason": "no_contact",
                     *           "message": "We do not have a verified grievance contact for Sample Bank yet, so this request is blocked. We have noted it so the contact can be found. Nothing is sent without one."
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["CreateDraftsResponse"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The request */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "drafted",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": null,
                     *         "dueAt": null
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": false,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [
                     *         {
                     *           "code": "draft_unsafe",
                     *           "message": "The text still has an [OPEN] placeholder. Replace it with the wording you want to send, or remove the line.",
                     *           "findings": [
                     *             "open_placeholder"
                     *           ]
                     *         }
                     *       ],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": null,
                     *       "canSetOutcome": false,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "none",
                     *         "dueAt": null,
                     *         "remaining": 1,
                     *         "sequence": null,
                     *         "sentAt": null,
                     *         "draft": null,
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": []
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    approveRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "draftHash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8"
                 *     }
                 */
                "application/json": {
                    /** @description The hash of the version the user was shown */
                    draftHash: string;
                };
            };
        };
        responses: {
            /** @description Approved (or already approved) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "approved",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": null,
                     *         "dueAt": null
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": true,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": true,
                     *       "blockers": [],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": null,
                     *       "canSetOutcome": false,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "none",
                     *         "dueAt": null,
                     *         "remaining": 1,
                     *         "sequence": null,
                     *         "sentAt": null,
                     *         "draft": null,
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": []
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not approvable now */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The draft cannot be used yet */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    closeRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Closed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "closed",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": null,
                     *         "dueAt": null
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": false,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [
                     *         {
                     *           "code": "draft_unsafe",
                     *           "message": "The text still has an [OPEN] placeholder. Replace it with the wording you want to send, or remove the line.",
                     *           "findings": [
                     *             "open_placeholder"
                     *           ]
                     *         }
                     *       ],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": null,
                     *       "canSetOutcome": false,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "none",
                     *         "dueAt": null,
                     *         "remaining": 1,
                     *         "sequence": null,
                     *         "sentAt": null,
                     *         "draft": null,
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": []
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Cannot be closed now */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    editRequestDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "baseHash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                 *       "subject": "Request to erase my personal data",
                 *       "body": "I would like to ask Sample Shop to erase the personal data it holds about me."
                 *     }
                 */
                "application/json": {
                    /** @description The hash of the version being edited. If it is no longer the latest the edit is refused (409 `draft_changed`). */
                    baseHash: string;
                    subject: string;
                    body: string;
                };
            };
        };
        responses: {
            /** @description The request with its new draft version */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "drafted",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": null,
                     *         "dueAt": null
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 2,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                     *         "createdBy": "user",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": false,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [
                     *         {
                     *           "code": "draft_unsafe",
                     *           "message": "The text still has an [OPEN] placeholder. Replace it with the wording you want to send, or remove the line.",
                     *           "findings": [
                     *             "open_placeholder"
                     *           ]
                     *         }
                     *       ],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": null,
                     *       "canSetOutcome": false,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "none",
                     *         "dueAt": null,
                     *         "remaining": 1,
                     *         "sequence": null,
                     *         "sentAt": null,
                     *         "draft": null,
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": []
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The draft cannot be edited now */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The text looks like it contains an ID number */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createFollowup: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The request, with its follow-up draft */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "no_reply",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": "2026-11-22T10:00:00.000Z",
                     *         "dueAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": true,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         },
                     *         {
                     *           "type": "approved",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1
                     *           }
                     *         },
                     *         {
                     *           "type": "sent",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "delivery": "fake"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": {
                     *         "value": "no_answer_yet",
                     *         "setByUser": false,
                     *         "at": null
                     *       },
                     *       "canSetOutcome": true,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "drafted",
                     *         "dueAt": "2026-11-22T10:00:00.000Z",
                     *         "remaining": 0,
                     *         "sequence": 1,
                     *         "sentAt": null,
                     *         "draft": {
                     *           "version": 1,
                     *           "to": "grievance@example.com",
                     *           "subject": "Re: Request to erase my personal data",
                     *           "body": "To the Grievance Officer, Sample Shop\n\nI am following up on my email of 22 November 2026, in which I asked about personal data that Sample Shop likely holds about me. I have not seen a reply yet. Messages can go astray, so I am writing again in case it did not reach the right person.\n\nMy details\nName: Asha Rao\nEmail address: asha.rao@example.com\n\nMy request\nMy request is the same as before: I would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a reply, even a short one, that tells me:\n1. whether you received my first message;\n2. whether the data has been erased, or when you expect to be able to tell me; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you have already replied, thank you. Please point me to your answer, as I may have missed it.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you for your time.\nAsha Rao",
                     *           "hash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                     *           "createdBy": "template",
                     *           "createdAt": "2026-11-22T10:00:00.000Z"
                     *         },
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": [
                     *           {
                     *             "code": "draft_unsafe",
                     *             "message": "The text still has an [OPEN] placeholder. Replace it with the wording you want to send, or remove the line.",
                     *             "findings": [
                     *               "open_placeholder"
                     *             ]
                     *           }
                     *         ]
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No follow-up can be prepared now */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    approveFollowup: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "draftHash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
                 *     }
                 */
                "application/json": {
                    /** @description The hash of the version the user was shown */
                    draftHash: string;
                };
            };
        };
        responses: {
            /** @description Approved (or already approved) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "no_reply",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": "2026-11-22T10:00:00.000Z",
                     *         "dueAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": true,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         },
                     *         {
                     *           "type": "approved",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1
                     *           }
                     *         },
                     *         {
                     *           "type": "sent",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "delivery": "fake"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": {
                     *         "value": "no_answer_yet",
                     *         "setByUser": false,
                     *         "at": null
                     *       },
                     *       "canSetOutcome": true,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "approved",
                     *         "dueAt": "2026-11-22T10:00:00.000Z",
                     *         "remaining": 0,
                     *         "sequence": 1,
                     *         "sentAt": null,
                     *         "draft": {
                     *           "version": 1,
                     *           "to": "grievance@example.com",
                     *           "subject": "Re: Request to erase my personal data",
                     *           "body": "To the Grievance Officer, Sample Shop\n\nI am following up on my email of 22 November 2026, in which I asked about personal data that Sample Shop likely holds about me. I have not seen a reply yet. Messages can go astray, so I am writing again in case it did not reach the right person.\n\nMy details\nName: Asha Rao\nEmail address: asha.rao@example.com\n\nMy request\nMy request is the same as before: I would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a reply, even a short one, that tells me:\n1. whether you received my first message;\n2. whether the data has been erased, or when you expect to be able to tell me; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you have already replied, thank you. Please point me to your answer, as I may have missed it.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you for your time.\nAsha Rao",
                     *           "hash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                     *           "createdBy": "template",
                     *           "createdAt": "2026-11-22T10:00:00.000Z"
                     *         },
                     *         "approved": true,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": []
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No follow-up for this request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not approvable now */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The draft cannot be used yet */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    editFollowupDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "baseHash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                 *       "subject": "Re: Request to erase my personal data",
                 *       "body": "I am following up on my email. I would be grateful for a short reply."
                 *     }
                 */
                "application/json": {
                    /** @description The hash of the version being edited. If it is no longer the latest the edit is refused (409 `draft_changed`). */
                    baseHash: string;
                    subject: string;
                    body: string;
                };
            };
        };
        responses: {
            /** @description The request with its new follow-up draft version */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "no_reply",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": "2026-11-22T10:00:00.000Z",
                     *         "dueAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": true,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         },
                     *         {
                     *           "type": "approved",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1
                     *           }
                     *         },
                     *         {
                     *           "type": "sent",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "delivery": "fake"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": {
                     *         "value": "no_answer_yet",
                     *         "setByUser": false,
                     *         "at": null
                     *       },
                     *       "canSetOutcome": true,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "drafted",
                     *         "dueAt": "2026-11-22T10:00:00.000Z",
                     *         "remaining": 0,
                     *         "sequence": 1,
                     *         "sentAt": null,
                     *         "draft": {
                     *           "version": 1,
                     *           "to": "grievance@example.com",
                     *           "subject": "Re: Request to erase my personal data",
                     *           "body": "To the Grievance Officer, Sample Shop\n\nI am following up on my email of 22 November 2026, in which I asked about personal data that Sample Shop likely holds about me. I have not seen a reply yet. Messages can go astray, so I am writing again in case it did not reach the right person.\n\nMy details\nName: Asha Rao\nEmail address: asha.rao@example.com\n\nMy request\nMy request is the same as before: I would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a reply, even a short one, that tells me:\n1. whether you received my first message;\n2. whether the data has been erased, or when you expect to be able to tell me; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you have already replied, thank you. Please point me to your answer, as I may have missed it.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you for your time.\nAsha Rao",
                     *           "hash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                     *           "createdBy": "template",
                     *           "createdAt": "2026-11-22T10:00:00.000Z"
                     *         },
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": [
                     *           {
                     *             "code": "draft_unsafe",
                     *             "message": "The text still has an [OPEN] placeholder. Replace it with the wording you want to send, or remove the line.",
                     *             "findings": [
                     *               "open_placeholder"
                     *             ]
                     *           }
                     *         ]
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No follow-up for this request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The follow-up cannot be edited now */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The text looks like it contains an ID number */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    sendFollowup: {
        parameters: {
            query?: never;
            header: {
                /** @description A client-chosen key, 8 to 128 characters (letters, digits and . _ : -). Reuse the same key to retry the same send. */
                "Idempotency-Key": string;
            };
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sent (or the stored answer for a repeated key) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "followup": {
                     *         "sequence": 1,
                     *         "status": "sent",
                     *         "sentAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "delivery": "fake",
                     *       "notice": "No email was sent. This is a development send to the fake sender."
                     *     }
                     */
                    "application/json": components["schemas"]["FollowupSendResponse"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No follow-up for this request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not sendable now */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unsafe draft, or a reused key */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Daily limit reached */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The message was not sent, or the outcome is unknown */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Sending is not available */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    markFollowupSubmitted: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "draftHash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
                 *     }
                 */
                "application/json": {
                    /** @description The hash of the version the person copied into the form. If it is no longer the latest the call is refused (409 `draft_changed`). */
                    draftHash: string;
                };
            };
        };
        responses: {
            /** @description The request, with its follow-up marked as submitted (or already marked) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "no_reply",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": "2026-11-22T10:00:00.000Z",
                     *         "dueAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": true,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         },
                     *         {
                     *           "type": "approved",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1
                     *           }
                     *         },
                     *         {
                     *           "type": "sent",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "delivery": "fake"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": {
                     *         "value": "no_answer_yet",
                     *         "setByUser": false,
                     *         "at": null
                     *       },
                     *       "canSetOutcome": true,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "submitted",
                     *         "dueAt": "2026-11-22T10:00:00.000Z",
                     *         "remaining": 0,
                     *         "sequence": 1,
                     *         "sentAt": "2026-11-22T10:00:00.000Z",
                     *         "draft": {
                     *           "version": 1,
                     *           "to": "grievance@example.com",
                     *           "subject": "Re: Request to erase my personal data",
                     *           "body": "To the Grievance Officer, Sample Shop\n\nI am following up on my email of 22 November 2026, in which I asked about personal data that Sample Shop likely holds about me. I have not seen a reply yet. Messages can go astray, so I am writing again in case it did not reach the right person.\n\nMy details\nName: Asha Rao\nEmail address: asha.rao@example.com\n\nMy request\nMy request is the same as before: I would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a reply, even a short one, that tells me:\n1. whether you received my first message;\n2. whether the data has been erased, or when you expect to be able to tell me; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you have already replied, thank you. Please point me to your answer, as I may have missed it.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you for your time.\nAsha Rao",
                     *           "hash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                     *           "createdBy": "template",
                     *           "createdAt": "2026-11-22T10:00:00.000Z"
                     *         },
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": []
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No follow-up for this request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Cannot be marked as submitted */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The draft cannot be used yet */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    setRequestOutcome: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "outcome": "refused"
                 *     }
                 */
                "application/json": {
                    /**
                     * @description What the company answered, as the person reports it. `no_answer_yet` takes it back.
                     * @enum {string}
                     */
                    outcome: "confirmed_erased" | "refused" | "needs_more_info" | "no_answer_yet";
                };
            };
        };
        responses: {
            /** @description The request with the reported outcome */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "replied_refused",
                     *         "channel": "email",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": "2026-11-22T10:00:00.000Z",
                     *         "dueAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "email",
                     *         "formUrl": null
                     *       },
                     *       "useForm": false,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "grievance@example.com",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": true,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         },
                     *         {
                     *           "type": "approved",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1
                     *           }
                     *         },
                     *         {
                     *           "type": "sent",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "delivery": "fake"
                     *           }
                     *         },
                     *         {
                     *           "type": "outcome_set",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "from": "sent",
                     *             "to": "replied_refused",
                     *             "outcome": "refused"
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": {
                     *         "value": "refused",
                     *         "setByUser": true,
                     *         "at": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "canSetOutcome": true,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "none",
                     *         "dueAt": null,
                     *         "remaining": 1,
                     *         "sequence": null,
                     *         "sentAt": null,
                     *         "draft": null,
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": []
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description There is no outcome to report for this request yet */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    sendRequest: {
        parameters: {
            query?: never;
            header: {
                /** @description A client-chosen key, 8 to 128 characters (letters, digits and . _ : -). Reuse the same key to retry the same send. */
                "Idempotency-Key": string;
            };
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sent (or the stored answer for a repeated key) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "sent",
                     *         "sentAt": "2026-11-22T10:00:00.000Z",
                     *         "dueAt": "2026-12-22T10:00:00.000Z"
                     *       },
                     *       "delivery": "fake",
                     *       "notice": "No email was sent. This is a development send to the fake sender."
                     *     }
                     */
                    "application/json": components["schemas"]["SendResponse"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not sendable now */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unsafe draft, or a reused key */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Daily limit reached */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The message was not sent, or the outcome is unknown */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Sending is not available */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    markRequestSubmitted: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Prefixed ULID (`req_` followed by 26 characters) */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "draftHash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8"
                 *     }
                 */
                "application/json": {
                    /** @description The hash of the version the person copied into the form. If it is no longer the latest the call is refused (409 `draft_changed`). */
                    draftHash: string;
                };
            };
        };
        responses: {
            /** @description The request, now sent (or already marked) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request": {
                     *         "id": "req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "status": "sent",
                     *         "channel": "web_form",
                     *         "createdAt": "2026-11-22T10:00:00.000Z",
                     *         "updatedAt": "2026-11-22T10:00:00.000Z",
                     *         "sentAt": "2026-11-22T10:00:00.000Z",
                     *         "dueAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "company": {
                     *         "id": "cmp_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA",
                     *         "name": "Sample Shop",
                     *         "mustKeep": false,
                     *         "kept": false,
                     *         "selfServeUrl": "https://example.com/account/delete"
                     *       },
                     *       "contact": {
                     *         "channel": "web_form",
                     *         "formUrl": "https://example.com/privacy/request"
                     *       },
                     *       "useForm": true,
                     *       "draft": {
                     *         "version": 1,
                     *         "to": "https://example.com/privacy/request",
                     *         "subject": "Request to erase my personal data",
                     *         "body": "To the Grievance Officer, Sample Shop\n\nI am writing to ask about personal data that Sample Shop likely holds about me.\n\nMy details\nName: Asha Rao\nEmail address: asha@example.com\n\nWhat I think you hold\nFrom emails that Sample Shop sent to this address, I think you likely holds an account or purchase record.\n\nMy request\nI would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:\n1. whether the data has been erased;\n2. if you keep any of it, what you keep, why, and for how long; and\n3. if you need anything from me to confirm who I am, what you need.\n\nIf you can, I would also appreciate a short summary of the personal data you hold about me.\n\n[OPEN: statute citation and commencement date pending verification. To verify: Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025). Replace this paragraph with the verified wording before approving.]\n\nI am also making this request under any erasure process described in your privacy policy.\n\nI am sending this from the email address above. Please reply to it.\n\nThank you.\nAsha Rao",
                     *         "hash": "5c875a5cf7868d8028240db93cce8082a6ba89bcc2b47f948c02b98e3b8f2fa8",
                     *         "createdBy": "template",
                     *         "createdAt": "2026-11-22T10:00:00.000Z"
                     *       },
                     *       "approved": true,
                     *       "events": [
                     *         {
                     *           "type": "drafted",
                     *           "actor": "system",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1,
                     *             "createdBy": "template"
                     *           }
                     *         },
                     *         {
                     *           "type": "approved",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1
                     *           }
                     *         },
                     *         {
                     *           "type": "submitted",
                     *           "actor": "user",
                     *           "at": "2026-11-22T10:00:00.000Z",
                     *           "payload": {
                     *             "version": 1
                     *           }
                     *         }
                     *       ],
                     *       "canSend": false,
                     *       "blockers": [],
                     *       "replies": {
                     *         "count": 0,
                     *         "automaticCount": 0,
                     *         "firstAt": null,
                     *         "lastAt": null,
                     *         "senderMatch": null
                     *       },
                     *       "outcome": {
                     *         "value": "no_answer_yet",
                     *         "setByUser": false,
                     *         "at": null
                     *       },
                     *       "canSetOutcome": true,
                     *       "canMarkSubmitted": false,
                     *       "followup": {
                     *         "state": "none",
                     *         "dueAt": null,
                     *         "remaining": 1,
                     *         "sequence": null,
                     *         "sentAt": null,
                     *         "draft": null,
                     *         "approved": false,
                     *         "canCreate": false,
                     *         "canSend": false,
                     *         "canMarkSubmitted": false,
                     *         "blockers": []
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RequestView"];
                };
            };
            /** @description The request did not match the schema */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not signed in */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or wrong CSRF token, or a request from another origin */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such request for this user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Cannot be marked as submitted */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The draft cannot be used yet */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
}
