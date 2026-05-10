import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceIngestor } from "../source-ingestor.ts";

function createServiceClient() {
  const insertedRows: Array<{ table: string; value: unknown }> = [];

  return {
    insertedRows,
    from(table: string) {
      if (table === "source_documents") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: null });
          },
          insert(value: unknown) {
            insertedRows.push({ table, value });
            const row = value as {
              company_id: string;
              kind: string;
              source_url: string;
              fetched_at_window: string;
              raw_content: string;
              scrape_request_id: string | null;
              metadata: Record<string, unknown>;
            };
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({
                      data: {
                        id: "doc-1",
                        company_id: row.company_id,
                        kind: row.kind,
                        source_url: row.source_url,
                        fetched_at: "2026-05-10T00:00:00.000Z",
                        fetched_at_window: row.fetched_at_window,
                        raw_content: row.raw_content,
                        scrape_request_id: row.scrape_request_id,
                        metadata: row.metadata
                      },
                      error: null
                    });
                  }
                };
              }
            };
          }
        };
      }

      if (table === "audit_events") {
        return {
          insert() {
            return Promise.resolve({ data: null, error: null });
          }
        };
      }

      throw new Error(`Unexpected table ${table}`);
    }
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "Deno");
  vi.unstubAllGlobals();
});

describe("source ingestor", () => {
  it("uses Groq to normalize scraped content when GROQ_API_KEY is configured", async () => {
    (globalThis as { Deno: { env: { get: (name: string) => string | undefined } } }).Deno = {
      env: {
        get: (name) => {
          if (name === "SGAI_API_KEY") return "sgai-test-key";
          if (name === "GROQ_API_KEY") return "groq-test-key";
          return undefined;
        }
      }
    };

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              scrape_request_id: "sg_req_1",
              raw_content: "<html><body><h1>Example</h1><p>Messy HTML</p></body></html>",
              cost: 0.01,
              metadata: { mode: "api" }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "Example\nMessy HTML"
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
    );

    const client = createServiceClient();
    const ingestor = createSourceIngestor(client as never);

    const docs = await ingestor.fetchSources({
      company_id: "company-1",
      kind: "earnings_transcript",
      source_urls: ["https://example.com"],
      audit: {
        org_id: "org-1",
        actor_id: "user-1",
        project_id: null,
        report_type: "earnings_summary"
      }
    });

    expect(docs).toHaveLength(1);
    expect(docs[0]?.raw_content).toBe("Example\nMessy HTML");
    expect(client.insertedRows).toEqual([
      {
        table: "source_documents",
        value: {
          company_id: "company-1",
          kind: "earnings_transcript",
          source_url: "https://example.com",
          fetched_at_window: expect.any(String),
          raw_content: "Example\nMessy HTML",
          scrape_request_id: "sg_req_1",
          metadata: {
            source_kind: "earnings_transcript",
            llm_provider: "groq",
            llm_model: "groq/llama3-70b-8192",
            provider: "scrapegraphai",
            mode: "api"
          }
        }
      }
    ]);
  });
});
