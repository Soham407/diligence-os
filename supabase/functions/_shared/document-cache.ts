export type SourceKind = "bse_filing" | "nse_filing" | "earnings_transcript";

export type CachedDocument = {
  id: string;
  company_id: string | null;
  kind: SourceKind;
  source_url: string;
  fetched_at: string;
  fetched_at_window: string;
  raw_content: string;
  scrape_request_id: string | null;
  metadata: Record<string, unknown>;
};

export type ScrapeResult = {
  raw_content: string;
  scrape_request_id: string | null;
  cost: number | null;
  metadata?: Record<string, unknown>;
};

type LookupInput = {
  source_url: string;
  fetched_at_window: string;
};

type InsertInput = {
  company_id: string | null;
  kind: SourceKind;
  source_url: string;
  fetched_at_window: string;
  raw_content: string;
  scrape_request_id: string | null;
  metadata: Record<string, unknown>;
};

export type ScrapeAuditContext = {
  org_id: string | null;
  actor_id: string | null;
  project_id: string | null;
  report_type?: string;
};

export type GetOrFetchOptions = {
  company_id: string;
  kind: SourceKind;
  metadata?: Record<string, unknown>;
  audit?: ScrapeAuditContext;
};

type DocumentCacheDeps = {
  now?: () => Date;
  lookupBySourceAndWindow: (input: LookupInput) => Promise<CachedDocument | null>;
  insertDocument: (input: InsertInput) => Promise<CachedDocument>;
  scrape: (input: { source_url: string; kind: SourceKind }) => Promise<ScrapeResult>;
  logScrapeAudit?: (context: ScrapeAuditContext, payload: Record<string, unknown>) => Promise<void>;
};

function toFetchedAtWindow(now: Date, ttlMs: number): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("ttl must be a positive number of milliseconds");
  }

  const windowStartMs = Math.floor(now.getTime() / ttlMs) * ttlMs;
  return new Date(windowStartMs).toISOString().slice(0, 13);
}

export class DocumentCache {
  private readonly deps: DocumentCacheDeps;

  constructor(deps: DocumentCacheDeps) {
    this.deps = deps;
  }

  async getOrFetch(
    source_url: string,
    ttlMs: number,
    options: GetOrFetchOptions
  ): Promise<{ document: CachedDocument; cacheHit: boolean }> {
    const now = this.deps.now ? this.deps.now() : new Date();
    const fetched_at_window = toFetchedAtWindow(now, ttlMs);

    const cached = await this.deps.lookupBySourceAndWindow({ source_url, fetched_at_window });
    if (cached) {
      return { document: cached, cacheHit: true };
    }

    const scraped = await this.deps.scrape({ source_url, kind: options.kind });

    const inserted = await this.deps.insertDocument({
      company_id: options.company_id,
      kind: options.kind,
      source_url,
      fetched_at_window,
      raw_content: scraped.raw_content,
      scrape_request_id: scraped.scrape_request_id,
      metadata: {
        ...(options.metadata ?? {}),
        ...(scraped.metadata ?? {})
      }
    });

    if (this.deps.logScrapeAudit && options.audit) {
      await this.deps.logScrapeAudit(options.audit, {
        source_url,
        source_document_id: inserted.id,
        scrape_request_id: scraped.scrape_request_id,
        cost: scraped.cost,
        cache_hit: false,
        ...(options.audit.report_type ? { report_type: options.audit.report_type } : {})
      });
    }

    return { document: inserted, cacheHit: false };
  }
}
