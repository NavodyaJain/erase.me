# API contract

`openapi.json` is the contract for the core API (OpenAPI 3.1). It is **generated** from the zod schemas in `src/contract/` and checked in. Do not edit it by hand.

```
pnpm --filter @erase/api openapi:generate     # rewrite openapi.json after changing a schema or a route
pnpm --filter @erase/api openapi:check        # fails if the committed file is out of date (CI runs this)
pnpm --filter @erase/contracts generate       # regenerate the TypeScript types from it
```

Adding or changing an endpoint means: change the schema in `src/contract/schemas.ts`, add or edit the operation in `src/contract/routes.ts` (with a fictional example), regenerate both files, and commit them. Tests fail if a served `/v1` route is missing from the document (or the reverse), if a real response does not match its documented schema, or if an error `code` is returned that the document does not list for that operation.

Examples use fictional companies and `example.com` addresses only. Nothing here is personal data.

## Calling the API

- **Session.** Sign in through the browser at `GET /v1/auth/google/start`. The `erase_session` cookie (HttpOnly) identifies the user. Send every call with credentials included.
- **CSRF.** Every POST, PUT, PATCH and DELETE needs the `x-csrf-token` header (the `csrfToken` from `GET /v1/me`) and a browser `Origin` that is the web app. `@erase/api-client` does both.
- **Idempotency.** `POST /v1/requests/{id}/send` needs an `Idempotency-Key` header. Make one key per "send" action and reuse it for every retry.

## Errors

Failures are RFC 9457 problem details (`application/problem+json`):

```json
{ "type": "urn:erase:problem:draft_changed", "title": "The draft changed", "status": 409,
  "code": "draft_changed", "detail": "The text you approved is not the latest version. Review it again.",
  "instance": "/v1/requests/req_.../approve", "requestId": "..." }
```

Branch on `code`. `title` and `detail` are sentences for a person; they never contain draft text, addresses or tokens. Three codes carry extra fields: `use_form` (`formUrl`, `selfServeUrl`), `draft_unsafe` (`findings`, kinds only) and `validation_failed` (`errors`: path and rule, never the submitted value).

| Status | Code | Meaning and what to do |
| --- | --- | --- |
| 400 | `validation_failed`, `malformed_request` | The request did not match the schema. Fix it. |
| 400 | `idempotency_key_required`, `idempotency_key_invalid` | Send a well-formed `Idempotency-Key` on send. |
| 401 | `unauthorized` | Not signed in. Go to sign-in. |
| 403 | `forbidden` | Missing or wrong CSRF token, or a request from another origin. Refresh the token from `GET /v1/me` once. |
| 404 | `not_found` | No such resource for this user. Another user's resource looks the same. |
| 409 | `draft_changed` | **Stale hash.** The draft changed since the person saw it (edit, or approve with an old `draftHash`). Reload the request and show the latest version. |
| 409 | `use_form` | **Web-form company.** It cannot be sent by email. Show the draft to copy and link to `formUrl`. |
| 409 | `must_keep` | The company is needed to keep an account working (for example the account provider). No deletion request is offered. Explain; do not promise anything. |
| 409 | `kept` | The user chose "keep this". Offer to undo it (`DELETE /v1/companies/{id}/keep`) to continue. |
| 409 | `no_contact`, `contact_bounced`, `contact_changed` | No verified grievance contact (or it stopped working or changed). The request is blocked until it is checked or recreated. |
| 409 | `approval_required`, `already_sent`, `send_in_progress`, `invalid_transition`, `request_not_editable`, `request_not_closable`, `company_excluded`, `fictional_company`, `inbox_not_connected`, `inbox_limit`, `draft_integrity` | The request or company is not in a state where that is allowed. The `detail` says why. |
| 422 | `draft_unsafe` | The text looks like it holds an ID-like number, or still has an `[OPEN]` placeholder. `findings` names the kinds. Ask the person to edit it. |
| 422 | `idempotency_key_reuse` | That key was used for a different request. Make a new key. |
| 429 | `rate_limited`, `daily_cap_reached` | Slow down; or the daily limit for sent requests was reached. |
| 502 | `send_failed` | Gmail did not accept the message; nothing was sent. Retrying with the same key is safe. |
| 502 | `send_outcome_unknown` | Gmail did not confirm. The request is **not** marked sent and is **not** retried automatically. Tell the person to check the Sent folder in Gmail. |
| 503 | `real_send_blocked`, `send_disabled` | Sending is switched off here (real sending is off until it is enabled and the statute wording is verified). The draft can still be edited and approved. |
| 503 | `auth_not_configured`, `encryption_not_configured`, `not_ready` | The server is missing configuration. |

## Outcomes that are not errors

`POST /v1/requests/drafts` answers 200 with one outcome per company. Treat each as data:

| `outcome` | Meaning |
| --- | --- |
| `created` | An email request was made; `requestId` is set. |
| `existing` | The company already has an open email request; `requestId` is set. |
| `use_form` | A web-form company: a request holds a draft to copy, and `formUrl` says where to paste it. |
| `kept` | The user chose to keep this company, so no request is made. `message` explains. |
| `blocked` | See `reason`: `must_keep`, `no_contact`, `contact_bounced`, `company_excluded`, `not_found`. `message` explains, without any promise about deletion. |

`selfServeUrl` (the company's own account-deletion page) is returned when the catalog has one, so it can be shown before a request by email. It is never given for a must-keep company.

## Wording

Results are hints from header metadata, never statements of fact: `confidence` is `high` (likely holds data) or `low` (may hold), and `activity` is `looks_in_use` or `looks_unused`, a hint and never a decision. The API makes no promise about what a company does with a request.
