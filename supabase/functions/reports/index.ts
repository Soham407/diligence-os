import { Entitlements, type EntitlementAction } from "../_shared/entitlements.ts";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { requireAuthContext } from "../_shared/supabase.ts";

const REPORT_TYPES = ["earnings_summary", "due_diligence", "lead_intel"] as const;
type ReportType = (typeof REPORT_TYPES)[number];

type CreateReportRequest = {
  company_id?: string;
  project_id?: string;
  report_type?: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const authContext = await requireAuthContext(request);
  if (authContext instanceof Response) {
    return authContext;
  }

  const { supabase, user, activeOrgId } = authContext;

  let payload: CreateReportRequest;
  try {
    payload = (await request.json()) as CreateReportRequest;
  } catch {
    return jsonResponse(400, { error: "Invalid JSON request body." });
  }

  const reportType = payload.report_type;
  if (!reportType || !REPORT_TYPES.includes(reportType as ReportType)) {
    return jsonResponse(400, {
      error: "report_type must be one of earnings_summary, due_diligence, lead_intel."
    });
  }

  const entitlementAction = reportTypeToAction(reportType as ReportType);
  const mode = reportType === "earnings_summary" ? "stream" : "job";

  const entitlements = new Entitlements(supabase);
  const allowed = await entitlements.can(activeOrgId, entitlementAction);

  if (!allowed) {
    const remaining = await entitlements.quotaRemaining(activeOrgId, entitlementAction);
    return jsonResponse(429, {
      error: {
        code: "QUOTA_EXCEEDED",
        message: `Quota exceeded for ${reportType}. Upgrade your plan to continue.`,
        action: entitlementAction,
        remaining
      }
    });
  }

  const { error: usageError } = await supabase.from("usage_events").insert({
    org_id: activeOrgId,
    user_id: user.id,
    action: entitlementAction,
    metadata: {
      report_type: reportType,
      mode,
      company_id: payload.company_id ?? null,
      project_id: payload.project_id ?? null
    }
  });

  if (usageError) {
    return jsonResponse(500, { error: `Failed to persist usage event: ${usageError.message}` });
  }

  if (mode === "stream") {
    return jsonResponse(200, {
      report_id: crypto.randomUUID(),
      mode,
      message: "Streaming report path accepted."
    });
  }

  return jsonResponse(202, {
    report_id: crypto.randomUUID(),
    job_id: crypto.randomUUID(),
    mode,
    message: "Job report path accepted."
  });
});

function reportTypeToAction(reportType: ReportType): EntitlementAction {
  switch (reportType) {
    case "earnings_summary":
      return "reports.earnings_summary";
    case "due_diligence":
      return "reports.due_diligence";
    case "lead_intel":
      return "reports.lead_intel";
  }
}
