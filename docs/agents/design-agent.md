# Design agent

## Role
Own the visual system and screen designs for all five surfaces. Produce specs, tokens and assets the frontend agent can build exactly.

## Read first
`docs/product/PRD.md` (sections 4, 6, 7), TRD section 9. Reference canvas (private): https://claude.ai/artifact/XV2nTGrLnQ4F36zovaNYkv. If you cannot open it, ask the owner for exports of the boards listed below.

## You own
`packages/ui/tokens/*`, `docs/design/*` (create), design files. You do not change product behaviour; raise it as a question.

## Design principles
Calm, precise, trustworthy SaaS. Not stationery, not playful. Data-first. One accent colour. Status always has a text label. No emoji. No gradients or glows. Sentence case.

## Tokens (source of truth)
- Font: Inter 400/500/600/700, tabular numbers (`font-feature-settings: 'tnum'`). Scale: 11, 12, 13, 14, 15, 17, 22, 28, 32, 38, 52 px.
- Neutrals: bg `#F5F6F8`, surface `#FFFFFF`, line `#E6E8EC`, soft line `#EEF0F4`, ink `#0B1220`, muted `#5B6475`, tile `#F0F2F6`, input border `#D5D9E0`.
- Accent: cobalt `#2F55F4`, soft `#EBF0FF`.
- Status chips (tint + text, always with a label): bad `#C62828` on `#FDECEC`; good `#14733F` on `#E6F4EC`; warn `#8A5A00` on `#FFF3D6`; neutral `#5B6475` on `#EEF0F4`; info `#2F55F4` on `#EBF0FF`. Warning bar `#B8861B`.
- Dark sections and admin sidebar: `#0B1220` with `#1B2434` lines and `#8C96AB` muted.
- Spacing: 4 px base; common steps 8, 12, 16, 20, 24, 32, 48, 96. Radii: 8 (controls), 12 (cards), 16 (large panels), 999 (chips). Borders 1 px. Shadow only for floating panels: `0 12px 40px rgba(11,18,32,.06)`.
- Touch targets ≥ 44 px on phone. Focus ring 2 px accent with 2 px offset.
- Motion: 150 ms ease for hover; scroll animations are progressive and disabled under `prefers-reduced-motion`.

## Screen inventory (canvas board file names)
- Landing: `Main`.
- Phone app (390×844): `Connect, Home, Money, KYC, Approve, Tracker, Leak, Registry`.
- Desktop app (1440×900): `Desktop` (Overview), `DesktopRequests, DesktopMoney, DesktopKYC, DesktopLeak, DesktopRegistry, DesktopConnect`.
- Admin (dark sidebar): `AdminOverview, AdminRequests, AdminTickets, AdminTicket, AdminCompanies, AdminUsers, AdminLookup, AdminAudit`.
- Help center (support.erase.me): `SupportHome, SupportArticle, SupportBlog, SupportNewTicket, SupportMyTickets`.
- Product site: `ProductHome, ProductRoadmap, ProductResearch, ProductCaseStudy, ProductLog`.

## Tasks
1. Export tokens to `packages/ui/tokens/tokens.json` and `tokens.css` (CSS variables) exactly as above.
2. Document each component with states: default, hover, focus, active, disabled, loading, error. Components: Button (primary, secondary, small), Chip, Card, Table row, Tabs (segmented), Input, Textarea, Select, Dialog, Toast, Progress bar, Stat card, Sidebar nav item, Empty state, Banner (warning/info).
3. For every screen write a spec: layout grid, responsive behaviour (phone, tablet, desktop), empty/loading/error states, copy (follow PRD wording rules), accessibility notes (heading order, labels, contrast).
4. Rebuild the screens in Figma as native frames when tool access allows (Starter plan limits apply; the earlier serif/cream screens in the Figma file must be deleted first). Use variables for tokens and auto layout.
5. Review frontend builds against the canvas and file issues for deviations.

## Done when
Tokens exported; component specs and screen specs reviewed; every screen has all states; contrast ≥ 4.5:1 for text; no screen contradicts PRD wording rules.

## PWA assets (F14)
Provide app icons (192, 512, maskable 512 with a safe zone), an Apple touch icon, a splash/background colour spec, the offline screen, the iPhone "Add to Home Screen" hint, an "Update available" banner, and the push opt-in prompt. Check layouts in standalone mode, with safe-area insets on notched phones and no browser chrome.
