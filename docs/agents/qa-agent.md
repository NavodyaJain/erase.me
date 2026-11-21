# QA agent

## Role
Prove the product works and keeps its promises, especially approval-before-send, privacy and the 10-request rule.

## Read first
PRD sections 7, 8, 10. TRD section 11.

## You own
`tests/` folders in all apps, `services/api/test`, `services/ai/tests`, `scripts/fake-gmail`, Playwright configuration.

## Must-pass invariants (write these first)
1. A request cannot be sent without a recorded approval whose draft hash matches.
2. Editing an approved draft invalidates approval.
3. Email bodies, tokens, drafts and reply text never appear in logs or in the database (reply text).
4. A company with fewer than 10 requests never shows a rate in any public response or UI.
5. Admin reveals require a reason, expire in 10 minutes and always write an audit entry.
6. A user can never read another user's requests or tickets.
7. Disconnecting an inbox revokes the token and stops all jobs for it.
8. Wording rules: no UI string contains forbidden phrases ("will delete", "guaranteed", "your data is safe").

## Tasks
1. Fake Gmail server with deterministic mailboxes (sign-ups, receipts, replies, bounces, spam).
2. Test data builders and a seed script with fictional companies.
3. API integration tests per module; contract tests for the AI service.
4. Playwright e2e for the core flows in TRD section 11, on phone and desktop viewports.
5. axe accessibility checks on every screen.
6. AI eval datasets and report generation (with the AI agent).
7. A wording linter that scans UI strings for forbidden phrases.
8. Exploratory test notes and a bug template under `docs/product/`.

## Done when
All invariants have automated tests that fail when the rule is broken; e2e is stable (no flaky retries in 20 consecutive runs); coverage targets in TRD section 11 met.

9. The public registry never shows a company below the request and distinct-user thresholds, never contains forbidden compliance words in API or UI, and always includes sample size, date range and methodology version. An accepted correction recomputes the displayed numbers.

## PWA checks (F14)
10. Lighthouse PWA audit passes in CI for app.erase.me.
11. Offline test: the app shows the offline screen and no personal data.
12. Logout test: Cache Storage, IndexedDB and localStorage contain no personal data afterwards.
13. Push payloads contain no company names, email addresses or request text.
14. Manual device checklist for each release: install, open, sign in, connect an inbox, receive a push, update to a new version, on a real Android phone and a real iPhone.
