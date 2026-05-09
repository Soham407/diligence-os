# PRD — Financial Intelligence & Due Diligence OS (India)

**Version:** 1.0
**Status:** Locked — ready for `to-issues` decomposition
**Date:** 2026-05-10
**Repo:** `Soham407/diligence-os`
**Supersedes:** `docs/prd/0001-financial-intelligence-os.md` (initial draft)

This PRD is the canonical specification. It is the output of a 10-question architectural grilling session that resolved every load-bearing ambiguity in the original draft. Every decision below is locked. Deviations require an ADR.

---

## Table of contents

1. [Problem statement](#1-problem-statement)
2. [Solution](#2-solution)
3. [Architectural decisions (locked)](#3-architectural-decisions-locked)
4. [User stories](#4-user-stories)
5. [Module breakdown](#5-module-breakdown)
6. [Database schema](#6-database-schema)
7. [API contracts](#7-api-contracts)
8. [Implementation decisions](#8-implementation-decisions)
9. [Testing decisions](#9-testing-decisions)
10. [Out of scope](#10-out-of-scope)
11. [Open items and risks](#11-open-items-and-risks)
12. [Glossary](#12-glossary)

---

## 1. Problem statement

Indian financial intelligence is fragmented across BSE/NSE disclosures, investor-relations PDFs, earnings call transcripts, MCA filings, and a long tail of regional news. Three audiences feel this acutely:

- **Retail investors** open an annual report or earnings transcript, hit 80 pages of dense prose, and bounce. They want the gist — what changed, what management is hiding, what the numbers actually say — in two minutes.
- **SME consultants, financial advisors, and wealth managers** assemble due-diligence dossiers by hand from MCA downloads, screenshots, and Moneycontrol tabs. A single client-ready dossier costs them half a day of skilled time.
- **Research agencies and boutique research shops** that sell research-as-a-service have no productization leverage — every client report is bespoke labour, not productized output.

The common root cause: there is no India-aware, agentic layer that can resolve a company, pull the right local sources, and reason over them with financial discipline. The market sub-segments differ in price tolerance, latency tolerance, and exclusivity expectation — but they share the same upstream data and the same need for citation-grounded structured intelligence.

## 2. Solution

A multi-tier financial analysis platform — **Diligence OS** — that mines Indian primary sources (BSE/NSE filings, earnings call transcripts in v1) and uses Anthropic Claude Managed Agents over MCP to produce structured, audited financial intelligence for three tiers in parallel:

- **Retail tier (freemium, Next.js + React Native).** Paste a ticker or company name → get an AI-summarized earnings call or annual report with key takeaways, sentiment shifts, and red flags.
- **B2B SaaS tier (paid, Next.js dashboard).** Run a full due-diligence dossier on a listed Indian company — financial health, governance, peer comparison, management commentary deltas — in minutes.
- **Agency tier (internal tool mode).** Generate white-label deep-dive market and lead-intelligence reports that the agency sells to its own clients under client-specific branding.

The architecture is deliberately lean: a Next.js / React Native frontend talks to **Supabase Edge Functions**, which orchestrate **ScrapeGraphAI** for ingestion and **Anthropic Managed Agents** for reasoning. There is no Python middleware, no dedicated server. Edge Functions are the only backend.

### High-level flow

```
Next.js / RN client
   │  (POST /functions/v1/reports)
   ▼
Supabase Edge Function  ── (ScrapeGraphAI REST) ──▶  Source documents
   │                                                   (cached, Layer 1)
   │  (Anthropic SDK with managed-agents-2026-04-01 beta)
   ▼
Claude Managed Agent (autonomous session)
   │
   ▼  submit_<type>_report tool call (typed JSON)
Report Composer  ──▶  Layer 2 cache (compositions)  ──▶  reports.payload (Layer 3, immutable)
```

### Sequencing note

Architecture is designed for all three tiers in parallel from day one. **Go-to-market sequencing leads with the Agency tier** — small research shops are the first paying ICP. The architecture does not bend toward Agency; the GTM order does.

---

## 3. Architectural decisions (locked)

Each decision below was resolved through grilling. The "Why" line summarizes the load-bearing reason. Deviations require a new ADR.

### AD-1. Tenancy: personal-org-by-default

**Decision.** Every user has at least one `organization` row, auto-created at signup by a Postgres trigger on `auth.users` insert. There is no "user-only" ownership of any data; every report, watchlist, and audit event belongs to exactly one org.

**Why.** A single ownership column (`org_id`) means one RLS rule, one code path, one schema shape. Dual-mode (user-or-org) doubles every privileged code path and creates tenant-confusion bugs that are hard to test.

**Mechanism.** Postgres trigger calls a function that inserts into `organizations` and `org_members` in the same transaction. No application-layer race window.

### AD-2. Membership: user → many orgs with active-org JWT claim

**Decision.** A user has many `org_members` rows. The session JWT carries an `active_org_id` claim in `app_metadata`. The client never passes `org_id` in request payloads. Org-switching goes through a dedicated Edge Function (or Supabase Custom Access Token Hook) that re-issues the JWT with the new claim.

**Why.** A wealth manager who is also a retail user is a real persona, not an edge case. Forcing one identity per user breaks that persona. Trusting client-supplied org IDs leaks data across tenants.

### AD-3. RLS: membership-verified active org via `current_active_org()`

**Decision.** Every RLS policy on org-scoped data uses a Postgres helper:

```sql
CREATE FUNCTION current_active_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT org_id FROM org_members
  WHERE user_id = auth.uid()
  AND   org_id  = (auth.jwt() -> 'app_metadata' ->> 'active_org_id')::uuid
  LIMIT 1
$$;
```

Policies become `org_id = current_active_org()`. The function returns NULL (no rows) when the user has been removed from the claimed org, immediately revoking access regardless of JWT TTL.

**Why.** A pure JWT claim check trusts that the user still belongs to the org they claim. Stale-JWT replay after kick-from-org would otherwise let a removed user read data for the rest of the token TTL. Membership verification on every query closes that gap with no perceptible cost (single-row lookup).

### AD-4. Report layering: three-layer with hybrid Layer 2 cache

**Decision.** Reports are physically modeled in three layers:

| Layer | What | Sharing model | Lifetime |
|---|---|---|---|
| **L1: source_documents** | Raw scraped data (filings, transcripts) | **Global** — keyed by `(source_url, fetched_at_window)` | Long-lived; refresh on TTL or new filing |
| **L2: compositions** | Typed JSON output of agent reasoning | **Hybrid** — cached for retail/B2B (6h TTL); **bypassed** when `project_id IS NOT NULL` (Agency) | TTL or until input set changes |
| **L3: reports** | User-facing immutable artifact (export, audit, white-label) | **Per-org** — one row per (org, request) | Permanent until explicit user delete |

Layer 2 cache key:

```
(company_id, report_type, source_doc_set_hash, agent_version)
source_doc_set_hash = sha256(JSON.stringify(source_documents_used.sort()))
```

When a new filing is scraped, the `source_documents_used` set changes, the hash changes, the cache misses, fresh composition runs. No manual invalidation required.

**Cache-bypass predicate for Agency:** `reports.project_id IS NOT NULL`. Every Agency-tier report carries a `project_id`; the Layer 2 lookup is skipped. This enforces the data exclusivity contract with agency clients (no cross-org cache contamination of client research).

**Why.** Public-record sources (L1) should be paid for once. Agent reasoning over those sources (L2) is a deterministic function of input set + agent version, so caching is safe and economically essential. The user-facing artifact (L3) is per-org for audit, white-label, and immutability. Agencies pay for exclusivity; their bypass predicate makes that contractual commitment a structural one.

### AD-5. Execution model: hybrid by report duration (Shape C)

**Decision.** Two execution paths:

- **Short reports (target latency < 30s).** Used for retail Earnings Summary. Edge Function calls `client.beta.sessions.streamEvents(...)` and pipes the SSE stream directly to the client. One Edge Function, one connection, no job table.
- **Long reports (target latency 1–5 min).** Used for B2B Due Diligence and Agency deep-dives. Edge Function creates the Anthropic Managed Agent session, returns `{ job_id }` in <1s. A separate `pg_cron` worker polls Anthropic for session events and writes them to a `job_events` table. The frontend subscribes via Supabase Realtime and renders updates.

**Why.** Anthropic Managed Agent sessions are autonomous — the Agent Harness drives reasoning on Anthropic's infrastructure regardless of whether a stream consumer is connected. This makes fire-and-forget safe. Edge Function wall-clock limits (~50s) force long reports off the streaming path. Short retail summaries don't need job-table plumbing and benefit from immediate UX feedback. Two paths, both correct for their workload, sharing the same Agent Orchestrator.

### AD-6. Structured output: final-tool-call as primary (Shape A)

**Decision.** Each agent has a custom output tool — `submit_earnings_summary`, `submit_due_diligence_report`, `submit_lead_intel_report` — whose JSON Schema *is* the report shape. The system prompt and `tool_choice` constrain the agent to end every run with a call to that tool. The tool's arguments are the structured report.

**Fallback.** Shape C (two-stage: stream thinking → non-streaming `response_format: json_schema` synthesis) reserved for edge cases where the tool-call shape doesn't fit (rare, free-form narrative sections).

**Why.** Anthropic's tool-use machinery handles schema validation, partial-arg streaming, and retries. The cached Layer 2 artifact is unambiguous (the tool args object). `agent_version` in the cache key has stable semantics — bumping the tool schema invalidates exactly the right cache slice.

### AD-7. Agent topology: one Managed Agent per report type, shared environment

**Decision.** Three Anthropic Managed Agents:

| Logical name | Tool | Used by |
|---|---|---|
| Earnings Reviewer | `submit_earnings_summary` | Retail tier |
| Due Diligence Analyst | `submit_due_diligence_report` | B2B SaaS tier |
| Lead Intel Generator | `submit_lead_intel_report` | Agency tier |

All three share one `environment_id` named `financial-runtime` (model: `claude-opus-4-7`). System prompts are composed at provisioning time from shared text fragments stored in this repo (citation rules, formatting standards, India-context constraints) plus per-agent persona fragments. CI/CD or a local build script renders the final prompts before invoking `ant beta:agents create` / update.

**Why.** Versioning isolation — a prompt fix to retail shouldn't risk B2B output. Cost attribution — `audit_events` records `agent_id`, so per-tier cost is a trivial GROUP BY. Tier separation — Agency-mode prompt overrides hit only the Agency agent. The drift risk between three system prompts is mitigated by the shared-fragment build process.

### AD-8. Company canonical key: companies + securities (Shape B)

**Decision.** Two canonical tables:

- `companies` — keyed by uuid; `cin` is the natural unique key (nullable for foreign / pre-MCA data). One row per legal entity. Reports always link to `companies.id`.
- `securities` — keyed by uuid; `isin` is the natural unique key. One row per security instrument. `nse_symbol` and `bse_code` are indexed columns on `securities` (no separate alias table in v1). `is_primary` boolean acts as the deterministic tie-break for the Company Resolver.

The Company Resolver normalizes any input (CIN, ISIN, NSE symbol, BSE code, free-text name) to a single `company_id`.

**Why.** Analytical artifacts (financials, governance, management commentary) are CIN-level. Multiple ISINs can attach to one CIN (dual-class shares). Private companies have CIN but no security — Shape B accommodates them as `companies` rows with no `securities` children, ready for v1.1 MCA21 ingestion without migration. Layer 2 cache hits on `company_id` correctly conflate "TCS" and "TATACONSUL" queries.

### AD-9. Tier upgrade path: personal-org retail-only; B2B/Agency are separate orgs (Shape B)

**Decision.** Personal orgs (auto-created at signup) are restricted to retail tiers (`retail_free`, `retail_pro`). Upgrading to B2B or Agency goes through a "Create Organization" flow:

1. User completes a form (legal name, billing email, GSTIN, plan choice).
2. Razorpay subscription is created and tied to `organizations.id` — not the user.
3. New `organizations` row inserted; user becomes auto-`admin` via `org_members`.
4. User's personal org is untouched; remains their retail playground.

Reports do not transfer between orgs in v1 — they live where they were born.

Active-org defaulting on login: `user_profiles.last_active_org_id` → fallback to personal org.

Active-org revocation when removed from a B2B/Agency org: handled structurally by `current_active_org()` (AD-3) returning NULL on the first query post-removal. JWT TTL refresh updates `app_metadata` to point back at personal org.

**Why.** Data separation between personal and professional research is a feature, not friction. Subscription cancellation gracefully falls back to personal retail org. Billing identity (GSTIN, billing email) lives only on B2B/Agency orgs and never gets entangled with personal accounts.

### AD-10. Agency client-project structure: flat projects table (Shape A)

**Decision.** A flat `projects` table:

```
projects (
  id, org_id, client_name, client_slug, white_label_config jsonb,
  created_by, created_at, archived_at
)
```

`reports.project_id` and `audit_events.project_id` are nullable foreign keys to `projects`. Retail and B2B reports always have `project_id IS NULL`; only Agency reports tag a project.

**White-label resolution contract (symmetric):** at PDF-export time, the Composer reads white-label from `project.white_label_config` if `project_id` is set, else from `org.white_label_config`, else falls back to platform defaults. This makes the export logic identical across all three tiers — only the lookup chain differs.

**Internal access control inside an Agency org is deferred.** All members of an Agency org see all projects in v1. Per-project ACLs (`project_members`) are an additive table reserved for v1.1.

**Why.** True hierarchical authorization (nested orgs) would force `current_active_org()` into recursive-CTE territory, breaking its single-row lookup performance. Agencies in v1 are small (<10 people) and project visibility is acceptable internally. The cache-bypass predicate `project_id IS NOT NULL` (locked in AD-4) makes data exclusivity for agency clients structural, not policy.

### AD-11. Source provenance / citation model

**Decision.** Per-claim citation granularity, hybrid storage, polymorphic locator, required verbatim quote with soft-match verification.

The agent's output tool emits structured citations inline:

```typescript
{
  sections: [
    {
      heading: string,
      claims: [
        {
          claim_id: string,                            // unique within report
          text: string,
          citations: [
            {
              source_document_id: uuid,
              locator:                                  // discriminated union
                | { type: "pdf_page",        page: number }
                | { type: "text_span",       start_char: number, end_char: number }
                | { type: "audio_timestamp", start_sec: number, end_sec: number }
                | { type: "html_anchor",     selector: string },
              quote: string                            // verbatim, ≤ 500 chars
            }
          ]
        }
      ]
    }
  ],
  executive_summary: string,
  key_takeaways: string[],
  red_flags: { text: string, citations: Citation[] }[],
  source_documents_used: uuid[]                         // sorted; drives cache hash
}
```

The Composer materializes citations into `report_citations` (see schema) for indexed lookup. Inlined payload remains the rendering source of truth.

**Composer contract (8 mandatory steps):**

1. Receive `submit_<type>_report` tool args.
2. Validate against tier-specific Zod schema with discriminated `locator` union.
3. Verify every cited `source_document_id` is present in `source_documents_used`.
4. Verify `claim_id` uniqueness within the report.
5. Verify `sha256(JSON.stringify(source_documents_used.sort()))` equals the precomputed `source_doc_set_hash` used as the cache key (integrity check that the agent didn't fabricate sources).
6. Substring-match each `quote` against `source_documents.raw_content`. Set `quote_verified = true` on hit; **soft-flag** (not reject) on miss with a `citation_verification_failed` event in `audit_events`.
7. Persist `reports.payload` (full inlined JSON) and `report_citations` rows in one transaction.
8. On steps 2–5 failure: reject, log to `audit_events`, retry once with stricter prompt. On second failure, fall back to Shape C synthesis (AD-6).

**Why.** Per-claim is the only granularity that makes the trust feature real — coarser groupings destroy verification. Hybrid storage gives both rendering performance and audit indexability. Polymorphic locator handles diverse Indian source formats (PDF filings, text transcripts, audio earnings calls, HTML pages) without a single rigid schema. Required quote turns "trust the AI" into "verify in two seconds." Soft-match verification catches gross hallucinations without rejecting valid paraphrases.

---

## 4. User stories

### Retail (freemium)

1. As a retail investor, I want to search for a listed Indian company by name or ticker, so that I can find the right entity without knowing its exact NSE/BSE symbol.
2. As a retail investor, I want to paste a link to an earnings call transcript or upload its PDF, so that I can get a summary even when our automated source fetch misses it.
3. As a retail investor, I want a 60-second AI-generated summary of an earnings call, so that I understand the key takeaways without reading the transcript.
4. As a retail investor, I want quarter-over-quarter sentiment and tone deltas highlighted, so that I can spot when management's framing has shifted.
5. As a retail investor, I want a "red flags" section calling out evasive answers, guidance changes, and unusual accounting language, so that I can think critically about what I'm reading.
6. As a retail investor, I want a simplified summary of the latest annual report, so that I get the big picture without parsing 200 pages.
7. As a retail investor, I want to bookmark companies into a watchlist, so that I get a fresh summary when new filings drop.
8. As a retail investor, I want a free tier that lets me run N summaries per month, so that I can try the product before paying.
9. As a retail investor, I want to upgrade via Razorpay using UPI or netbanking, so that I can pay with what I actually have.
10. As a retail investor on mobile, I want a React Native app that gives me push notifications when a watchlisted company files results, so that I never miss the moment.
11. As a retail investor, I want every claim in the summary to link back to the exact page or timestamp in the source, so that I can verify and trust the AI's output.
12. As a retail investor, I want the report to stream into the UI as it's generated, so that I see progress and never wait on a blank page.

### B2B SaaS (consultants, advisors, wealth managers)

13. As a wealth manager, I want to enter a listed Indian company and get a full due-diligence dossier in under five minutes, so that I can prepare for a client call same-day.
14. As a financial advisor, I want the dossier to cover financial health, governance, ownership structure, and peer comparison, so that I cover the standard checklist without manual assembly.
15. As an SME consultant, I want side-by-side comparison of the same company's last four earnings calls, so that I can see how the narrative has evolved.
16. As a wealth manager, I want to download the dossier as a branded PDF, so that I can share it with clients in a presentable format.
17. As a wealth manager, I want my organization's logo and disclaimers on every export, so that exported reports look like they came from us.
18. As a B2B admin, I want to invite team members and assign them seats, so that my whole team can use the platform without sharing logins.
19. As a B2B admin, I want role-based access (admin, analyst, viewer), so that junior analysts can't accidentally change billing.
20. As a B2B user, I want to see how many dossiers my team has run this month and how many remain in our plan, so that I can manage usage proactively.
21. As a B2B user, I want each report to show its source list with timestamps and verbatim quotes, so that I can defend conclusions to a compliance officer.
22. As a B2B user, I want to subscribe via Razorpay with GST-compliant invoices, so that I can expense the subscription cleanly.
23. As a B2B user, I want long-running reports to run in the background, so that I can close my laptop and come back to a finished dossier.
24. As a B2B user, I want my reports to remain accessible read-only after I cancel my subscription, so that historical work isn't held hostage.

### Agency (internal tool mode)

25. As an agency operator, I want to spin up a "research project" tied to a client, so that I can keep multiple engagements separate.
26. As an agency operator, I want to pick from report templates (lead intelligence, deep-dive market research, competitive landscape), so that I don't reinvent the structure each time.
27. As an agency operator, I want to add ad-hoc URLs as additional sources, so that I can include client-supplied private docs in the analysis.
28. As an agency operator, I want to edit the AI's output before exporting, so that I can polish or correct it before delivery.
29. As an agency operator, I want a fully white-label PDF export with no mention of our platform, so that the client experience is mine, not the tool's.
30. As an agency operator, I want a tamper-evident audit log of every source fetched and every agent run for a project, so that I can prove provenance to a client or regulator.
31. As an agency operator, I want guarantee that my client's dossiers are never reused to serve another firm's request, so that exclusivity is structural, not contractual.

### Cross-cutting

32. As any user, I want to authenticate via email magic-link or Google OAuth, so that I don't manage another password.
33. As any user, I want my session to persist across web and mobile, so that I can switch devices without re-logging in.
34. As any user, I want to see clearly which tier and org I'm acting as, so that upgrade and access decisions are informed.
35. As any user with multiple orgs, I want a fast org switcher in the UI, so that I can move between personal and work contexts without logging out.
36. As any user, I want to be immediately revoked from an org's data when removed by an admin, so that organizational membership reflects reality.
37. As an operator, I want every scrape and agent call recorded with cost, so that I can monitor unit economics per report.
38. As an operator, I want rate limits per tier enforced server-side, so that abuse cannot blow through our ScrapeGraphAI / Anthropic budget.

---

## 5. Module breakdown

Twelve modules. Each is designed as a deep module — small, stable interface hiding meaningful complexity. Interfaces below are illustrative, not normative for file paths.

| # | Module | Interface (illustrative) | Owner of |
|---|---|---|---|
| 1 | **Company Resolver** | `resolve(query) → company_id \| null` | Free-text → canonical entity |
| 2 | **Source Ingestor** | `fetchSources({company, kind, since?}) → SourceDocument[]` | ScrapeGraphAI orchestration |
| 3 | **Document Cache** | `getOrFetch(source_url, ttl) → SourceDocument` | L1 dedup |
| 4 | **Agent Orchestrator** | `runAgent({type, context, sessionMode}) → RawAgentOutput` | Anthropic Managed Agents calls |
| 5 | **Report Composer** | `compose(rawArgs, schema) → TypedReport` | 8-step contract (AD-11) |
| 6 | **Entitlements** | `can(activeOrg, action) → bool`, `quotaRemaining(activeOrg, action) → number` | Tier gating |
| 7 | **Job Runner** | `enqueue(spec) → job_id`, `getJob(id) → JobStatus` | Long-report polling + Realtime |
| 8 | **Auth & Tenancy** | RLS helpers + org lifecycle | Personal-org trigger, JWT issuance |
| 9 | **Billing** | Razorpay webhook handler | Subscription state → Entitlements |
| 10 | **Web App (Next.js)** | — | Retail / B2B / Agency surfaces |
| 11 | **Mobile App (React Native)** | — | Retail-only in v1 |
| 12 | **Audit Log** | `record(event)` | Append-only provenance + cost |

Cross-cutting rules:

- **All AI calls go through the Agent Orchestrator.** Never direct from a route handler.
- **All scraping goes through the Source Ingestor + Document Cache.** No Edge Function calls ScrapeGraphAI directly.
- **Frontends never bypass Entitlements server-side.** Client-side gating is for UX only; the Edge Function re-checks every privileged action.
- **Reports are immutable once composed.** Re-runs create new `reports` rows.

---

## 6. Database schema

This is the v1 schema. Migrations are tracked in `supabase/migrations/` once the app code is bootstrapped. Tables grouped by concern.

### Identity and tenancy

```sql
-- users come from auth.users (Supabase managed)
-- one personal org auto-created via trigger on auth.users insert

CREATE TABLE organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  org_type            text NOT NULL CHECK (org_type IN ('personal','b2b','agency')),
  plan                text NOT NULL,
  billing_email       text,
  gstin               text,
  white_label_config  jsonb DEFAULT '{}',
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE org_members (
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('admin','analyst','viewer')),
  created_at          timestamptz DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX ON org_members (user_id);

CREATE TABLE user_profiles (
  user_id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  personal_org_id     uuid NOT NULL REFERENCES organizations(id),
  last_active_org_id  uuid REFERENCES organizations(id),
  display_name        text,
  created_at          timestamptz DEFAULT now()
);

CREATE FUNCTION current_active_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT org_id FROM org_members
  WHERE user_id = auth.uid()
  AND   org_id  = (auth.jwt() -> 'app_metadata' ->> 'active_org_id')::uuid
  LIMIT 1
$$;
```

### Canonical entities (AD-8)

```sql
CREATE TABLE companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cin                 text UNIQUE,                 -- nullable for foreign / pre-MCA data
  pan                 text UNIQUE,
  legal_name          text NOT NULL,
  display_name        text NOT NULL,
  sector              text,
  listing_status      text CHECK (listing_status IN ('listed','private','delisted')),
  mca_metadata        jsonb DEFAULT '{}',
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE securities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  isin                text UNIQUE NOT NULL,
  security_type       text CHECK (security_type IN ('equity','debt','preference')),
  nse_symbol          text,
  bse_code            text,
  is_primary          bool DEFAULT false,
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX ON securities (company_id);
CREATE INDEX ON securities (nse_symbol);
CREATE INDEX ON securities (bse_code);
CREATE UNIQUE INDEX one_primary_per_company
  ON securities (company_id) WHERE is_primary = true;
```

### Layer 1: source documents (global)

```sql
CREATE TABLE source_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid REFERENCES companies(id),
  kind                text NOT NULL CHECK (kind IN ('bse_filing','nse_filing','earnings_transcript')),
  source_url          text NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  fetched_at_window   text NOT NULL,               -- e.g. '2026-05-10T00' for hourly windows
  raw_content         text NOT NULL,
  scrape_request_id   text,                        -- ScrapeGraphAI request ref
  metadata            jsonb DEFAULT '{}',
  UNIQUE (source_url, fetched_at_window)
);

CREATE INDEX ON source_documents (company_id, kind);
```

### Layer 2: cached compositions

```sql
CREATE TABLE compositions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  report_type         text NOT NULL CHECK (report_type IN ('earnings_summary','due_diligence','lead_intel')),
  source_doc_set_hash text NOT NULL,
  agent_version       text NOT NULL,
  payload             jsonb NOT NULL,              -- the validated tool args
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,        -- 6h TTL
  UNIQUE (company_id, report_type, source_doc_set_hash, agent_version)
);

CREATE INDEX ON compositions (expires_at);
```

### Agency projects (AD-10)

```sql
CREATE TABLE projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_name         text NOT NULL,
  client_slug         text NOT NULL,
  white_label_config  jsonb DEFAULT '{}',
  created_by          uuid REFERENCES auth.users(id),
  created_at          timestamptz DEFAULT now(),
  archived_at         timestamptz,
  UNIQUE (org_id, client_slug)
);
```

### Layer 3: reports + citations (AD-11)

```sql
CREATE TABLE reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  project_id          uuid REFERENCES projects(id),     -- null for retail/B2B
  company_id          uuid NOT NULL REFERENCES companies(id),
  report_type         text NOT NULL CHECK (report_type IN ('earnings_summary','due_diligence','lead_intel')),
  composition_id      uuid REFERENCES compositions(id),  -- null for agency (cache bypass)
  source_doc_set_hash text NOT NULL,
  agent_version       text NOT NULL,
  status              text NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  payload             jsonb,                              -- full inlined report incl. citations
  created_by          uuid REFERENCES auth.users(id),
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX ON reports (org_id, created_at DESC);
CREATE INDEX ON reports (project_id) WHERE project_id IS NOT NULL;

CREATE TABLE report_citations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id           uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  claim_id            text NOT NULL,
  source_document_id  uuid NOT NULL REFERENCES source_documents(id),
  locator             jsonb NOT NULL,
  quote               text NOT NULL,
  quote_verified      bool DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  UNIQUE (report_id, claim_id, source_document_id)
);

CREATE INDEX ON report_citations (source_document_id);
CREATE INDEX ON report_citations (report_id, claim_id);
```

### Jobs (AD-5)

```sql
CREATE TABLE jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  report_id           uuid REFERENCES reports(id),
  anthropic_session_id text,
  status              text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE job_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind                text NOT NULL,
  payload             jsonb,
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX ON job_events (job_id, created_at);
```

Realtime is enabled on `job_events` and `reports`. Frontend subscribes to job events for live progress.

### Audit log

```sql
CREATE TABLE audit_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid REFERENCES organizations(id),
  project_id          uuid REFERENCES projects(id),
  actor_id            uuid REFERENCES auth.users(id),
  kind                text NOT NULL,                  -- 'scrape','agent_run','export','citation_verification_failed', ...
  payload             jsonb NOT NULL DEFAULT '{}',    -- includes cost, tokens, duration
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX ON audit_events (org_id, created_at DESC);
CREATE INDEX ON audit_events (project_id) WHERE project_id IS NOT NULL;
```

`audit_events` is append-only — enforced by a row-level policy that allows INSERT but denies UPDATE and DELETE, plus a Postgres role separation in the migration phase.

### Subscriptions (Razorpay)

```sql
CREATE TABLE subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL UNIQUE REFERENCES organizations(id),
  razorpay_sub_id     text UNIQUE NOT NULL,
  plan                text NOT NULL,
  status              text NOT NULL,                 -- 'active','past_due','cancelled','expired'
  current_period_end  timestamptz,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE usage_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  user_id             uuid REFERENCES auth.users(id),
  action              text NOT NULL,                  -- 'report_generated', etc.
  metadata            jsonb DEFAULT '{}',
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX ON usage_events (org_id, action, created_at);
```

### RLS policy template

Every org-scoped table follows this template:

```sql
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_member_read ON reports
  FOR SELECT USING (org_id = current_active_org());

CREATE POLICY org_member_write ON reports
  FOR INSERT WITH CHECK (org_id = current_active_org());

-- Reports are immutable: no UPDATE policy.
-- Optional admin DELETE policy gated on role check.
```

---

## 7. API contracts (Edge Functions)

All routes require Supabase JWT. RLS handles tenant isolation; Edge Functions never accept `org_id` from the client.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/functions/v1/companies/resolve` | Free-text → `CanonicalCompany` |
| `POST` | `/functions/v1/reports` | Body: `{ company_id, report_type, project_id?, custom_sources? }`. Returns `{ report_id, mode: 'stream' \| 'job', job_id? }` |
| `GET`  | `/functions/v1/reports/:id` | Returns `TypedReport` (Layer 3 row) |
| `GET`  | `/functions/v1/jobs/:id` | Returns `JobStatus` |
| `POST` | `/functions/v1/orgs/switch` | Body: `{ org_id }`. Re-issues JWT with new `active_org_id`. |
| `POST` | `/functions/v1/orgs` | Create B2B/Agency org; initiates Razorpay subscription |
| `POST` | `/functions/v1/projects` | Create Agency project |
| `GET`  | `/functions/v1/exports/:report_id.pdf` | White-labeled PDF (lookup chain: project → org → platform) |
| `POST` | `/functions/v1/billing/razorpay-webhook` | Subscription state → `subscriptions` table |

`POST /reports` decides streaming vs job mode by `report_type`:

- `earnings_summary` → streaming (AD-5 short path)
- `due_diligence`, `lead_intel` → job mode (AD-5 long path)

---

## 8. Implementation decisions

### Stack

- **Frontend:** Next.js (web) + React Native (mobile, retail-only v1), TypeScript, Tailwind CSS. Shared design system in a `ui` workspace package. Vitest for unit tests.
- **Backend:** Supabase only — Postgres for state, Auth for identity, Edge Functions (TypeScript / Deno) for all custom logic. **No Python middleware in v1; this is a binding architectural constraint.**
- **Ingestion:** ScrapeGraphAI via REST API (Node SDK from inside Edge Functions). v1 source kinds: `bse_filing`, `nse_filing`, `earnings_transcript`.
- **Reasoning:** Anthropic Claude Managed Agents (`managed-agents-2026-04-01` beta header). Three agents on a shared `financial-runtime` environment. Model: `claude-opus-4-7`.
- **Payments:** Razorpay subscriptions. Webhooks → Edge Function → `subscriptions` table → entitlements pick up new tier.

### Prompt management (AD-7 mechanism)

System prompts are composed at provisioning time:

```
prompts/
├── shared/
│   ├── citation-rules.md
│   ├── india-context.md
│   ├── formatting-standards.md
│   └── negative-constraints.md
├── earnings-reviewer/
│   └── persona.md
├── due-diligence-analyst/
│   └── persona.md
└── lead-intel-generator/
    └── persona.md
```

A build script concatenates `shared/*` + `<agent>/persona.md` + tool schema into the final system prompt for each agent and updates them via `ant beta:agents update`. Prompt versions are stored in repo and `agent_version` (used in Layer 2 cache key) is the build hash.

### Streaming vs job mode (AD-5 mechanism)

**Streaming path** (`earnings_summary`):

```ts
const stream = await client.beta.sessions.streamEvents({
  session_id: session.id,
  messages: [{ role: 'user', content: contextWithSources }]
});
return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' }});
```

**Job path** (`due_diligence`, `lead_intel`):

1. Edge Function creates Anthropic session, inserts `jobs` and `reports` rows (status `pending`), returns `{ report_id, job_id }`.
2. `pg_cron` worker (every 10s) iterates `jobs WHERE status='running'`, polls Anthropic session for new events, inserts into `job_events`.
3. Frontend subscribes to `job_events` and `reports` via Supabase Realtime, renders updates.
4. On session completion, the worker invokes the Composer (8 steps), updates `reports.payload` and `jobs.status='succeeded'`.

### Tier gating mechanism

`Entitlements.can(activeOrg, action)` is called server-side at the start of every privileged Edge Function. Tiers are read from `subscriptions.plan`. Quotas are computed from `usage_events` over a rolling window.

Client-side, the same logic is mirrored as read-only state (from a `/me` endpoint) for UX gating — but the server is the source of truth and re-checks every action.

### Audit-log immutability mechanism

`audit_events` is append-only enforced two ways:

1. RLS policies on the table allow INSERT, deny UPDATE and DELETE.
2. Migrations grant only INSERT and SELECT to the application Postgres role; UPDATE/DELETE require a separate elevated role used only for one-off corrections under explicit operational policy.

### Data residency

Supabase project provisioned in `ap-south-1` (Mumbai). Confirmed before any production data is loaded.

---

## 9. Testing decisions

A good test verifies external behaviour of a module — its inputs and outputs, not its internals. We do not test that a function called another function. We test that given inputs X, the module returns output Y, including for adversarial inputs.

### Modules with tests in v1

**Module 1 — Company Resolver.** Pure logic, high blast radius if wrong. Unit tests with a fixture symbol table covering: exact NSE symbol, exact BSE code, fuzzy name match, ambiguous brand name (multiple companies share it), CIN for unlisted private company, garbage input, dual-class disambiguation via `is_primary`. Asserts on `company_id` resolution and on `null` for unresolvable queries.

**Module 5 — Report Composer.** The correctness boundary between unstructured agent output and persisted typed reports. Unit tests with fixture `RawAgentOutput` payloads covering: well-formed output, missing required field, extra fields (tolerated/stripped), wrong types, partially-filled output, citations referencing source IDs not in `source_documents_used` (must reject step 3), duplicate `claim_id` (must reject step 4), `source_doc_set_hash` mismatch (must reject step 5), quote substring miss (must soft-flag step 6, not reject). Asserts the 8-step contract is honored exactly.

### Modules without automated tests in v1 (explicit decision)

Agent Orchestrator, Source Ingestor, Job Runner, Billing, Entitlements, Auth & Tenancy. These ship with manual end-to-end runs and audit-log monitoring. Tests for these are tracked as v1.1 follow-up issues.

### Tooling

- **Vitest** for TypeScript unit tests. Fixtures co-located under `__fixtures__/`.
- **No mocking of internal modules.** Mock only at network boundaries (ScrapeGraphAI, Anthropic).
- **Postgres-level tests** for RLS policies — fixture two users in different orgs, verify cross-org read returns empty.

---

## 10. Out of scope

- **Python or FastAPI middleware of any kind.** All logic stays in Supabase Edge Functions per AD-7 and the binding stack constraint.
- **MCA21 ingestion** for private Indian companies — deferred to v1.1.
- **News, press, Moneycontrol ingestion** — deferred to v1.1.
- **B2B and Agency mobile apps** — v1 mobile is retail-only.
- **International companies** (US/UK/EU listings) — India-only in v1.
- **Real-time / streaming market data** (price ticks, intraday quotes) — fundamentals-only in v1.
- **Custom-trained financial models** — v1 relies entirely on Anthropic Managed Agent templates.
- **Multi-language UI** — English only in v1.
- **Stripe** — Razorpay is the only payment processor in v1.
- **Per-project ACLs (`project_members`)** within Agency orgs — deferred to v1.1.
- **Cross-org report transfer** — reports stay in the org they were born in.
- **Hard hallucination rejection on quote-substring miss** — v1 soft-flags only.
- **Per-security analytical reports** (e.g., DVR-specific dossiers) — v1 reports are entity-level (`company_id`).

---

## 11. Open items and risks

These are detail-level items deferred to PLAN, not architectural ambiguities.

| Item | Why deferred | When resolved |
|---|---|---|
| Rate limit policy per tier (req/min, reports/day) | Operational tuning | Pre-launch load test |
| Cost ceiling per agent run (token / time cap) | Anthropic API specifics | First week of integration |
| Push notification provider (FCM vs Expo) | Mobile build choice | RN scaffold phase |
| ScrapeGraphAI recipe storage location (code vs DB) | Both viable; pick during ingestion phase | Source Ingestor implementation |
| White-label PDF generation library | Multiple viable options | Export feature phase |
| Free-tier quota numbers | Needs cost data | Pre-launch with real ScrapeGraphAI/Anthropic pricing |
| GST invoice PDF template | Compliance review | Billing implementation |
| Anthropic webhook support for session completion | If supported, replaces `pg_cron` polling | Verified during Agent Orchestrator build |
| Internal Agency analyst access boundary | Acceptable v1 risk; sales-conversation mitigation | v1.1 `project_members` |
| SEBI advisory T&C language | Legal review | Pre-launch with counsel |

### Known risks

- **Agent prompt drift across three agents.** Mitigated by shared-fragment build process (AD-7).
- **Citation hallucinations.** Mitigated by `submit_report` integrity check (Composer step 5) + soft-match verification (step 6) + audit-log review.
- **JWT staleness post-org-removal.** Mitigated structurally by `current_active_org()` (AD-3) returning NULL on first query, regardless of TTL.
- **Cache key drift on agent prompt changes.** Mitigated by including `agent_version` (build hash) in Layer 2 cache key.
- **Edge Function cold-start latency for retail streaming.** Will measure pre-launch; mitigation is Supabase Edge Function pre-warming or moving retail to a dedicated function deployment.

---

## 12. Glossary

Terms used throughout this PRD with locked definitions.

- **Active org.** The single organization the user's session is currently acting on behalf of. Carried in the JWT `app_metadata.active_org_id` claim.
- **Agent.** An Anthropic Managed Agent — one of `Earnings Reviewer`, `Due Diligence Analyst`, `Lead Intel Generator`. Each has its own `agent_id` and emits structured output via a `submit_<type>_report` tool call.
- **Agent version.** The build hash of the composed system prompt + tool schema for an agent. Part of the Layer 2 cache key.
- **Canonical company.** A row in the `companies` table identified by `company_id` (uuid). Natural unique key is CIN.
- **Cache bypass predicate.** `reports.project_id IS NOT NULL`. Reports with this property never read from or write to Layer 2 compositions cache.
- **Composition.** A Layer 2 cached row holding the validated tool args output from an agent run, keyed by `(company_id, report_type, source_doc_set_hash, agent_version)`.
- **`current_active_org()`.** Postgres helper used by every RLS policy to verify the user's claimed active org against live `org_members`.
- **Org.** A row in `organizations`. Three types: `personal`, `b2b`, `agency`. Plan determines tier and feature access.
- **Personal org.** An auto-created org of size 1, restricted to retail tiers. Cannot upgrade to B2B or Agency in place.
- **Project (Agency).** A row in `projects` representing one client engagement. Carries white-label config and triggers Layer 2 cache bypass.
- **Report.** A Layer 3 row in `reports` — the immutable user-facing artifact. Always belongs to exactly one org.
- **Source document.** A Layer 1 row in `source_documents` — raw scraped data, globally shared and deduped.
- **`source_doc_set_hash`.** `sha256(JSON.stringify(source_documents_used.sort()))`. Determines Layer 2 cache hits and acts as Composer integrity check.
- **Tool-call output.** The pattern where an agent emits structured output by calling a custom tool (e.g., `submit_due_diligence_report`) whose JSON schema is the report shape.
