import { AgencyDashboard } from "./agency-dashboard";
import { AuthPanel } from "./auth-panel";
import { CompanyResolverPanel } from "./company-resolver-panel";
import { ReportPanel } from "./report-panel";
import { createSupabaseServerClient } from "../lib/supabase/server";

type SearchParams = {
  projectId?: string;
};

type AuditLogRow = {
  id: string;
  created_at: string;
  kind: string;
  project_id: string | null;
  source_url: string | null;
  cost: number | null;
  agent_id: string | null;
  report_type: string | null;
  flagged_for_review: boolean;
};

type CostDashboardRow = {
  day: string;
  agent_id: string;
  org_type: string;
  total_cost: number;
  run_count: number;
};

function coerceNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export default async function Home({
  searchParams
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  const authMemberships: Array<{
    orgId: string;
    role: string;
    orgName: string;
    orgType: string;
  }> = [];

  const organizations: Array<{
    id: string;
    name: string;
    org_type: string;
    plan: string;
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
        .select("org_id, role, organizations(id,name,org_type,plan)")
        .eq("user_id", user.id)
    ]);

    for (const row of memberRows ?? []) {
      const orgRecord = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      if (!orgRecord) {
        continue;
      }

      authMemberships.push({
        orgId: row.org_id,
        role: row.role,
        orgName: orgRecord.name,
        orgType: orgRecord.org_type
      });

      organizations.push({
        id: orgRecord.id,
        name: orgRecord.name,
        org_type: orgRecord.org_type,
        plan: orgRecord.plan
      });
    }

    const claimedActiveOrgId =
      typeof user.app_metadata?.active_org_id === "string" ? user.app_metadata.active_org_id : null;
    activeOrgId = claimedActiveOrgId ?? profile?.last_active_org_id ?? profile?.personal_org_id ?? null;
  }

  if (!user?.email) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-20 text-slate-100">
        <section className="mx-auto max-w-3xl space-y-6">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Diligence OS</p>
          <h1 className="text-4xl font-semibold leading-tight md:text-5xl">Agency Tier Baseline</h1>
          <p className="text-lg text-slate-300">Sign in to create orgs, projects, and lead-intel reports.</p>
          <AuthPanel memberships={[]} userEmail={null} userId={null} activeOrgId={null} />
        </section>
      </main>
    );
  }

  const activeOrg = organizations.find((organization) => organization.id === activeOrgId) ?? null;
  const activeMembership = authMemberships.find((membership) => membership.orgId === activeOrgId) ?? null;
  const isActiveOrgAdmin = activeMembership?.role === "admin";
  const isPlatformAdmin =
    user.app_metadata?.platform_admin === true || user.app_metadata?.platform_admin === "true";

  let projects: Array<{ id: string; client_name: string; client_slug: string; created_at: string }> = [];
  let reports: Array<{
    id: string;
    report_type: string;
    project_id: string | null;
    status: string;
    created_at: string;
  }> = [];
  let orgAuditLog: AuditLogRow[] = [];
  let projectAuditLog: AuditLogRow[] = [];
  let costDashboard: CostDashboardRow[] = [];

  if (activeOrg?.org_type === "agency") {
    const { data: projectRows } = await supabase
      .from("projects")
      .select("id, client_name, client_slug, created_at")
      .eq("org_id", activeOrg.id)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    projects = projectRows ?? [];

    let reportQuery = supabase
      .from("reports")
      .select("id, report_type, project_id, status, created_at")
      .eq("org_id", activeOrg.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (params.projectId) {
      reportQuery = reportQuery.eq("project_id", params.projectId);
    }

    const { data: reportRows } = await reportQuery;
    reports = reportRows ?? [];
  }

  if (isActiveOrgAdmin) {
    const { data: orgAuditRows } = await supabase.rpc("get_org_audit_log", {
      p_project_id: null,
      p_limit: 100
    });
    orgAuditLog = ((orgAuditRows as AuditLogRow[] | null) ?? []).map((row) => ({
      ...row,
      cost: coerceNullableNumber(row.cost)
    }));

    if (activeOrg?.org_type === "agency" && params.projectId) {
      const { data: projectAuditRows } = await supabase.rpc("get_org_audit_log", {
        p_project_id: params.projectId,
        p_limit: 100
      });
      projectAuditLog = ((projectAuditRows as AuditLogRow[] | null) ?? []).map((row) => ({
        ...row,
        cost: coerceNullableNumber(row.cost)
      }));
    }
  }

  if (isPlatformAdmin) {
    const { data: costRows } = await supabase.rpc("get_internal_cost_dashboard", {
      p_days: 30
    });
    costDashboard = ((costRows as CostDashboardRow[] | null) ?? []).map((row) => ({
      ...row,
      total_cost: coerceNullableNumber(row.total_cost) ?? 0,
      run_count: Number(row.run_count) || 0
    }));
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <section className="mx-auto max-w-5xl space-y-6">
        <AuthPanel
          memberships={authMemberships}
          userEmail={user.email}
          userId={user.id}
          activeOrgId={activeOrgId}
        />
        <CompanyResolverPanel />
        <AgencyDashboard
          activeOrg={activeOrg}
          organizations={organizations}
          projects={projects}
          reports={reports}
          selectedProjectId={params.projectId ?? null}
          activeOrgRole={activeMembership?.role ?? null}
          isPlatformAdmin={Boolean(isPlatformAdmin)}
          costDashboard={costDashboard}
          orgAuditLog={orgAuditLog}
          projectAuditLog={projectAuditLog}
          userEmail={user.email}
        />
        <ReportPanel />
      </section>
    </main>
  );
}
