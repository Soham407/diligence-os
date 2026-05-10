import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeSourceDocSetHash,
  estimateCostUsd,
  extractToolPayloadFromSse,
  parseUsageFromSseData,
  runAgent,
  type AgentUsage
} from "../agent-orchestrator.ts";

type CacheChainResult = {
  data: { id: string; payload: Record<string, unknown>; agent_version: string } | null;
  error: { message: string } | null;
};

function createCacheClient(result: CacheChainResult, flags?: { onFrom?: () => void }) {
  return {
    from(_table: string) {
      flags?.onFrom?.();
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        gt() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve(result);
        }
      };
    }
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "Deno");
  vi.unstubAllGlobals();
});

describe("agent orchestrator SSE helpers", () => {
  it("extracts final tool payload from streamed input_json_delta chunks", () => {
    const toolName = "submit_earnings_summary";

    const events = [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          name: toolName
        }
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"executive_summary":"Q4 was resilient",'
        }
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '"key_takeaways":["Margins expanded"],"source_documents_used":["doc-1"]}'
        }
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 1
      })}\n\n`
    ];

    const payload = extractToolPayloadFromSse(events.join(""), toolName);

    expect(payload).toEqual({
      executive_summary: "Q4 was resilient",
      key_takeaways: ["Margins expanded"],
      source_documents_used: ["doc-1"]
    });
  });

  it("prefers direct tool_use input when present", () => {
    const toolName = "submit_earnings_summary";

    const payload = extractToolPayloadFromSse(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          name: toolName,
          input: {
            executive_summary: "Direct payload",
            key_takeaways: ["Takeaway"],
            source_documents_used: ["doc-2"]
          }
        }
      })}\n\n`,
      toolName
    );

    expect(payload).toEqual({
      executive_summary: "Direct payload",
      key_takeaways: ["Takeaway"],
      source_documents_used: ["doc-2"]
    });
  });

  it("reads usage from stream events and estimates cost", () => {
    const usage = [
      parseUsageFromSseData(
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1200 } } })
      ),
      parseUsageFromSseData(
        JSON.stringify({ type: "message_delta", usage: { output_tokens: 340, input_tokens: 1200 } })
      )
    ].reduce<AgentUsage>(
      (acc, next) => ({
        inputTokens: next.inputTokens ?? acc.inputTokens,
        outputTokens: next.outputTokens ?? acc.outputTokens
      }),
      { inputTokens: null, outputTokens: null }
    );

    expect(usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
    expect(estimateCostUsd(usage, { inputPerMillion: 15, outputPerMillion: 75 })).toBeCloseTo(0.0435);
  });
});

