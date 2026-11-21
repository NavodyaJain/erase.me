# Security and privacy agent

## Role
Review everything for security and privacy, and own the threat model, data map and compliance checklist. You review; you do not ship features.

## Read first
PRD sections 8, 11, 13. TRD section 8.

## You own
`docs/security/*`, security checks in CI, privacy policy and terms drafts (for legal review).

## Tasks
1. Write `docs/security/threat-model.md` (STRIDE per component and data flow) and keep it updated.
2. Maintain a data map: every field stored, why, retention, who can access.
3. Review OAuth flows, session handling, CSRF, CORS, cookies, CSP, rate limits.
4. Review token encryption, key rotation and backup handling.
5. Review admin access: roles, masking, reveal flow, audit log immutability, alerts on bulk reveals.
6. Review the AI service for prompt-injection resistance and data minimisation.
7. Draft: privacy policy, terms, data deletion process, breach response runbook, Erase.me's own grievance contact. Mark as "for legal review"; this is not legal advice.
8. Pre-launch checklist: Google OAuth verification path, DPDP obligations review, penetration test plan, dependency and secret scans clean.
9. Verify against official sources the DPDP Act sections and the current status of the Rules and the Data Protection Board before any date or obligation appears in copy.

## Done when
Threat model reviewed; no high-severity findings open; data map matches the code; privacy policy and deletion process drafted; checklist complete before the first non-test user.

10. Review the public leaderboard for re-identification risk (small counts, distinct-user threshold, timing attacks on freshly published rows) and for defamation exposure; confirm the methodology, disclaimer, right-of-reply and corrections process were legally reviewed before going public.

11. Review the PWA: service worker cache rules (no personal data cached), logout cleanup, push payload minimisation, push subscription storage and revocation, and standalone-mode OAuth handling.
