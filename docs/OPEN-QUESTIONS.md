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
- **Statute citation.** Drafts carry a visible `[OPEN: ...]` line until the owner verifies the wording and replaces `STATUTE_CITATION` in `services/api/src/modules/requests/draft-citation.ts` (set `verified: true` and check `line`). Approval and sending refuse any text that still contains `[OPEN`, so the marker has to be edited out or replaced. **Real sending stays off until then**, whatever `ALLOW_REAL_SEND` says: the sender is `real_send_blocked`, not a quiet fallback to the fake.
- **Sender selection.** `ALLOW_REAL_SEND=true` (not in a test run) and a verified citation: real Gmail send, capped per user per day by `REAL_SEND_DAILY_CAP`. Otherwise development and test use the fake sender, labelled `delivery: "fake"` with a notice in the response and in the `sent` event payload, and nothing leaves the machine. Staging and production with the flag off answer 503 `send_disabled`.
- **ID numbers.** Rules only. A 12-digit run counts as an Aadhaar number only if it passes Verhoeff and starts with 2-9. PAN, passport, voter ID (EPIC), GSTIN and Luhn-valid card numbers are blocked too. They are refused when a draft is edited, and checked again at approval and at send. Reports kind only, never the text.
- **Recipient.** Fixed from the verified contact; the user edits subject and body only. If the contact changes after the draft was made, sending is refused (`contact_changed`) and the request must be closed and recreated.
- **Missing contact.** The draft is blocked with an explanation, and `audit_log` gets `company.contact_missing` as a stand-in for the admin task (F6-AC4) until the admin module exists.
- **Close before sending** is included (`POST /v1/requests/:id/close`), so a request can be discarded and the company freed for a new one.
- **Gmail label.** `Erase.me/Requests` is skipped: creating labels needs a scope (`gmail.labels` or `gmail.modify`) we did not request. Replies will be tracked by the stored thread id.
- **Unknown send outcome.** If Gmail times out or answers unreadably after we may have handed it the message, the idempotency claim stays `in_progress`, the request is not marked sent, nothing is retried automatically, and the user is told to check the Sent folder. Nothing in Phase 1 resolves such a request after that: it needs a manual fix by the owner (mark it sent, or fail the claim so it can be tried again). Decide how this should work in the admin module.
- **OpenAPI** for these routes is skipped until the contracts task.

Left for later: `must_keep` is enforced at create, approve and send. The reply states, follow-up and proof pack stay unbuilt, and no job moves a request past `sent`.

## Design drift found by the banned-word lint

The boards state "leaked" as fact. PRD 4.4 says use "may have shared". Boards are unedited; fix when those screens are built.
- `Main.dc.html:341` landing hero: "Spot who leaked your email"
- `DesktopLeak.dc.html:31`: "so you can see who leaked it"
- `Leak.dc.html:89`: status chip "Leaked"
