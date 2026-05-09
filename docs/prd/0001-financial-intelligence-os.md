# PRD-0001: Financial Intelligence & Due Diligence OS (India)

**Status:** Draft — `needs-triage`
**Scope:** v1 — all three GTM angles (Retail, B2B SaaS, Agency) in parallel on a single codebase.

---

## Problem Statement

Indian financial intelligence is fragmented across BSE/NSE disclosures, investor-relations PDFs, earnings call transcripts, MCA filings, and a long tail of news sources. Three audiences feel this pain acutely:

- **Retail investors** open an annual report or earnings transcript, hit 80 pages of dense prose, and bounce. They want the gist — what changed, what management is hiding, what the numbers actually say — in two minutes, not two hours.
- **SME consultants, financial advisors, and wealth managers** are asked to produce due-diligence on an Indian company (often private) and end up assembling it by hand from screenshots, MCA downloads, and Moneycontrol tabs. A single dossier costs them half a day of skilled time.
- **Agencies and research shops** that sell research-as-a-service have no leverage — every new client report is bespoke labour, not productized output.

The common root cause: there is no India-aware, agentic layer that can resolve a company, pull the right local sources, and reason over them with financial discipline.

## Solution

A multi-tier financial analysis platform — **Financial Intelligence & Due Diligence OS** — that mines Indian primary sources (BSE/NSE filings, earnings call transcripts) and uses Claude Managed Agents over MCP to produce structured, audited financial intelligence:

- **Retail tier (freemium, Next.js + RN):** Paste a ticker or company name → get an AI-summarized earnings call or annual report with key takeaways, sentiment shifts, and red flags.
- **B2B SaaS tier (paid, Next.js dashboard):** Run a full due-diligence dossier on a listed Indian company — financial health, governance, peer comparison, management commentary deltas — in minutes.
- **Agency tier (internal tool mode):** Generate white-labelable lead-intelligence and deep-dive market reports that the agency sells to its own clients.

The architecture is deliberately lean: a Next.js / React Native frontend talks to **Supabase Edge Functions**, which orchestrate **ScrapeGraphAI** for ingestion and **Anthropic Managed Agents** (over MCP) for reasoning. There is no Python middleware, no dedicated server. Edge Functions are the only backend.

## User Stories

### Retail (freemium)

1. As a retail investor, I want to search for a listed Indian company by name or ticker, so that I can find the right entity without knowing its exact NSE/BSE symbol.
2. As a retail investor, I want to paste a link to an earnings call transcript or upload its PDF, so that I can get a summary even when our automated source fetch misses it.
3. As a retail investor, I want a 60-second AI-generated summary of an earnings call, so that I understand the key takeaways without reading the transcript.
4. As a retail investor, I want quarter-over-quarter sentiment and tone deltas highlighted, so that I can spot when management's framing has shifted.
5. As a retail investor, I want a "red flags" section calling out evasive answers, guidance changes, and unusual accounting language, so that I can think critically about what I'm reading.
6. As a retail investor, I want to see a simplified summary of the latest annual report, so that I get the big picture without parsing 200 pages.
7. As a retail investor, I want to bookmark companies into a watchlist, so that I get a fresh summary when new filings drop.
8. As a retail investor, I want a free tier that lets me run N summaries per month, so that I can try the product before paying.
9. As a retail investor, I want to upgrade via Razorpay using UPI or netbanking, so that I can pay with what I actually have.
10. As a retail investor on mobile, I want a React Native app that gives me push notifications when a watchlisted company files results, so that I never miss the moment.
11. As a retail investor, I want every claim in the summary to link back to the exact page or timestamp in the source, so that I can verify and trust the AI's output.

### B2B SaaS (consultants, advisors, wealth managers)

