import type { z } from "zod";

export type SourceDocumentForComposer = {
  id: string;
  raw_content: string;
};

export type MaterializedCitation = {
  claim_id: string;
  source_document_id: string;
  locator: Record<string, unknown>;
  quote: string;
  quote_verified: boolean;
};

export type CitationVerificationFailure = {
  claim_id: string;
  source_document_id: string;
  quote: string;
};

export type ReportComposerContext = {
  sourceDocSetHash: string;
  sourceDocuments: SourceDocumentForComposer[];
};

export type ComposeFailureCode =
  | "schema_validation_failed"
  | "source_document_integrity_failed"
  | "duplicate_claim_id"
  | "source_doc_set_hash_mismatch";

export class ReportComposerError extends Error {
  readonly code: ComposeFailureCode;
  readonly details: Record<string, unknown>;

  constructor(code: ComposeFailureCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type ClaimCitation = {
  claimId: string;
  sourceDocumentId: string;
  locator: Record<string, unknown>;
  quote: string;
};

type ComposableReport = {
  source_documents_used: string[];
  sections: Array<{
    claims: Array<{
      claim_id: string;
      citations: Array<{
        source_document_id: string;
        locator: Record<string, unknown>;
        quote: string;
      }>;
    }>;
  }>;
  red_flags: Array<{
    citations: Array<{
      source_document_id: string;
      locator: Record<string, unknown>;
      quote: string;
    }>;
  }>;
};

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function collectCitations(payload: ComposableReport): ClaimCitation[] {
  const citations: ClaimCitation[] = [];

  for (const section of payload.sections) {
    for (const claim of section.claims) {
      for (const citation of claim.citations) {
        citations.push({
          claimId: claim.claim_id,
          sourceDocumentId: citation.source_document_id,
          locator: citation.locator,
          quote: citation.quote
        });
      }
    }
  }

  for (let index = 0; index < payload.red_flags.length; index += 1) {
    const claimId = `red_flag_${index + 1}`;
    const redFlag = payload.red_flags[index];
    for (const citation of redFlag.citations) {
      citations.push({
        claimId,
        sourceDocumentId: citation.source_document_id,
        locator: citation.locator,
        quote: citation.quote
      });
    }
  }

  return citations;
}

function assertSourceIdIntegrity(payload: ComposableReport, citations: ClaimCitation[]) {
  const sourceDocumentSet = new Set(payload.source_documents_used);
  const invalidSourceIds = citations
    .map((citation) => citation.sourceDocumentId)
    .filter((sourceDocumentId) => !sourceDocumentSet.has(sourceDocumentId));

  if (invalidSourceIds.length > 0) {
    throw new ReportComposerError(
      "source_document_integrity_failed",
      "Citation source_document_id must exist in source_documents_used",
      { invalid_source_document_ids: Array.from(new Set(invalidSourceIds)) }
    );
  }
}

function assertClaimIdUniqueness(payload: ComposableReport) {
  const claimIds: string[] = [];
  for (const section of payload.sections) {
    for (const claim of section.claims) {
      claimIds.push(claim.claim_id);
    }
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const claimId of claimIds) {
    if (seen.has(claimId)) {
      duplicates.add(claimId);
      continue;
    }
    seen.add(claimId);
  }

  if (duplicates.size > 0) {
    throw new ReportComposerError("duplicate_claim_id", "claim_id values must be unique within a report", {
      duplicate_claim_ids: Array.from(duplicates.values())
    });
  }
}

async function assertSourceDocSetHash(payload: ComposableReport, expectedHash: string) {
  const actualHash = await sha256Hex(JSON.stringify(payload.source_documents_used.slice().sort()));
  if (actualHash !== expectedHash) {
    throw new ReportComposerError(
      "source_doc_set_hash_mismatch",
      "source_doc_set_hash did not match the expected input set hash",
      { expected_hash: expectedHash, actual_hash: actualHash }
    );
  }
}

export class ReportComposer {
  private readonly context: ReportComposerContext;

  constructor(context: ReportComposerContext) {
    this.context = context;
  }

  async compose<T extends ComposableReport>(
    rawArgs: unknown,
    schema: z.ZodType<T>
  ): Promise<{
    payload: T;
    citations: MaterializedCitation[];
    verificationFailures: CitationVerificationFailure[];
  }> {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      throw new ReportComposerError("schema_validation_failed", "Report payload failed schema validation", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code
        }))
      });
    }

    const payload = parsed.data;
    const citations = collectCitations(payload);

    assertSourceIdIntegrity(payload, citations);
    assertClaimIdUniqueness(payload);
    await assertSourceDocSetHash(payload, this.context.sourceDocSetHash);

    const contentBySource = new Map<string, string>();
    for (const sourceDocument of this.context.sourceDocuments) {
      contentBySource.set(sourceDocument.id, sourceDocument.raw_content ?? "");
    }

    const materializedCitations: MaterializedCitation[] = [];
    const verificationFailures: CitationVerificationFailure[] = [];

    for (const citation of citations) {
      const sourceText = contentBySource.get(citation.sourceDocumentId) ?? "";
      const quoteVerified = sourceText.includes(citation.quote);

      if (!quoteVerified) {
        verificationFailures.push({
          claim_id: citation.claimId,
          source_document_id: citation.sourceDocumentId,
          quote: citation.quote
        });
      }

      materializedCitations.push({
        claim_id: citation.claimId,
        source_document_id: citation.sourceDocumentId,
        locator: citation.locator,
        quote: citation.quote,
        quote_verified: quoteVerified
      });
    }

    return {
      payload,
      citations: materializedCitations,
      verificationFailures
    };
  }
}

export function isRejectableComposerError(error: unknown): error is ReportComposerError {
  if (!(error instanceof ReportComposerError)) {
    return false;
  }

  return (
    error.code === "schema_validation_failed" ||
    error.code === "source_document_integrity_failed" ||
    error.code === "duplicate_claim_id" ||
    error.code === "source_doc_set_hash_mismatch"
  );
}

export async function composeWithRecovery<T extends ComposableReport>(input: {
  composer: ReportComposer;
  rawArgs: unknown;
  schema: z.ZodType<T>;
  retryWithStricterPrompt: () => Promise<unknown>;
  fallbackShapeC: () => Promise<unknown>;
  onRejectableFailure?: (attempt: 1 | 2, error: ReportComposerError) => Promise<void> | void;
}): Promise<{
  payload: T;
  citations: MaterializedCitation[];
  verificationFailures: CitationVerificationFailure[];
  attemptCount: number;
  usedShapeCFallback: boolean;
}> {
  try {
    const composed = await input.composer.compose(input.rawArgs, input.schema);
    return { ...composed, attemptCount: 1, usedShapeCFallback: false };
  } catch (firstError) {
    if (!isRejectableComposerError(firstError)) {
      throw firstError;
    }

    await input.onRejectableFailure?.(1, firstError);
    const strictRawArgs = await input.retryWithStricterPrompt();

    try {
      const composed = await input.composer.compose(strictRawArgs, input.schema);
      return { ...composed, attemptCount: 2, usedShapeCFallback: false };
    } catch (secondError) {
      if (!isRejectableComposerError(secondError)) {
        throw secondError;
      }

      await input.onRejectableFailure?.(2, secondError);
      const shapeCRawArgs = await input.fallbackShapeC();
      const composed = await input.composer.compose(shapeCRawArgs, input.schema);
      return { ...composed, attemptCount: 3, usedShapeCFallback: true };
    }
  }
}
