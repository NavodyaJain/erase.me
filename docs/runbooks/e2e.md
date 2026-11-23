# End-to-end tests (Playwright)

The e2e suite drives the real web app (a production build) and the real API against a fake Google and a fake Gmail.
Everything in it is fictional: people, companies, contacts (`@example.com`) and mail headers. No real Google, Gmail or
personal data is involved, and nothing can really be sent.

## What runs
| Part | What it is |
| --- | --- |
| API (`services/api/e2e`) | The real API, started by `pnpm --filter @erase/api e2e:server` on port **4100**. Google is replaced by a fake that approves at once and returns to the real callback (so state, PKCE and nonce checks still run). Gmail is replaced by nine fictional header-only messages. A fictional catalog is loaded. |
| Database | A dedicated `erase_e2e` database, dropped and recreated on every start. The dev database (`erase`) is never touched. |
| Web (`apps/web`) | A production build in its own folder (`.next-e2e`), served by `next start` on port **3100**, built against the API on 4100. Production, because the service worker only registers in production builds. |
| Tests (`apps/web/e2e`) | Playwright, Chromium only, one test at a time, no retries. Every test starts by wiping the database through `POST /e2e/reset`. |

The specs cover the happy path (sign in, connect, scan, draft, edit the `[OPEN]` line out, approve, send, see it as
Sent), the blocked and edge cases (must keep, Keep this, no contact, web form, changed draft, ID or card number, real
send unavailable, sign-out), the PWA (manifest, icons, service worker, offline page, nothing personal cached) and a
phone and desktop smoke test with axe.

## Why sign-in is safe to automate here
Real Google sign-in cannot be automated, so the e2e API swaps in a fake Google. There is no test-only login route and no
session shortcut. The e2e entry exists only in `services/api/e2e`, which `src` never imports. It refuses to start unless
all of these hold (`e2e/guard.ts`, tested in `test/unit/e2e-guard.test.ts`):
- `E2E_MODE=true`
- `NODE_ENV` is not `production` or `staging`
- `ALLOW_REAL_SEND` is false
- `DATABASE_URL` points at a local database whose name ends in `_e2e`

The same tests check that nothing under `src`, the env schema or the OpenAPI contract mentions the e2e stack.

## Run it on Windows
One-time setup (C: is nearly full, so the browser goes on D:):
```powershell
# 1. Postgres must be running (Docker Desktop, then):
docker compose up -d postgres

# 2. Put Playwright's browser download on D: (open a new terminal after this). Chromium only.
[Environment]::SetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH', 'D:\playwright-browsers', 'User')
$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\playwright-browsers'
pnpm --filter @erase/web exec playwright install chromium
```
Every run:
```powershell
pnpm --filter @erase/web e2e                      # builds the web app, starts both servers, runs everything
pnpm --filter @erase/web e2e e2e/happy-path.spec.ts   # one file
pnpm --filter @erase/web exec playwright test --ui    # pick tests in the UI (build first with e2e:build)
pnpm --filter @erase/web exec playwright show-report  # after a CI-style run
```
Settings you may need:
| Variable | Default | Use |
| --- | --- | --- |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright's own folder on C: | Set it to `D:\playwright-browsers` |
| `E2E_DATABASE_ADMIN_URL` | `postgres://erase:erase@localhost:5432/postgres` (or `TEST_DATABASE_ADMIN_URL`) | A superuser URL for the Postgres that holds `erase_e2e` |
| `E2E_API_PORT`, `E2E_WEB_PORT` | 4100, 3100 | Only if those ports are busy (also change `playwright.config.ts`) |

If a port is busy from an earlier run, find it with `Get-NetTCPConnection -LocalPort 4100 -State Listen` and stop that
process. The suite never reuses a running server, because the database is recreated at start.

## When a test fails
- The trace is kept: `pnpm --filter @erase/web exec playwright show-trace test-results\<test>\trace.zip`.
- `test-results\<test>\error-context.md` holds a text snapshot of the page at the point of failure.
- In CI the report and traces are uploaded as the `playwright-report` artifact for 7 days.

## Keeping it deterministic
- No fixed sleeps: tests wait for what the user would see (web-first assertions) or poll a condition.
- One worker, one database, wiped before every test, and no retries, so a flaky test fails and gets fixed.
- The auth rate limit (30 a minute per address) is raised for this stack only, because every test signs in again.
- The one thing staged at the network is `real_send_blocked`: the e2e stack always has the test sender, so the refusal
  the real configuration gives is returned by the browser's route handler. The message path is real; the server side of
  that refusal is covered by the API's own tests.

## CI
The `e2e` job in `.github/workflows/ci.yml` runs on every push to `main` and `phase-1` and on pull requests. It installs
only Chromium (cached), runs `pnpm --filter @erase/web e2e`, and uploads the report and traces when it fails.
