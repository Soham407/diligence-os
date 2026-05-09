import { AuthPanel } from "./auth-panel";
import { ReportPanel } from "./report-panel";
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
        <h1 className="text-4xl font-semibold leading-tight md:text-5xl">Entitlements + Tier Gating</h1>
        <p className="text-lg text-slate-300">
          Server-side entitlement checks gate report endpoints. Client-side state mirrors `/me` for UX-only
          upsell.
        </p>
        <AuthPanel userEmail={user?.email ?? null} />
        {user ? <ReportPanel /> : null}
      </section>
    </main>
  );
}
