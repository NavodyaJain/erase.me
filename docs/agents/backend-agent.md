# Backend agent

## Role
Build and maintain the core API, database and jobs. You are the system of record and the only holder of Gmail tokens.

## Read first
PRD sections 7, 8, 11. TRD sections 2, 6, 8, 11, 12.

## You own
`services/api`, `packages/contracts` (generated), `services/api/openapi`, database migrations.

## Stack
Node 20, TypeScript strict, Fastify, Zod, `zod-to-openapi`, Drizzle (or Prisma, confirm), PostgreSQL 16, Redis + BullMQ, Vitest, Supertest, Testcontainers.

## Rules
1. Module layout: controller → service → repository. No business logic in controllers. Only repositories touch the DB.
2. Schema-first: define Zod schemas, derive types and OpenAPI. CI fails if generated contracts drift.
3. Never store email bodies, attachments or full subject lines. Never log tokens, addresses, drafts or reply text.
4. Encrypt Gmail refresh tokens with envelope encryption; store key id; support rotation.
5. Enforce the request state machine in one place. `send` requires a prior `approved` event whose `draft_hash` matches the current draft. Write a test that proves a request cannot be sent without approval.
6. `request_events` and `audit_log` are append-only; the app DB role has no UPDATE/DELETE on them.
7. Every admin read of personal data writes an audit entry before returning. Reveal requires `reason` and expires in 10 minutes.
8. Public registry endpoints must hide any company with fewer than 10 requests and never return per-request data.
9. All POSTs that send or create accept an `Idempotency-Key`. Jobs are idempotent with retries and a dead-letter queue.
10. Call the AI service only via `src/clients/ai` with typed, validated requests and a timeout; handle outages gracefully (queue and retry, surface "drafting delayed").

## Tasks (in order)
1. Config with validated env; health endpoint; logger with PII scrubber; problem-details errors.
2. Migrations for: users, inboxes, scans, companies, user_companies, requests, request_drafts, request_events, reply_labels, audit_log, admin_users, tickets, ticket_messages, registry_stats, feature_flags.
3. Auth: Google OIDC sign-in, sessions, CSRF, logout, account deletion job.
4. Gmail module: connect/disconnect, token encryption, scan job (metadata only), sending, reply polling, bounce detection. Build against an interface so the fake Gmail can stand in.
5. Companies module and catalog; "not mine" and merge.
6. Requests module: drafts via AI client, edit, approve, send, follow-up, proof pack PDF, tracker queries.
7. Overview endpoint (F3).
8. Registry: `registry_stats` refresh job and public endpoints with the 10-request rule.
9. Tickets module and admin module (requests review, tickets, companies, users masked + reveal, audit, health).
10. Deferred: money, kyc, aliases.

## Done when
OpenAPI complete and clients regenerate cleanly; unit and integration tests pass; state machine and approval guard 100% covered; migrations run from scratch and upgrade; no PII in logs (test with a log-capture assertion); load test shows scans do not exceed Gmail quotas.

## Registry methodology (F9b)
Implement `registry_methodology`, versioned `registry_stats`, company statements and corrections per TRD 6.3/6.4. Public output must enforce min requests, min distinct users, rounded percentages, sample size and date range, and must never contain the words compliant/non-compliant/violating/illegal.
