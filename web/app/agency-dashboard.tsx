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

type AgencyDashboardProps = {
  userEmail: string;
  activeOrg: Organization | null;
  organizations: Organization[];
  projects: Project[];
  reports: ReportRow[];
  selectedProjectId: string | null;
};

export function AgencyDashboard({
  userEmail,
  activeOrg,
  organizations,
  projects,
  reports,
  selectedProjectId
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

  async function onCreateOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <section className="mx-auto max-w-5xl space-y-6">
        <div className="space-y-1">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Diligence OS</p>
          <h1 className="text-3xl font-semibold">Agency Dashboard</h1>
          <p className="text-sm text-slate-300">Signed in as {userEmail}</p>
        </div>

        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-5">
          <h2 className="text-xl font-semibold">Create Organization</h2>
          <p className="mt-1 text-sm text-slate-300">Includes Agency-tier plans (`org_type='agency'`).</p>
          <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={onCreateOrganization}>
            <input
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2"
              onChange={(event) => setOrgName(event.target.value)}
              placeholder="Organization name"
              required
              value={orgName}
            />
            <select
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2"
              onChange={(event) => setOrgPlan(event.target.value)}
              value={orgPlan}
            >
              <option value="agency_basic">Agency Basic</option>
              <option value="agency_pro">Agency Pro</option>
              <option value="b2b_basic">B2B Basic</option>
            </select>
            <input
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2"
              onChange={(event) => setBillingEmail(event.target.value)}
              placeholder="Billing email"
              type="email"
              value={billingEmail}
            />
            <input
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2"
              onChange={(event) => setGstin(event.target.value)}
              placeholder="GSTIN"
              value={gstin}
            />
            <button
              className="rounded-md bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-60"
              disabled={busy}
              type="submit"
            >
              Create Organization
            </button>
          </form>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-5">
          <h2 className="text-xl font-semibold">Active Organization</h2>
          <p className="mt-2 text-sm text-slate-300">
            {activeOrg
              ? `${activeOrg.name} (${activeOrg.org_type}, ${activeOrg.plan})`
              : "No active organization claim found."}
          </p>
          <p className="mt-2 text-xs text-slate-400">Available orgs: {organizations.length}</p>
        </section>

        {isAgency ? (
          <section className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/80 p-5">
            <h2 className="text-xl font-semibold">Agency Projects</h2>

            <div className="space-y-2">
              <label className="text-sm text-slate-300" htmlFor="project-switcher">
                Project switcher
              </label>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2"
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
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2"
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Client name"
                required
                value={projectName}
              />
              <input
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2"
                onChange={(event) => setProjectSlug(event.target.value)}
                placeholder="client-slug"
                required
                value={projectSlug}
              />
              <button
                className="rounded-md bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-60"
                disabled={busy}
                type="submit"
              >
                Create Project
              </button>
            </form>

            <form className="grid gap-3 md:grid-cols-3" onSubmit={onRunLeadIntel}>
              <input
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 md:col-span-2"
                onChange={(event) => setCompanyId(event.target.value)}
                placeholder="Company UUID for lead intel run"
                required
                value={companyId}
              />
              <button
                className="rounded-md border border-slate-500 px-4 py-2 text-sm font-semibold disabled:opacity-60"
                disabled={busy || !selectedProjectId}
                type="submit"
              >
                Run Lead Intel
              </button>
            </form>
            <p className="text-xs text-slate-400">
              Lead Intel runs are project-scoped and filtered by `project_id`.
            </p>

            <div className="space-y-2">
              <h3 className="text-lg font-semibold">Reports</h3>
              {reports.length === 0 ? (
                <p className="text-sm text-slate-300">No reports in this filter.</p>
              ) : (
                <ul className="space-y-2 text-sm text-slate-200">
                  {reports.map((report) => (
                    <li className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2" key={report.id}>
                      <span className="font-mono text-xs text-slate-400">{report.id}</span>
                      <p>
                        {report.report_type} · {report.status} · project {report.project_id ?? "none"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-5">
            <h2 className="text-xl font-semibold">Agency View</h2>
            <p className="text-sm text-slate-300">
              Switch to an agency org session to view project switcher and project-scoped reports.
            </p>
          </section>
        )}

        {status ? <p className="text-sm text-emerald-400">{status}</p> : null}
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
      </section>
    </main>
  );
}