describe("agent orchestrator compositions cache", () => {
  it("calls Gemini and parses the structured JSON payload", async () => {
    (globalThis as { Deno: { env: { get: (name: string) => string | undefined } } }).Deno = {
      env: {
        get: (name) => {
          if (name === "GEMINI_API_KEY") return "gemini-test-key";
          if (name === "GEMINI_MODEL") return "gemini-2.5-flash";
          if (name === "AGENT_VERSION") return "agent-v1";
          return undefined;
        }
      }
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        executive_summary: "Gemini summary",
                        key_takeaways: ["Fast"],
                        sections: [],
                        red_flags: [],
                        source_documents_used: ["doc-1"]
                      })
                    }
                  ]
                }
              }
            ],
            usageMetadata: {
              promptTokenCount: 1200,
              candidatesTokenCount: 340
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      })
    );

    const run = await runAgent({
      type: "earnings_summary",
      sessionMode: "sync",
      context: {
        companyId: "company-1",
        sourceDocumentIds: ["doc-1"],
        customSources: [],
        projectId: null
      }
    });

    const completion = await run.completion;

    expect(completion.payload).toEqual({
      executive_summary: "Gemini summary",
      key_takeaways: ["Fast"],
      sections: [],
      red_flags: [],
      source_documents_used: ["doc-1"]
    });
    expect(completion.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
    expect(run.agentId).toBe("gemini-earnings_summary");
  });

  it("streams a synthetic SSE wrapper for Gemini output", async () => {
    (globalThis as { Deno: { env: { get: (name: string) => string | undefined } } }).Deno = {
      env: {
        get: (name) => {
          if (name === "GEMINI_API_KEY") return "gemini-test-key";
          if (name === "GEMINI_MODEL") return "gemini-2.5-flash";
          return undefined;
        }
      }
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        executive_summary: "Gemini streamed summary",
                        key_takeaways: ["Structured"],
                        sections: [],
                        red_flags: [],
                        source_documents_used: ["doc-1"]
                      })
                    }
                  ]
                }
              }
            ],
            usageMetadata: {
              promptTokenCount: 900,
              candidatesTokenCount: 210
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      })
    );

    const run = await runAgent({
      type: "earnings_summary",
      sessionMode: "stream",
      context: {
        companyId: "company-1",
        sourceDocumentIds: ["doc-1"],
        customSources: [],
        projectId: null
      }
    });

    expect(run.mode).toBe("stream");

    const reader = run.stream.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
    reader.releaseLock();

    expect(text).toContain("Gemini completed the structured report synthesis.");
    expect(extractToolPayloadFromSse(text, "submit_earnings_summary")).toEqual({
      executive_summary: "Gemini streamed summary",
      key_takeaways: ["Structured"],
      sections: [],
      red_flags: [],
      source_documents_used: ["doc-1"]
    });

    const completion = await run.completion;
    expect(completion.usage).toEqual({ inputTokens: 900, outputTokens: 210 });
  });

  it("normalizes source document ids before hashing cache key input", async () => {
    const a = await computeSourceDocSetHash(["doc-2", "doc-1", "doc-3"]);
    const b = await computeSourceDocSetHash(["doc-1", "doc-3", "doc-2"]);

    expect(a).toBe(b);
  });

  it("returns cached payload and metadata on cache hit", async () => {
    (globalThis as { Deno: { env: { get: (name: string) => string | undefined } } }).Deno = {
      env: {
        get: (name) => {
          if (name === "AGENT_VERSION") return "dev";
          return undefined;
        }
      }
    };

    const run = await runAgent({
      type: "due_diligence",
      sessionMode: "sync",
      context: {
        companyId: "company-1",
        sourceDocumentIds: ["doc-b", "doc-a"],
        customSources: [],
        projectId: null
      },
      cache: {
        client: createCacheClient({
          data: {
            id: "composition-1",
            payload: { executive_summary: "cached", source_documents_used: ["doc-a", "doc-b"] },
            agent_version: "dev"
          },
          error: null
        })
      }
    });

    const completion = await run.completion;
    expect(completion.payload).toEqual({
      executive_summary: "cached",
      source_documents_used: ["doc-a", "doc-b"]
    });
    expect(run.cache.hit).toBe(true);
    expect(run.cache.bypassed).toBe(false);
    expect(run.cache.compositionId).toBe("composition-1");
  });

  it("bypasses cache reads when project_id is present", async () => {
    let fromCalled = false;
    (globalThis as { Deno: { env: { get: (name: string) => string | undefined } } }).Deno = {
      env: {
        get: (name) => {
          if (name === "AGENT_VERSION") return "dev";
          return undefined;
        }
      }
    };

    const run = await runAgent({
      type: "lead_intel",
      sessionMode: "sync",
      context: {
        companyId: "company-2",
        sourceDocumentIds: ["doc-1"],
        customSources: [],
        projectId: "project-1"
      },
      cache: {
        client: createCacheClient(
          { data: null, error: null },
          {
            onFrom: () => {
              fromCalled = true;
            }
          }
        )
      }
    });

    expect(run.cache.bypassed).toBe(true);
    expect(run.cache.hit).toBe(false);
    expect(fromCalled).toBe(false);
  });
});
