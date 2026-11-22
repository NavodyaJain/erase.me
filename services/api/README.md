# services/api
The single core backend (TypeScript). Owns the database and all business rules.
- `src/modules/*`  one folder per domain (controller, service, repository, schema, tests)
- `src/clients/ai` the only place that calls `services/ai`
- `src/jobs`       queue workers (scans, reminders, day-30 follow-ups)
- `openapi/`       API contract, source of truth for `packages/contracts`
Rules: validate every input, no business logic in controllers, every admin/support read writes an audit entry.

## Dev helper (local only)
`pnpm --filter @erase/api dev` serves a small page at <http://localhost:4000/dev/connect>: sign in, connect a Gmail inbox, run a scan, read a table of company, first seen, last seen and signals. It never shows or keeps subjects or sender addresses, and it cannot send.
- Code is in `src/dev/`, started only by `src/dev/dev-server.ts`. `src/server.ts` (the production entry) does not import it and `tsconfig.build.json` excludes it.
- It refuses to start when `NODE_ENV` is `production` or `staging`, or when `API_HOST` is not a loopback address.
- Needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `TOKEN_MASTER_KEY` in `.env`, and `make up` plus `db:migrate` first.
- Its routes are under `/dev` and are not part of the OpenAPI contract.

## Catalog and detection rules
- `catalog/catalog.json` is the reviewed company catalog: display name, domains, category, `must_keep`, and (only when checked against its source) a grievance contact. `catalog/catalog.local.json` is optional, gitignored, and overrides by slug. Both are validated at start-up and synced into `companies`.
- `src/modules/gmail/detection-rules.ts`: delivery-service domains, exclusions and the confidence rule. `signals.ts`: what a message's headers say. Header metadata only; no bodies.
- Scan limits are set in `.env`: `SCAN_WINDOW_YEARS`, `SCAN_MAX_MESSAGES`, `SCAN_EXCLUDE`. `pnpm --filter @erase/api dev:coverage` prints message counts (no content) to show whether a cap, a window or the search itself limits a scan.

## Requests (drafts, approval, send)
`src/modules/requests`: state machine (`state-machine.ts`), draft template and hash, ID-number guard, service with the approval and send guards, routes.
- `POST /v1/requests/drafts` (batch), `GET /v1/requests`, `GET /v1/requests/:id`, `PATCH /v1/requests/:id/draft`, `POST /v1/requests/:id/approve`, `POST /v1/requests/:id/close`, `POST /v1/requests/:id/send` (needs `Idempotency-Key`).
- An approval is bound to the sha256 of recipient, subject and body. An edit makes a new version and a new hash, and puts the request back to `drafted`.
- Send needs a user approval of the current hash (application guard; migration 0002 enforces it again), a verified contact, a company that is not must-keep, and text without ID numbers or an `[OPEN]` placeholder.
- A web-form company (`grievance_channel = web_form`) cannot be sent by email: create answers outcome `use_form` with the link and a draft to copy and paste, and approve and send answer 409 `use_form`. The optional `self_serve_url` of a company is returned with the create results and the request view.
- Drafts are polite requests, not demands. The statute sections and the commencement date sit behind one flag in `draft-citation.ts`.
- Real sending is off until the owner verifies the statute citation (`draft-citation.ts`) and sets `ALLOW_REAL_SEND=true`. In development and test the fake sender is used and every response says so.

## Companies, keep, and the contract
- `GET /v1/companies` lists the user's detected companies (confidence, signals, `mustKeep`, `kept`, activity hint, self-serve link, open request). `PUT` and `DELETE /v1/companies/:id/keep` set and clear "keep this".
- The API contract is `openapi/openapi.json`, generated from `src/contract` (`pnpm --filter @erase/api openapi:generate`; `openapi:check` fails if it is stale, and CI runs it). See `openapi/README.md`. The typed client is `@erase/api-client`, built on the generated types in `@erase/contracts`.
