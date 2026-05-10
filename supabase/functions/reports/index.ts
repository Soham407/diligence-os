import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Entitlements } from "../_shared/entitlements.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  runAgent,
  runReportAgent,
  runReportAgentShapeC,
  type LegacyAgentRunResult,
  type ReportType
} from "../_shared/agent-orchestrator.ts";
import {
  composeWithRecovery,
  ReportComposer,
  type MaterializedCitation,
  type ReportComposerError
} from "../_shared/report-composer.ts";
import {
  DueDiligenceReportSchema,
  EarningsSummarySchema,
  LeadIntelReportSchema
} from "../_shared/report-schemas.ts";
import { createSourceIngestor } from "../_shared/source-ingestor.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase.ts";

type CreateReportBody = {
  company_id?: string;
  report_type?: ReportType;
  project_id?: string | null;
  custom_sources?: string[];
};

type ReportRow = {
  id: string;
  org_id: string;
  project_id: string | null;
  company_id: string;
  report_type: string;
  composition_id: string | null;
  status: string;
  created_at: string;
};

function normalizeCustomSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function isReportType(value: unknown): value is ReportType {
  return value === "earnings_summary" || value === "due_diligence" || value === "lead_intel";
}

function streamHeaders(): Headers {
  return new Headers({
    ...corsHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no"
  });
}

function trackBackground(promise: Promise<unknown>) {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } })
    .EdgeRuntime;

  runtime?.waitUntil?.(promise);
}

function reportSchemaForType(reportType: ReportType) {
  if (reportType === "earnings_summary") return EarningsSummarySchema;
  if (reportType === "due_diligence") return DueDiligenceReportSchema;
  return LeadIntelReportSchema;
}

