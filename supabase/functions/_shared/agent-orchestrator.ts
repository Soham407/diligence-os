import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

export type ReportType = "earnings_summary" | "due_diligence" | "lead_intel";

const TOOL_BY_REPORT_TYPE: Record<ReportType, string> = {
  earnings_summary: "submit_earnings_summary",
  due_diligence: "submit_due_diligence_report",
  lead_intel: "submit_lead_intel_report"
};

const MODEL_ID_ENV_BY_REPORT_TYPE: Record<ReportType, string> = {
  earnings_summary: "GEMINI_AGENT_ID_EARNINGS_REVIEWER",
  due_diligence: "GEMINI_AGENT_ID_DUE_DILIGENCE_ANALYST",
  lead_intel: "GEMINI_AGENT_ID_LEAD_INTEL_GENERATOR"
};

type AgentContext = {
  companyId: string;
  sourceDocumentIds: string[];
  customSources: string[];
  projectId: string | null;
};

type AgentRecoveryMode = "default" | "strict_retry";

export type AgentRunInput = {
  type: ReportType;
  context: AgentContext;
  sessionMode: "stream" | "sync";
  recoveryMode?: AgentRecoveryMode;
  cache?: {
    client: Pick<SupabaseClient, "from">;
    sourceDocSetHash?: string;
    nowIso?: string;
  };
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
  cache: CompositionCacheMeta;
};

type CompositionCacheRow = {
  id: string;
  payload: Record<string, unknown>;
  agent_version: string;
};

export type CompositionCacheMeta = {
  bypassed: boolean;
  hit: boolean;
  compositionId: string | null;
  sourceDocSetHash: string;
};

export async function computeSourceDocSetHash(sourceDocumentIds: string[]): Promise<string> {
  const sortedSourceIds = sourceDocumentIds.slice().sort();
  const bytes = new TextEncoder().encode(JSON.stringify(sortedSourceIds));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function findActiveComposition(input: {
  client: Pick<SupabaseClient, "from">;
  companyId: string;
  reportType: ReportType;
  sourceDocSetHash: string;
  agentVersion: string;
  nowIso: string;
}): Promise<CompositionCacheRow | null> {
  const { data, error } = await input.client
    .from("compositions")
    .select("id, payload, agent_version")
    .eq("company_id", input.companyId)
    .eq("report_type", input.reportType)
    .eq("source_doc_set_hash", input.sourceDocSetHash)
    .eq("agent_version", input.agentVersion)
    .gt("expires_at", input.nowIso)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read compositions cache: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return data as CompositionCacheRow;
}

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

function getGeminiModel(): string {
  return Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
}

function getGeminiAgentId(reportType: ReportType): string {
  return Deno.env.get(MODEL_ID_ENV_BY_REPORT_TYPE[reportType]) ?? `gemini-${reportType}`;
}

export function estimateCostUsd(usage: AgentUsage, rates: CostRates): number | null {
  if (usage.inputTokens === null && usage.outputTokens === null) {
    return null;
  }

  const inputComponent = ((usage.inputTokens ?? 0) / 1_000_000) * rates.inputPerMillion;
  const outputComponent = ((usage.outputTokens ?? 0) / 1_000_000) * rates.outputPerMillion;
  return Number((inputComponent + outputComponent).toFixed(10));
}

function buildToolInputSchema() {
  return {
    type: "object",
    properties: {
      executive_summary: { type: "string" },
      key_takeaways: { type: "array", items: { type: "string" } },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            heading: { type: "string" },
            claims: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  claim_id: { type: "string" },
                  text: { type: "string" },
                  citations: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        source_document_id: { type: "string" },
                        locator: {
                          oneOf: [
                            {
                              type: "object",
                              properties: {
                                type: { const: "pdf_page" },
                                page: { type: "number" }
                              },
                              required: ["type", "page"]
                            },
                            {
                              type: "object",
                              properties: {
                                type: { const: "text_span" },
                                start_char: { type: "number" },
                                end_char: { type: "number" }
                              },
                              required: ["type", "start_char", "end_char"]
                            },
                            {
                              type: "object",
                              properties: {
                                type: { const: "audio_timestamp" },
                                start_sec: { type: "number" },
                                end_sec: { type: "number" }
                              },
                              required: ["type", "start_sec", "end_sec"]
                            },
                            {
                              type: "object",
                              properties: {
                                type: { const: "html_anchor" },
                                selector: { type: "string" }
                              },
                              required: ["type", "selector"]
                            }
                          ]
                        },
                        quote: { type: "string" }
                      },
                      required: ["source_document_id", "locator", "quote"]
                    }
                  }
                },
                required: ["claim_id", "text", "citations"]
              }
            }
          },
          required: ["heading", "claims"]
        }
      },
      red_flags: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            citations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  source_document_id: { type: "string" },
                  locator: { type: "object" },
                  quote: { type: "string" }
                },
                required: ["source_document_id", "locator", "quote"]
              }
            }
          },
          required: ["text", "citations"]
        }
      },
      source_documents_used: { type: "array", items: { type: "string" } }
    },
    required: [
      "executive_summary",
      "key_takeaways",
      "sections",
      "red_flags",
      "source_documents_used"
    ],
    additionalProperties: true
  };
}

