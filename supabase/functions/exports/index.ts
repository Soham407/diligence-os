import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { buildReportPdf } from "./pdf-render.ts";
import { platformDefaultsFromEnv, resolveWhiteLabel } from "./white-label.ts";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase.ts";

type ExportReportRow = {
  id: string;
  org_id: string;
  project_id: string | null;
  report_type: string;
  created_at: string;
  payload: unknown;
  company_id: string;
  organizations: { name?: string | null; white_label_config?: unknown } | { name?: string | null; white_label_config?: unknown }[] | null;
  projects:
    | { client_name?: string | null; white_label_config?: unknown }
    | { client_name?: string | null; white_label_config?: unknown }[]
    | null;
  companies:
    | { display_name?: string | null; legal_name?: string | null }
    | { display_name?: string | null; legal_name?: string | null }[]
    | null;
};

function parseReportId(pathname: string): string | null {
  const normalized = pathname.replace(/\/+$/, "");
  const match = normalized.match(/\/([0-9a-fA-F-]{36})\.pdf$/);
  return match ? match[1] : null;
}

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function collectSourceDocumentIds(payload: unknown): string[] {
  const root = asRecord(payload);
  const collected = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      collected.add(trimmed);
    }
  };

  for (const sourceId of asStringArray(root.source_documents_used)) {
    add(sourceId);
  }

  const inspectCitations = (citations: unknown) => {
    if (!Array.isArray(citations)) return;
    for (const citationEntry of citations) {
      const citation = asRecord(citationEntry);
      add(citation.source_document_id);
    }
  };

  if (Array.isArray(root.sections)) {
    for (const sectionEntry of root.sections) {
      const section = asRecord(sectionEntry);
      if (!Array.isArray(section.claims)) continue;

      for (const claimEntry of section.claims) {
        const claim = asRecord(claimEntry);
        inspectCitations(claim.citations);
      }
    }
  }

  if (Array.isArray(root.red_flags)) {
    for (const redFlagEntry of root.red_flags) {
      const redFlag = asRecord(redFlagEntry);
      inspectCitations(redFlag.citations);
    }
  }

  return Array.from(collected.values());
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const reportId = parseReportId(new URL(request.url).pathname);
  if (!reportId) {
    return jsonResponse(404, { error: "Report PDF route not found." });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return jsonResponse(401, { error: "Missing Authorization header." });
  }

  const userClient = createUserClient(authorization);
  const serviceClient = createServiceClient();

  const {
    data: { user },
    error: userError
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return jsonResponse(401, { error: "Invalid user session." });
  }

  const { data: activeOrgId, error: activeOrgError } = await userClient.rpc("current_active_org");
  if (activeOrgError || !activeOrgId) {
    return jsonResponse(403, { error: "No active organization context." });
  }

  const { data: reportRow, error: reportError } = await serviceClient
    .from("reports")
    .select(
      "id, org_id, project_id, report_type, created_at, payload, company_id, organizations(name, white_label_config), projects(client_name, white_label_config), companies(display_name, legal_name)"
    )
    .eq("id", reportId)
    .eq("org_id", activeOrgId)
    .single<ExportReportRow>();

  if (reportError || !reportRow) {
    return jsonResponse(404, { error: "Report not found." });
  }

  const organization = pickOne(reportRow.organizations);
  if (!organization) {
    return jsonResponse(500, { error: "Report organization context is missing." });
  }

  const project = pickOne(reportRow.projects);
  const company = pickOne(reportRow.companies);

  const whiteLabel = resolveWhiteLabel(
    {
      project_id: reportRow.project_id,
      project: project
        ? {
            client_name: project.client_name ?? null,
            white_label_config: project.white_label_config
          }
        : null,
      organization: {
        name: organization.name ?? null,
        white_label_config: organization.white_label_config
      }
    },
    platformDefaultsFromEnv()
  );

  const sourceDocumentIds = collectSourceDocumentIds(reportRow.payload);
  const sourceDocuments = sourceDocumentIds.length
    ? (
        await serviceClient
          .from("source_documents")
          .select("id, source_url, fetched_at")
          .in("id", sourceDocumentIds)
      ).data ?? []
    : [];

  const pdfBytes = await buildReportPdf({
    reportId: reportRow.id,
    reportType: reportRow.report_type,
    createdAt: reportRow.created_at,
    companyName: company?.display_name ?? company?.legal_name ?? reportRow.company_id,
    payload: reportRow.payload,
    whiteLabel,
    sourceDocuments
  });

  await serviceClient.from("audit_events").insert({
    org_id: reportRow.org_id,
    project_id: reportRow.project_id,
    actor_id: user.id,
    kind: "export",
    payload: {
      report_id: reportRow.id,
      format: "pdf",
      white_label_source: whiteLabel.source
    }
  });

  return new Response(pdfBytes, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="report-${reportId}.pdf"`
    }
  });
});
