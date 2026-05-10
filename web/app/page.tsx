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
  const user =
    supabase === null
      ? null
      : (
          await supabase.auth.getUser()
        ).data.user;

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
  const supabaseClient = supabase!;

  if (user) {
    const [{ data: profile }, { data: memberRows }] = await Promise.all([
      supabaseClient
        .from("user_profiles")
        .select("last_active_org_id, personal_org_id")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabaseClient
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

  if (supabase === null || !user?.email) {
    return (
      <main className="app-main">
        <section className="app-shell max-w-4xl">
          <div className="topbar">
            <div className="brand-lockup">
              <div className="brand-mark">DO</div>
              <div>
                <p className="text-sm font-black tracking-[-0.03em]">Diligence OS</p>
                <p className="text-xs text-[var(--muted)]">Financial intelligence workspace</p>
              </div>
            </div>
            <p className="rounded-full border border-[var(--line)] bg-white/50 px-3 py-1 text-xs font-black uppercase tracking-[0.18em] text-[var(--accent)]">
              Agency baseline
            </p>
          </div>

          <div className="hero-panel">
            <div className="hero-grid">
              <div>
                <p className="eyebrow">Diligence OS</p>
                <h1 className="hero-title">Research, resolve, and report from one controlled workspace.</h1>
                <p className="hero-copy">
                  Sign in to manage organizations, run company intelligence workflows, and generate
                  audit-ready financial reports.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                <div className="metric-card">
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">01</p>
                  <p className="mt-2 font-black">Resolve companies</p>
                </div>
                <div className="metric-card">
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">02</p>
                  <p className="mt-2 font-black">Run reports</p>
                </div>
                <div className="metric-card">
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">03</p>
                  <p className="mt-2 font-black">Track audit trail</p>
                </div>
              </div>
            </div>
          </div>
          {supabase === null ? (
            <p className="status-warn">
              Supabase auth is not configured yet. Add `NEXT_PUBLIC_SUPABASE_URL` and
              `NEXT_PUBLIC_SUPABASE_ANON_KEY` to `.env` or `.env.local` to enable sign-in and
              authenticated features.
            </p>
          ) : null}
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
    const { data: projectRows } = await supabaseClient
      .from("projects")
      .select("id, client_name, client_slug, created_at")
      .eq("org_id", activeOrg.id)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    projects = projectRows ?? [];

    let reportQuery = supabaseClient
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
    const { data: orgAuditRows } = await supabaseClient.rpc("get_org_audit_log", {
      p_project_id: null,
      p_limit: 100
    });
    orgAuditLog = ((orgAuditRows as AuditLogRow[] | null) ?? []).map((row) => ({
      ...row,
      cost: coerceNullableNumber(row.cost)
    }));

    if (activeOrg?.org_type === "agency" && params.projectId) {
      const { data: projectAuditRows } = await supabaseClient.rpc("get_org_audit_log", {
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
    const { data: costRows } = await supabaseClient.rpc("get_internal_cost_dashboard", {
      p_days: 30
    });
    costDashboard = ((costRows as CostDashboardRow[] | null) ?? []).map((row) => ({
      ...row,
      total_cost: coerceNullableNumber(row.total_cost) ?? 0,
      run_count: Number(row.run_count) || 0
    }));
  }

  return (
    <main className="app-main">
      <section className="app-shell">
        <div className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark">DO</div>
            <div>
              <p className="text-sm font-black tracking-[-0.03em]">Diligence OS</p>
              <p className="text-xs text-[var(--muted)]">Signed in as {user.email}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">
            <span className="rounded-full border border-[var(--line)] bg-white/50 px-3 py-1">
              {activeOrg?.org_type ?? "No org"}
            </span>
            <span className="rounded-full border border-[var(--line)] bg-white/50 px-3 py-1">
              {activeMembership?.role ?? "Unknown role"}
            </span>
          </div>
        </div>

        <div className="hero-panel">
          <div className="hero-grid">
            <div>
              <p className="eyebrow">Command center</p>
              <h1 className="hero-title">Agency intelligence without the spreadsheet sprawl.</h1>
              <p className="hero-copy">
                Resolve canonical companies, launch report workflows, and watch audit/cost signals from
                one operational dashboard.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <div className="metric-card">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">Projects</p>
                <p className="mt-2 text-3xl font-black tracking-[-0.06em]">{projects.length}</p>
              </div>
              <div className="metric-card">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">Reports</p>
                <p className="mt-2 text-3xl font-black tracking-[-0.06em]">{reports.length}</p>
              </div>
              <div className="metric-card">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">Review</p>
                <p className="mt-2 text-3xl font-black tracking-[-0.06em]">
                  {orgAuditLog.filter((row) => row.flagged_for_review).length}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
          <aside className="space-y-5 xl:sticky xl:top-28 xl:self-start">
            <AuthPanel
              memberships={authMemberships}
              userEmail={user.email}
              userId={user.id}
              activeOrgId={activeOrgId}
            />
            <CompanyResolverPanel />
          </aside>
          <div className="space-y-5">
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
          </div>
        </div>
      </section>
    </main>
  );
}
