# Erase.me — Product Requirements Document (PRD)

Version 1.0 · 2026-11-17 · Owner: Navodya
Audience: product, design, engineering and AI coding agents. Read this with `docs/architecture/TRD.md`.
Anything marked **[ASSUMPTION]** is a proposal to confirm. Anything marked **[OPEN]** is an unresolved question.

---

## 1. Summary

Erase.me is a D2C, India-first, AI-native "digital life audit". The user connects one or more Gmail inboxes. Erase.me finds the companies that hold their data, shows what those companies cost them (Money) and what they may still hold (Risk), and sends erasure requests under the Digital Personal Data Protection Act, 2023 (DPDP Act) from the user's own Gmail after they approve (Control). It tracks replies, follows up, and builds a public record of which companies actually delete data.

One-line pitch: *Find who holds your data, see what it costs and exposes, and make them delete it.*

### 1.1 The claim this product must prove
People will connect Gmail, send an erasure request, and companies will respond. Everything in this PRD serves that claim. Features that do not serve it are deferred (section 9).

### 1.2 Purpose of the project
This is a portfolio product built to demonstrate product management, plus hands-on use of RAG, an agent loop and MCP connectors. It must do real work for real users (a test cohort), not be a demo or a chatbot. Domains of the owner's employer (CRM, EHR, RCM) are out of scope.

---

## 2. Problem

- People have signed up to dozens or hundreds of services over many years across several email addresses. They cannot list them.
- Some of those companies hold sensitive documents (Aadhaar, PAN, selfie, bank statements), often from loan, wallet or broker onboarding. Many accounts are abandoned.
- Subscriptions and autopays quietly continue, and renewals are missed.
- The DPDP Act gives data principals a right to correction and erasure (Section 12) and a right of grievance redressal (Section 13), but exercising it means finding the company, finding the contact, writing the request, tracking it and chasing it. Almost nobody does this.
- There is no public signal of which companies actually honour deletion.

## 3. Users

| Persona | Description | Main need |
| --- | --- | --- |
| Primary: **Riya**, 24–35, urban India, uses Gmail, 3 inboxes (current, college, old) | Has used loan apps, wallets, brokers, travel and streaming apps. Privacy-aware but busy | See everything in one place and clean it up without effort |
| Secondary: cost-conscious subscriber | Wants to find forgotten subscriptions | Money back, cancel links |
| Internal: **Admin/operator** | The owner and, later, a few staff | Keep requests flowing, fix bad contacts, review low-confidence labels, handle tickets |
| Public: **Reader** of product.erase.me | Hiring managers, PMs, peers | Understand the product thinking and evidence |

## 4. Goals, non-goals, principles

### 4.1 Goals (first 12 weeks)
1. 15 test users complete the flow: connect Gmail, see companies, approve and send at least one request.
2. 50+ real requests sent; every reply recorded and classified.
3. Publish real results on product.erase.me (reply rate, deletion rate, time to reply), including failures.
4. Ship a clean, tested, documented codebase that shows RAG, an agent loop and MCP in real use.

### 4.2 Non-goals (v1)
- No native mobile apps and no Flutter codebase. The product ships as a responsive web app that is installable as a Progressive Web App (PWA). App-store listings are out of scope for v1.
- No non-Gmail providers.
- No legal advice, no promise of deletion, no guarantee of compliance by companies.
- No selling or sharing of user data. No ads.
- No automatic sending without user approval.
- No monetisation in v1.

### 4.3 Product principles
1. **User approves every outbound request.** Nothing is sent without an explicit action.
2. **Read-only by default.** Gmail access is the minimum needed. Company names and dates are kept, not email text.
3. **Honest wording.** We say "likely holds", "may have", "looks unused". We never state as fact what we infer.
4. **Be honest about limits.** For lenders/brokers who may have to keep records by law, we say "Must keep" and never promise deletion.
5. **Evidence before features.** Each phase ends in a gate.
6. **Fair public data.** Registry rates only show for companies with 10 or more requests. No user is identifiable.

### 4.4 Wording rules (mandatory in all UI, emails, docs)
- Use: "likely holds", "may have", "looks unused", "may have to keep records", "Honored means the company confirmed deletion in writing".
- Never use: "will delete", "guaranteed", "your data is safe", "leaked" as a fact (use "may have shared"). 
- Sentence case. No exclamation marks, no emoji, no hype words.
- Anything that is sample data is labelled "sample data".

