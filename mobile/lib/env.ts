function readExpoPublicEnv(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
    };
  };

  return runtime.process?.env?.[name];
}

export function getMobileSupabaseEnv() {
  const supabaseUrl = readExpoPublicEnv("EXPO_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = readExpoPublicEnv("EXPO_PUBLIC_SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY for mobile Supabase auth."
    );
  }

  return { supabaseUrl, supabaseAnonKey };
}
