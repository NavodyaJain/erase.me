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