12. As a wealth manager, I want to enter a listed Indian company and get a full due-diligence dossier in under five minutes, so that I can prepare for a client call same-day.
13. As a financial advisor, I want the dossier to cover financial health, governance, ownership structure, and peer comparison, so that I cover the standard checklist without manual assembly.
14. As an SME consultant, I want side-by-side comparison of the same company's last four earnings calls, so that I can see how the narrative has evolved.
15. As a wealth manager, I want to download the dossier as a branded PDF, so that I can share it with clients in a presentable format.
16. As a wealth manager, I want my organization's logo and disclaimers on every export, so that exported reports look like they came from us.
17. As a B2B admin, I want to invite team members and assign them seats, so that my whole team can use the platform without sharing logins.
18. As a B2B admin, I want role-based access (admin, analyst, viewer), so that junior analysts can't accidentally change billing.
19. As a B2B user, I want to see how many dossiers my team has run this month and how many remain in our plan, so that I can manage usage proactively.
20. As a B2B user, I want each report to show its source list with timestamps, so that I can defend conclusions to a compliance officer.
21. As a B2B user, I want to subscribe via Razorpay with GST-compliant invoices, so that I can expense the subscription cleanly.

### Agency (internal tool mode)

22. As an agency operator, I want to spin up a "research project" tied to a client, so that I can keep multiple engagements separate.
23. As an agency operator, I want to pick from report templates (lead intelligence, deep-dive market research, competitive landscape), so that I don't reinvent the structure each time.
24. As an agency operator, I want to add ad-hoc URLs as additional sources, so that I can include client-supplied private docs in the analysis.
25. As an agency operator, I want to edit the AI's output before exporting, so that I can polish or correct it before delivery.
26. As an agency operator, I want a fully white-label PDF export with no mention of our platform, so that the client experience is mine, not the tool's.
27. As an agency operator, I want a tamper-evident audit log of every source fetched and every agent run for a project, so that I can prove provenance to a client or regulator.

### Cross-cutting

28. As any user, I want to authenticate via email magic-link or Google OAuth, so that I don't manage another password.
29. As any user, I want my session to persist across web and mobile, so that I can switch devices without re-logging in.
30. As any user, I want long-running reports to show progress and notify me when ready, so that I can leave the page and come back.
31. As any user, I want to see clearly which tier I'm on and what's gated, so that upgrade decisions are informed.
32. As an operator, I want every scrape and agent call recorded with cost, so that I can monitor unit economics per report.
33. As an operator, I want rate limits per tier enforced server-side, so that abuse cannot blow through our ScrapeGraphAI / Anthropic budget.

## Implementation Decisions

### Architecture (locked per ADR direction)

- **Frontend:** Next.js (web) + React Native (mobile), TypeScript + Tailwind CSS. Single design system shared via a `ui` package.
- **Backend:** Supabase only — Postgres for state, Auth for identity, Edge Functions (TypeScript/Deno) for **all** custom logic. **No Python/FastAPI middleware.**
- **Ingestion:** ScrapeGraphAI via REST API (Node SDK acceptable from inside Edge Functions). v1 sources: BSE/NSE filings + earnings call transcripts only. MCA21 and news are deferred to v1.1.
- **Reasoning:** Anthropic Managed Agents called from Edge Functions. Financial-services Managed Agent templates (e.g. "Earnings Reviewer", "Due Diligence Analyst") are accessed via MCP-style external tool calls.
- **Payments:** Razorpay (subscriptions + UPI), webhooks consumed by an Edge Function.

### Modules to build

Each module is designed as a **deep module** — a small, stable interface hiding meaningful complexity, so it can be tested in isolation and replaced without ripple.

