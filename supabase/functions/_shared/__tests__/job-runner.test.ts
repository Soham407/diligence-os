import { describe, expect, it } from "vitest";
import { createJobRunner } from "../job-runner.ts";

type InsertResult = { data: unknown; error: { message: string } | null };
type SelectResult = { data: unknown; error: { message: string } | null };

function createMockClient(input: { insertResult: InsertResult; selectResult: SelectResult }) {
  const insertedRows: Array<{ table: string; value: unknown }> = [];

  const client = {
    from(table: string) {
      if (table === "jobs") {
        return {
          insert(value: unknown) {
            insertedRows.push({ table, value });
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve(input.insertResult);
                  }
                };
              }
            };
          },
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve(input.selectResult);
                  }
                };
              }
            };
          }
        };
      }

      if (table === "job_events") {
        return {
          insert(value: unknown) {
            insertedRows.push({ table, value });
            return Promise.resolve({ data: null, error: null });
          }
        };
      }

      throw new Error(`Unexpected table ${table}`);
    }
  };

  return { client, insertedRows };
}

describe("Job Runner", () => {
  it("enqueues a queued job and can fetch it by id", async () => {
    const { client, insertedRows } = createMockClient({
      insertResult: {
        data: {
          id: "job-1",
          org_id: "org-1",
          report_id: "report-1",
          anthropic_session_id: "sess-1",
          status: "queued",
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        error: null
      },
      selectResult: {
        data: {
          id: "job-1",
          org_id: "org-1",
          report_id: "report-1",
          anthropic_session_id: "sess-1",
          status: "queued",
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        error: null
      }
    });

    const runner = createJobRunner(client as never);

    const enqueued = await runner.enqueue({
      orgId: "org-1",
      reportId: "report-1",
      anthropicSessionId: "sess-1",
      spec: {
        report_type: "due_diligence",
        company_id: "company-1",
        custom_sources: []
      }
    });

    expect(enqueued.id).toBe("job-1");
    expect(enqueued.status).toBe("queued");

    const loaded = await runner.getJob("job-1");
    expect(loaded?.id).toBe("job-1");

    expect(insertedRows).toContainEqual({
      table: "job_events",
      value: {
        job_id: "job-1",
        kind: "job_enqueued",
        payload: {
          report_type: "due_diligence",
          company_id: "company-1",
          custom_sources: []
        }
      }
    });
  });
});