---

## 5. Scope by phase

| Phase | Weeks | Contents | Gate |
| --- | --- | --- | --- |
| 0 Validate | 1–2 | 8–10 interviews; 5 requests sent by hand; log every reply | Need confirmed in interviews |
| 1 Thin slice | 3–5 | Connect Gmail, company list, approve and send, request tracker | Full flow works on own inbox |
| 2 Test users | 6–8 | 15 test users, observe, fix blockers | Most users send at least one request |
| 3 Decide | 9–12 | Day-30 follow-ups, reply sorting, results published | Results published on product.erase.me |

Features beyond the thin slice (Money, KYC ranking, Aliases, public leaderboard, admin/support tooling in production) return when their trigger happens (section 9).

---

## 6. Surfaces

| Surface | URL | Audience | Backend |
| --- | --- | --- | --- |
| Marketing landing | erase.me (apps/web, public routes) | Visitors | Core API (leaderboard data) |
| User app | app.erase.me (apps/web) | Signed-in users | Core API |
| Admin | admin.erase.me (apps/admin) | Owner/operators. Includes ticket handling | Core API (admin routes) |
| Help center | support.erase.me (apps/support) | Users. Docs, guides, raise and follow tickets | Static content + Core API (tickets) |
| Product site | product.erase.me (apps/product) | Public readers. Roadmap, research, case studies, build log, decisions | None. Static |

Design reference: the Claude design canvas, 34 boards (landing, 8 phone screens, 7 desktop app screens, 8 admin, 5 support, 5 product). Screen file names are listed in `docs/agents/design-agent.md`.

---

## 7. Functional requirements

Each feature lists user stories, rules and acceptance criteria (AC). IDs are used in tickets and tests.

### F1 — Sign-in and connect inboxes (Connect)
**Stories**
- As a user I sign in with Google and add one or more Gmail inboxes.
- As a user I can see exactly what is read and what is kept, and disconnect any inbox.

**Rules**
- Sign-in identifies the user. Inbox connection is a separate, explicit consent step per inbox (incremental authorization).
- Gmail access is read-only plus send (send is used only when the user approves a request). **[ASSUMPTION]** scopes: `gmail.readonly` and `gmail.send`. See TRD section 7 for verification impact.
- Show a plain-language panel: "What we read / What we keep / What we never do".
- Disconnect revokes the token immediately and stops scans for that inbox.
- While the app is in Google test mode, only allow-listed test users can connect (up to 100).

**AC**
- F1-AC1: A new user can sign in and connect an inbox in under 2 minutes in the happy path.
- F1-AC2: The consent panel appears before the Google consent screen.
- F1-AC3: Disconnect revokes the OAuth token at Google and marks the inbox disconnected; no further API calls are made to it.
- F1-AC4: Up to 5 inboxes per user.

### F2 — Scan and company discovery (Find)
**Stories**
- As a user I see a live scan of each inbox and a growing list of companies.
- As a user I can correct a wrong company, merge duplicates or mark "not mine".

**Rules**
- Detect sign-up, welcome, receipt, invoice, OTP-free account emails by sender domain, subject and headers (including `List-Unsubscribe`). Only metadata and minimal signals are persisted: company, category, first seen, last seen, signal types. Email bodies are not stored.
- A company has a canonical record (name, domains, category, grievance contact, source of contact).
- Scan is resumable and idempotent. Progress is shown (percent and count found).
- Category set: loan app, wallet/payments, broker/investing, credit, e-commerce, travel, streaming, education, social, SaaS, other.

**AC**
- F2-AC1: Scan of a 10-year inbox completes in the background and streams progress; the UI never blocks.
- F2-AC2: Rescanning the same inbox does not create duplicates.
- F2-AC3: The user can mark a company "not mine" and it is excluded everywhere.
- F2-AC4: No email body or full subject line is stored. **[OPEN]** whether to store subject text; default is not to.

### F3 — Home / Overview
**Stories**
- As a user I see four numbers (Companies, Money per year, Risk, Control) and "Do this next" actions.

**Rules**
- Actions are ranked: renewals soon, high-risk inactive companies, drafts awaiting approval, replies needing the user, possible leak.
- Phone and desktop layouts both supported (see design).

