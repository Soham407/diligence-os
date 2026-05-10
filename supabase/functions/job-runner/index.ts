import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  runReportAgent,
  runReportAgentShapeC,
  type ReportType
} from "../_shared/agent-orchestrator.ts";
import {
  composeWithRecovery,
  ReportComposer,
  type MaterializedCitation,
  type ReportComposerError
} from "../_shared/report-composer.ts";
import { createJobRunner, type JobRow } from "../_shared/job-runner.ts";
import { DueDiligenceReportSchema } from "../_shared/report-schemas.ts";
import { createSourceIngestor } from "../_shared/source-ingestor.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase.ts";

type JobSpec = {
  report_type: ReportType;
  company_id: string;
  custom_sources?: string[];
  project_id?: string | null;
  actor_id?: string;
};

type ReportRow = {
  id: string;
  org_id: string;
  project_id: string | null;
  company_id: string;
  report_type: ReportType;
  composition_id: string | null;
  source_doc_set_hash: string;
  agent_version: string;
  status: string;
  created_by: string | null;
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

function isAuthorizedCronRequest(request: Request): boolean {
  const configuredToken = Deno.env.get("JOB_RUNNER_CRON_TOKEN");
  if (!configuredToken) {
    return true;
  }

  const token = request.headers.get("x-job-runner-token");
  return token === configuredToken;
}

async function completeReportWithCitations(input: {
  serviceClient: ReturnType<typeof createServiceClient>;
  reportId: string;
  payload: Record<string, unknown>;
  status: "succeeded" | "failed";
  citations: MaterializedCitation[];
  compositionId: string | null;
  agentVersion: string;
  sourceDocSetHash: string;
}): Promise<ReportRow> {
  const { data, error } = await input.serviceClient.rpc("complete_report_with_citations", {
    p_report_id: input.reportId,
    p_payload: input.payload,
    p_status: input.status,
    p_citations: input.citations,
    p_composition_id: input.compositionId,
    p_agent_version: input.agentVersion,
    p_source_doc_set_hash: input.sourceDocSetHash
  });

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to complete report with citations");
  }

  const row = (Array.isArray(data) ? data[0] : data) as ReportRow | null;
  if (!row) {
    throw new Error("Failed to complete report with citations");
  }

  return row;
}

async function loadJobSpec(
  runner: ReturnType<typeof createJobRunner>,
  jobId: string
): Promise<JobSpec | null> {
  const events = await runner.listJobEvents(jobId);
  const enqueued = events.find((event) => event.kind === "job_enqueued");
  if (!enqueued?.payload || typeof enqueued.payload !== "object") {
    return null;
  }

  const raw = enqueued.payload as Record<string, unknown>;
  if (
    raw.report_type !== "due_diligence" &&
    raw.report_type !== "earnings_summary" &&
    raw.report_type !== "lead_intel"
  ) {
    return null;
  }

  if (typeof raw.company_id !== "string") {
    return null;
  }

  return {
    report_type: raw.report_type,
    company_id: raw.company_id,
    custom_sources: normalizeCustomSources(raw.custom_sources),
    project_id: typeof raw.project_id === "string" ? raw.project_id : null,
    actor_id: typeof raw.actor_id === "string" ? raw.actor_id : undefined
  };
}

