"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase/browser";
import { getSupabaseEnv } from "../lib/supabase/env";

type AuthPanelProps = {
  userEmail: string | null;
  userId: string | null;
  activeOrgId: string | null;
  memberships: Array<{
    orgId: string;
    orgName: string;
    orgType: string;
    role: string;
  }>;
};

export function AuthPanel({ userEmail, userId, activeOrgId, memberships }: AuthPanelProps) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { supabaseUrl, supabaseAnonKey } = useMemo(() => getSupabaseEnv(), []);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState(activeOrgId ?? "");

  async function onMagicLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);

    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo }
    });

    setBusy(false);

    if (signInError) {
      setError(signInError.message);
      return;
    }

    setStatus("Magic link sent. Check your inbox to complete sign-in.");
  }

  async function onGoogleClick() {
    setBusy(true);
    setError(null);
    const redirectTo = `${window.location.origin}/auth/callback`;

    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo }
    });

    if (signInError) {
      setBusy(false);
      setError(signInError.message);
    }
  }

  async function onSignOutClick() {
    setBusy(true);
    setError(null);

    const { error: signOutError } = await supabase.auth.signOut();
    setBusy(false);

    if (signOutError) {
      setError(signOutError.message);
      return;
    }

    window.location.reload();
  }

  async function onSwitchOrg(nextOrgId: string) {
    if (!userId || !nextOrgId || nextOrgId === selectedOrgId) {
      return;
    }

    setBusy(true);
    setStatus(null);
    setError(null);

    const {
      data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      setBusy(false);
      setError("No active session available for org switch.");
      return;
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/orgs/switch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey
      },
      body: JSON.stringify({ org_id: nextOrgId })
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setBusy(false);
      setError(body.error ?? "Failed to switch org.");
      return;
    }

    const { error: refreshError } = await supabase.auth.refreshSession();
    setBusy(false);

    if (refreshError) {
      setError(refreshError.message);
      return;
    }

    setSelectedOrgId(nextOrgId);
    setStatus("Active organization switched.");
    window.location.reload();
  }

  return (
    <section className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/80 p-6">
      <h2 className="text-2xl font-semibold">Authentication</h2>
      {userEmail ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-300">Signed in as {userEmail}</p>
          <label className="block text-sm text-slate-300" htmlFor="active-org">
            Active organization
          </label>
          <select
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-slate-400 focus:ring-2"
            disabled={busy || memberships.length === 0}
            id="active-org"
            onChange={(event) => {
              void onSwitchOrg(event.target.value);
            }}
            value={selectedOrgId}
          >
            {selectedOrgId === "" ? (
              <option disabled value="">
                Select an organization
              </option>
            ) : null}
            {memberships.map((membership) => (
              <option key={membership.orgId} value={membership.orgId}>
                {membership.orgName} ({membership.orgType}, {membership.role})
              </option>
            ))}
          </select>
          <button
            className="rounded-md bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-60"
            disabled={busy}
            onClick={onSignOutClick}
            type="button"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <form className="space-y-3" onSubmit={onMagicLinkSubmit}>
            <label className="block text-sm text-slate-300" htmlFor="email">
              Email (magic link)
            </label>
            <input
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-slate-400 focus:ring-2"
              id="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
            <button
              className="rounded-md bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-60"
              disabled={busy}
              type="submit"
            >
              Send magic link
            </button>
          </form>

          <button
            className="rounded-md border border-slate-500 px-4 py-2 text-sm font-semibold text-slate-100 disabled:opacity-60"
            disabled={busy}
            onClick={onGoogleClick}
            type="button"
          >
            Continue with Google
          </button>
        </div>
      )}

      {status ? <p className="text-sm text-emerald-400">{status}</p> : null}
      {error ? <p className="text-sm text-rose-400">{error}</p> : null}
    </section>
  );
}
