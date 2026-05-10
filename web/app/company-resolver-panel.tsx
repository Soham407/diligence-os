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
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [company, setCompany] = useState<CanonicalCompany | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

    const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();

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
    <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/80 p-6">
      <h2 className="text-2xl font-semibold">Company Resolver</h2>
      <p className="text-sm text-slate-300">Resolve ticker/name/CIN/ISIN into canonical company metadata.</p>

      <form className="flex flex-col gap-3 md:flex-row" onSubmit={onSubmit}>
        <input
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try ALPHA, 532100, INELOTUS00029, or company name"
          required
          value={query}
        />
        <button
          className="rounded-md bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-60"
          disabled={busy}
          type="submit"
        >
          Resolve
        </button>
      </form>

      {submitted && !company ? <p className="text-sm text-amber-200">No canonical company match found.</p> : null}

      {company ? (
        <div className="space-y-2 rounded-md border border-slate-700 bg-slate-950/70 p-4 text-sm text-slate-200">
          <p>
            <span className="text-slate-400">Company ID:</span> {company.id}
          </p>
          <p>
            <span className="text-slate-400">Legal Name:</span> {company.legal_name}
          </p>
          <p>
            <span className="text-slate-400">Display Name:</span> {company.display_name}
          </p>
          <p>
            <span className="text-slate-400">Sector:</span> {company.sector ?? "-"}
          </p>
          <p>
            <span className="text-slate-400">Listing Status:</span> {company.listing_status ?? "-"}
          </p>
          <p>
            <span className="text-slate-400">Primary Security:</span>{" "}
            {company.primary_security
              ? `${company.primary_security.isin} | NSE ${company.primary_security.nse_symbol ?? "-"} | BSE ${company.primary_security.bse_code ?? "-"}`
              : "-"}
          </p>
        </div>
      ) : null}

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}
    </section>
  );
}
