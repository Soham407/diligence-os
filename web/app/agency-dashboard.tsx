"use client";

import { FormEvent, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "../lib/supabase/browser";

type Organization = {
  id: string;
  name: string;
  org_type: string;
  plan: string;
};

type Project = {
  id: string;
  client_name: string;
  client_slug: string;
  created_at: string;
};

type ReportRow = {
  id: string;
  report_type: string;
  project_id: string | null;
  status: string;
  created_at: string;
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

type AgencyDashboardProps = {
  userEmail: string;
  activeOrg: Organization | null;
  activeOrgRole: string | null;
  isPlatformAdmin: boolean;
  organizations: Organization[];
  projects: Project[];
  reports: ReportRow[];
  selectedProjectId: string | null;
  costDashboard: CostDashboardRow[];
  orgAuditLog: AuditLogRow[];
  projectAuditLog: AuditLogRow[];
};

export function AgencyDashboard({
  userEmail,
  activeOrg,
  activeOrgRole,
  isPlatformAdmin,
  organizations,
  projects,
  reports,
  selectedProjectId,
  costDashboard,
  orgAuditLog,
  projectAuditLog
}: AgencyDashboardProps) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [busy, setBusy] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [orgPlan, setOrgPlan] = useState("agency_basic");
  const [billingEmail, setBillingEmail] = useState("");
  const [gstin, setGstin] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authConfigured = supabase !== null;

  async function onCreateOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setError("Supabase auth is not configured.");
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);

    const { data, error: rpcError } = await supabase.rpc("create_organization", {
      p_name: orgName,
      p_plan: orgPlan,
      p_billing_email: billingEmail || null,
      p_gstin: gstin || null
    });

    setBusy(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setStatus(`Organization created: ${data?.name ?? orgName}. Re-login to refresh active org JWT claim.`);
    setOrgName("");
    setBillingEmail("");
    setGstin("");
    router.refresh();
  }

  async function onCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setError("Supabase auth is not configured.");
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);

    const { data, error: fnError } = await supabase.functions.invoke("projects", {
      body: {
        client_name: projectName,
        client_slug: projectSlug,
        white_label_config: {}
      }
    });

    setBusy(false);

    if (fnError) {
      setError(fnError.message);
      return;
    }

    if (data?.error) {
      setError(data.error);
      return;
    }

    setStatus(`Project created: ${projectName}`);
    setProjectName("");
    setProjectSlug("");
    router.refresh();
  }

  async function onRunLeadIntel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setError("Supabase auth is not configured.");
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);

    const { data, error: fnError } = await supabase.functions.invoke("reports", {
      body: {
        company_id: companyId,
        report_type: "lead_intel",
        project_id: selectedProjectId,
        custom_sources: []
      }
    });

    setBusy(false);

    if (fnError) {
      setError(fnError.message);
      return;
    }

    if (data?.error) {
      setError(data.error);
      return;
    }

    setStatus(`Lead Intel report created: ${data?.report?.id ?? "ok"}`);
    setCompanyId("");
    router.refresh();
  }

  function onProjectChange(newProjectId: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (newProjectId) {
      next.set("projectId", newProjectId);
    } else {
      next.delete("projectId");
    }

    router.push(`${pathname}?${next.toString()}`);
  }

  const isAgency = activeOrg?.org_type === "agency";
  const isOrgAdmin = activeOrgRole === "admin";
  const flaggedQueue = orgAuditLog.filter((row) => row.flagged_for_review);
  const projectFlaggedQueue = projectAuditLog.filter((row) => row.flagged_for_review);

  return (
    <section className="space-y-5">
        <div className="section-card-strong">
          <p className="eyebrow">Workspace</p>
          <h2 className="section-title">Agency Dashboard</h2>
          <p className="section-subtitle">Signed in as {userEmail}</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="metric-card">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">Organizations</p>
              <p className="mt-2 text-3xl font-black tracking-[-0.06em]">{organizations.length}</p>
            </div>
            <div className="metric-card">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">Active role</p>
              <p className="mt-2 text-lg font-black">{activeOrgRole ?? "unknown"}</p>
            </div>
            <div className="metric-card">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">Plan</p>
              <p className="mt-2 text-lg font-black">{activeOrg?.plan ?? "none"}</p>
            </div>
          </div>
        </div>

        <section className="section-card space-y-4">
          <div>
            <p className="eyebrow">Admin</p>
            <h2 className="section-title">Create Organization</h2>
            <p className="section-subtitle">Includes Agency-tier plans (`org_type='agency'`).</p>
          </div>
          {!authConfigured ? (
            <p className="status-warn">
              Supabase auth is not configured, so agency actions are disabled.
            </p>
          ) : null}
          <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={onCreateOrganization}>
            <input
              className="field"
              onChange={(event) => setOrgName(event.target.value)}
              placeholder="Organization name"
              required
              value={orgName}
            />
            <select
              className="field"
              onChange={(event) => setOrgPlan(event.target.value)}
              value={orgPlan}
            >
              <option value="agency_basic">Agency Basic</option>
              <option value="agency_pro">Agency Pro</option>
              <option value="b2b_basic">B2B Basic</option>
            </select>
            <input
              className="field"
              onChange={(event) => setBillingEmail(event.target.value)}
              placeholder="Billing email"
              type="email"
              value={billingEmail}
            />
            <input
              className="field"
              onChange={(event) => setGstin(event.target.value)}
              placeholder="GSTIN"
              value={gstin}
            />
            <button
              className="btn-primary"
              disabled={busy || !authConfigured}
              type="submit"
            >
              Create Organization
            </button>
          </form>
        </section>

        <section className="section-card">
          <p className="eyebrow">Current scope</p>
          <h2 className="section-title">Active Organization</h2>
          <p className="mt-3 text-sm font-semibold">
            {activeOrg
              ? `${activeOrg.name} (${activeOrg.org_type}, ${activeOrg.plan})`
              : "No active organization claim found."}
          </p>
          <p className="mt-2 text-xs font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
            Active role: {activeOrgRole ?? "unknown"} · Available orgs: {organizations.length}
          </p>
        </section>

        {isPlatformAdmin ? (
          <section className="section-card space-y-4">
            <div>
              <p className="eyebrow">Platform admin</p>
              <h2 className="section-title">Operator Cost Dashboard</h2>
              <p className="section-subtitle">Grouped by `agent_id`, `org_type`, and UTC day.</p>
            </div>
            {costDashboard.length === 0 ? (
              <p className="section-subtitle">No cost rows for the selected window.</p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-[var(--line)] bg-white/50">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                    <tr>
                      <th className="px-2 py-2">Day (UTC)</th>
                      <th className="px-2 py-2">Agent</th>
                      <th className="px-2 py-2">Org type</th>
                      <th className="px-2 py-2">Runs</th>
                      <th className="px-2 py-2">Cost (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costDashboard.map((row) => (
                      <tr className="border-t border-[var(--line)]" key={`${row.day}-${row.agent_id}-${row.org_type}`}>
                        <td className="px-3 py-2">{row.day}</td>
                        <td className="px-3 py-2">{row.agent_id}</td>
                        <td className="px-3 py-2">{row.org_type}</td>
                        <td className="px-3 py-2">{row.run_count}</td>
                        <td className="px-3 py-2">${row.total_cost.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        {isOrgAdmin ? (
          <section className="section-card space-y-4">
            <div>
              <p className="eyebrow">Governance</p>
              <h2 className="section-title">Organization Audit Log</h2>
              <p className="section-subtitle">Scrapes and agent runs with timestamps, source URLs, and costs.</p>
            </div>
            {orgAuditLog.length === 0 ? (
              <p className="section-subtitle">No audit events available for this organization.</p>
            ) : (
              <ul className="space-y-2">
                {orgAuditLog.map((event) => (
                  <li className="data-list-item" key={event.id}>
                    <p className="font-mono text-xs text-[var(--muted)]">{event.created_at}</p>
                    <p>
                      {event.kind} · report {event.report_type ?? "n/a"} · project {event.project_id ?? "none"}
                    </p>
                    <p className="text-xs text-[var(--muted)]">
                      source {event.source_url ?? "n/a"} · agent {event.agent_id ?? "n/a"} · cost{" "}
                      {event.cost === null ? "n/a" : `$${event.cost.toFixed(4)}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <div className="status-warn space-y-2">
              <h3 className="text-sm font-black">Flagged Review Queue</h3>
              {flaggedQueue.length === 0 ? (
                <p>No `citation_verification_failed` rows.</p>
              ) : (
                <ul className="space-y-2">
                  {flaggedQueue.map((event) => (
                    <li key={event.id}>
                      {event.created_at} · project {event.project_id ?? "none"} · report {event.report_type ?? "n/a"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}

        {isAgency ? (
          <section className="section-card-strong space-y-5">
            <div>
              <p className="eyebrow">Client workbench</p>
              <h2 className="section-title">Agency Projects</h2>
              <p className="section-subtitle">
                Create scoped projects, run lead-intel jobs, and filter reports by client.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--muted)]" htmlFor="project-switcher">
                Project switcher
              </label>
              <select
                className="field"
                id="project-switcher"
                onChange={(event) => onProjectChange(event.target.value)}
                value={selectedProjectId ?? ""}
              >
                <option value="">All agency reports</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.client_name} ({project.client_slug})
                  </option>
                ))}
              </select>
            </div>

            <form className="grid gap-3 md:grid-cols-3" onSubmit={onCreateProject}>
              <input
                className="field"
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Client name"
                required
                value={projectName}
              />
              <input
                className="field"
                onChange={(event) => setProjectSlug(event.target.value)}
                placeholder="client-slug"
                required
                value={projectSlug}
              />
              <button
                className="btn-primary"
                disabled={busy || !authConfigured}
                type="submit"
              >
                Create Project
              </button>
            </form>

            <form className="grid gap-3 md:grid-cols-3" onSubmit={onRunLeadIntel}>
              <input
                className="field md:col-span-2"
                onChange={(event) => setCompanyId(event.target.value)}
                placeholder="Company UUID for lead intel run"
                required
                value={companyId}
              />
              <button
                className="btn-secondary"
                disabled={busy || !selectedProjectId || !authConfigured}
                type="submit"
              >
                Run Lead Intel
              </button>
            </form>
            <p className="text-xs font-semibold text-[var(--muted)]">
              Lead Intel runs are project-scoped and filtered by `project_id`.
            </p>

            <div className="space-y-2">
              <h3 className="text-lg font-black tracking-[-0.03em]">Reports</h3>
              {reports.length === 0 ? (
                <p className="section-subtitle">No reports in this filter.</p>
              ) : (
                <ul className="grid gap-2 md:grid-cols-2">
                  {reports.map((report) => (
                    <li className="data-list-item" key={report.id}>
                      <span className="font-mono text-xs text-[var(--muted)]">{report.id}</span>
                      <p className="font-semibold">
                        {report.report_type} · {report.status} · project {report.project_id ?? "none"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {isOrgAdmin ? (
              <div className="space-y-3 rounded-3xl border border-[var(--line)] bg-white/45 p-4">
                <h3 className="text-lg font-black tracking-[-0.03em]">Project Audit Log</h3>
                <p className="section-subtitle">Filtered by current `project_id` selection.</p>
                {!selectedProjectId ? (
                  <p className="section-subtitle">Select a project to load project-scoped audit events.</p>
                ) : projectAuditLog.length === 0 ? (
                  <p className="section-subtitle">No audit events in this project.</p>
                ) : (
                  <ul className="space-y-2">
                    {projectAuditLog.map((event) => (
                      <li className="data-list-item" key={event.id}>
                        <p className="font-mono text-xs text-[var(--muted)]">{event.created_at}</p>
                        <p className="font-semibold">
                          {event.kind} · report {event.report_type ?? "n/a"} · cost{" "}
                          {event.cost === null ? "n/a" : `$${event.cost.toFixed(4)}`}
                        </p>
                        <p className="text-xs text-[var(--muted)]">
                          source {event.source_url ?? "n/a"} · agent {event.agent_id ?? "n/a"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {selectedProjectId ? (
                  <div className="status-warn space-y-1">
                    <p className="text-xs font-black uppercase tracking-[0.12em]">
                      Project Review Queue
                    </p>
                    {projectFlaggedQueue.length === 0 ? (
                      <p>No flagged citation verification failures.</p>
                    ) : (
                      <ul className="space-y-1">
                        {projectFlaggedQueue.map((event) => (
                          <li key={event.id}>{event.created_at} · {event.id}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : (
          <section className="section-card">
            <p className="eyebrow">Client workbench</p>
            <h2 className="section-title">Agency View</h2>
            <p className="section-subtitle">
              Switch to an agency org session to view project switcher and project-scoped reports.
            </p>
          </section>
        )}

        {status ? <p className="status-success">{status}</p> : null}
        {error ? <p className="status-error">{error}</p> : null}
      </section>
  );
}