1. **Company Resolver** — Resolves a free-text query (ticker, name, CIN) to a canonical `CanonicalCompany` (NSE/BSE symbol, ISIN, CIN, display name, sector). Pure logic over a curated symbol table seeded from BSE/NSE master files. Interface: `resolve(query) → CanonicalCompany | null`.
2. **Source Ingestor** — Wraps ScrapeGraphAI. Knows which scraping recipe to use per `(source_kind, company)`. Interface: `fetchSources({ company, kind, since? }) → SourceDocument[]`. `kind ∈ {bse_filing, nse_filing, earnings_transcript}` in v1.
3. **Document Cache** — Postgres-backed (table `source_documents`) keyed by `(source_url, fetched_at_window)`. Re-fetches only on cache miss or stale TTL. Cuts ScrapeGraphAI cost.
4. **Agent Orchestrator** — Maps a logical request (`summarize_earnings_call`, `due_diligence_dossier`, `lead_intel_report`) to a specific Managed Agent template + system prompt + tool config. Interface: `runAgent(template, context) → RawAgentOutput`. Centralizes retries, cost tracking, and timeout policy.
5. **Report Composer** — Validates `RawAgentOutput` against a Zod schema per report type (`EarningsSummary`, `DueDiligenceReport`, `LeadIntelReport`) and rejects malformed output before persistence. Interface: `compose(raw, schema) → TypedReport`.
6. **Entitlements** — Tier-aware gating: `can(user, action) → boolean`, `quotaRemaining(user, action) → number`. Backed by a `tiers` table + `usage_events`. Single source of truth used by Edge Functions and (read-only) by frontends to render upsell UI.
7. **Job Runner** — For long-running reports (B2B dossiers, agency deep-dives) that exceed Edge Function execution windows. Uses Supabase Queues / `pg_cron`. Interface: `enqueue(jobSpec) → jobId`, `getJob(jobId) → JobStatus`. Frontend polls or subscribes via Supabase Realtime.
8. **Auth & Tenancy** — Supabase Auth (email magic-link + Google OAuth). Org-level tenancy for B2B/Agency tiers via an `organizations` + `org_members` schema. Postgres RLS policies isolate tenant data.
9. **Billing** — Razorpay subscriptions via webhook → Edge Function → updates `subscriptions` table → entitlements pick up new tier. GST-compliant invoice metadata stored alongside subscription.
10. **Audit Log** — Append-only `audit_events` table recording: each scrape (source URL, ScrapeGraphAI request id, cost), each agent run (template, tokens, cost, duration), each report export. Required for B2B/Agency compliance.
11. **Web App (Next.js)** — Three surfaces sharing a layout: `/r/*` retail, `/b/*` B2B dashboard, `/a/*` agency workbench. Tier inferred at session, routes guarded server-side.
12. **Mobile App (React Native)** — Retail-only in v1 (watchlist + push notifications + read-only summary view). B2B/Agency mobile is out of scope for v1.

### Schema (high-level)

- `organizations`, `org_members(role: admin|analyst|viewer)`
- `users` (Supabase Auth) + `user_profiles(tier, default_org_id)`
- `companies (id, nse_symbol, bse_code, isin, cin, name, sector)`
- `source_documents (id, company_id, kind, source_url, fetched_at, raw_content, scrape_request_id)`
- `reports (id, owner_id, org_id?, company_id, type, status, payload jsonb, created_at)`
- `subscriptions (id, owner_id|org_id, razorpay_sub_id, tier, status, current_period_end)`
- `usage_events (id, user_id, action, metadata, created_at)` — drives entitlements
- `audit_events (id, actor_id, kind, payload, created_at)` — append-only

### API contracts (Edge Functions)

- `POST /functions/v1/companies/resolve` → `CanonicalCompany`
- `POST /functions/v1/reports` `{ company_id, type }` → `{ job_id }`
- `GET  /functions/v1/jobs/:id` → `JobStatus`
- `GET  /functions/v1/reports/:id` → `TypedReport`
- `POST /functions/v1/billing/razorpay-webhook` → `200`
- All routes require Supabase JWT; RLS enforces tenant isolation.

### Architectural decisions

