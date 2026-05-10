export type ReportType = "earnings_summary" | "due_diligence" | "lead_intel";

const TOOL_BY_REPORT_TYPE: Record<ReportType, string> = {
  earnings_summary: "submit_earnings_summary",
  due_diligence: "submit_due_diligence_report",
  lead_intel: "submit_lead_intel_report"
};

const AGENT_ENV_BY_REPORT_TYPE: Record<ReportType, string> = {
  earnings_summary: "ANTHROPIC_AGENT_ID_EARNINGS_REVIEWER",
  due_diligence: "ANTHROPIC_AGENT_ID_DUE_DILIGENCE_ANALYST",
  lead_intel: "ANTHROPIC_AGENT_ID_LEAD_INTEL_GENERATOR"
};

type AgentContext = {
  companyId: string;
  sourceDocumentIds: string[];
  customSources: string[];
  projectId: string | null;
};

export type AgentRunInput = {
  type: ReportType;
  context: AgentContext;
  sessionMode: "stream" | "sync";
};

export type AgentUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

type CostRates = {
  inputPerMillion: number;
  outputPerMillion: number;
};

type AgentCompletion = {
  payload: Record<string, unknown>;
  usage: AgentUsage;
  durationMs: number;
  cost: number | null;
};

type BaseRunResult = {
  toolName: string;
  agentId: string;
  agentVersion: string;
};

export type StreamRunResult = BaseRunResult & {
  mode: "stream";
  stream: ReadableStream<Uint8Array>;
  completion: Promise<AgentCompletion>;
};

export type SyncRunResult = BaseRunResult & {
  mode: "sync";
  completion: Promise<AgentCompletion>;
};

export type AgentRunResult = StreamRunResult | SyncRunResult;

function toPositiveNumber(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getCostRates(): CostRates {
  return {
    inputPerMillion: toPositiveNumber(Deno.env.get("ANTHROPIC_INPUT_COST_PER_MILLION_USD"), 0),
    outputPerMillion: toPositiveNumber(Deno.env.get("ANTHROPIC_OUTPUT_COST_PER_MILLION_USD"), 0)
  };
}

export function estimateCostUsd(usage: AgentUsage, rates: CostRates): number | null {
  if (usage.inputTokens === null && usage.outputTokens === null) {
    return null;
  }

  const inputComponent = ((usage.inputTokens ?? 0) / 1_000_000) * rates.inputPerMillion;
  const outputComponent = ((usage.outputTokens ?? 0) / 1_000_000) * rates.outputPerMillion;
  return Number((inputComponent + outputComponent).toFixed(10));
}

function buildAnthropicBody(input: AgentRunInput, toolName: string, agentId: string, stream: boolean) {
  return {
    model: "claude-opus-4-7",
    max_tokens: 1200,
    stream,
    tools: [
      {
        name: toolName,
        description: `Submit final ${input.type} report payload`,
        input_schema: {
          type: "object",
          properties: {
            executive_summary: { type: "string" },
            key_takeaways: { type: "array", items: { type: "string" } },
            source_documents_used: { type: "array", items: { type: "string" } }
          },
          required: ["executive_summary", "key_takeaways", "source_documents_used"],
          additionalProperties: true
        }
      }
    ],
    tool_choice: { type: "tool", name: toolName },
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          agent_id: agentId,
          report_type: input.type,
          company_id: input.context.companyId,
          source_document_ids: input.context.sourceDocumentIds,
          custom_sources: input.context.customSources,
          project_id: input.context.projectId
        })
      }
    ]
  };
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseUsageFromSseData(data: string): AgentUsage {
  try {
    const parsed = JSON.parse(data) as {
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      message?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    };

    const usage = parsed.usage ?? parsed.message?.usage;

    return {
      inputTokens: toNumberOrNull(usage?.input_tokens),
      outputTokens: toNumberOrNull(usage?.output_tokens)
    };
  } catch {
    return { inputTokens: null, outputTokens: null };
  }
}

