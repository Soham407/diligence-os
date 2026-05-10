"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";

let browserClient: SupabaseClient | null | undefined;

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!browserClient) {
    const supabaseEnv = getSupabaseEnv();
    browserClient = supabaseEnv
      ? createBrowserClient(supabaseEnv.supabaseUrl, supabaseEnv.supabaseAnonKey)
      : null;
  }

  return browserClient;
}