- **Edge Functions are the only backend.** Every API surface, webhook, and scheduled job runs as a Supabase Edge Function. No bespoke Node/Python server is permitted in v1.
- **All AI calls go through the Agent Orchestrator** — never directly from a route handler. This keeps cost tracking, retries, and prompt versioning in one place.
- **All scraping goes through the Source Ingestor + Document Cache.** No Edge Function calls ScrapeGraphAI directly.
- **Reports are immutable once composed.** Re-runs create new report rows, never mutate existing ones (audit + diffability).
- **Frontends never bypass Entitlements server-side.** Client-side gating is for UX only; the Edge Function re-checks every privileged action.

## Testing Decisions

A good test verifies **external behaviour** of a module — its inputs and outputs, not its internals. We do not test that a function called another function; we test that given inputs X, the module returns output Y, including for adversarial inputs.

### Modules with tests in v1

- **Company Resolver** — Pure logic, high blast radius if wrong (a misresolved ticker poisons every downstream report). Unit-test with a fixture symbol table covering: exact NSE symbol, exact BSE code, fuzzy name match, ambiguous name (multiple companies share a brand), CIN for unlisted private company, garbage input. Asserts on the returned `CanonicalCompany` shape and on null for unresolvable queries.
- **Report Composer** — The correctness boundary between unstructured agent output and persisted typed reports. Unit-test with fixture `RawAgentOutput` payloads representing: well-formed output, missing required field, extra fields (should be tolerated/stripped), wrong types, partially-filled output. Asserts the composer rejects invalid payloads cleanly rather than persisting half-formed reports.

### Modules without tests in v1 (decision)

Agent Orchestrator, Source Ingestor, Job Runner, Billing, and Entitlements ship without automated tests in v1 by explicit choice. They are validated by manual end-to-end runs and by the audit log in production. Tests for these are tracked as follow-up issues post-v1.

### Prior art

This is a greenfield repo — there is no existing test convention to mirror yet. The first two modules' tests should establish the pattern: Vitest for TypeScript unit tests, fixtures co-located under `__fixtures__/`, no mocking of internal modules (only of network boundaries).

## Out of Scope

- **Python / FastAPI middleware** of any kind. All logic stays in Edge Functions per ADR direction.
- **MCA21 ingestion** for private Indian companies — deferred to v1.1.
- **News / press / Moneycontrol ingestion** — deferred to v1.1.
- **B2B and Agency mobile apps** — v1 mobile is retail-only.
- **International companies** (US/UK/EU listings) — India-only in v1.
- **Real-time / streaming market data** (price ticks, intraday) — fundamentals-only in v1.
- **Custom-trained financial models** — v1 relies entirely on Anthropic Managed Agent templates.
- **Multi-language UI** — English only in v1; regional languages deferred.
- **A dedicated Stripe integration** — Razorpay is the only payment processor in v1.

## Further Notes

- **Cost modelling matters early.** ScrapeGraphAI + Managed Agent calls are the dominant variable cost. The Document Cache and the per-report cost recorded in `audit_events` are how we track unit economics from day one. Set tier quotas conservatively; raise them with data.
- **Source provenance is a feature, not infrastructure.** Both retail trust and B2B compliance depend on every claim being traceable to a source URL with a fetched-at timestamp. Treat citations as first-class output of the Report Composer, not a UI afterthought.
- **Greenfield repo.** No `CONTEXT.md`, no ADRs, no code yet. Glossary terms used in this PRD (`CanonicalCompany`, `SourceDocument`, `TypedReport`, `Entitlements`) should be promoted into `CONTEXT.md` when the repo is initialized.
- **Issue-tracker note.** This PRD lives at `docs/prd/0001-financial-intelligence-os.md`. Once the repo is `git init`'d and pushed to GitHub, publish as an issue with `gh issue create --title "PRD: Financial Intelligence & Due Diligence OS" --body-file docs/prd/0001-financial-intelligence-os.md --label needs-triage`.
