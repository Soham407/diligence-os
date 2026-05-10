import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { DocumentCache, type CachedDocument, type GetOrFetchOptions, type ScrapeResult, type SourceKind } from "./document-cache.ts";

const ONE_HOUR_MS = 60 * 60 * 1000;
const GROQ_MODEL = "llama3-70b-8192";

type SourceIngestorDeps = {
  documentCache: DocumentCache;
  ttlMs: number;
};

type FetchSourcesInput = {
  company_id: string;
  kind: SourceKind;
  since?: string;
  source_urls?: string[];
  audit?: GetOrFetchOptions["audit"];
};

type ScrapeGraphResponse = {
  request_id?: string;
  scrape_request_id?: string;
  cost?: number;
  data?: {
    content?: string;
    raw_content?: string;
    text?: string;
    markdown?: string;
  };
  content?: string;
  raw_content?: string;
  text?: string;
  markdown?: string;
  metadata?: Record<string, unknown>;
};

function parseTtlMs(value: string | undefined): number {
  if (!value) return ONE_HOUR_MS;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ONE_HOUR_MS;
}

function uniqueUrls(urls: string[]): string[] {
  const deduped = new Set<string>();
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length > 0) {
      deduped.add(trimmed);
    }
  }

  return Array.from(deduped.values());
}

function renderTemplate(template: string, input: FetchSourcesInput): string {
  return template
    .replaceAll("{company_id}", encodeURIComponent(input.company_id))
    .replaceAll("{since}", encodeURIComponent(input.since ?? ""));
}

function resolveSourceUrls(input: FetchSourcesInput): string[] {
  const explicit = uniqueUrls(input.source_urls ?? []);
  if (explicit.length > 0) {
    return explicit;
  }

  const templateByKind: Record<SourceKind, string | undefined> = {
    bse_filing: Deno.env.get("SCRAPEGRAPH_BSE_SOURCE_TEMPLATE"),
    nse_filing: Deno.env.get("SCRAPEGRAPH_NSE_SOURCE_TEMPLATE"),
    earnings_transcript: Deno.env.get("SCRAPEGRAPH_EARNINGS_SOURCE_TEMPLATE")
  };

  const template = templateByKind[input.kind];
  if (!template) {
    return [];
  }

  return [renderTemplate(template, input)];
}

async function scrapeWithScrapeGraph(input: { source_url: string; kind: SourceKind }): Promise<ScrapeResult> {
  const apiKey = Deno.env.get("SGAI_API_KEY") ?? Deno.env.get("SCRAPEGRAPH_API_KEY");
  const apiUrl = Deno.env.get("SCRAPEGRAPH_API_URL") ?? "https://api.scrapegraphai.com/v1/scrape";

  if (!apiKey) {
    return {
      raw_content: `Fetched placeholder content for ${input.source_url}`,
      scrape_request_id: `mock-${crypto.randomUUID()}`,
      cost: 0,
      metadata: {
        provider: "scrapegraphai",
        mode: "mock",
        source_kind: input.kind
      }
    };
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      url: input.source_url,
      source_kind: input.kind
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`ScrapeGraphAI request failed (${response.status}): ${details}`);
  }

  const body = (await response.json()) as ScrapeGraphResponse;
  const rawContent =
    body.data?.raw_content ??
    body.data?.content ??
    body.data?.text ??
    body.data?.markdown ??
    body.raw_content ??
    body.content ??
    body.text ??
    body.markdown;

  if (!rawContent || rawContent.trim().length === 0) {
    throw new Error("ScrapeGraphAI response did not include raw content");
  }

  const groqApiKey = Deno.env.get("GROQ_API_KEY");
  const normalizedContent = groqApiKey
    ? await normalizeContentWithGroq({
        groqApiKey,
        sourceUrl: input.source_url,
        kind: input.kind,
        rawContent
      })
    : rawContent;

  return {
    raw_content: normalizedContent,
    scrape_request_id: body.scrape_request_id ?? body.request_id ?? null,
    cost: typeof body.cost === "number" ? body.cost : null,
    metadata: {
      provider: "scrapegraphai",
      mode: "api",
      source_kind: input.kind,
      ...(groqApiKey
        ? {
            llm_provider: "groq",
            llm_model: `groq/${GROQ_MODEL}`
          }
        : {}),
      ...(body.metadata ?? {})
    }
  };
}