async function persistReportWithCitations(input: {
  serviceClient: ReturnType<typeof createServiceClient>;
  orgId: string;
  projectId: string | null;
  companyId: string;
  reportType: ReportType;
  compositionId: string | null;
  sourceDocSetHash: string;
  agentVersion: string;
  payload: Record<string, unknown>;
  citations: MaterializedCitation[];
  createdBy: string;
}): Promise<ReportRow> {
  const { data, error } = await input.serviceClient.rpc("create_report_with_citations", {
    p_org_id: input.orgId,
    p_project_id: input.projectId,
    p_company_id: input.companyId,
    p_report_type: input.reportType,
    p_composition_id: input.compositionId,
    p_source_doc_set_hash: input.sourceDocSetHash,
    p_agent_version: input.agentVersion,
    p_status: "succeeded",
    p_payload: input.payload,
    p_created_by: input.createdBy,
    p_citations: input.citations
  });

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to persist report and citations");
  }

  const row = (Array.isArray(data) ? data[0] : data) as ReportRow | null;
  if (!row) {
    throw new Error("Failed to persist report and citations");
  }

  return row;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return jsonResponse(401, { error: "Missing Authorization header" });
  }

  let body: CreateReportBody;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  if (!body.company_id || !isReportType(body.report_type)) {
    return jsonResponse(400, { error: "company_id and report_type are required" });
  }

  const customSources = normalizeCustomSources(body.custom_sources);
  const projectId = body.project_id ?? null;
  const bypassCache = projectId !== null;

  const userClient = createUserClient(authorization);
  const serviceClient = createServiceClient();

  const {
    data: { user },
    error: userError
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return jsonResponse(401, { error: "Invalid user session" });
  }

  const { data: activeOrgId, error: activeOrgError } = await userClient.rpc("current_active_org");
  if (activeOrgError || !activeOrgId) {
    return jsonResponse(403, { error: "No active organization context" });
  }

  const entitlements = new Entitlements(userClient);
  const entitlementAction = `reports.${body.report_type}` as const;
  const allowed = await entitlements.can(activeOrgId, entitlementAction);
  if (!allowed) {
    const remaining = await entitlements.quotaRemaining(activeOrgId, entitlementAction);
    return jsonResponse(429, {
      error: {
        code: "QUOTA_EXCEEDED",
        message: `Quota exceeded for ${body.report_type}. Upgrade your plan to continue.`,
        action: entitlementAction,
        remaining
      }
    });
  }

  if (projectId) {
    const { data: projectRow, error: projectError } = await userClient
      .from("projects")
      .select("id, org_id")
      .eq("id", projectId)
      .single();

    if (projectError || !projectRow || projectRow.org_id !== activeOrgId) {
      return jsonResponse(403, { error: "project_id must belong to the active organization" });
    }
  }

  const { data: companyRow, error: companyError } = await userClient
    .from("companies")
    .select("id")
    .eq("id", body.company_id)
    .single();

  if (companyError || !companyRow) {
    return jsonResponse(404, { error: "Company not found" });
  }

  const sourceIngestor = createSourceIngestor(serviceClient);
  const ingestedSources = await sourceIngestor.fetchSources({
    company_id: companyRow.id,
    kind: "earnings_transcript",
    source_urls: customSources,
    audit: {
      org_id: activeOrgId,
      actor_id: user.id,
      project_id: projectId,
      report_type: body.report_type
    }
  });

  const sourceDocumentIds = ingestedSources.map((document) => document.id);
  const sortedSourceIds = sourceDocumentIds.slice().sort();
  const sourceDocSetHash = await sha256Hex(JSON.stringify(sortedSourceIds));

  const composer = new ReportComposer({
    sourceDocSetHash,
    sourceDocuments: ingestedSources.map((source) => ({
      id: source.id,
      raw_content: source.raw_content
    }))
  });

  const { error: usageError } = await serviceClient.from("usage_events").insert({
    org_id: activeOrgId,
    user_id: user.id,
    action: entitlementAction,
    metadata: {
      report_type: body.report_type,
      company_id: body.company_id,
      project_id: projectId,
      cache_bypass: bypassCache
    }
  });

  if (usageError) {
    return jsonResponse(500, { error: usageError.message });
  }

  const schema = reportSchemaForType(body.report_type);

  const logComposerFailure = async (attempt: 1 | 2, error: ReportComposerError) => {
    const { error: auditInsertError } = await serviceClient.from("audit_events").insert({
      org_id: activeOrgId,
      project_id: projectId,
      actor_id: user.id,
      kind: "report_composer_failed",
      payload: {
        report_type: body.report_type,
        source_doc_set_hash: sourceDocSetHash,
        attempt,
        error_code: error.code,
        details: error.details
      }
    });

    if (auditInsertError) {
      console.error("failed to insert report_composer_failed audit event", auditInsertError.message);
    }
  };

  const logCitationVerificationFailures = async (
    verificationFailures: Array<{ claim_id: string; source_document_id: string; quote: string }>
  ) => {
    if (verificationFailures.length === 0) return;

    const events = verificationFailures.map((failure) => ({
      org_id: activeOrgId,
      project_id: projectId,
      actor_id: user.id,
      kind: "citation_verification_failed",
      payload: {
        report_type: body.report_type,
        source_doc_set_hash: sourceDocSetHash,
        claim_id: failure.claim_id,
        source_document_id: failure.source_document_id,
        quote: failure.quote
      }
    }));

    const { error: auditInsertError } = await serviceClient.from("audit_events").insert(events);
    if (auditInsertError) {
      console.error("failed to insert citation_verification_failed audit events", auditInsertError.message);
    }
  };

  if (body.report_type === "earnings_summary") {
    const agentRun = await runAgent({
      type: "earnings_summary",
      sessionMode: "stream",
      cache: {
        client: serviceClient,
        sourceDocSetHash
      },
      context: {
        companyId: companyRow.id,
        sourceDocumentIds: sortedSourceIds,
        customSources,
        projectId
      }
    });

    if (agentRun.mode !== "stream") {
      return jsonResponse(500, { error: "Streaming mode expected for earnings_summary" });
    }

    const persistOnCompletion = agentRun.completion
      .then(async (completion) => {
        const composed = await composeWithRecovery({
          composer,
          rawArgs: completion.payload,
          schema,
          retryWithStricterPrompt: async () => {
            const retryRun = await runReportAgent({
              reportType: body.report_type as ReportType,
              companyId: companyRow.id,
              sourceDocumentIds: sortedSourceIds,
              customSources,
              projectId,
              recoveryMode: "strict_retry"
            });
            return retryRun.payload;
          },
          fallbackShapeC: async () => {
            const fallbackRun = await runReportAgentShapeC({
              reportType: body.report_type as ReportType,
              companyId: companyRow.id,
              sourceDocumentIds: sortedSourceIds,
              customSources,
              projectId
            });
            return fallbackRun.payload;
          },
          onRejectableFailure: logComposerFailure
        });

        await logCitationVerificationFailures(composed.verificationFailures);

        let compositionId = agentRun.cache.compositionId;
        if (compositionId && composed.attemptCount > 1) {
          compositionId = null;
        }

        if (!bypassCache && !compositionId) {
          const { data: insertedComposition, error: compositionError } = await serviceClient
            .from("compositions")
            .upsert(
              {
                company_id: companyRow.id,
                report_type: body.report_type,
                source_doc_set_hash: sourceDocSetHash,
                agent_version: agentRun.agentVersion,
                payload: composed.payload,
                expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
              },
              { onConflict: "company_id,report_type,source_doc_set_hash,agent_version" }
            )
            .select("id")
            .single();

          if (compositionError || !insertedComposition) {
            throw new Error(compositionError?.message ?? "Failed to persist composition");
          }

          compositionId = insertedComposition.id;
        }

        const createdReport = await persistReportWithCitations({
          serviceClient,
          orgId: activeOrgId,
          projectId,
          companyId: companyRow.id,
          reportType: body.report_type as ReportType,
          compositionId,
          sourceDocSetHash,
          agentVersion: agentRun.agentVersion,
          payload: composed.payload as Record<string, unknown>,
          citations: composed.citations,
          createdBy: user.id
        });

        await serviceClient.from("audit_events").insert({
          org_id: activeOrgId,
          project_id: projectId,
          actor_id: user.id,
          kind: agentRun.cache.hit ? "composition_cache_hit" : "agent_run",
          payload: {
            report_id: createdReport.id,
            report_type: body.report_type,
            tool_name: agentRun.toolName,
            agent_id: agentRun.agentId,
            agent_version: agentRun.agentVersion,
            source_doc_set_hash: sourceDocSetHash,
            cache_hit: agentRun.cache.hit,
            cache_bypass: bypassCache,
            composer_attempt_count: composed.attemptCount,
            shape_c_fallback_used: composed.usedShapeCFallback,
            tokens: {
              input: completion.usage.inputTokens,
              output: completion.usage.outputTokens
            },
            duration_ms: completion.durationMs,
            cost: completion.cost
          }
        });
      })
      .catch(async (error) => {
        await serviceClient.from("audit_events").insert({
          org_id: activeOrgId,
          project_id: projectId,
          actor_id: user.id,
          kind: "agent_run_failed",
          payload: {
            report_type: body.report_type,
            tool_name: agentRun.toolName,
            agent_id: agentRun.agentId,
            agent_version: agentRun.agentVersion,
            source_doc_set_hash: sourceDocSetHash,
            message: error instanceof Error ? error.message : "unknown streaming failure"
          }
        });
      });

    trackBackground(persistOnCompletion);

    return new Response(agentRun.stream, {
      status: 200,
      headers: streamHeaders()
    });
  }

  let rawPayload: Record<string, unknown> | null = null;
  let compositionId: string | null = null;
  let agentVersion = Deno.env.get("AGENT_VERSION") ?? "dev";
  let primaryAgentRun: LegacyAgentRunResult | null = null;
  primaryAgentRun = await runReportAgent({
    reportType: body.report_type,
    companyId: companyRow.id,
    sourceDocumentIds: sortedSourceIds,
    customSources,
    projectId,
    cache: {
      client: serviceClient,
      sourceDocSetHash
    }
  });

  rawPayload = primaryAgentRun.payload;
  compositionId = primaryAgentRun.cache.compositionId;
  agentVersion = primaryAgentRun.agentVersion;

  const composed = await composeWithRecovery({
    composer,
    rawArgs: rawPayload,
    schema,
    retryWithStricterPrompt: async () => {
      const retryRun = await runReportAgent({
        reportType: body.report_type as ReportType,
        companyId: companyRow.id,
        sourceDocumentIds: sortedSourceIds,
        customSources,
        projectId,
        cache: {
          client: serviceClient,
          sourceDocSetHash
        },
        recoveryMode: "strict_retry"
      });
      return retryRun.payload;
    },
    fallbackShapeC: async () => {
      const fallbackRun = await runReportAgentShapeC({
        reportType: body.report_type as ReportType,
        companyId: companyRow.id,
        sourceDocumentIds: sortedSourceIds,
        customSources,
        projectId
      });
      return fallbackRun.payload;
    },
    onRejectableFailure: logComposerFailure
  });

  await logCitationVerificationFailures(composed.verificationFailures);

  if (compositionId && composed.attemptCount > 1) {
    compositionId = null;
  }

  if (primaryAgentRun) {
    await serviceClient.from("audit_events").insert({
      org_id: activeOrgId,
      project_id: projectId,
      actor_id: user.id,
      kind: primaryAgentRun.cache.hit ? "composition_cache_hit" : "agent_run",
      payload: {
        report_type: body.report_type,
        tool_name: primaryAgentRun.toolName,
        agent_id: primaryAgentRun.agentId,
        agent_version: primaryAgentRun.agentVersion,
        source_doc_set_hash: sourceDocSetHash,
        cache_hit: primaryAgentRun.cache.hit,
        cache_bypass: bypassCache,
        composer_attempt_count: composed.attemptCount,
        shape_c_fallback_used: composed.usedShapeCFallback
      }
    });
  }

  if (!bypassCache && !compositionId) {
    const { data: insertedComposition, error: compositionError } = await serviceClient
      .from("compositions")
      .upsert(
        {
          company_id: companyRow.id,
          report_type: body.report_type,
          source_doc_set_hash: sourceDocSetHash,
          agent_version: agentVersion,
          payload: composed.payload,
          expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
        },
        { onConflict: "company_id,report_type,source_doc_set_hash,agent_version" }
      )
      .select("id")
      .single();

    if (compositionError || !insertedComposition) {
      return jsonResponse(500, {
        error: compositionError?.message ?? "Failed to persist composition"
      });
    }

    compositionId = insertedComposition.id;
  }

  const createdReport = await persistReportWithCitations({
    serviceClient,
    orgId: activeOrgId,
    projectId,
    companyId: companyRow.id,
    reportType: body.report_type,
    compositionId,
    sourceDocSetHash,
    agentVersion,
    payload: composed.payload as Record<string, unknown>,
    citations: composed.citations,
    createdBy: user.id
  });

  return jsonResponse(201, {
    report: createdReport,
    cache: {
      bypassed: bypassCache,
      composition_id: compositionId
    }
  });
});
