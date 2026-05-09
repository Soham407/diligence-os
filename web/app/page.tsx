import { AuthPanel } from "./auth-panel";
import { ReportPanel } from "./report-panel";
import { createSupabaseServerClient } from "../lib/supabase/server";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  const memberships: Array<{
    orgId: string;
    role: string;
    orgName: string;
    orgType: string;
  }> = [];
  let activeOrgId: string | null = null;

  if (user) {
    const [{ data: profile }, { data: memberRows }] = await Promise.all([
      supabase
        .from("user_profiles")
        .select("last_active_org_id, personal_org_id")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("org_members")
        .select("org_id, role, organizations(name, org_type)")
        .eq("user_id", user.id)
    ]);

    for (const row of memberRows ?? []) {
      const orgRecord = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      if (!orgRecord) {
        continue;
      }

      memberships.push({
        orgId: row.org_id,
        role: row.role,
        orgName: orgRecord.name,
        orgType: orgRecord.org_type
      });
    }

    const claimedActiveOrgId =
      typeof user.app_metadata?.active_org_id === "string" ? user.app_metadata.active_org_id : null;
    activeOrgId = claimedActiveOrgId ?? profile?.last_active_org_id ?? profile?.personal_org_id ?? null;
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-20 text-slate-100">
      <section className="mx-auto max-w-3xl space-y-6">
        <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Diligence OS</p>
        <h1 className="text-4xl font-semibold leading-tight md:text-5xl">Entitlements + Tier Gating</h1>
        <p className="text-lg text-slate-300">
          Server-side entitlement checks gate report endpoints. Client-side state mirrors `/me` for UX-only
          upsell.
        </p>
        <AuthPanel
          memberships={memberships}
          userEmail={user?.email ?? null}
          userId={user?.id ?? null}
          activeOrgId={activeOrgId}
        />
        {user ? <ReportPanel /> : null}
      </section>
    </main>
  );
}
