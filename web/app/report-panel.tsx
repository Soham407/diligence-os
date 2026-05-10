"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase/browser";
import { getSupabaseEnv } from "../lib/supabase/env";

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

type StreamUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export function ReportPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { supabaseUrl, supabaseAnonKey } = useMemo(() => getSupabaseEnv(), []);
  const [me, setMe] = useState<MePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [finalPayload, setFinalPayload] = useState<Record<string, unknown> | null>(null);
  const [latestReportId, setLatestReportId] = useState<string | null>(null);
  const [usage, setUsage] = useState<StreamUsage>({ inputTokens: null, outputTokens: null });

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
    const trimmedCompanyId = companyId.trim();
    if (!trimmedCompanyId) {
      setError("Enter a company UUID first.");
      return;
    }

    setBusy(true);
    setError(null);
    setStatus("Starting earnings summary stream...");
    setTrail([]);
    setFinalPayload(null);
    setLatestReportId(null);
    setUsage({ inputTokens: null, outputTokens: null });

    const {
      data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      setBusy(false);
      setError("No active session token available.");
      return;
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/reports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey
      },
      body: JSON.stringify({
        company_id: trimmedCompanyId,
        report_type: "earnings_summary"
      })
    });

    if (!response.ok) {
      const message = await parseFetchError(response);
      setError(message);
      setBusy(false);
      await loadMe();
      return;
    }

    if (!response.body) {
      setError("Streaming response body was empty.");
      setBusy(false);
      await loadMe();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let activeToolIndex: number | null = null;
    let partialToolInput = "";
    let parsedFinalPayload: Record<string, unknown> | null = null;

    const appendTrail = (line: string) => {
      setTrail((current) => [...current, line]);
    };

    const handleBlock = (rawBlock: string) => {
      const lines = rawBlock.split("\n");
      let eventName = "message";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }

      const data = dataLines.join("\n");
      if (!data || data === "[DONE]") {
        return;
      }

      try {
        const parsed = JSON.parse(data) as {
          type?: string;
          index?: number;
          delta?: { type?: string; text?: string; partial_json?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          content_block?: { type?: string; name?: string; input?: Record<string, unknown> };
        };

        const textDelta = parsed.delta?.type === "text_delta" ? parsed.delta.text : null;
        if (typeof textDelta === "string" && textDelta.trim().length > 0) {
          appendTrail(textDelta);
        }

        if (parsed.type === "content_block_start") {
          if (
            parsed.content_block?.type === "tool_use" &&
            parsed.content_block?.name === "submit_earnings_summary"
          ) {
            activeToolIndex = typeof parsed.index === "number" ? parsed.index : null;
            partialToolInput = "";
            appendTrail("[tool] assembling submit_earnings_summary payload");

            if (parsed.content_block.input && typeof parsed.content_block.input === "object") {
              parsedFinalPayload = parsed.content_block.input;
            }
          }
        }

        if (
          parsed.type === "content_block_delta" &&
          activeToolIndex !== null &&
          parsed.index === activeToolIndex &&
          parsed.delta?.type === "input_json_delta"
        ) {
          partialToolInput += parsed.delta.partial_json ?? "";
        }

        if (parsed.type === "content_block_stop" && activeToolIndex !== null && parsed.index === activeToolIndex) {
          try {
            const candidate = JSON.parse(partialToolInput);
            if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
              parsedFinalPayload = candidate as Record<string, unknown>;
            }
          } catch {
            // ignore malformed partial JSON and rely on DB payload lookup after stream end
          }
        }

        const usagePayload = parsed.usage ?? parsed.message?.usage;
        if (usagePayload) {
          setUsage((current) => ({
            inputTokens:
              typeof usagePayload.input_tokens === "number"
                ? usagePayload.input_tokens
                : current.inputTokens,
            outputTokens:
              typeof usagePayload.output_tokens === "number"
                ? usagePayload.output_tokens
                : current.outputTokens
          }));
        }
      } catch {
        appendTrail(`[${eventName}] ${data}`);
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        if (value) {
          buffer += decoder.decode(value, { stream: true }).replaceAll("\r", "");

          while (true) {
            const delimiterIndex = buffer.indexOf("\n\n");
            if (delimiterIndex < 0) {
              break;
            }

            const block = buffer.slice(0, delimiterIndex);
            buffer = buffer.slice(delimiterIndex + 2);
            handleBlock(block);
          }
        }
      }

      buffer += decoder.decode().replaceAll("\r", "");
      if (buffer.trim().length > 0) {
        handleBlock(buffer);
      }
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "Stream interrupted.");
      setBusy(false);
      await loadMe();
      return;
    } finally {
      reader.releaseLock();
    }

    if (parsedFinalPayload) {
      setFinalPayload(parsedFinalPayload);
    }

    const { data: reportRow } = await supabase
      .from("reports")
      .select("id, payload")
      .eq("company_id", trimmedCompanyId)
      .eq("report_type", "earnings_summary")
      .eq("status", "succeeded")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (reportRow?.id) {
      setLatestReportId(reportRow.id);
      if (!parsedFinalPayload && reportRow.payload && typeof reportRow.payload === "object") {
        setFinalPayload(reportRow.payload as Record<string, unknown>);
      }
      setStatus(`Stream finished. Report persisted: ${reportRow.id}`);
    } else {
      setStatus("Stream finished. Waiting for persisted report row...");
    }

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

      <div className="space-y-2">
        <label className="block text-sm text-slate-300" htmlFor="earnings-company-id">
          Company UUID
        </label>
        <input
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-slate-400 focus:ring-2"
          disabled={busy || loading}
          id="earnings-company-id"
          onChange={(event) => setCompanyId(event.target.value)}
          placeholder="Paste listed company UUID"
          type="text"
          value={companyId}
        />
      </div>

      <button
        className="rounded-md bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-60"
        disabled={busy || loading}
        onClick={runEarningsSummary}
        type="button"
      >
        Run earnings summary (stream)
      </button>

      {showUpsell ? (
        <p className="rounded-md border border-amber-400/60 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Free-tier quota exhausted. Upgrade to continue running earnings summaries.
        </p>
      ) : null}

      {status ? <p className="text-sm text-emerald-400">{status}</p> : null}
      {error ? <p className="text-sm text-rose-400">{error}</p> : null}

      {trail.length > 0 ? (
        <div className="space-y-2 rounded-md border border-slate-800 bg-slate-950/80 p-3">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Streaming trail</p>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-sm text-slate-200">
            {trail.join("")}
          </pre>
        </div>
      ) : null}

      {latestReportId ? (
        <p className="text-sm text-slate-300">Latest persisted report: {latestReportId}</p>
      ) : null}

      {usage.inputTokens !== null || usage.outputTokens !== null ? (
        <p className="text-sm text-slate-300">
          Tokens: in {usage.inputTokens ?? "-"} · out {usage.outputTokens ?? "-"}
        </p>
      ) : null}

      {finalPayload ? (
        <div className="space-y-2 rounded-md border border-slate-800 bg-slate-950/80 p-3">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Final payload</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-slate-200">
            {JSON.stringify(finalPayload, null, 2)}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

async function parseFetchError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } | string };
    if (typeof payload.error === "string") {
      return payload.error;
    }

    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return payload.error.message;
    }
  } catch {
    return `Request failed with status ${response.status}.`;
  }

  return `Request failed with status ${response.status}.`;
}
