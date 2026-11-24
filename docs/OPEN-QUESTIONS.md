# Open questions and decisions log

Items marked **[OPEN]** in the PRD and TRD, with the owner's answers (2026-11-21). Phase 1 covers F1, F2, F3 (minimal), F6, F7 (states only), F14.

## Answered for Phase 1

| Item | Source | Decision |
| --- | --- | --- |
| Overview cards for deferred features | PRD F3 | Show Companies and Control. Money and Risk render "Not available yet". Drop the Subscriptions table and the alias row. |
| Grievance contact source | PRD F6-AC4 | Reviewed `catalog.json`. Every entry needs `email`, `source_url` (the company's published privacy or grievance page) and `verified_on`. Fictional dev entries use `@example.com` and `fictional: true`. Never invent real addresses. Unknown contact blocks the draft. Real entries are added by the owner later. |
| Draft template wording | TRD 7.5, PRD F6 | Written from TRD 7.5 (prompt and output rules) and PRD F6, with the PRD 4.4 wording rules; flagged for the owner's legal review. (This row said "PRD 7.5", which does not exist.) No legal conclusions, no threats. The statute citation is **[OPEN]**: drafts carry a visible [OPEN] marker, approval and sending refuse text that still has it, and real sending stays off until the owner verifies the wording and replaces the constant in `services/api/src/modules/requests/draft-citation.ts`. |
| Reply handling | PRD F7 | Reply states exist in the state machine. No job moves a request past `sent` in Phase 1. |
| Registry | PRD F9 | No registry code in Phase 1 (not even the 10-request and 5-user guard). |
| Key management | TRD 8.3 | A local master key from the environment behind a `KeyProvider` interface so KMS can replace it. Never committed. |
| Store subject text | PRD F2-AC4 | No (default). |
| Retention after inbox disconnect | PRD section 8 | Default: keep detected companies 30 days after disconnect, then delete. Phase 1 builds the retention field only (`inboxes.purge_after`). |
| Real sends | AGENTS.md rule 1 | Off by default. Dev and test send only to the fake Gmail. A real send needs `ALLOW_REAL_SEND=true` and a per-user daily cap. |

## Still open, not Phase 1

- DPDP commencement and rules status (PRD F9b rule 9, risks). No dates in copy until verified.
- Hosting vendors for API, AI, Postgres, Redis (TRD 4, 16).
- Embedding model and provider zero-retention terms (TRD 4, 7.7).
- Cancellation help scope (PRD F4, deferred).
- Manual "forward receipts" fallback if Gmail verification is not obtained (TRD 15).
- Gmail push (Pub/Sub) vs polling, reply-text-in-memory confirmation, persisting reply subject lines (TRD 16).

## Phase 2 tasks noted

- `purge-deleted` job: hard-delete detected companies 30 days after inbox disconnect (`inboxes.purge_after`) and personal data within 30 days of account deletion. Append-only tables (`request_events`) need a documented owner-role purge path.
- Row-level security on user-owned tables (TRD 6.4 assumption) is not in Phase 1; ownership is enforced in the service layer and tested.

- Purge of `sessions` and `oauth_states` rows that are expired or consumed (the app role has no DELETE).
- Account deletion today (task 3): sessions end at once, Gmail tokens are revoked and dropped, and the user row is anonymised (email, name and Google id replaced). Rows that reference the user (detected companies, requests, events) remain until the owner-role purge deletes them. This does not yet meet "personal data deleted within 30 days"; the purge job does.
- Scan jobs and the deletion job run in-process (`src/jobs/queue.ts`) behind a `JobQueue` interface. Moving them to BullMQ on Redis needs `bullmq` and `ioredis` and is not done yet.
- The Gmail client is a small `fetch` wrapper (list, metadata) rather than the `googleapis` package, which is very large. Sending, reply polling and bounce detection are not in the Gmail module yet; sending arrives with the requests module so it sits behind the approval guard.
- A scan creates a placeholder company (name from the domain, category `other`, no grievance contact) for any sender domain the catalog does not list. Placeholders cannot be drafted until a reviewed catalog entry exists. Decide whether the catalog task should merge or prune them.
- The Google callback is shared: sign-in and inbox connect both use `/v1/auth/google/callback`, told apart by server-side state. This keeps one registered redirect URI. Post-login redirects (`/?auth_error=<code>`, `/?inbox=connected`) are provisional until the web routes exist.

- Detection rules (scan tuning): a company is "likely" (high) with a welcome, receipt or transactional signal, or two different kinds of signal, and "possible" (low) with only bulk-mail headers (list-unsubscribe, newsletter) or only a verify prompt. `list_unsubscribe` plus `newsletter` count as one kind. Confirm this rule; it is in `detection-rules.ts` (`confidenceFor`).
- Email-delivery services (SendGrid, Mailchimp, Elastic Email and so on) are never companies. The brand is taken from Reply-To, then from List-Unsubscribe hosts; otherwise the message is skipped. The list is `DELIVERY_DOMAINS` in `detection-rules.ts`.
- `must_keep` lives in the catalog and on `companies.must_keep`. Google is must-keep. A must-keep company gets `risk_level = must_keep` for the user and no grievance contact, so the requests module must refuse to draft for it and the UI must not promise deletion. That refusal is not built yet (requests module).
- Catalog: `services/api/catalog/catalog.json` (committed, reviewed) plus `catalog.local.json` (gitignored, for names of services seen in one person's own inbox, since committing those would publish which services they use). The catalog is synced into `companies` at start-up. Merging duplicate companies that share a brand (for example two domains already stored as two rows) belongs to the companies task.
- Scan limits are configurable: `SCAN_WINDOW_YEARS` (default whole mailbox), `SCAN_MAX_MESSAGES` (default 50000), `SCAN_EXCLUDE` (employer domains or addresses). Gmail request pacing is unchanged (15 per second in the scan).
- Rows recorded before these rules (for example a sending service stored as a company) are not deleted, since the app role cannot delete; they are filtered out when results are read.

## Requests, drafts and sending (Phase 1, task 5)

Decided by the owner (2026-11-22):
- **Statute citation.** (Superseded by the 2026-11-22 update below: the gate now covers the date too.) Drafts carry a visible `[OPEN: ...]` line until the owner verifies the wording and replaces `STATUTE_CITATION` in `services/api/src/modules/requests/draft-citation.ts` (set `verified: true` and check `line`). Approval and sending refuse any text that still contains `[OPEN`, so the marker has to be edited out or replaced. **Real sending stays off until then**, whatever `ALLOW_REAL_SEND` says: the sender is `real_send_blocked`, not a quiet fallback to the fake.
- **Sender selection.** `ALLOW_REAL_SEND=true` (not in a test run) and a verified citation: real Gmail send, capped per user per day by `REAL_SEND_DAILY_CAP`. Otherwise development and test use the fake sender, labelled `delivery: "fake"` with a notice in the response and in the `sent` event payload, and nothing leaves the machine. Staging and production with the flag off answer 503 `send_disabled`.
- **ID numbers.** Rules only. A 12-digit run counts as an Aadhaar number only if it passes Verhoeff and starts with 2-9. PAN, passport, voter ID (EPIC), GSTIN and Luhn-valid card numbers are blocked too. They are refused when a draft is edited, and checked again at approval and at send. Reports kind only, never the text.
- **Recipient.** Fixed from the verified contact; the user edits subject and body only. If the contact changes after the draft was made, sending is refused (`contact_changed`) and the request must be closed and recreated.
- **Missing contact.** The draft is blocked with an explanation, and `audit_log` gets `company.contact_missing` as a stand-in for the admin task (F6-AC4) until the admin module exists.
- **Close before sending** is included (`POST /v1/requests/:id/close`), so a request can be discarded and the company freed for a new one.
- **Gmail label.** `Erase.me/Requests` is skipped: creating labels needs a scope (`gmail.labels` or `gmail.modify`) we did not request. Replies will be tracked by the stored thread id.
- **Unknown send outcome.** If Gmail times out or answers unreadably after we may have handed it the message, the idempotency claim stays `in_progress`, the request is not marked sent, nothing is retried automatically, and the user is told to check the Sent folder. Nothing in Phase 1 resolves such a request after that: it needs a manual fix by the owner (mark it sent, or fail the claim so it can be tried again). Decide how this should work in the admin module.
- **OpenAPI** for these routes is skipped until the contracts task.

### Draft wording and contact channels (2026-11-22)

Decided by the owner:
- **A request, not a demand.** DPDP rights (sections 11-13) are expected to commence about 13 May 2027 (18 months from 13 November 2025). Until then drafts are polite requests. The template asks for erasure with reference to Section 12(3) of the Act, optionally for a short summary of the data held (Section 11(1)), says the rights provisions are notified to commence in May 2027 so this is a request now, and says the request is also made under any erasure process described in the company's own privacy policy (a generic sentence, not a link). "Within 30 days" is worded as something the user would be grateful for, never a deadline. No threat, no "legally required", no accusation. Tests check the rendered text against the banned words and a list of legal-demand phrases.
- **One gate for the statute and the date.** This resolves the earlier "no dates in copy until verified" rule: the section numbers and the May 2027 sentence live in one paragraph behind `STATUTE_CITATION.verified` (`draft-citation.ts`). While it is false the draft shows a single `[OPEN: ...]` paragraph in their place, nothing else in the text carries a section number or a date, approval and sending refuse the marker, and real sending stays blocked. **To do (owner): verify the wording, the section numbers and the commencement date against official sources, edit the constants, set `verified: true`.** PRD F6 still says drafts "cite the section and ask for written confirmation within 30 days"; this wording supersedes it.
- **Contact channels.** A company contact is an email address or a web form. A web form cannot be sent by email: creating a request returns outcome `use_form` with the link and a draft to copy and paste; approve and send answer 409 `use_form` with the same link. "Mark as submitted" is left for the tracker task, so a web-form request stays `drafted` until the user closes it. `request_drafts.to_email` holds the form URL for these (see the db README).
- **Self-serve link.** A catalog entry may carry `self_serve_url` (the company's own account-deletion page). It is shown before a request by email: in the create results, the request view, the detections list and the dev page. Never for a must-keep company.
- **No real contacts in the repo.** The committed catalog has only fictional entries on example.com (including one web form and one self-serve link). Real emails, form URLs and self-serve links are added by hand from each company's own page, in `catalog.json` or `catalog.local.json`, with `source_url` and `verified_on`.

### Keep this, the activity hint and the API contract (2026-11-22)

Decided by the owner:
- **"Keep this".** `PUT` and `DELETE /v1/companies/:id/keep` (idempotent; `:id` is the detected-company id). A kept company is never offered for a request: create answers outcome `kept`. A request already in progress is **refused at approve and send with 409 `kept`** (like `must_keep`), and goes on once the user clears it. Editing and closing still work, and an already-sent request is unaffected (a new send key still answers `already_sent`). Keep on a must-keep company answers 409 `must_keep`, on a "not mine" company 409 `company_excluded`. Each change writes an `audit_log` entry (`company.keep_set`, `company.keep_cleared`).
- **Activity hint.** `user_companies.last_transactional_at` is set by the scan to the date of the latest receipt or transactional message (header signals and dates only). "Looks in use" means one within `ACTIVITY_RECENT_DAYS` (90); "looks unused" means the last message of any kind is older than `ACTIVITY_OLD_DAYS` (365); otherwise none. A company scanned before the column existed gets no "in use" hint until a rescan. It is a hint only and changes nothing about what a user can do.
- **No pagination** on `GET /v1/companies` for now.
- **API contract.** `services/api/openapi/openapi.json` is generated from zod (`src/contract`), checked in, and kept current by a CI check. `@erase/contracts` holds the generated types and `@erase/api-client` is the typed client (cookies, CSRF header, required Idempotency-Key on send). Both are source-only packages with no build step. See `services/api/openapi/README.md` for the error and outcome shapes.
- New dev dependencies are pinned to exact versions: `@seriousme/openapi-schema-validator`, `ajv`, `ajv-formats`, `openapi-typescript`, `openapi-fetch`.

Left for later: the dev page shows the hint and "kept" but has no Keep button; the contract has no pagination parameters yet.

Left for later: `must_keep` is enforced at create, approve and send. The reply states, follow-up and proof pack stay unbuilt, and no job moves a request past `sent`.

## Phase 2: tracking after send (decisions, 2026-11-24)

Approved plan, with these answers:
- Reply tracking needs **no Gmail scope beyond `gmail.readonly` and `gmail.send`**, which we already request. Google lists `gmail.readonly` among the scopes of `users.threads.get`, and `format=metadata` with `metadataHeaders` is supported. The reply check asks for a partial response (`fields`), so no snippet or body is transferred, and the client drops any it is given.
- The outcome (Confirmed erased, Refused, Needs more info, No answer yet) is set by the user, also when no reply was detected. Erase.me never infers it. "No answer yet" returns the request to sent, or to no_reply once the follow-up day has passed. Outcomes are shown as "Reported by you" and must not be published as company facts.
- An automatic reply gets its own "Automatic reply" label. It does not change the status and does not stop the follow-up clock.
- One follow-up per request, in the app only, no day-14 nudge. The follow-up wording is drafted for the owner's review before anything can be sent, and its statute wording stays behind the same citation gate.
- "Mark as submitted" for web-form requests is in scope. Bounce detection is not.
- "Delete my data" is the existing delete-account flow: 7 days to undo, or "Delete now". Polling, follow-up sweeps and all sends for that user pause during the 7 days, and the "Your data" screen says so. Token revoke is attempted for each inbox; a failure is recorded (counts only) and the person is told to remove access in their Google account settings. A tombstone user row stays with no personal data (no email, no hash of it).
- Purge runs through `SECURITY DEFINER` functions. Closed requests' drafts are not purged on a timer.
- Jobs run in the API process behind a scheduler interface (Postgres advisory lock per task). BullMQ and Redis stay deferred.

## Design drift found by the banned-word lint

The boards state "leaked" as fact. PRD 4.4 says use "may have shared". Boards are unedited; fix when those screens are built.
- `Main.dc.html:341` landing hero: "Spot who leaked your email"
- `DesktopLeak.dc.html:31`: "so you can see who leaked it"
- `Leak.dc.html:89`: status chip "Leaked"

Status after the web build (task 7): the app does not copy this wording. Phase 1 builds no Leak screen, and the landing hero is not built, so the three lines above are flagged, not fixed in the boards. The Home and Desktop boards also say a company "may have leaked" an address; the app uses the hedged "may hold your data" instead. When the Leak screen is built (Phase 2), take its wording from PRD 4.4, not from the board.
