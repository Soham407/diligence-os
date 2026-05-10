import { describe, expect, it } from "vitest";
import { composeWithRecovery, ReportComposer, ReportComposerError } from "../report-composer.ts";
import {
  DueDiligenceReportSchema,
  EarningsSummarySchema,
  LeadIntelReportSchema
} from "../report-schemas.ts";
import {
  reportComposerFixtureSourceDocuments,
  reportComposerFixtureWellFormedPayload
} from "../__fixtures__/report-composer.fixture.ts";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function createComposer() {
  const hash = await sha256Hex(
    JSON.stringify(reportComposerFixtureWellFormedPayload.source_documents_used.slice().sort())
  );

  return new ReportComposer({
    sourceDocSetHash: hash,
    sourceDocuments: reportComposerFixtureSourceDocuments
  });
}

describe("ReportComposer", () => {
  it("accepts a well-formed payload and materializes citations", async () => {
    const composer = await createComposer();

    const composed = await composer.compose(reportComposerFixtureWellFormedPayload, EarningsSummarySchema);

    expect(composed.payload).toEqual(reportComposerFixtureWellFormedPayload);
    expect(composed.citations).toHaveLength(2);
    expect(composed.citations.every((citation) => citation.quote_verified)).toBe(true);
    expect(composed.verificationFailures).toEqual([]);
  });

  it("rejects missing required fields", async () => {
    const composer = await createComposer();
    const { executive_summary: _omitted, ...missingSummary } = reportComposerFixtureWellFormedPayload;

    await expect(composer.compose(missingSummary, EarningsSummarySchema)).rejects.toMatchObject({
      code: "schema_validation_failed"
    } satisfies Partial<ReportComposerError>);
  });

  it("tolerates and strips extra fields", async () => {
    const composer = await createComposer();
    const payloadWithExtras = {
      ...reportComposerFixtureWellFormedPayload,
      unexpected: "strip me"
    };

    const composed = await composer.compose(payloadWithExtras, EarningsSummarySchema);

    expect((composed.payload as Record<string, unknown>).unexpected).toBeUndefined();
  });

  it("rejects wrong field types", async () => {
    const composer = await createComposer();
    const payload = {
      ...reportComposerFixtureWellFormedPayload,
      key_takeaways: "not-an-array"
    };

    await expect(composer.compose(payload, EarningsSummarySchema)).rejects.toMatchObject({
      code: "schema_validation_failed"
    } satisfies Partial<ReportComposerError>);
  });

  it("rejects citations referencing source_document_id outside source_documents_used", async () => {
    const composer = await createComposer();
    const payload = structuredClone(reportComposerFixtureWellFormedPayload);
    payload.sections[0].claims[0].citations[0].source_document_id =
      "33333333-3333-3333-3333-333333333333";

    await expect(composer.compose(payload, EarningsSummarySchema)).rejects.toMatchObject({
      code: "source_document_integrity_failed"
    } satisfies Partial<ReportComposerError>);
  });

  it("rejects duplicate claim_id values", async () => {
    const composer = await createComposer();
    const payload = structuredClone(reportComposerFixtureWellFormedPayload);
    payload.sections.push({
      heading: "Governance",
      claims: [
        {
          claim_id: "claim-1",
          text: "Duplicate claim id.",
          citations: [
            {
              source_document_id: "11111111-1111-1111-1111-111111111111",
              locator: { type: "pdf_page", page: 2 },
              quote: "Revenue increased 12% year over year"
            }
          ]
        }
      ]
    });

    await expect(composer.compose(payload, EarningsSummarySchema)).rejects.toMatchObject({
      code: "duplicate_claim_id"
    } satisfies Partial<ReportComposerError>);
  });

  it("rejects source_doc_set_hash mismatch", async () => {
    const composer = new ReportComposer({
      sourceDocSetHash: "mismatch",
      sourceDocuments: reportComposerFixtureSourceDocuments
    });

    await expect(composer.compose(reportComposerFixtureWellFormedPayload, EarningsSummarySchema)).rejects.toMatchObject(
      {
        code: "source_doc_set_hash_mismatch"
      } satisfies Partial<ReportComposerError>
    );
  });

  it("soft-flags quote substring misses without rejecting", async () => {
    const composer = await createComposer();
    const payload = structuredClone(reportComposerFixtureWellFormedPayload);
    payload.sections[0].claims[0].citations[0].quote = "text that does not exist in source";

    const composed = await composer.compose(payload, EarningsSummarySchema);

    expect(composed.citations[0].quote_verified).toBe(false);
    expect(composed.verificationFailures).toEqual([
      {
        claim_id: "claim-1",
        source_document_id: "11111111-1111-1111-1111-111111111111",
        quote: "text that does not exist in source"
      }
    ]);
  });

  it("enforces locator discriminated union for all tier schemas", async () => {
    const payload = structuredClone(reportComposerFixtureWellFormedPayload);
    payload.sections[0].claims[0].citations[0].locator = {
      type: "unsupported_locator",
      page: 2
    };

    for (const schema of [EarningsSummarySchema, DueDiligenceReportSchema, LeadIntelReportSchema]) {
      const parsed = schema.safeParse(payload);
      expect(parsed.success).toBe(false);
    }
  });

  it("falls back to Shape C after two consecutive compose failures", async () => {
    const composer = await createComposer();
    const invalidPayload = {
      ...reportComposerFixtureWellFormedPayload,
      source_documents_used: ["11111111-1111-1111-1111-111111111111"]
    };

    const failureCodes: string[] = [];

    const recovered = await composeWithRecovery({
      composer,
      rawArgs: invalidPayload,
      schema: EarningsSummarySchema,
      retryWithStricterPrompt: async () => invalidPayload,
      fallbackShapeC: async () => reportComposerFixtureWellFormedPayload,
      onRejectableFailure: (_attempt, error) => {
        failureCodes.push(error.code);
      }
    });

    expect(failureCodes).toEqual(["source_document_integrity_failed", "source_document_integrity_failed"]);
    expect(recovered.usedShapeCFallback).toBe(true);
    expect(recovered.attemptCount).toBe(3);
    expect(recovered.payload.executive_summary).toBe(
      reportComposerFixtureWellFormedPayload.executive_summary
    );
  });
});
