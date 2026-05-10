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
  const supabaseEnv = useMemo(() => getSupabaseEnv(), []);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState(activeOrgId ?? "");

  const authConfigured = supabase !== null && supabaseEnv !== null;

  async function onMagicLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setError("Supabase auth is not configured.");
      return;
    }

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
    if (!supabase) {
      setError("Supabase auth is not configured.");
      return;
    }

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
    if (!supabase) {
      setError("Supabase auth is not configured.");
      return;
    }

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
    if (!userId || !nextOrgId || nextOrgId === selectedOrgId || !supabaseEnv || !supabase) {
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

    const { supabaseUrl, supabaseAnonKey } = supabaseEnv;
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
    <section className="section-card space-y-5">
      <div>
        <p className="eyebrow">Session</p>
        <h2 className="section-title">Authentication</h2>
      </div>
      {!authConfigured ? (
        <p className="status-warn">
          Supabase auth is not configured, so sign-in and org switching are disabled.
        </p>
      ) : null}
      {userEmail ? (
        <div className="space-y-4">
          <p className="rounded-2xl border border-[var(--line)] bg-white/50 px-4 py-3 text-sm font-semibold">
            Signed in as {userEmail}
          </p>
          <label className="block text-sm font-bold text-[var(--muted)]" htmlFor="active-org">
            Active organization
          </label>
          <select
            className="field"
            disabled={busy || memberships.length === 0 || !authConfigured}
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
            className="btn-quiet w-full"
            disabled={busy || !authConfigured}
            onClick={onSignOutClick}
            type="button"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <form className="space-y-3" onSubmit={onMagicLinkSubmit}>
            <label className="block text-sm font-bold text-[var(--muted)]" htmlFor="email">
              Email (magic link)
            </label>
            <input
              className="field"
              id="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
            <button
              className="btn-primary w-full"
              disabled={busy || !authConfigured}
              type="submit"
            >
              Send magic link
            </button>
          </form>

          <button
            className="btn-secondary w-full"
            disabled={busy || !authConfigured}
            onClick={onGoogleClick}
            type="button"
          >
            Continue with Google
          </button>
        </div>
      )}

      {status ? <p className="status-success">{status}</p> : null}
      {error ? <p className="status-error">{error}</p> : null}
    </section>
  );
}
