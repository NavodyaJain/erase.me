# End-to-end tests (Playwright)

The e2e suite drives the real web app (a production build) and the real API against a fake Google and a fake Gmail.
Everything in it is fictional: people, companies, contacts (`@example.com`) and mail headers. No real Google, Gmail or
personal data is involved, and nothing can really be sent.

## What runs
| Part | What it is |
| --- | --- |
| API (`services/api/e2e`) | The real API, started by `pnpm --filter @erase/api e2e:server` on port **4100**. Google is replaced by a fake that approves at once and returns to the real callback (so state, PKCE and nonce checks still run). Gmail is replaced by nine fictional header-only messages, plus any replies a test adds. The app's clock can be moved on. A fictional catalog is loaded. Background jobs are off: a test runs them when it wants them. |
| Database | A dedicated `erase_e2e` database, dropped and recreated on every start. The dev database (`erase`) is never touched. |
| Web (`apps/web`) | A production build in its own folder (`.next-e2e`), served by `next start` on port **3100**, built against the API on 4100. Production, because the service worker only registers in production builds. |
| Tests (`apps/web/e2e`) | Playwright, Chromium only, one test at a time, no retries. Every test starts by wiping the database through `POST /e2e/reset`. |

The specs cover:
- the happy path (sign in, connect, scan, draft, edit the `[OPEN]` line out, approve, send, see it as Sent);
- the blocked and edge cases (must keep, Keep this, no contact, web form, changed draft, ID or card number, real send unavailable, sign-out);
- tracking (`tracking.spec.ts`): a reply and the answer the person reports, an automatic reply, the follow-up after 31 days (a labelled test send), a follow-up changed after it was read (`draft_changed`, no retry), and a web-form request marked as submitted with nothing sent;
- deletion (`deletion.spec.ts`): the paused state, Undo, "Delete now", the token revoke at the fake Google, a tombstone with nothing personal, and a second person whose rows stay byte for byte the same;
- the PWA (manifest, icons, service worker, offline page, nothing personal cached) and a 320px, 390px and desktop layout check with axe.

## Test controls (e2e only)
`services/api/e2e/controls.ts` adds these routes to the e2e API. They have **no sign-in**, so they exist nowhere else.

| Route | What it does | Helper in `apps/web/e2e/helpers.ts` |
| --- | --- | --- |
| `POST /e2e/reset` | Wipes people and their data; puts the clock, the fake Google and the fake Gmail back. Runs before every test. | `test` (automatic) |
| `POST /e2e/clock` `{ "advanceDays": 31 }` | Moves the **app's** clock on (1 to 400 days). | `advanceDays` |
| `POST /e2e/replies` `{ "requestId": "req_...", "automatic": false }` | A reply from the company arrives on that sent request's thread, as headers only. | `replyArrives` |
| `POST /e2e/jobs/{poll-replies,followup-sweep,purge}` | Runs that background job now and returns its counts. | `runJob` |
| `POST /e2e/google/identity` `{ "who": "second" }` | Chooses who the fake Google signs in and connects next (`first` by default). | `googleSignsIn` |
| `GET /e2e/google/revoked` | The (fake) tokens the fake Google was asked to revoke. | `revokedTokens` |
| `GET /e2e/data?email=` or `?userId=` | A person's row, counts of what belongs to them, which sends or submissions happened, and their rows as text to compare. | `personData` |
| `GET /e2e/google/authorize` | The fake consent page. | (the browser follows it) |

Two things to remember when writing a test:
- **Only the app's clock moves.** The database clock stays real. The purge functions use the database clock, so "Delete now" works, but advancing the clock does not make an undo period end for the purge job.
- **Moving the clock past 30 days ends the session**, as it would for a person who stayed away. Call `signIn(page)` again.

Try them by hand while the stack is running (PowerShell):
```powershell
$env:E2E_MODE = 'true'; pnpm --filter @erase/api e2e:server          # in one terminal
Invoke-RestMethod -Method Post http://localhost:4100/e2e/clock -ContentType 'application/json' -Body '{"advanceDays":31}'
Invoke-RestMethod -Method Post http://localhost:4100/e2e/jobs/followup-sweep
```

## Why sign-in is safe to automate here
Real Google sign-in cannot be automated, so the e2e API swaps in a fake Google. There is no test-only login route and no
session shortcut. The e2e entry exists only in `services/api/e2e`, which `src` never imports. It refuses to start unless
all of these hold (`e2e/guard.ts`):
- `E2E_MODE=true`
- `NODE_ENV` is not `production` or `staging`
- `ALLOW_REAL_SEND` is false
- `DATABASE_URL` points at a local database whose name ends in `_e2e`

The guard runs twice: on the environment the process was **started** with (so `NODE_ENV=production` is refused, not
quietly overridden), and again inside `registerE2eControls`, so the routes cannot be added to any app that fails it.

Tests: `test/unit/e2e-guard.test.ts` (the rules; nothing under `src`, the env schema or the OpenAPI contract mentions the
e2e stack) and `test/unit/e2e-controls.test.ts` (a normal and a production-configured app answer 404 to every control
route; the controls refuse to register; the e2e entry, started as a real process, refuses without `E2E_MODE`, in
production, in staging and with real sending on). `src/start.ts` only accepts replacement clients and a clock as
`overrides`, which the production entry never passes.

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

## Checking for flakiness
Build once, then run the browser tests several times. Each run restarts both servers and recreates the database:
```powershell
pnpm --filter @erase/web e2e:build
$env:NEXT_PUBLIC_API_URL = 'http://localhost:4100'; $env:NEXT_DIST_DIR = '.next-e2e'
1..5 | ForEach-Object { pnpm --filter @erase/web exec playwright test; if (-not $?) { "run $_ failed" } }
```

## CI
The `e2e` job in `.github/workflows/ci.yml` runs on every push to `main` and every `phase-*` branch, and on pull requests.
It installs only Chromium (cached), runs `pnpm --filter @erase/web e2e` (every file in `apps/web/e2e`, so a new spec is
picked up by itself), and uploads the report and traces when it fails. The `js` job runs the guard and controls tests.
