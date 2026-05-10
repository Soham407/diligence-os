import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getMobileSupabaseEnv } from "./env";

let mobileClient: SupabaseClient | undefined;

export function getSupabaseMobileClient(): SupabaseClient {
  if (!mobileClient) {
    const { supabaseUrl, supabaseAnonKey } = getMobileSupabaseEnv();
    mobileClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false
      }
    });
  }

  return mobileClient;
}