**AC**
- F3-AC1: Every number links to its detail screen.
- F3-AC2: Empty states exist for every card (no inbox, scan running, nothing found).

### F4 — Money (Cost) — **Deferred to after Phase 3**
**Stories**
- As a user I see subscriptions and autopays with yearly total, renewal date and a "looks unused" hint, and a link to cancel.

**Rules**
- "Looks unused" is a hint: no recent product emails from that company in the last N days **[ASSUMPTION]** N = 90 and only for subscriptions.
- Never claim certainty. Cancel links come from the company catalog or unsubscribe headers; Erase.me does not cancel for the user in v1. **[OPEN]** scope of cancellation help.

**AC**
- F4-AC1: Total per year is the sum of annualised costs; the calculation method is shown on tap.
- F4-AC2: Each "looks unused" chip carries a text label and an explanation sentence.

### F5 — Exposure / KYC (Risk) — **Deferred to after Phase 3 (basic version in Phase 1 list)**
**Stories**
- As a user I see which companies likely hold Aadhaar, PAN, selfie or bank statements, ranked by risk.

**Rules**
- Holdings are inferred from category and signals (for example loan app onboarding emails). They are labelled "likely".
- Risk levels: High (sensitive document and inactive 6+ months), Medium, Low, **Must keep** (broker/lender that may have to keep records).
- Must keep: the request is still allowed, but UI says "May have to keep records" and no deletion is promised.

**AC**
- F5-AC1: No screen states that a company "has" a document as fact.
- F5-AC2: Must keep companies never show a "will delete" message.

### F6 — Approve requests (Control)
**Stories**
- As a user I review a drafted request, edit it, and approve it for sending from my Gmail.
- As a user I can approve a batch, but I see each draft.

**Rules**
- Draft is generated by the AI service from a template grounded in the DPDP Act (Section 12 erasure), the user's identity details, the company's grievance contact, and the data we think they hold. The draft cites the section and asks for written confirmation within 30 days.
- The user must see To, Subject, Body before sending. The send is a deliberate action.
- Identity details used: name and the inbox email only. No ID numbers are put into requests by default.
- Send via Gmail API from the user's inbox, into a labelled thread so replies can be tracked.
- Bounces are detected and surfaced; the company contact is flagged in admin.

**AC**
- F6-AC1: No request is ever sent without a recorded user approval event (timestamp, draft hash).
- F6-AC2: A draft edit changes the draft hash and requires approval again.
- F6-AC3: A request sent shows as Sent within 10 seconds, with Gmail thread id stored.
- F6-AC4: If the company's grievance contact is unknown, the draft is blocked and the user is told why; admin gets a task to find the contact.

### F7 — Tracker, replies, follow-ups, proof pack (Control)
**Stories**
- As a user I see each request's status and progress, and I am prompted when something needs me.
- As a user I get a proof pack I can download.

**Rules**
- Status machine: `drafted → approved → sent → reply_received → (replied_deleted | replied_info_requested | replied_refused) → closed`, with `no_reply` when nothing has arrived by the follow-up day; plus `bounced`. `reply_received` means a message from someone else arrived on the sent thread (found from headers only). The outcome (`replied_*`) is **set by the user**: Confirmed erased, Refused, Needs more info, or No answer yet. Erase.me never infers it, and it is shown as "Reported by you". An automatic reply (out-of-office and similar) is recorded with its own "Automatic reply" label; it does not change the status and does not stop the follow-up clock.
- Reply classification (**Phase 3**; Phase 2 has none, and the user sets the outcome): the AI service labels a reply as Deleted, Asked for more information, Refused, or Other. Only the label, a confidence score and short signal tags are stored. **[ASSUMPTION / DECISION PROPOSED]** The reply text is processed in memory and never persisted. The user can always open the actual reply in their own Gmail.
- Low-confidence labels (confidence below 0.7 **[ASSUMPTION]**) go to the admin review queue and show as "Replied" to the user until confirmed.
- Day-30 rule (`FOLLOWUP_AFTER_DAYS`): if there is no reply at day 30, "Follow up?" is shown with a hedged draft prepared for the user. The user approves the exact draft, with the same hash approval, idempotency and Keep-this and must-keep checks as the first request. One follow-up per request (`FOLLOWUP_MAX`), shown in the app only, no day-14 nudge.
- Proof pack: a PDF with request text, send time, company contact, replies' labels and timestamps, and a hash of each draft. It contains no email text beyond what the user already approved.

