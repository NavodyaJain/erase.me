# Design source of truth

`docs/design/` is the visual source of truth for every surface. Frontend builds are reviewed against these boards. If a board and the PRD disagree, stop and raise it as a question (see `AGENTS.md`).

## Contents

| Path | What |
| --- | --- |
| `source/*.dc.html` | The 34 design boards (plain HTML, inline styles). `source/canvas.json` has board titles and positions. `source/_runtime/` is the canvas helper; ignore it. |
| `screens/*.png` | Screenshots of every board, named from its title in `canvas.json`. |
| `tokens.json`, `tokens.css` | Colours, type, radii, spacing, shadow, focus, motion. |

To view a board live: `cd docs/design/source && python -m http.server`, then open `http://localhost:8000/<Board>.dc.html`.

Screenshots: phone boards 390x844, all others 1440 wide, full page, Inter loaded. Landing is ~6635 tall (canvas frame says 7000). A few product and support boards run past their 900 canvas frame, so the screenshot is taller than the frame. All boards are sample data.

## Board map

Owner = app in `apps/`. "web" serves both the marketing site (public routes) and the signed-in app.

### Landing (web, public routes)

| Board | Screenshot | PRD | App |
| --- | --- | --- | --- |
| Main | landing-page.png | F10 (leaderboard section also F9, F9b) | web |

### Phone app, 390x844 (web, PWA)

| Board | Screenshot | PRD | App |
| --- | --- | --- | --- |
| Connect | 01-connect-inboxes.png | F1 (F2 scan progress) | web |
| Home | 02-home.png | F3 | web |
| Money | 03-money-leaks.png | F4 (deferred) | web |
| KYC | 04-kyc-exposure.png | F5 (deferred) | web |
| Approve | 05-approve-requests.png | F6 | web |
| Tracker | 06-request-tracker.png | F7 | web |
| Leak | 07-leak-trace.png | F8 (deferred) | web |
| Registry | 08-who-honors-deletion.png | F9, F9b | web |

### Desktop app, 1440 (web)

| Board | Screenshot | PRD | App |
| --- | --- | --- | --- |
| Desktop | desktop-overview.png | F3 | web |
| DesktopRequests | desktop-requests.png | F6 + F7 (approve and track) | web |
| DesktopMoney | desktop-money.png | F4 (deferred) | web |
| DesktopKYC | desktop-exposure.png | F5 (deferred) | web |
| DesktopLeak | desktop-aliases.png | F8 (deferred) | web |
| DesktopRegistry | desktop-registry.png | F9, F9b | web |
| DesktopConnect | desktop-connect-inboxes.png | F1 (F2) | web |

### Admin, 1440 (admin.erase.me)

| Board | Screenshot | PRD | App |
| --- | --- | --- | --- |
| AdminOverview | admin-overview.png | F11 Overview | admin |
| AdminRequests | admin-requests.png | F11 Requests | admin |
| AdminTickets | admin-tickets.png | F11 Tickets (queue), F12 | admin |
| AdminTicket | admin-ticket-detail.png | F11 Ticket detail, F12 | admin |
| AdminCompanies | admin-companies.png | F11 Companies | admin |
| AdminUsers | admin-users.png | F11 Users (masked, reveal) | admin |
| AdminLookup | admin-look-up-a-user.png | F11 Look up a user | admin |
| AdminAudit | admin-audit-log.png | F11 Audit log | admin |

### Help center, 1440 (support.erase.me)

| Board | Screenshot | PRD | App |
| --- | --- | --- | --- |
| SupportHome | support-help-home.png | F12 Help home | support |
| SupportArticle | support-docs-article.png | F12 Docs article | support |
| SupportBlog | support-guides.png | F12 Guides | support |
| SupportNewTicket | support-raise-a-ticket.png | F12 Raise a ticket | support |
| SupportMyTickets | support-my-tickets.png | F12 My tickets | support |

### Product site, 1440 (product.erase.me)

| Board | Screenshot | PRD | App |
| --- | --- | --- | --- |
| ProductHome | product-home.png | F13 Home | product |
| ProductRoadmap | product-roadmap.png | F13 Roadmap | product |
| ProductResearch | product-research.png | F13 Research | product |
| ProductCaseStudy | product-case-study.png | F13 Case study | product |
| ProductLog | product-build-log.png | F13 Build log | product |

## Tokens

Extracted from all boards and reconciled with `docs/agents/design-agent.md`. The boards use exactly the brief's palette, plus these additions that are now in the tokens: `#F8F9FB` (row hover), `ui-monospace` (ids and codes), `0 6px 18px rgba(47,85,244,.22)` (primary button shadow). Interactive boards hover with 150 ms ease.

Known drift in the boards (tokens follow the brief; build to the tokens, not the drift):
- Off-scale font sizes used in places: 10, 16, 18, 19, 20, 30, 36, 40, 44, 48, 56.
- Off-scale radii: 2, 3, 4, 6, 7, 10, 13, 14, 20. Most-used are 8, 999, 12 as specified.
- Extra neutrals used a handful of times: `#E7EAF1` (96 uses, a second line colour, close to `#E6E8EC`), `#E9EBF0`, `#E1E4EA`, `#3A4354`, `#A8B1C2`, `#26304A`. Treat `#E7EAF1` as `line` unless a reviewer says otherwise.
- Phone boards show no status bar or safe-area insets; PWA standalone layout still needs checking.

## Decisions (owner, after Task 0)

- Tokens follow the design brief. `#E7EAF1` is the same line colour as `#E6E8EC`; use `--color-line`.
- App code snaps off-scale font sizes and radii to the nearest token. Do not copy drift from the boards.
- No new boards for PWA (F14) or component states now. Phase 1 builds empty, loading, error and offline states from the tokens. PWA screens are designed later.
- Phase 1 builds none of Money (F4), KYC (F5) or Aliases (F8). Their boards stay here for later.
- In Phase 1, copy the tokens to `packages/ui/tokens/` and have the apps import them from there. `docs/design/` stays as the reference.
- Landing height mismatch (6635 vs 7000): ignore.
