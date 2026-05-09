import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "");
  const isSwitchRoute = pathname === "/orgs/switch" || pathname === "/switch";
  if (request.method !== "POST" || !isSwitchRoute) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "missing_authorization" }, 401);
  }

  const accessToken = authHeader.slice("Bearer ".length);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: "missing_supabase_environment" }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser(accessToken);

  if (userError || !user) {
    return jsonResponse({ error: "unauthenticated" }, 401);
  }

  let body: { org_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  if (typeof body.org_id !== "string" || !isUuid(body.org_id)) {
    return jsonResponse({ error: "org_id must be a valid uuid" }, 400);
  }

  const { data: switchedOrgId, error: switchError } = await supabase.rpc("set_active_org", {
    next_org_id: body.org_id
  });

  if (switchError) {
    if (switchError.message.includes("cannot switch to org without membership")) {
      return jsonResponse({ error: "forbidden_org_switch" }, 403);
    }

    return jsonResponse({ error: "org_switch_failed", details: switchError.message }, 500);
  }

  return jsonResponse({ active_org_id: switchedOrgId });
});
