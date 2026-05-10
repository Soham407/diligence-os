create table if not exists public.source_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id),
  kind text not null check (kind in ('bse_filing', 'nse_filing', 'earnings_transcript')),
  source_url text not null,
  fetched_at timestamptz not null default now(),
  fetched_at_window text not null,
  raw_content text not null,
  scrape_request_id text,
  metadata jsonb not null default '{}'::jsonb,
  unique (source_url, fetched_at_window)
);

create index if not exists source_documents_company_kind_idx
  on public.source_documents (company_id, kind);
