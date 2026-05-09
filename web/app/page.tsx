import { AuthPanel } from "./auth-panel";
import { createSupabaseServerClient } from "../lib/supabase/server";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-20 text-slate-100">
      <section className="mx-auto max-w-3xl space-y-6">
        <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Diligence OS</p>
        <h1 className="text-4xl font-semibold leading-tight md:text-5xl">
          Supabase Auth Foundation
        </h1>
        <p className="text-lg text-slate-300">
          Sign in with email magic link or Google OAuth to validate the auth baseline.
        </p>
        <AuthPanel userEmail={user?.email ?? null} />
      </section>
    </main>
  );
}
