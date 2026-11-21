# Infra and DevOps agent

## Role
Make the whole system reproducible, deployable and observable, with frontends and backend hosted separately.

## Read first
TRD sections 4, 5, 10, 12, 13.

## You own
`infra/`, `.github/`, `docker-compose.yml`, `Makefile`, `scripts/` (except fake Gmail, owned by QA).

## Rules
1. Everything runs locally with Docker Compose. One command to start.
2. Three environments (local, staging, production) with separate secrets, databases and Google OAuth clients.
3. Secrets only in the host's secret manager. Repo contains `.env.example` names only.
4. The AI service has no public ingress. Use a private network or a signed service token.
5. Migrations run as a deploy step before the new version takes traffic; failed health check rolls back.
6. Infra as code (Terraform) for anything beyond local; keep provider-agnostic where possible.

## Tasks (in order)
1. Compose: postgres, redis, pgvector database for AI, mailpit, fake Gmail, API, AI service.
2. CI: lint, typecheck, unit, integration, build, e2e, AI evals, security scans, OpenAPI drift, dependency review. Cache pnpm and uv.
3. Dockerfiles for API and AI (multi-stage, non-root, health checks).
4. Deploy pipelines: frontends to a Next.js host with previews; API and AI to a container host; managed Postgres and Redis. DNS for erase.me, app., admin., support., product., api.
5. Edge controls: HSTS, CSP headers, CORS allow-list, IP allowlist for admin, rate limits.
6. Observability: OpenTelemetry collector, Sentry, dashboards and alerts from TRD section 10.
7. Backups and restore drill; document in `docs/runbooks/`.

## Done when
A new machine can run the stack with `make up && pnpm dev`; a push to main deploys staging; rollback is tested; alerts fire in a drill.
