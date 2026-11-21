# Agent playbook

Each file here is a self-contained brief for one AI coding agent. Paste the relevant file, plus `docs/product/PRD.md` and `docs/architecture/TRD.md`, into the agent. Every agent also follows the shared rules below.

| Agent | File | Owns |
| --- | --- | --- |
| Design | `design-agent.md` | Design system, screens, tokens, Figma/canvas |
| Frontend | `frontend-agent.md` | `apps/*`, `packages/ui`, `packages/api-client` consumption |
| Backend | `backend-agent.md` | `services/api`, `packages/contracts`, database |
| AI | `ai-agent.md` | `services/ai`: extraction, RAG, agent loop, MCP, evals |
| Infra and DevOps | `infra-agent.md` | `infra/`, CI/CD, environments, observability |
| QA | `qa-agent.md` | Tests, fake Gmail, e2e, accessibility, evals gate |
| Security and privacy | `security-privacy-agent.md` | Threat model, access control, privacy, audit |
| Content | `content-agent.md` | `apps/product` and `apps/support` content, landing copy, wording |

## Build order
1. **Infra** sets up local stack, CI skeleton, env schema. **Design** exports tokens.
2. **Backend** scaffolds the core API: config, DB, migrations for core tables, auth, audit, OpenAPI. **Frontend** builds `packages/ui` from tokens.
3. **AI** builds the service skeleton with `/healthz`, extraction and draft endpoints behind fixtures. **QA** builds the fake Gmail server.
4. **Phase 1 vertical slice**: connect inbox, scan, company list, draft, approve, send, tracker (PRD F1, F2, F6, F7, F3 minimal).
5. **Phase 2**: admin (F11) minimum, help center (F12), landing (F10), registry (F9) with sample data.
6. **Phase 3**: reply classification, day-30 follow-ups, proof pack, results on product site.
7. Deferred features only when their trigger in PRD section 9 happens.

## Shared rules for every agent
1. Read `docs/product/PRD.md` and `docs/architecture/TRD.md` first. If a brief and those documents disagree, stop and report the conflict.
2. Stay inside the folders you own. Cross-boundary needs go through the API contract (`services/api/openapi`) or an issue.
3. No request is ever sent without a recorded user approval (PRD F6). No email bodies are stored (PRD section 8).
4. Wording rules (PRD 4.4) apply to all user-facing text, code comments in UI strings and docs.
5. Sample data is fictional and labelled "sample data". Never use real company names for fake findings; use fictional names.
6. TypeScript strict. Python typed with `ruff` and `mypy`. No `any` without a comment. No new dependency without a one-line reason in the PR.
7. Small PRs, Conventional Commits, tests with every change, update docs and the OpenAPI file with every API change.
8. Never commit secrets. Use `.env.example` for names only.
9. Log without personal data. Never log email addresses, tokens, draft text or reply text.
10. Definition of done is listed in each brief. Finish with a short summary: what changed, how it was tested, what is left.
