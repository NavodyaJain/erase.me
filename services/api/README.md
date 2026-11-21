# services/api
The single core backend (TypeScript). Owns the database and all business rules.
- `src/modules/*`  one folder per domain (controller, service, repository, schema, tests)
- `src/clients/ai` the only place that calls `services/ai`
- `src/jobs`       queue workers (scans, reminders, day-30 follow-ups)
- `openapi/`       API contract, source of truth for `packages/contracts`
Rules: validate every input, no business logic in controllers, every admin/support read writes an audit entry.