**AC**
- F7-AC1: Status changes are append-only events with actor and timestamp.
- F7-AC2: Day-30 follow-up job is idempotent and runs at least daily.
- F7-AC3: Proof pack can be generated for any request that has been sent.

### F8 — Aliases and leak trace (Trace) — **Deferred; later bet**
**Stories**
- As a user I create a unique alias per sign-up. If spam arrives on an alias, I see which company may have shared it.

**Rules**
- Needs inbound email infrastructure on `alias.erase.me`. Not part of v1. Wording: "may have shared", never "leaked" as fact.

### F9 — Registry and public leaderboard
**Stories**
- As a visitor or user I see which companies reply, how fast, and how often they confirm deletion.

**Rules**
- Aggregated from requests. A company's rate is shown only when it has 10 or more requests. Below that: "Not enough requests yet".
- Definitions: *Replies in* = median days to first reply. *Honored* = share of requests where the company confirmed deletion in writing. *Never replies* = share with no reply by day 30.
- No individual user or request is identifiable. No names in the aggregate.
- Landing page and in-app Registry read the same data. Until real data exists, the landing page shows clearly labelled sample data.

**AC**
- F9-AC1: A company with 9 requests shows no percentage anywhere (UI and API).
- F9-AC2: The API never returns per-request data to the public endpoint.

### F9b — Public response record and compliance methodology (landing page and Registry)

**Purpose.** The leaderboard is also a public survey of how companies respond to erasure requests made under the DPDP Act. It must be defensible.

**What it measures, and what it does not.** Erase.me measures how companies *respond to requests sent through Erase.me*. It does **not** certify, audit or rate legal compliance. A company is never labelled "compliant" or "non-compliant". Compliance is a legal conclusion that only the Data Protection Board or a court can reach.

**Public labels (use these, not "compliant"):**
- "Confirmed deletion in writing" (Honored)
- "Replied, did not confirm deletion"
- "Asked for more information"
- "Refused, citing legal retention"
- "No reply after 30 days"
Page title wording: "How companies respond to deletion requests". Avoid "violating", "non-compliant", "illegal".

