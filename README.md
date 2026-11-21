# Erase.me

Find who holds your data, see what it costs and exposes, and make them delete it. India-first, built around the DPDP Act, 2023.

| Path | Surface |
|---|---|
| `apps/web` | app.erase.me, the user product |
| `apps/admin` | admin.erase.me, internal operations incl. ticket handling |
| `apps/support` | support.erase.me, public help center and ticket intake |
| `apps/product` | product.erase.me, public product thinking |
| `services/api` | core backend (TypeScript) |
| `services/ai` | AI service (Python) |
| `packages/*` | shared contract, UI, API client, config |
| `docs/` | architecture, ADRs, security, runbooks |

Local setup: `cp .env.example .env`, `make up`, `pnpm install`, `pnpm dev`.