function forEachSseEvent(
  sseText: string,
  onEvent: (eventName: string, data: string) => void
): void {
  const normalized = sseText.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");

  let eventName = "message";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }

    const data = dataLines.join("\n");
    onEvent(eventName, data);
    eventName = "message";
    dataLines = [];
  };

  for (const line of lines) {
    if (line.length === 0) {
      flush();
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  flush();
}

type ToolCollectorState = {
  activeIndex: number | null;
  partialInput: string;
  finalPayload: Record<string, unknown> | null;
};

function updateToolCollector(
  state: ToolCollectorState,
  parsed: {
    type?: string;
    index?: number;
    content_block?: { type?: string; name?: string; input?: unknown };
    delta?: { type?: string; partial_json?: string };
    name?: string;
    input?: unknown;
  },
  toolName: string
): void {
  if (state.finalPayload) {
    return;
  }

  if (parsed.type === "content_block_start") {
    if (parsed.content_block?.type === "tool_use" && parsed.content_block?.name === toolName) {
      state.activeIndex = typeof parsed.index === "number" ? parsed.index : null;
      state.partialInput = "";

      if (parsed.content_block.input && typeof parsed.content_block.input === "object") {
        state.finalPayload = parsed.content_block.input as Record<string, unknown>;
      }
    }

    return;
  }

  if (parsed.type === "content_block_delta") {
    if (
      state.activeIndex !== null &&
      parsed.index === state.activeIndex &&
      parsed.delta?.type === "input_json_delta"
    ) {
      state.partialInput += parsed.delta.partial_json ?? "";
    }

    return;
  }

  if (parsed.type === "content_block_stop") {
    if (state.activeIndex !== null && parsed.index === state.activeIndex && state.partialInput.length > 0) {
      try {
        const parsedInput = JSON.parse(state.partialInput);
        if (parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)) {
          state.finalPayload = parsedInput as Record<string, unknown>;
        }
      } catch {
        // keep null and fail at completion boundary if we never receive a valid tool payload
      }
    }

    return;
  }

  if (parsed.type === "tool_use" && parsed.name === toolName && parsed.input && typeof parsed.input === "object") {
    state.finalPayload = parsed.input as Record<string, unknown>;
  }
}

export function extractToolPayloadFromSse(
  sseText: string,
  toolName: string
): Record<string, unknown> | null {
  const state: ToolCollectorState = {
    activeIndex: null,
    partialInput: "",
    finalPayload: null
  };

  forEachSseEvent(sseText, (_eventName, data) => {
    if (data === "[DONE]") {
      return;
    }

    try {
      const parsed = JSON.parse(data) as {
        type?: string;
        index?: number;
        content_block?: { type?: string; name?: string; input?: unknown };
        delta?: { type?: string; partial_json?: string };
        name?: string;
        input?: unknown;
      };
      updateToolCollector(state, parsed, toolName);
    } catch {
      // ignore non-JSON stream chunks
    }
  });

  return state.finalPayload;
}

function extractUsageFromSse(sseText: string): AgentUsage {
  const usage: AgentUsage = {
    inputTokens: null,
    outputTokens: null
  };

  forEachSseEvent(sseText, (_eventName, data) => {
    if (data === "[DONE]") {
      return;
    }

    const eventUsage = parseUsageFromSseData(data);
    if (eventUsage.inputTokens !== null) {
      usage.inputTokens = eventUsage.inputTokens;
    }

    if (eventUsage.outputTokens !== null) {
      usage.outputTokens = eventUsage.outputTokens;
    }
  });

  return usage;
}

async function callAnthropicManagedAgent(
  input: AgentRunInput,
  toolName: string,
  agentId: string,
  anthropicApiKey: string
): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01"
    },
    body: JSON.stringify(buildAnthropicBody(input, toolName, agentId, false))
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${details}`);
  }

  const body = (await response.json()) as {
    content?: Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };

  const toolUse = body.content?.find((item) => item.type === "tool_use" && item.name === toolName);
  if (!toolUse?.input) {
    throw new Error(`Anthropic response missing required tool_use: ${toolName}`);
  }

  return toolUse.input;
}

async function collectCompletionFromSse(
  stream: ReadableStream<Uint8Array>,
  toolName: string,
  startedAtMs: number
): Promise<AgentCompletion> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let sseText = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (value) {
        sseText += decoder.decode(value, { stream: true });
      }
    }

    sseText += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  const payload = extractToolPayloadFromSse(sseText, toolName);
  if (!payload) {
    throw new Error(`Anthropic stream completed without final tool payload: ${toolName}`);
  }

  const usage = extractUsageFromSse(sseText);
  const durationMs = Math.max(Date.now() - startedAtMs, 0);

  return {
    payload,
    usage,
    durationMs,
    cost: estimateCostUsd(usage, getCostRates())
  };
}

async function callAnthropicManagedAgentStream(
  input: AgentRunInput,
  toolName: string,
  agentId: string,
  anthropicApiKey: string
): Promise<{ stream: ReadableStream<Uint8Array>; completion: Promise<AgentCompletion> }> {
  const startedAtMs = Date.now();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01"
    },
    body: JSON.stringify(buildAnthropicBody(input, toolName, agentId, true))
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Anthropic streaming request failed (${response.status}): ${details}`);
  }

  if (!response.body) {
    throw new Error("Anthropic streaming response did not include a body");
  }

  const [clientStream, collectorStream] = response.body.tee();
  const completion = collectCompletionFromSse(collectorStream, toolName, startedAtMs);

  return { stream: clientStream, completion };
}

function createSseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

function buildMockPayload(input: AgentRunInput): Record<string, unknown> {
  return {
    executive_summary: "Mock report payload because ANTHROPIC_API_KEY is not configured.",
    key_takeaways: [
      `Generated for ${input.type}`,
      `project_id=${input.context.projectId ?? "none"}`,
      `sources=${input.context.sourceDocumentIds.length}`
    ],
    source_documents_used: input.context.sourceDocumentIds.slice().sort()
  };
}

function toInputJsonChunks(payload: Record<string, unknown>): string[] {
  const json = JSON.stringify(payload);
  const midpoint = Math.max(Math.floor(json.length / 2), 1);
  return [json.slice(0, midpoint), json.slice(midpoint)];
}

function buildMockSse(toolName: string, payload: Record<string, unknown>): string {
  const chunks = toInputJsonChunks(payload);

  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 1200 } }
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Reviewing earnings transcript and extracting key claims..." }
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", name: toolName }
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: chunks[0] }
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: chunks[1] }
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 1
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      usage: { input_tokens: 1200, output_tokens: 340 }
    })}\n\n`,
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
  ].join("");
}

function createMockStreamResult(
  input: AgentRunInput,
  toolName: string,
  startedAtMs: number
): { stream: ReadableStream<Uint8Array>; completion: Promise<AgentCompletion> } {
  const payload = buildMockPayload(input);
  const sseText = buildMockSse(toolName, payload);
  const stream = createSseStream(sseText);

  const completion = Promise.resolve({
    payload,
    usage: { inputTokens: 1200, outputTokens: 340 },
    durationMs: Math.max(Date.now() - startedAtMs, 0),
    cost: estimateCostUsd({ inputTokens: 1200, outputTokens: 340 }, getCostRates())
  });

  return { stream, completion };
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const toolName = TOOL_BY_REPORT_TYPE[input.type];
  const agentId = Deno.env.get(AGENT_ENV_BY_REPORT_TYPE[input.type]) ?? "local-agent";
  const agentVersion = Deno.env.get("AGENT_VERSION") ?? "dev";
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const startedAtMs = Date.now();

  if (input.sessionMode === "stream") {
    const streamResult = anthropicApiKey
      ? await callAnthropicManagedAgentStream(input, toolName, agentId, anthropicApiKey)
      : createMockStreamResult(input, toolName, startedAtMs);

    return {
      mode: "stream",
      stream: streamResult.stream,
      completion: streamResult.completion,
      toolName,
      agentId,
      agentVersion
    };
  }

  const payload = anthropicApiKey
    ? await callAnthropicManagedAgent(input, toolName, agentId, anthropicApiKey)
    : buildMockPayload(input);

  const usage: AgentUsage = anthropicApiKey
    ? { inputTokens: null, outputTokens: null }
    : { inputTokens: 1200, outputTokens: 340 };

  return {
    mode: "sync",
    completion: Promise.resolve({
      payload,
      usage,
      durationMs: Math.max(Date.now() - startedAtMs, 0),
      cost: estimateCostUsd(usage, getCostRates())
    }),
    toolName,
    agentId,
    agentVersion
  };
}

export type LegacyAgentRunInput = {
  reportType: ReportType;
  companyId: string;
  sourceDocumentIds: string[];
  customSources: string[];
  projectId: string | null;
};

export type LegacyAgentRunResult = {
  payload: Record<string, unknown>;
  toolName: string;
  agentId: string;
  agentVersion: string;
};

export async function runReportAgent(input: LegacyAgentRunInput): Promise<LegacyAgentRunResult> {
  const run = await runAgent({
    type: input.reportType,
    sessionMode: "sync",
    context: {
      companyId: input.companyId,
      sourceDocumentIds: input.sourceDocumentIds,
      customSources: input.customSources,
      projectId: input.projectId
    }
  });

  const completion = await run.completion;

  return {
    payload: completion.payload,
    toolName: run.toolName,
    agentId: run.agentId,
    agentVersion: run.agentVersion
  };
}
