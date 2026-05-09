"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase/browser";

type AuthPanelProps = {
  userEmail: string | null;
};

export function AuthPanel({ userEmail }: AuthPanelProps) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/80 p-6">
      <h2 className="text-2xl font-semibold">Authentication</h2>
      {userEmail ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-300">Signed in as {userEmail}</p>
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