function buildGeminiPrompt(input: AgentRunInput, agentId: string): string {
  const recoveryMode = input.recoveryMode ?? "default";

  return [
    `You are preparing a structured ${input.type} report.`,
    "Return only valid JSON that matches the supplied schema.",
    "Use only the provided source_document_ids when citing evidence.",
    JSON.stringify({
      agent_id: agentId,
      report_type: input.type,
      company_id: input.context.companyId,
      source_document_ids: input.context.sourceDocumentIds,
      custom_sources: input.context.customSources,
      project_id: input.context.projectId,
      recovery_mode: recoveryMode
    })
  ].join("\n\n");
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

function extractGeminiText(body: {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  text?: string;
}): string {
  const candidateText = body.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (candidateText) {
    return candidateText;
  }

  if (typeof body.text === "string" && body.text.trim().length > 0) {
    return body.text.trim();
  }

  throw new Error("Gemini response did not include text content");
}

function extractGeminiUsage(body: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    responseTokenCount?: number;
    totalTokenCount?: number;
    prompt_token_count?: number;
    candidates_token_count?: number;
    response_token_count?: number;
    total_token_count?: number;
  };
}): AgentUsage {
  const usage = body.usageMetadata ?? {};
  const inputTokens = usage.promptTokenCount ?? usage.prompt_token_count ?? null;
  const outputTokens =
    usage.candidatesTokenCount ??
    usage.candidates_token_count ??
    usage.responseTokenCount ??
    usage.response_token_count ??
    null;

  return {
    inputTokens: toNumberOrNull(inputTokens),
    outputTokens: toNumberOrNull(outputTokens)
  };
}

