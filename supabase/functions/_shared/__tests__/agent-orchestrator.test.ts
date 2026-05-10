import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  extractToolPayloadFromSse,
  parseUsageFromSseData,
  type AgentUsage
} from "../agent-orchestrator.ts";

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
