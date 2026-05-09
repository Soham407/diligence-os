import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Entitlements } from "../_shared/entitlements.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { runReportAgent, type ReportType } from "../_shared/agent-orchestrator.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase.ts";

type CreateReportBody = {
  company_id?: string;
  report_type?: ReportType;
  project_id?: string | null;
  custom_sources?: string[];
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

  const sourceDocumentIds: string[] = [];

  for (const sourceUrl of customSources) {
    const fetchedWindow = new Date().toISOString().slice(0, 13);
    const { data: existingDoc } = await serviceClient
      .from("source_documents")
      .select("id")
      .eq("source_url", sourceUrl)
      .eq("fetched_at_window", fetchedWindow)
      .maybeSingle();

    let sourceDocumentId = existingDoc?.id;

    if (!sourceDocumentId) {
      const { data: insertedDoc, error: insertDocError } = await serviceClient
        .from("source_documents")
        .insert({
          company_id: companyRow.id,
          kind: "earnings_transcript",
          source_url: sourceUrl,
          fetched_at_window: fetchedWindow,
          raw_content: `Fetched placeholder content for ${sourceUrl}`,
          metadata: { ingested_by: "reports-function" }
        })
        .select("id")
        .single();

      if (insertDocError || !insertedDoc) {
        return jsonResponse(500, { error: insertDocError?.message ?? "Failed to persist source document" });
      }

      sourceDocumentId = insertedDoc.id;
    }

    sourceDocumentIds.push(sourceDocumentId);

    await serviceClient.from("audit_events").insert({
      org_id: activeOrgId,
      project_id: projectId,
      actor_id: user.id,
      kind: "scrape",
      payload: {
        source_url: sourceUrl,
        source_document_id: sourceDocumentId,
        report_type: body.report_type
      }
    });
  }

  const sortedSourceIds = sourceDocumentIds.slice().sort();
  const sourceDocSetHash = await sha256Hex(JSON.stringify(sortedSourceIds));

  let payload: Record<string, unknown> | null = null;
  let compositionId: string | null = null;
  let agentVersion = Deno.env.get("AGENT_VERSION") ?? "dev";

  if (!bypassCache) {
    const { data: existingComposition } = await serviceClient
      .from("compositions")
      .select("id, payload")
      .eq("company_id", companyRow.id)
      .eq("report_type", body.report_type)
      .eq("source_doc_set_hash", sourceDocSetHash)
      .eq("agent_version", agentVersion)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (existingComposition) {
      payload = existingComposition.payload as Record<string, unknown>;
      compositionId = existingComposition.id;
    }
  }

  if (!payload) {
    const agentRun = await runReportAgent({
      reportType: body.report_type,
      companyId: companyRow.id,
      sourceDocumentIds: sortedSourceIds,
      customSources,
      projectId
    });

    payload = agentRun.payload;
    agentVersion = agentRun.agentVersion;

    await serviceClient.from("audit_events").insert({
      org_id: activeOrgId,
      project_id: projectId,
      actor_id: user.id,
      kind: "agent_run",
      payload: {
        report_type: body.report_type,
        tool_name: agentRun.toolName,
        agent_id: agentRun.agentId,
        agent_version: agentRun.agentVersion,
        source_doc_set_hash: sourceDocSetHash,
        cache_bypass: bypassCache
      }
    });

    if (!bypassCache) {
      const { data: insertedComposition, error: compositionError } = await serviceClient
        .from("compositions")
        .upsert(
          {
            company_id: companyRow.id,
            report_type: body.report_type,
            source_doc_set_hash: sourceDocSetHash,
            agent_version: agentRun.agentVersion,
            payload,
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
  }

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

  const { data: createdReport, error: reportError } = await serviceClient
    .from("reports")
    .insert({
      org_id: activeOrgId,
      project_id: projectId,
      company_id: companyRow.id,
      report_type: body.report_type,
      composition_id: compositionId,
      source_doc_set_hash: sourceDocSetHash,
      agent_version: agentVersion,
      status: "succeeded",
      payload,
      created_by: user.id
    })
    .select("id, org_id, project_id, company_id, report_type, composition_id, status, created_at")
    .single();

  if (reportError || !createdReport) {
    return jsonResponse(500, { error: reportError?.message ?? "Failed to create report" });
  }

  return jsonResponse(201, {
    report: createdReport,
    cache: {
      bypassed: bypassCache,
      composition_id: compositionId
    }
  });
});
