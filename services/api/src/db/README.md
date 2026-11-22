# Database

Postgres 16. Drizzle schema in `schema/`, SQL migrations in `migrations/` (forward-only).

## Workflow

```
pnpm --filter @erase/api db:generate                       # schema change -> new migration
pnpm exec drizzle-kit generate --custom --name=<name>      # hand-written SQL (roles, grants, triggers)
pnpm --filter @erase/api db:migrate                        # apply, as the owner role (DATABASE_MIGRATION_URL)
```

Never edit an applied migration. Add a new one. Any new table needs a grant in a migration; the integration test
`has every table classified as append-only or mutable` fails until it is added.

## Roles

| Role | Used by | Notes |
| --- | --- | --- |
| `erase` | migrations | Owner. Local superuser from docker-compose. |
| `erase_app` | (group) | `NOLOGIN`, created by migration 0001, holds the app privileges. |
| `erase_api` | the API (`DATABASE_URL`) | Login role, member of `erase_app`. Created by `infra/docker/postgres/init`. |

The app role can INSERT and SELECT on `request_events`, `request_drafts` and `audit_log`, never UPDATE or DELETE.
It has no DELETE anywhere in Phase 1. Purging and account deletion (Phase 2) run as the owner.

## Rules enforced in the database

- Ids are prefixed ULIDs (`usr_`, `req_`, ...).
- A request cannot leave `drafted` or `approved` without a user `approved` event for the latest draft (migration 0002).
  The service enforces the same rule first; this is the backstop.
- A request can only point at a company of the same user, and a detected company only at an inbox of the same user.
- One open request per detected company; one active scan per inbox.
- A grievance contact needs a source page and verification date. Fictional entries are `@example.com` only.
- A connected inbox has an encrypted token. A disconnected one has none and has `purge_after` set (retention field; the purge job is Phase 2).
- No column stores received email content. Only `request_drafts.subject` and `.body` hold text, and that is the draft the user approves.

## Auth tables (migrations 0003 and 0004)

- `sessions`: server-side sessions. Only the SHA-256 of the cookie token is stored. 30-day sliding expiry; a new row at every sign-in.
- `oauth_states`: one row per Google authorization attempt (state hash, PKCE verifier, nonce). Single use, 10 minutes.
- Both are mutable (revoke, consume) with no DELETE for the app role. Expired rows are removed by the Phase 2 owner-role purge job.

## Idempotency (migrations 0005 and 0006)

- `idempotency_keys`: one claim per send (`scope = 'send'`). Unique per `(user_id, scope, key)`, and a partial unique index allows only one `in_progress` or `completed` send per request, whatever key it used. `failed` frees the request for another attempt; an unknown outcome stays `in_progress` on purpose.
- Holds ids, status codes and the response to replay. Never draft text or addresses. Mutable (INSERT, SELECT, UPDATE), no DELETE.

## Contact channels and the self-serve link (migration 0007)

- `companies.grievance_channel` is `email` (default) or `web_form`. An email contact has `grievance_email`; a web form has `grievance_form_url` and no address. Never both (`companies_channel_fields`).
- Either kind needs `grievance_source` (the company's own page) and `grievance_verified_on` (`companies_grievance_provenance`). A `verified` contact needs the field its channel uses (`companies_verified_has_contact`).
- `grievance_form_url` and `self_serve_url` must be `https` (`companies_urls_https`). Fictional entries may only point at example.com (addresses, forms and links alike), and real entries never do.
- `self_serve_url` is the company's own account-deletion page, shown to the user before a request by email. Optional.

## `request_drafts.to_email` holds the destination (decision)

For a company that takes requests by email, `to_email` is the verified address. For a `web_form` company it holds the **form URL**. The column keeps its name because renaming it would touch an append-only table and every query for no gain: a draft has exactly one destination, the draft hash covers it (so a changed form link is a changed draft), and the service reads it only through `destinationOf(company)`. A draft whose destination does not match the company's current contact is refused at approval and send (`contact_changed`). Nothing sends to a form URL: the sender is never called for a web-form request (`use_form`). The column has no format check, so it accepts either.

## Differences from TRD 6.4

- `companies.grievance_verified_on` is a `date` (was `grievance_verified_at`); added `is_fictional`.
- `request_events.draft_hash` is a column, not a payload field, so the approval guard can query it.
- `request_drafts.created_by` also allows `template` (Phase 1 drafts come from a fixed template, not the AI service).
- `inboxes.purge_after` added for the retention field.
- Sessions and OAuth state are tables of their own (TRD 8.1 says Redis or Postgres; Postgres keeps Phase 1 to one store).
- `audit_log.ip` is personal data. Decide its retention before admin ships.
