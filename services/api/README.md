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
