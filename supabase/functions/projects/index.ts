import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createUserClient } from "../_shared/supabase.ts";

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

  const supabase = createUserClient(authorization);

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return jsonResponse(401, { error: "Invalid user session" });
  }

  let body: { client_name?: string; client_slug?: string; white_label_config?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const clientName = body.client_name?.trim();
  const clientSlug = body.client_slug?.trim();

  if (!clientName || !clientSlug) {
    return jsonResponse(400, { error: "client_name and client_slug are required" });
  }

  const { data: activeOrgData, error: activeOrgError } = await supabase.rpc("current_active_org");
  if (activeOrgError || !activeOrgData) {
    return jsonResponse(403, { error: "No active organization context" });
  }

  const { data: orgRow, error: orgError } = await supabase
    .from("organizations")
    .select("id, org_type")
    .eq("id", activeOrgData)
    .single();

  if (orgError || !orgRow || orgRow.org_type !== "agency") {
    return jsonResponse(403, { error: "Projects can only be created in an agency organization" });
  }

  const { data: createdProject, error: createError } = await supabase
    .from("projects")
    .insert({
      org_id: orgRow.id,
      client_name: clientName,
      client_slug: clientSlug,
      white_label_config:
        typeof body.white_label_config === "object" && body.white_label_config !== null
          ? body.white_label_config
          : {},
      created_by: user.id
    })
    .select("id, org_id, client_name, client_slug, white_label_config, created_by, created_at")
    .single();

  if (createError || !createdProject) {
    return jsonResponse(400, { error: createError?.message ?? "Failed to create project" });
  }

  return jsonResponse(201, { project: createdProject });
});
