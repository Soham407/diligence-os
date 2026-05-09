# Anthropic Claude Managed Agents — Setup Notes

**API surface:** `managed-agents-2026-04-01` (beta).
**Captured:** 2026-05-10.

These notes capture the exact integration path for Claude Managed Agents in our stack (Supabase Edge Functions, no Python middleware). Anthropic hosts the orchestration, sandboxing, and tool execution — we only orchestrate the request flow.

## Step 1 — One-time CLI setup

Define the agent and its execution environment once on Anthropic's infrastructure.

### 1a. Create the agent

```bash
ant beta:agents create \
  --name "Due Diligence Analyst" \
  --model '{id: claude-opus-4-7}' \
  --system "You are an expert Indian market financial analyst. Process the provided raw scraped data and output structured due diligence reports." \
  --tool '{type: agent_toolset_20260401}'
```

Save the returned `agent_id`.

### 1b. Create the environment

Spins up the cloud container the agent thinks and executes tools in.

```bash
ant beta:environments create \
  --name "financial-runtime" \
  --config '{type: cloud, networking: {type: unrestricted}}'
```

Save the returned `environment_id`.

### Agents we'll create in v1

| Logical name             | Purpose                                         | Maps to module           |
| ------------------------ | ----------------------------------------------- | ------------------------ |
| Earnings Reviewer        | Summarize earnings call transcripts (Retail)    | Agent Orchestrator       |
| Due Diligence Analyst    | Full dossier on listed Indian company (B2B)     | Agent Orchestrator       |
| Lead Intel Generator     | Agency-mode deep-dive / lead intelligence       | Agent Orchestrator       |

Store `agent_id` and `environment_id` per logical agent in Supabase env vars or a `managed_agents` table.

## Step 2 — Supabase Edge Function (execution path)

The Edge Function is the orchestrator: scrape → hand off to Managed Agent → stream back to client.

```ts
// supabase/functions/generate-diligence/index.ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});

Deno.serve(async (req) => {
  const { targetUrl } = await req.json();

  const rawScrapedData = await fetchScrapeGraphData(targetUrl);

  const session = await client.beta.sessions.create({
    agent_id: Deno.env.get('AGENT_ID_DUE_DILIGENCE')!,
    environment_id: Deno.env.get('ENVIRONMENT_ID_FINANCIAL_RUNTIME')!,
    title: `Diligence Run: ${targetUrl}`,
  });

  const stream = await client.beta.sessions.streamEvents({
    session_id: session.id,
    messages: [
      {
        role: 'user',
        content: `Analyze this filing data: ${JSON.stringify(rawScrapedData)}`,
      },
    ],
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
});
```

Critical:

- **Beta header is required** — `'anthropic-beta': 'managed-agents-2026-04-01'`.
- **`agent_id` and `environment_id`** come from Step 1 — never hard-code in source, always read from env or DB.
- **Streaming** is `text/event-stream` — pipe directly to the Next.js client for real-time UI.

## Step 3 — Next.js frontend

The frontend posts to the Edge Function and reads the SSE stream:

```ts
const res = await fetch('/api/generate-diligence', {
  method: 'POST',
  body: JSON.stringify({ targetUrl }),
});

const reader = res.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  appendToReportUi(decoder.decode(value));
}
```

The user sees the report being written live as the Managed Agent reasons.

## Why this fits our architecture

- **No Python middleware.** Anthropic hosts orchestration, sandboxing, and tool execution; Supabase Edge Functions do nothing more than route.
- **No long-running server.** The Edge Function returns within its execution window because the heavy work is on Anthropic's side; we're streaming, not blocking.
- **Cost is observable per call.** Sessions and stream events are countable — funnel them through the Agent Orchestrator module so usage and spend land in `audit_events`.

## Open items

- Confirm rate limits and concurrency caps for `managed-agents-2026-04-01` against expected v1 traffic.
- Decide whether each logical agent gets its own `environment_id` or whether one shared `financial-runtime` environment suffices.
- Define the JSON schema we want the agent to emit per report type (consumed by the Report Composer module — see PRD-0001).
