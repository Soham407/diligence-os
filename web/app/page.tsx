import { AuthPanel } from "./auth-panel";
import { AgencyDashboard } from "./agency-dashboard";
import { createSupabaseServerClient } from "../lib/supabase/server";

type SearchParams = {
  projectId?: string;
};

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

  if (!user?.email) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-20 text-slate-100">
        <section className="mx-auto max-w-3xl space-y-6">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Diligence OS</p>
          <h1 className="text-4xl font-semibold leading-tight md:text-5xl">Agency Tier Baseline</h1>
          <p className="text-lg text-slate-300">Sign in to create orgs, projects, and lead-intel reports.</p>
          <AuthPanel userEmail={null} />
        </section>
      </main>
    );
  }

  const { data: activeOrgId } = await supabase.rpc("current_active_org");

  const { data: memberships } = await supabase
    .from("org_members")
    .select("organizations(id,name,org_type,plan)")
    .eq("user_id", user.id);

  const organizations = (memberships ?? [])
    .flatMap((membership) =>
      Array.isArray(membership.organizations) ? membership.organizations : []
    )
    .filter(
      (organization): organization is { id: string; name: string; org_type: string; plan: string } =>
        Boolean(
          organization &&
            typeof organization.id === "string" &&
            typeof organization.name === "string" &&
            typeof organization.org_type === "string" &&
            typeof organization.plan === "string"
        )
    );

  const activeOrg = organizations.find((organization) => organization.id === activeOrgId) ?? null;

  let projects: Array<{ id: string; client_name: string; client_slug: string; created_at: string }> = [];
  let reports: Array<{
    id: string;
    report_type: string;
    project_id: string | null;
    status: string;
    created_at: string;
  }> = [];

  if (activeOrg?.org_type === "agency") {
    const { data: projectRows } = await supabase
      .from("projects")
      .select("id, client_name, client_slug, created_at")
      .eq("org_id", activeOrg.id)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    projects = projectRows ?? [];

    const selectedProjectId = params.projectId;
    let reportQuery = supabase
      .from("reports")
      .select("id, report_type, project_id, status, created_at")
      .eq("org_id", activeOrg.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (selectedProjectId) {
      reportQuery = reportQuery.eq("project_id", selectedProjectId);
    }

    const { data: reportRows } = await reportQuery;
    reports = reportRows ?? [];
  }

  return (
    <AgencyDashboard
      activeOrg={activeOrg}
      organizations={organizations}
      projects={projects}
      reports={reports}
      selectedProjectId={params.projectId ?? null}
      userEmail={user.email}
    />
  );
}