async function normalizeContentWithGroq(input: {
  groqApiKey: string;
  sourceUrl: string;
  kind: SourceKind;
  rawContent: string;
}): Promise<string> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.groqApiKey}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You clean scraped web content for downstream extraction. Return only the cleaned text, no commentary, no code fences."
        },
        {
          role: "user",
          content: JSON.stringify({
            source_url: input.sourceUrl,
            source_kind: input.kind,
            content: input.rawContent.slice(0, 12000)
          })
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Groq normalization failed (${response.status}): ${details}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
      };
    }>;
  };

  const content = body.choices?.[0]?.message?.content?.trim();
  return content && content.length > 0 ? content : input.rawContent;
}

export class SourceIngestor {
  private readonly deps: SourceIngestorDeps;

  constructor(deps: SourceIngestorDeps) {
    this.deps = deps;
  }

  async fetchSources(input: FetchSourcesInput): Promise<CachedDocument[]> {
    const sourceUrls = resolveSourceUrls(input);
    if (sourceUrls.length === 0) {
      return [];
    }

    const documents: CachedDocument[] = [];

    for (const sourceUrl of sourceUrls) {
      const resolved = await this.deps.documentCache.getOrFetch(sourceUrl, this.deps.ttlMs, {
        company_id: input.company_id,
        kind: input.kind,
        metadata: {
          source_kind: input.kind,
          ...(input.since ? { since: input.since } : {})
        },
        audit: input.audit
      });

      documents.push(resolved.document);
    }

    return documents;
  }
}

export function createSourceIngestor(serviceClient: SupabaseClient): SourceIngestor {
  const documentCache = new DocumentCache({
    lookupBySourceAndWindow: async ({ source_url, fetched_at_window }) => {
      const { data, error } = await serviceClient
        .from("source_documents")
        .select("id, company_id, kind, source_url, fetched_at, fetched_at_window, raw_content, scrape_request_id, metadata")
        .eq("source_url", source_url)
        .eq("fetched_at_window", fetched_at_window)
        .maybeSingle();

      if (error) {
        throw new Error(error.message);
      }

      if (!data) {
        return null;
      }

      return {
        ...data,
        metadata: (data.metadata ?? {}) as Record<string, unknown>
      } as CachedDocument;
    },
    insertDocument: async (input) => {
      const { data, error } = await serviceClient
        .from("source_documents")
        .insert({
          company_id: input.company_id,
          kind: input.kind,
          source_url: input.source_url,
          fetched_at_window: input.fetched_at_window,
          raw_content: input.raw_content,
          scrape_request_id: input.scrape_request_id,
          metadata: input.metadata
        })
        .select("id, company_id, kind, source_url, fetched_at, fetched_at_window, raw_content, scrape_request_id, metadata")
        .single();

      if (error || !data) {
        if (error?.code === "23505") {
          const { data: existing, error: existingError } = await serviceClient
            .from("source_documents")
            .select("id, company_id, kind, source_url, fetched_at, fetched_at_window, raw_content, scrape_request_id, metadata")
            .eq("source_url", input.source_url)
            .eq("fetched_at_window", input.fetched_at_window)
            .single();

          if (existingError || !existing) {
            throw new Error(existingError?.message ?? error.message);
          }

          return {
            ...existing,
            metadata: (existing.metadata ?? {}) as Record<string, unknown>
          } as CachedDocument;
        }

        throw new Error(error?.message ?? "Failed to insert source document");
      }

      return {
        ...data,
        metadata: (data.metadata ?? {}) as Record<string, unknown>
      } as CachedDocument;
    },
    scrape: scrapeWithScrapeGraph,
    logScrapeAudit: async (context, payload) => {
      const { error } = await serviceClient.from("audit_events").insert({
        org_id: context.org_id,
        actor_id: context.actor_id,
        project_id: context.project_id,
        kind: "scrape",
        payload
      });

      if (error) {
        throw new Error(error.message);
      }
    }
  });

  return new SourceIngestor({
    documentCache,
    ttlMs: parseTtlMs(Deno.env.get("SOURCE_DOCUMENT_CACHE_TTL_MS"))
  });
}
