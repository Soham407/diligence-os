import { Entitlements } from "../_shared/entitlements.ts";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { requireAuthContext } from "../_shared/supabase.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const authContext = await requireAuthContext(request);
  if (authContext instanceof Response) {
    return authContext;
  }

  const { supabase, activeOrgId } = authContext;
  const entitlements = new Entitlements(supabase);

  const snapshot = await entitlements.snapshot(activeOrgId);

  return jsonResponse(200, {
    active_org_id: activeOrgId,
    tier: snapshot.tier,
    quotas_remaining: snapshot.quotasRemaining,
    feature_flags: snapshot.featureFlags
  });
});