async function callGeminiReport(
  input: AgentRunInput,
  toolName: string,
  agentId: string,
  geminiApiKey: string
): Promise<{ payload: Record<string, unknown>; usage: AgentUsage }> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${getGeminiModel()}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildGeminiPrompt(input, agentId)
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: buildToolInputSchema()
        }
      })
    }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${details}`);
  }

  const body = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
    text?: string;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      responseTokenCount?: number;
      totalTokenCount?: number;
      prompt_token_count?: number;
      candidates_token_count?: number;
      response_token_count?: number;
      total_token_count?: number;
    };
  };

  const text = extractGeminiText(body);
  return {
    payload: extractJsonObjectFromText(text),
    usage: extractGeminiUsage(body)
  };
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
  const sortedSources = input.context.sourceDocumentIds.slice().sort();
  const primarySource = sortedSources[0] ?? null;

  return {
    executive_summary: "Mock report payload because GEMINI_API_KEY is not configured.",
    key_takeaways: [
      `Generated for ${input.type}`,
      `project_id=${input.context.projectId ?? "none"}`,
      `sources=${input.context.sourceDocumentIds.length}`
    ],
    sections: [
      {
        heading: "Mock Findings",
        claims: [
          {
            claim_id: "mock-claim-1",
            text: "Synthetic claim for local development and tests.",
            citations: primarySource
              ? [
                  {
                    source_document_id: primarySource,
                    locator: { type: "text_span", start_char: 0, end_char: 64 },
                    quote: "Synthetic claim"
                  }
                ]
              : []
          }
        ]
      }
    ],
    red_flags: [],
    source_documents_used: sortedSources
  };
}

function toInputJsonChunks(payload: Record<string, unknown>): string[] {
  const json = JSON.stringify(payload);
  const midpoint = Math.max(Math.floor(json.length / 2), 1);
  return [json.slice(0, midpoint), json.slice(midpoint)];
}

function buildMockSse(
  toolName: string,
  payload: Record<string, unknown>,
  options?: { usage?: AgentUsage; introText?: string }
): string {
  const chunks = toInputJsonChunks(payload);
  const usage = options?.usage ?? { inputTokens: 1200, outputTokens: 340 };
  const introText = options?.introText ?? "Reviewing source documents and extracting key claims...";

  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens
        }
      }
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: introText }
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
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens
      }
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

async function callGeminiReportStream(
  input: AgentRunInput,
  toolName: string,
  agentId: string,
  geminiApiKey: string
): Promise<{ stream: ReadableStream<Uint8Array>; completion: Promise<AgentCompletion> }> {
  const startedAtMs = Date.now();
  const { payload, usage } = await callGeminiReport(input, toolName, agentId, geminiApiKey);

  return {
    stream: createSseStream(
      buildMockSse(toolName, payload, {
        usage,
        introText: "Gemini completed the structured report synthesis."
      })
    ),
    completion: Promise.resolve({
      payload,
      usage,
      durationMs: Math.max(Date.now() - startedAtMs, 0),
      cost: estimateCostUsd(usage, getCostRates())
    })
  };
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const toolName = TOOL_BY_REPORT_TYPE[input.type];
  const agentId = getGeminiAgentId(input.type);
  let agentVersion = Deno.env.get("AGENT_VERSION") ?? getGeminiModel();
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  const startedAtMs = Date.now();

  const sourceDocSetHash =
    input.cache?.sourceDocSetHash ?? (await computeSourceDocSetHash(input.context.sourceDocumentIds));
  const cache: CompositionCacheMeta = {
    bypassed: input.context.projectId !== null,
    hit: false,
    compositionId: null,
    sourceDocSetHash
  };

  const canReadCache = input.cache?.client && !cache.bypassed && (input.recoveryMode ?? "default") === "default";
  let cachedPayload: Record<string, unknown> | null = null;
  if (canReadCache) {
    const activeComposition = await findActiveComposition({
      client: input.cache.client,
      companyId: input.context.companyId,
      reportType: input.type,
      sourceDocSetHash,
      agentVersion,
      nowIso: input.cache.nowIso ?? new Date().toISOString()
    });

    if (activeComposition) {
      cache.hit = true;
      cache.compositionId = activeComposition.id;
      agentVersion = activeComposition.agent_version;
      cachedPayload = activeComposition.payload;
    }
  }

  if (cachedPayload) {
    const completion = Promise.resolve({
      payload: cachedPayload,
      usage: { inputTokens: null, outputTokens: null },
      durationMs: 0,
      cost: null
    });

    if (input.sessionMode === "stream") {
      const stream = createSseStream(buildMockSse(toolName, cachedPayload));
      return {
        mode: "stream",
        stream,
        completion,
        toolName,
        agentId,
        agentVersion,
        cache
      };
    }

    return {
      mode: "sync",
      completion,
      toolName,
      agentId,
      agentVersion,
      cache
    };
  }

  if (input.sessionMode === "stream") {
    const streamResult = geminiApiKey
      ? await callGeminiReportStream(input, toolName, agentId, geminiApiKey)
      : createMockStreamResult(input, toolName, startedAtMs);

    return {
      mode: "stream",
      stream: streamResult.stream,
      completion: streamResult.completion,
      toolName,
      agentId,
      agentVersion,
      cache
    };
  }

  const { payload, usage } = geminiApiKey
    ? await callGeminiReport(input, toolName, agentId, geminiApiKey)
    : { payload: buildMockPayload(input), usage: { inputTokens: 1200, outputTokens: 340 } };

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
    agentVersion,
    cache
  };
}

function buildShapeCPrompt(input: {
  reportType: ReportType;
  sourceDocumentIds: string[];
  customSources: string[];
  companyId: string;
  projectId: string | null;
}): string {
  return [
    "Return only valid JSON that conforms to this structure:",
    JSON.stringify(buildToolInputSchema()),
    "Use source_document_id values only from source_document_ids.",
    JSON.stringify({
      report_type: input.reportType,
      company_id: input.companyId,
      source_document_ids: input.sourceDocumentIds,
      custom_sources: input.customSources,
      project_id: input.projectId
    })
  ].join("\n\n");
}

function extractJsonObjectFromText(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
    throw new Error("Shape C response did not include a JSON object");
  }

  const jsonCandidate = trimmed.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonCandidate) as Record<string, unknown>;
}

async function callGeminiShapeCSynthesis(
  input: {
    reportType: ReportType;
    companyId: string;
    sourceDocumentIds: string[];
    customSources: string[];
    projectId: string | null;
  },
  geminiApiKey: string
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${getGeminiModel()}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildShapeCPrompt(input) }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: buildToolInputSchema()
        }
      })
    }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini Shape C synthesis failed (${response.status}): ${details}`);
  }

  const body = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
    text?: string;
  };

  return extractJsonObjectFromText(extractGeminiText(body));
}

