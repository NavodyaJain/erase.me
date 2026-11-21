# Frontend agent

## Role
Build the five web surfaces in Next.js exactly to the design, consuming only the core API.

## Read first
PRD sections 6, 7 (F1–F3, F6, F7, F9–F13). TRD sections 3, 4, 9. `docs/agents/design-agent.md` for tokens.

## You own
`apps/web`, `apps/admin`, `apps/support`, `apps/product`, `packages/ui`, `packages/api-client` usage (generated, do not edit generated code).

## Stack
Next.js App Router, React, TypeScript strict, Tailwind with tokens, Radix primitives, TanStack Query, React Hook Form + Zod, Playwright, Vitest + Testing Library.

## Rules
1. Call the API only through `@erase/api-client`. Never call the AI service, Gmail or the database.
2. Pull all colours, spacing, radii and type from tokens. No hard-coded hex values in components.
3. Every screen has loading, empty, error and success states. Status chips always include a text label.
4. Accessibility: semantic HTML, labelled inputs, keyboard support, focus management in dialogs, `aria-live` for scan progress, contrast AA.
5. Never show certainty the data does not support: use the PRD wording rules.
6. Approve flow: the user sees To, Subject and Body; Send is a separate explicit action; editing re-requires approval.
7. Admin: never render personal data unless it came from a reveal response; show the reveal reason prompt and the 10-minute countdown.
8. Landing: content visible by default; scroll animation under `@supports (animation-timeline: view())`; respect `prefers-reduced-motion`; stacked cards collapse to a list under 760 px.
9. product and support content are MDX files under `content/`; build statically; no tracking.
10. Admin and user sessions use different cookies; never share auth code paths in the UI.

## Tasks (in order)
1. `packages/ui`: tokens, primitives, layouts (AppShell, Sidebar, PublicShell), Storybook optional.
2. `apps/web` public: landing sections (nav, hero, results band, demo, stacked cards, leaderboard, privacy, FAQ, CTA, footer).
3. `apps/web` app: Connect, Overview, Companies list, Approve, Tracker/Requests (phone and desktop).
4. `apps/admin`: sign-in (SSO), Overview, Requests (review labels), Tickets, Companies, Users (masked + reveal), Audit log.
5. `apps/support`: Help home, Docs article, Guides listing, Raise a ticket, My tickets.
6. `apps/product`: Home, Roadmap, Research, Case study, Build log.
7. Deferred screens: Money, Exposure, Aliases, Registry in app after their triggers.

## Done when
Matches the design at 390, 768 and 1440 widths; axe has zero serious issues; Lighthouse accessibility ≥ 95; Playwright flows pass against the fake Gmail stack; no console errors; no hard-coded colours.

## Leaderboard (F9b)
Every leaderboard view shows sample size, date range, "self-selected sample", the disclaimer and a methodology link; company pages show a published company statement marked "provided by the company". Use only the neutral labels from the content agent brief.

## PWA (F14)
1. Make `apps/web` an installable PWA per TRD 9.1: manifest, icons (192, 512, maskable), Apple touch icon, offline page, service worker.
2. The service worker precaches the static shell only. Never cache `/v1/*` responses or authenticated pages. Clear caches, IndexedDB and localStorage on logout.
3. Add the one-time iPhone install hint and an "Update available" prompt for new service worker versions.
4. Web push is opt-in, only after the first sent request, and the payload has no personal content.
5. Verify Google sign-in and the Gmail connect flow in standalone mode on real Android and iPhone devices.
