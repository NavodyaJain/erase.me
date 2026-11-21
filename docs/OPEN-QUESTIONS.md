# Open questions and decisions log

Items marked **[OPEN]** in the PRD and TRD, with the owner's answers (2026-11-21). Phase 1 covers F1, F2, F3 (minimal), F6, F7 (states only), F14.

## Answered for Phase 1

| Item | Source | Decision |
| --- | --- | --- |
| Overview cards for deferred features | PRD F3 | Show Companies and Control. Money and Risk render "Not available yet". Drop the Subscriptions table and the alias row. |
| Grievance contact source | PRD F6-AC4 | Reviewed `catalog.json`. Every entry needs `email`, `source_url` (the company's published privacy or grievance page) and `verified_on`. Fictional dev entries use `@example.com` and `fictional: true`. Never invent real addresses. Unknown contact blocks the draft. Real entries are added by the owner later. |
| Draft template wording | PRD 7.5 | Written from PRD 7.5, flagged for the owner's legal review. No legal conclusions, no threats. The statute citation is **[OPEN]** until the owner verifies it. |
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

## Design drift found by the banned-word lint

The boards state "leaked" as fact. PRD 4.4 says use "may have shared". Boards are unedited; fix when those screens are built.
- `Main.dc.html:341` landing hero: "Spot who leaked your email"
- `DesktopLeak.dc.html:31`: "so you can see who leaked it"
- `Leak.dc.html:89`: status chip "Leaked"