async function processDueDiligenceJob(input: {
  serviceClient: ReturnType<typeof createServiceClient>;
  runner: ReturnType<typeof createJobRunner>;
  job: JobRow;
  spec: JobSpec;
}): Promise<void> {
  const { serviceClient, runner, spec } = input;

  if (!input.job.report_id) {
    throw new Error("Job missing report_id");
  }

  const { data: reportRow, error: reportError } = await serviceClient
    .from("reports")
    .select(
      "id, org_id, project_id, company_id, report_type, composition_id, source_doc_set_hash, agent_version, status, created_by"
    )
    .eq("id", input.job.report_id)
    .single();

  if (reportError || !reportRow) {
    throw new Error(reportError?.message ?? "Report not found for job");
  }

  if (reportRow.report_type !== "due_diligence") {
    throw new Error(`Unsupported report_type for issue #30 path: ${reportRow.report_type}`);
  }

  await runner.updateJob(input.job.id, {
    status: "running",
    anthropic_session_id: input.job.anthropic_session_id ?? `sess_${input.job.id}`
  });

  await serviceClient
    .from("reports")
    .update({ status: "running" })
    .eq("id", reportRow.id);

  await runner.appendEvent(input.job.id, "job_status", {
    status: "running"
  });

  await runner.appendEvent(input.job.id, "anthropic_polled", {
    session_id: input.job.anthropic_session_id ?? `sess_${input.job.id}`,
    polled_at: new Date().toISOString()
  });

  const sourceIngestor = createSourceIngestor(serviceClient);
  const ingestedSources = await sourceIngestor.fetchSources({
    company_id: spec.company_id,
    kind: "earnings_transcript",
    source_urls: spec.custom_sources ?? [],
    audit: {
      org_id: reportRow.org_id,
      actor_id: spec.actor_id ?? reportRow.created_by ?? "system",
      project_id: reportRow.project_id,
      report_type: reportRow.report_type
    }
  });

  const sourceDocumentIds = ingestedSources.map((document) => document.id);
  const sortedSourceIds = sourceDocumentIds.slice().sort();
  const sourceDocSetHash = await sha256Hex(JSON.stringify(sortedSourceIds));

  await runner.appendEvent(input.job.id, "job_progress", {
    stage: "sources_ready",
    source_document_count: sortedSourceIds.length
  });

  const composer = new ReportComposer({
    sourceDocSetHash,
    sourceDocuments: ingestedSources.map((source) => ({
      id: source.id,
      raw_content: source.raw_content
    }))
  });

  const logComposerFailure = async (attempt: 1 | 2, error: ReportComposerError) => {
    await serviceClient.from("audit_events").insert({
      org_id: reportRow.org_id,
      project_id: reportRow.project_id,
      actor_id: spec.actor_id ?? reportRow.created_by,
      kind: "report_composer_failed",
      payload: {
        report_id: reportRow.id,
        report_type: reportRow.report_type,
        source_doc_set_hash: sourceDocSetHash,
        attempt,
        error_code: error.code,
        details: error.details
      }
    });
  };

  const logCitationVerificationFailures = async (
    verificationFailures: Array<{ claim_id: string; source_document_id: string; quote: string }>
  ) => {
    if (verificationFailures.length === 0) return;

    const events = verificationFailures.map((failure) => ({
      org_id: reportRow.org_id,
      project_id: reportRow.project_id,
      actor_id: spec.actor_id ?? reportRow.created_by,
      kind: "citation_verification_failed",
      payload: {
        report_id: reportRow.id,
        report_type: reportRow.report_type,
        source_doc_set_hash: sourceDocSetHash,
        claim_id: failure.claim_id,
        source_document_id: failure.source_document_id,
        quote: failure.quote
      }
    }));

    await serviceClient.from("audit_events").insert(events);
  };

  const primaryAgentRun = await runReportAgent({
    reportType: "due_diligence",
    companyId: spec.company_id,
    sourceDocumentIds: sortedSourceIds,
    customSources: spec.custom_sources ?? [],
    projectId: reportRow.project_id,
    cache: {
      client: serviceClient,
      sourceDocSetHash
    }
  });

  const composed = await composeWithRecovery({
    composer,
    rawArgs: primaryAgentRun.payload,
    schema: DueDiligenceReportSchema,
    retryWithStricterPrompt: async () => {
      const retryRun = await runReportAgent({
        reportType: "due_diligence",
        companyId: spec.company_id,
        sourceDocumentIds: sortedSourceIds,
        customSources: spec.custom_sources ?? [],
        projectId: reportRow.project_id,
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
        reportType: "due_diligence",
        companyId: spec.company_id,
        sourceDocumentIds: sortedSourceIds,
        customSources: spec.custom_sources ?? [],
        projectId: reportRow.project_id
      });
      return fallbackRun.payload;
    },
    onRejectableFailure: logComposerFailure
  });

  await logCitationVerificationFailures(composed.verificationFailures);

  let compositionId = primaryAgentRun.cache.compositionId;
  if (compositionId && composed.attemptCount > 1) {
    compositionId = null;
  }

  if (reportRow.project_id === null && !compositionId) {
    const { data: insertedComposition, error: compositionError } = await serviceClient
      .from("compositions")
      .upsert(
        {
          company_id: spec.company_id,
          report_type: "due_diligence",
          source_doc_set_hash: sourceDocSetHash,
          agent_version: primaryAgentRun.agentVersion,
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

  await completeReportWithCitations({
    serviceClient,
    reportId: reportRow.id,
    payload: composed.payload as Record<string, unknown>,
    status: "succeeded",
    citations: composed.citations,
    compositionId,
    agentVersion: primaryAgentRun.agentVersion,
    sourceDocSetHash
  });

  await runner.updateJob(input.job.id, { status: "succeeded" });
  await runner.appendEvent(input.job.id, "job_status", {
    status: "succeeded",
    report_id: reportRow.id,
    cache_hit: primaryAgentRun.cache.hit,
    composer_attempt_count: composed.attemptCount,
    shape_c_fallback_used: composed.usedShapeCFallback
  });

  const auditKind = primaryAgentRun.cache.hit ? "composition_cache_hit" : "agent_run";
  await serviceClient.from("audit_events").insert({
    org_id: reportRow.org_id,
    project_id: reportRow.project_id,
    actor_id: spec.actor_id ?? reportRow.created_by,
    kind: auditKind,
    payload: {
      report_id: reportRow.id,
      report_type: reportRow.report_type,
      tool_name: primaryAgentRun.toolName,
      agent_id: primaryAgentRun.agentId,
      agent_version: primaryAgentRun.agentVersion,
      source_doc_set_hash: sourceDocSetHash,
      cache_hit: primaryAgentRun.cache.hit,
      cache_bypass: reportRow.project_id !== null,
      composer_attempt_count: composed.attemptCount,
      shape_c_fallback_used: composed.usedShapeCFallback
    }
  });
}

async function failJob(input: {
  serviceClient: ReturnType<typeof createServiceClient>;
  runner: ReturnType<typeof createJobRunner>;
  job: JobRow;
  message: string;
}) {
  await input.runner.updateJob(input.job.id, { status: "failed" });

  if (input.job.report_id) {
    await input.serviceClient
      .from("reports")
      .update({ status: "failed" })
      .eq("id", input.job.report_id);
  }

  await input.runner.appendEvent(input.job.id, "job_status", {
    status: "failed",
    message: input.message
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (!isAuthorizedCronRequest(request)) {
    return jsonResponse(401, { error: "Unauthorized cron invocation" });
  }

  const serviceClient = createServiceClient();
  const runner = createJobRunner(serviceClient);
  const jobs = await runner.listActiveJobs(20);

  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    const spec = await loadJobSpec(runner, job.id);
    if (!spec) {
      failed += 1;
      await failJob({
        serviceClient,
        runner,
        job,
        message: "Missing or invalid job_enqueued spec payload"
      });
      continue;
    }

    if (spec.report_type !== "due_diligence") {
      continue;
    }

    try {
      await processDueDiligenceJob({
        serviceClient,
        runner,
        job,
        spec
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      await failJob({
        serviceClient,
        runner,
        job,
        message: error instanceof Error ? error.message : "unknown job failure"
      });
    }
  }

  return jsonResponse(200, {
    processed,
    failed,
    scanned_jobs: jobs.length
  });
});
