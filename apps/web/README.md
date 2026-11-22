# app.erase.me (web)
The user product (PWA): sign in, connect inboxes, see which companies may hold your data, and draft, approve and send requests.
Talks only to `services/api` through `@erase/api-client` (no hand-written fetch). No direct calls to `services/ai`. Phase 1 builds Connect, Overview and Requests; Money, KYC exposure, Aliases and Registry are deferred.

## Run it
```
pnpm --filter @erase/api dev            # the API on :4000
pnpm --filter @erase/web dev            # this app on :3000 (copies the brand assets first)
```
Set `NEXT_PUBLIC_API_URL` (see `.env.example`). The API's `WEB_ORIGIN` must be this app's origin: see `docs/runbooks/web-origin.md` for cookies, CORS, the CSRF origin check and the post-sign-in redirect.

## Layout
- `src/app`: routes. `(app)` is the signed-in group (gate, then frame). `manifest.ts` and `offline/` are the PWA parts.
- `src/copy`: every user-facing string, and one message per API error code. Wording follows PRD 4.4 (hedged; no promise about what a company will do; no deletion promise for a must-keep company). Tests check it.
- `src/components`, `src/lib`: screens, hooks (TanStack Query over the typed client) and helpers. Shared primitives are in `@erase/ui`.

## PWA rules (F14)
- Installable: manifest with the brand icons (copied from `packages/ui` by `scripts/sync-brand.mjs`, not committed twice).
- `public/sw.js` is hand-written. It caches the static shell only: the offline page, icons and hashed `_next/static` files. It never caches API responses or the HTML of any page: navigations go to the network and fall back to `/offline`; other origins (the API) are not handled at all.
- A new worker waits until the person accepts "Update available". On sign-out the app sends `CLEAR_CACHES` and clears its own storage keys (`erase.*`), so no personal data is left on the device.
- iPhone has no install prompt, so a short hint shows once and at most every 30 days.
- The worker is registered in production builds only. Sign-in inside the installed app on a real Android phone and iPhone (F14-AC4) is a manual check before release.

## Wording and screens that differ from the design boards
The boards are sample data and follow `docs/design`, with these deliberate differences (see also `docs/OPEN-QUESTIONS.md`):
- Three boards state "leaked" as fact (Home, Desktop, Leak). The app uses hedged wording instead. <!-- banned-words:ignore - documents the boards' wording -->
- Boards that show risk levels, Money, KYC, Aliases, replies, "Chase now" and the proof pack are not built in Phase 1.
- Draft text always comes from the API; the boards' hard-coded draft wording is not used.
