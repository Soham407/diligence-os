"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase/browser";
import { getSupabaseEnv } from "../lib/supabase/env";

type PrimarySecurity = {
  id: string;
  isin: string;
  security_type: string | null;
  nse_symbol: string | null;
  bse_code: string | null;
  is_primary: boolean;
};

type CanonicalCompany = {
  id: string;
  legal_name: string;
  display_name: string;
  sector: string | null;
  listing_status: string | null;
  primary_security: PrimarySecurity | null;
};

export function CompanyResolverPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const supabaseEnv = useMemo(() => getSupabaseEnv(), []);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [company, setCompany] = useState<CanonicalCompany | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const authConfigured = supabase !== null && supabaseEnv !== null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authConfigured || !supabase || !supabaseEnv) {
      setError("Supabase auth is not configured.");
      return;
    }

    setBusy(true);
    setError(null);
    setSubmitted(false);

    const {
      data: { session },
      error: sessionError
    } = await supabase.auth.getSession();

    if (sessionError || !session?.access_token) {
      setBusy(false);
      setError("You must be signed in to resolve companies.");
      return;
    }

    const { supabaseUrl, supabaseAnonKey } = supabaseEnv;

    const response = await fetch(`${supabaseUrl}/functions/v1/companies/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });

    const payload = (await response.json()) as { error?: string; company?: CanonicalCompany | null };

    if (!response.ok) {
      setBusy(false);
      setCompany(null);
      setError(payload.error ?? "Company resolver request failed.");
      return;
    }

    setBusy(false);
    setSubmitted(true);
    setCompany(payload.company ?? null);
  }

  return (
    <section className="section-card space-y-4">
      <div>
        <p className="eyebrow">Entity graph</p>
        <h2 className="section-title">Company Resolver</h2>
        <p className="section-subtitle">Resolve ticker/name/CIN/ISIN into canonical company metadata.</p>
      </div>
      {!authConfigured ? (
        <p className="status-warn">
          Supabase auth is not configured, so resolver lookup is disabled.
        </p>
      ) : null}

      <form className="flex flex-col gap-3 md:flex-row" onSubmit={onSubmit}>
        <input
          className="field flex-1"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try ALPHA, 532100, INELOTUS00029, or company name"
          required
          value={query}
        />
        <button
          className="btn-primary"
          disabled={busy || !authConfigured}
          type="submit"
        >
          Resolve
        </button>
      </form>

      {submitted && !company ? <p className="status-warn">No canonical company match found.</p> : null}

      {company ? (
        <div className="space-y-2 rounded-2xl border border-[var(--line)] bg-white/55 p-4 text-sm">
          <p>
            <span className="font-bold text-[var(--muted)]">Company ID:</span> {company.id}
          </p>
          <p>
            <span className="font-bold text-[var(--muted)]">Legal Name:</span> {company.legal_name}
          </p>
          <p>
            <span className="font-bold text-[var(--muted)]">Display Name:</span> {company.display_name}
          </p>
          <p>
            <span className="font-bold text-[var(--muted)]">Sector:</span> {company.sector ?? "-"}
          </p>
          <p>
            <span className="font-bold text-[var(--muted)]">Listing Status:</span>{" "}
            {company.listing_status ?? "-"}
          </p>
          <p>
            <span className="font-bold text-[var(--muted)]">Primary Security:</span>{" "}
            {company.primary_security
              ? `${company.primary_security.isin} | NSE ${company.primary_security.nse_symbol ?? "-"} | BSE ${company.primary_security.bse_code ?? "-"}`
              : "-"}
          </p>
        </div>
      ) : null}

      {error ? <p className="status-error">{error}</p> : null}
    </section>
  );
}