export type LegacyAgentRunInput = {
  reportType: ReportType;
  companyId: string;
  sourceDocumentIds: string[];
  customSources: string[];
  projectId: string | null;
  recoveryMode?: AgentRecoveryMode;
  cache?: AgentRunInput["cache"];
};

export type LegacyAgentRunResult = {
  payload: Record<string, unknown>;
  toolName: string;
  agentId: string;
  agentVersion: string;
  cache: CompositionCacheMeta;
};

export async function runReportAgent(input: LegacyAgentRunInput): Promise<LegacyAgentRunResult> {
  const run = await runAgent({
    type: input.reportType,
    sessionMode: "sync",
    cache: input.cache,
    recoveryMode: input.recoveryMode ?? "default",
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
    agentVersion: run.agentVersion,
    cache: run.cache
  };
}

export async function runReportAgentShapeC(
  input: Omit<LegacyAgentRunInput, "recoveryMode">
): Promise<LegacyAgentRunResult> {
  const agentId = getGeminiAgentId(input.reportType);
  const agentVersion = Deno.env.get("AGENT_VERSION") ?? getGeminiModel();
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");

  const payload = geminiApiKey
    ? await callGeminiShapeCSynthesis(
        {
          reportType: input.reportType,
          companyId: input.companyId,
          sourceDocumentIds: input.sourceDocumentIds,
          customSources: input.customSources,
          projectId: input.projectId
        },
        geminiApiKey
      )
    : buildMockPayload({
        type: input.reportType,
        sessionMode: "sync",
        context: {
          companyId: input.companyId,
          sourceDocumentIds: input.sourceDocumentIds,
          customSources: input.customSources,
          projectId: input.projectId
        },
        recoveryMode: "strict_retry"
      });

  return {
    payload,
    toolName: TOOL_BY_REPORT_TYPE[input.reportType],
    agentId,
    agentVersion,
    cache: {
      bypassed: input.projectId !== null,
      hit: false,
      compositionId: null,
      sourceDocSetHash: await computeSourceDocSetHash(input.sourceDocumentIds)
    }
  };
}
