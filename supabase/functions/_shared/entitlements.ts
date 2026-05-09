import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

export const REPORT_ACTIONS = [
  "reports.earnings_summary",
  "reports.due_diligence",
  "reports.lead_intel"
] as const;

export type EntitlementAction = (typeof REPORT_ACTIONS)[number];

export type QuotaSnapshot = Record<EntitlementAction, number>;

export type EntitlementSnapshot = {
  tier: string;
  quotasRemaining: QuotaSnapshot;
  featureFlags: Record<string, boolean>;
};

export class Entitlements {
  constructor(private readonly supabase: SupabaseClient) {}

  async can(activeOrgId: string, action: EntitlementAction): Promise<boolean> {
    const remaining = await this.quotaRemaining(activeOrgId, action);
    return remaining > 0;
  }

  async quotaRemaining(activeOrgId: string, action: EntitlementAction): Promise<number> {
    const policy = await this.getPolicy(activeOrgId, action);

    if (!policy) {
      return 0;
    }

    const now = new Date();
    const from = new Date(now.getTime() - policy.rolling_window_days * 24 * 60 * 60 * 1000);

    const { count, error } = await this.supabase
      .from("usage_events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", activeOrgId)
      .eq("action", action)
      .gte("created_at", from.toISOString())
      .lte("created_at", now.toISOString());

    if (error) {
      throw new Error(`Failed to count usage events: ${error.message}`);
    }

    return Math.max(policy.quota_limit - (count ?? 0), 0);
  }

  async snapshot(activeOrgId: string): Promise<EntitlementSnapshot> {
    const tier = await this.getTier(activeOrgId);

    const quotasEntries = await Promise.all(
      REPORT_ACTIONS.map(async (action) => [action, await this.quotaRemaining(activeOrgId, action)] as const)
    );

    const { data: tierRow, error: tierError } = await this.supabase
      .from("entitlement_tiers")
      .select("feature_flags")
      .eq("tier", tier)
      .maybeSingle();

    if (tierError) {
      throw new Error(`Failed to load feature flags: ${tierError.message}`);
    }

    const featureFlags = normalizeFeatureFlags(tierRow?.feature_flags);

    return {
      tier,
      quotasRemaining: Object.fromEntries(quotasEntries) as QuotaSnapshot,
      featureFlags
    };
  }

  private async getTier(activeOrgId: string): Promise<string> {
    const { data, error } = await this.supabase
      .from("organizations")
      .select("plan")
      .eq("id", activeOrgId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load organization tier: ${error.message}`);
    }

    if (!data?.plan) {
      throw new Error("Active org not found.");
    }

    return data.plan;
  }

  private async getPolicy(activeOrgId: string, action: EntitlementAction) {
    const tier = await this.getTier(activeOrgId);

    const { data, error } = await this.supabase
      .from("entitlement_policies")
      .select("quota_limit, rolling_window_days")
      .eq("tier", tier)
      .eq("action", action)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load entitlement policy: ${error.message}`);
    }

    return data;
  }
}

function normalizeFeatureFlags(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, Boolean(value)])
  );
}
