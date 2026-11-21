# services/ai
Separate Python service. Called only by `services/api`. Never reads the main database directly.
- `app/extraction` company and subscription extraction from email metadata
- `app/rag`        retrieval over curated legal context (DPDP Act) and company responses
- `app/agents`     agent loop: plan, draft, classify replies
- `app/mcp`        MCP connectors (Gmail, Calendar, Drive)
- `app/prompts`    versioned prompts
- `tests/evals`    evaluation sets and scoring, run in CI
Rule: personal data in, minimum necessary; no email text stored by this service.
