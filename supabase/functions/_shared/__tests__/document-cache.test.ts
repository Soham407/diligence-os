import { describe, expect, it } from "vitest";
import { DocumentCache, type CachedDocument, type ScrapeResult } from "../document-cache.ts";

describe("DocumentCache", () => {
  it("scrapes on cache miss and records scrape_request_id with cost", async () => {
    const lookupCalls: string[] = [];
    const insertCalls: CachedDocument[] = [];
    const auditPayloads: Record<string, unknown>[] = [];

    const cache = new DocumentCache({
      now: () => new Date("2026-05-10T08:45:00.000Z"),
      lookupBySourceAndWindow: async ({ source_url, fetched_at_window }) => {
        lookupCalls.push(`${source_url}::${fetched_at_window}`);
        return null;
      },
      insertDocument: async (input) => {
        const created: CachedDocument = {
          id: "doc-1",
          company_id: input.company_id,
          kind: input.kind,
          source_url: input.source_url,
          fetched_at: "2026-05-10T08:45:00.000Z",
          fetched_at_window: input.fetched_at_window,
          raw_content: input.raw_content,
          scrape_request_id: input.scrape_request_id,
          metadata: input.metadata
        };
        insertCalls.push(created);
        return created;
      },
      scrape: async (): Promise<ScrapeResult> => ({
        raw_content: "Fresh transcript text",
        scrape_request_id: "sg_req_123",
        cost: 0.014,
        metadata: { provider: "scrapegraph" }
      }),
      logScrapeAudit: async (_ctx, payload) => {
        auditPayloads.push(payload);
      }
    });

    const result = await cache.getOrFetch("https://example.com/transcript", 60 * 60 * 1000, {
      company_id: "company-1",
      kind: "earnings_transcript",
      audit: {
        org_id: "org-1",
        actor_id: "user-1",
        project_id: null,
        report_type: "earnings_summary"
      }
    });

    expect(result.cacheHit).toBe(false);
    expect(result.document.id).toBe("doc-1");
    expect(lookupCalls[0]).toBe("https://example.com/transcript::2026-05-10T08");
    expect(insertCalls).toHaveLength(1);
    expect(auditPayloads).toEqual([
      {
        source_url: "https://example.com/transcript",
        source_document_id: "doc-1",
        scrape_request_id: "sg_req_123",
        cost: 0.014,
        cache_hit: false,
        report_type: "earnings_summary"
      }
    ]);
  });
});
