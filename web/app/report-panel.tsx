"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase/browser";

type MePayload = {
  active_org_id: string;
  tier: string;
  quotas_remaining: {
    "reports.earnings_summary": number;
    "reports.due_diligence": number;
    "reports.lead_intel": number;
  };
  feature_flags: Record<string, boolean>;
};

export function ReportPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [me, setMe] = useState<MePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMe() {
    setLoading(true);
    setError(null);

    const { data, error: invokeError } = await supabase.functions.invoke("me", {
      method: "GET"
    });

    if (invokeError) {
      setLoading(false);
      setError(invokeError.message);
      return;
    }

    setMe(data as MePayload);
    setLoading(false);
  }

  async function runEarningsSummary() {
    setBusy(true);
    setError(null);
    setStatus(null);

    const { data, error: invokeError } = await supabase.functions.invoke("reports", {
      body: {
        company_id: "demo-company",
        report_type: "earnings_summary"
      }
    });

    if (invokeError) {
      const message = await parseFunctionError(invokeError);
      setError(message);
      setBusy(false);
      await loadMe();
      return;
    }

    setStatus(`Report accepted (${String((data as { mode?: string }).mode ?? "stream")}).`);
    setBusy(false);
    await loadMe();
  }

  const remaining = me?.quotas_remaining["reports.earnings_summary"] ?? 0;
  const showUpsell = !loading && remaining <= 0;

  return (
    <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/80 p-6">
      <h2 className="text-2xl font-semibold">Entitlements</h2>

      {loading ? <p className="text-sm text-slate-300">Loading entitlements…</p> : null}

      {me ? (
        <div className="space-y-2 text-sm text-slate-300">
          <p>Tier: {me.tier}</p>
          <p>Earnings summaries remaining: {remaining}</p>
          <p>Due diligence enabled: {String(me.feature_flags.due_diligence_enabled ?? false)}</p>
          <p>Lead intel enabled: {String(me.feature_flags.lead_intel_enabled ?? false)}</p>
        </div>
      ) : null}

      <button
        className="rounded-md bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-60"
        disabled={busy || loading}
        onClick={runEarningsSummary}
        type="button"
      >
        Run earnings summary
      </button>

      {showUpsell ? (
        <p className="rounded-md border border-amber-400/60 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Free-tier quota exhausted. Upgrade to continue running earnings summaries.
        </p>
      ) : null}

      {status ? <p className="text-sm text-emerald-400">{status}</p> : null}
      {error ? <p className="text-sm text-rose-400">{error}</p> : null}
    </section>
  );
}

async function parseFunctionError(error: unknown): Promise<string> {
  if (typeof error !== "object" || error === null) {
    return "Request failed.";
  }

  const maybeContext = (error as { context?: unknown }).context;
  if (maybeContext instanceof Response) {
    try {
      const payload = (await maybeContext.json()) as { error?: { message?: string } | string };
      if (typeof payload.error === "string") {
        return payload.error;
      }

      if (payload.error && typeof payload.error === "object" && payload.error.message) {
        return payload.error.message;
      }
    } catch {
      return `Request failed with status ${maybeContext.status}.`;
    }
  }

  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage === "string") {
    return maybeMessage;
  }

  return "Request failed.";
}
