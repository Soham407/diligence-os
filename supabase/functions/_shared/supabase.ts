import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { jsonResponse } from "./http.ts";

export type AuthContext = {
  supabase: SupabaseClient;
  user: User;
  activeOrgId: string;
};

type SupabaseEnv = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
};

function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getSupabaseEnv(): SupabaseEnv {
  const url = getRequiredEnv("SUPABASE_URL");
  const anonKey = getRequiredEnv("SUPABASE_ANON_KEY");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { url, anonKey, serviceRoleKey };
}

function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.substring("Bearer ".length).trim();
}

export function createUserClient(authorization: string): SupabaseClient {
  const { url, anonKey } = getSupabaseEnv();
  return createClient(url, anonKey, {
    global: {
      headers: {
        Authorization: authorization,
        apikey: anonKey
      }
    }
  });
}

export function createServiceClient(): SupabaseClient {
  const { url, serviceRoleKey } = getSupabaseEnv();
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

export async function requireAuthContext(request: Request): Promise<AuthContext | Response> {
  const token = getBearerToken(request);

  if (!token) {
    return jsonResponse(401, { error: "Missing bearer token." });
  }

  const supabase = createClient(getRequiredEnv("SUPABASE_URL"), getRequiredEnv("SUPABASE_ANON_KEY"), {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });

  const {
    data: { user },
    error
  } = await supabase.auth.getUser();

  if (error || !user) {
    return jsonResponse(401, { error: "Invalid auth token." });
  }

  const activeOrgId = user.app_metadata?.active_org_id;

  if (typeof activeOrgId !== "string" || !activeOrgId) {
    return jsonResponse(400, { error: "Missing active org claim on session." });
  }

  return {
    supabase,
    user,
    activeOrgId
  };
}