**Methodology rules (all mandatory):**
1. Minimum sample: a company is shown only with 10 or more requests from at least 5 distinct users **[ASSUMPTION]**. Below that: "Not enough requests yet".
2. Show the count behind every rate ("based on 23 requests") and the date range. Round percentages to whole numbers.
3. Time window: rolling 12 months, plus all-time on the methodology page.
4. Count a request only if it was approved and sent by a real user, and the company had the full 30 days (or replied earlier). Requests younger than 30 days with no reply are "In progress", not "No reply".
5. Exclude requests where the grievance contact bounced or was wrong (that is our failure, not the company's) and requests the user cancelled. Show the exclusion counts on the methodology page.
6. Treat "Must keep" categories separately: a refusal citing legal retention is shown as "Refused, citing legal retention", not as a failure.
7. Label as "self-selected sample": results reflect Erase.me users, not all customers.
8. A visible methodology page is linked from every leaderboard view: definitions, thresholds, exclusions, limitations, version, last updated.
9. Before the DPDP provisions on data principal rights are in force, say so on the page; do not imply a legal deadline has been missed. **[OPEN]** verify the current status of the Act's commencement and the Rules from official sources before launch.
10. No individual user, request or email content is ever published.

**Right of reply and corrections:**
- Companies can claim their listing with a verified work email, add a public statement (shown beside their record, clearly marked as company-provided), and report an error.
- A corrections process: report → review in admin within 7 days **[ASSUMPTION]** → correct or reply. Corrections are logged and the methodology version is bumped when rules change.
- Data is recomputed from underlying request events, so a correction changes the number everywhere.

**Legal safeguards:**
- Facts only, stated neutrally, with the method. No adjectives about companies.
- Legal review of the methodology, the disclaimer text and the takedown/correction process before the leaderboard is public. This is a defamation and unfair-trade-practice risk if wrong.
- Disclaimer on every view: "Based on requests sent through Erase.me. This is not a legal finding or a compliance rating."

**Government and compliance angle (optional, later):** the aggregated, anonymised record could be shared with the Data Protection Board or researchers as a report. Only share with a documented data-sharing basis and legal review. Not part of v1.

**AC**
- F9b-AC1: No UI string or API field uses "compliant", "non-compliant", "violating" or "illegal".
- F9b-AC2: Every rate shows its sample size and date range; none shows below the threshold.
- F9b-AC3: The methodology page is reachable from the landing leaderboard, the in-app Registry and each company page, and shows the methodology version.
- F9b-AC4: A company statement and a correction request are visible to admins; an accepted correction recomputes the stats.

### F10 — Marketing landing page
Sections: sticky nav, hero with animated product card, results band with scroll counters, interactive "See it work" demo (4 steps), stacked feature cards (Find, Cost, Risk, Control, Trace), leaderboard with tabs (Best, Slowest, Never replies), privacy section, FAQ, final CTA, footer.
Rules: content visible by default; animations are progressive enhancements; respects `prefers-reduced-motion`; no layout shift; sample data is labelled.
AC: Lighthouse accessibility and best-practices at 95+ **[ASSUMPTION target]**; the page works with JavaScript animations disabled.

### F11 — Admin (admin.erase.me)
Screens: Overview, Requests, Tickets, Ticket detail, Companies, Users, Look up a user, Audit log.
Capabilities:
- Overview: test cohort stats, needs-attention queue, request status distribution, system health.
- Requests: filter, review low-confidence labels, mark bounced, send day-30 follow-ups, fix contacts.
- Tickets: queue, assign, reply, solve, saved replies. Support agents work inside admin.
- Companies: directory with grievance contact, verification date, request count, honored rate (hidden under 10).
- Users: masked IDs and emails; **reveal** requires a reason and is logged; reveal expires after 10 minutes.
- Audit log: every view and change of user data by people and jobs. Append-only. Exportable.
Rules: SSO with 2FA and IP allowlist; roles (Owner, Operator, Support agent) enforced in the API; masked by default; admins can never read email content because it is not stored.

### F12 — Help center and tickets (support.erase.me)
Screens: Help home, Docs article, Guides/blog listing, Raise a ticket, My tickets.
- Docs and guides are static content (Markdown/MDX) with search.
- Raising a ticket requires sign-in. Ticket has topic, subject, details, optional request id. A warning says never to include passwords, OTPs or ID numbers.
- My tickets shows only the user's own tickets and the thread. Replies also go by email.
- Ticket handling happens only in admin.
AC: a ticket is visible to its author and to authorised admin roles only.

### F13 — Product site (product.erase.me)
Pages: Home, Roadmap, Research, Case study, Build log (with decisions).
- Static, no login, no tracking.
- Interviews are published only with written consent, anonymised, as themes and short quotes; no raw transcripts.
- Only real numbers; sample content labelled.

### F14 — Installable web app (PWA)

**Stories**
- As a user on Android, iPhone or desktop I can install Erase.me to my home screen or desktop and open it like an app, without an app store.
- As a user I get notified when something needs me, even if I have not installed it.

**Rules**
- The user app (app.erase.me) is installable. Admin and the product site are not required to be installable. support.erase.me may be, as a later option.
- App name "Erase.me", short name "Erase", standalone display, theme colour `#2F55F4`, background `#F5F6F8`, start URL `/`, icons 192, 512 and maskable.
- The service worker caches only the static app shell (pages' structure, fonts, icons) and an offline page. It never caches API responses or any personal data, and the cache is cleared on logout.
- An offline screen explains that connection is needed and shows no stale personal data.
- iPhone has no automatic install prompt: show a short in-app hint ("Tap Share, then Add to Home Screen") once, dismissible, not repeated more than once every 30 days.
- Notifications: email is the primary channel and always sent. Web push is optional, opt-in only after the user has sent a request, and contains no personal content (for example "A company replied. Open Erase.me."). On iPhone, push works only for the installed app on supported iOS versions.
- Google sign-in and the Gmail connect flow must work in the installed (standalone) app on Android and iPhone, with a fallback that opens the system browser if the flow is blocked.

**AC**
- F14-AC1: Lighthouse PWA checks pass (installable, manifest valid, service worker registered) on app.erase.me.
- F14-AC2: With the network off, the app opens to the offline screen and shows no personal data.
- F14-AC3: After logout, no personal data exists in Cache Storage, IndexedDB or localStorage.
- F14-AC4: Sign-in and inbox connection succeed in the installed app on a real Android phone and a real iPhone.
- F14-AC5: A push notification never contains company names, email addresses or request text.

---

## 8. Data the product handles

| Data | Stored? | Notes |
| --- | --- | --- |
| Google account id, email, name | Yes | For sign-in |
| Gmail OAuth refresh tokens | Yes, encrypted | Revoked on disconnect/delete |
| Sender domain, company, category, first/last seen, signal types | Yes | Per user |
| Email bodies, attachments, full subject lines | No | Processed transiently only |
| Request drafts and approved text | Yes | User-approved content |
| Reply label, confidence, signal tags, timestamp | Yes | Reply text not stored |
| Support ticket text | Yes | User-provided |
| Audit log | Yes | No personal content, only references |

Retention: "Delete my data" (the existing delete-account flow) can be undone for 7 days (`ACCOUNT_PURGE_AFTER_DAYS`), with polling, follow-ups and sending paused for that user meanwhile, or the person can choose "Delete now". After that all personal data is deleted; only a tombstone row with no personal data (no email and no hash of it) remains. Detected companies are deleted 30 days after an inbox is disconnected (`INBOX_RETENTION_DAYS`). Earlier assumption, now met: on user account deletion, personal data is deleted within 30 days; aggregated registry counts are kept in anonymised form. **[OPEN]** retention after inbox disconnect without account deletion (default: keep detected companies for 30 days, then delete).

## 9. Deferred features and triggers

| Deferred | Trigger to build |
| --- | --- |
| Admin and support tooling in production beyond minimum | Manual handling becomes painful (more than a few hours a week) |
| Money (subscription cost) | Interviews show people want it |
| KYC exposure ranking | Reply data exists to ground it |
| Aliases and leak trace | Core flow proven |
| Public leaderboard | 10+ requests per company |
| Hindi and other languages | Test users ask |

## 10. Success metrics (proposals to adjust after Phase 0)

| Metric | Definition | Target |
| --- | --- | --- |
| Activation | Invited users who connect a Gmail | ≥ 60% |
| Time to first request | Connect → first request sent | ≤ 15 min median |
| Requests per user | Sent requests per active user | ≥ 3 |
| Reply rate | Companies replying within 30 days | Track, no target |
| Deletion confirmation rate | Replies confirming deletion | Track, no target |
| Approval-before-send | Requests with a recorded approval | 100% (hard requirement) |
| Draft edit rate | Drafts edited by user before sending | Track |

Report real numbers, including bad ones.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Gmail restricted scope needs Google verification and a security assessment | Stay in test mode for the portfolio build; apply only if continuing |
| Companies ignore requests | Still a finding; the follow-up and registry are the product |
| Users do not trust inbox access | Read-only, explicit panel, no email text kept, easy disconnect |
| DPDP enforcement dates unconfirmed **[OPEN]** | Verify against official sources before any date appears in copy |
| Admin/support access to personal data | Least privilege, masking, reasoned reveal, audit log |
| Leaderboard read as a legal compliance finding; defamation or unfair-practice claims | Measure responses, not compliance; neutral labels; methodology, right of reply, corrections, legal review before going public |
| Misclassification of replies | Confidence threshold, human review, user can see the original in Gmail |
| Wrong grievance contact | Verification date, bounce detection, admin fix queue |
| Scope creep | Deferred table and gates |

## 12. Open questions

1. Whether exposure profile (documents) is visible to the user in Phase 1 or only after Phase 3.
2. Whether Aliases ship in the first public MVP (current answer: no).
3. Retention after inbox disconnect.
4. Own RAG over a curated legal corpus versus a small fixed legal context (current plan: curated corpus in `services/ai/data`).
5. Cancellation help scope (links only versus guided steps).
6. Exact DPDP rule dates and the Data Protection Board process; verify with official sources.
7. Whether companies should be able to see their own (private) dashboard before the public listing goes live.
8. Reply handling: confirm that reply text is processed in memory only (proposed decision in F7).

## 13. Legal and compliance notes (not legal advice)

- Section 12 of the DPDP Act, 2023 covers the right to correction and erasure; Section 13 the right of grievance redressal. Verify current text and rule status before publishing copy.
- Erase.me itself processes personal data and must act as a careful data fiduciary/processor: consent, purpose limitation, data minimisation, security safeguards, breach process, grievance contact for Erase.me itself, privacy policy and terms before any external user.
- Keep a legal/privacy review step before the first non-test user.
