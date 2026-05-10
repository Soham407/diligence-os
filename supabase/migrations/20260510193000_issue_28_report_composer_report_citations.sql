create table if not exists public.report_citations (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  claim_id text not null,
  source_document_id uuid not null references public.source_documents(id),
  locator jsonb not null,
  quote text not null,
  quote_verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique (report_id, claim_id, source_document_id)
);

create index if not exists report_citations_source_document_idx
  on public.report_citations (source_document_id);

create index if not exists report_citations_report_claim_idx
  on public.report_citations (report_id, claim_id);

grant select, insert on public.report_citations to authenticated;

alter table public.report_citations enable row level security;

drop policy if exists report_citations_member_read on public.report_citations;
create policy report_citations_member_read on public.report_citations
for select
using (
  exists (
    select 1
    from public.reports r
    where r.id = report_id
      and r.org_id = public.current_active_org()
  )
);

drop policy if exists report_citations_member_write on public.report_citations;
create policy report_citations_member_write on public.report_citations
for insert
with check (
  exists (
    select 1
    from public.reports r
    where r.id = report_id
      and r.org_id = public.current_active_org()
  )
);

create or replace function public.create_report_with_citations(
  p_org_id uuid,
  p_project_id uuid,
  p_company_id uuid,
  p_report_type text,
  p_composition_id uuid,
  p_source_doc_set_hash text,
  p_agent_version text,
  p_status text,
  p_payload jsonb,
  p_created_by uuid,
  p_citations jsonb default '[]'::jsonb
)
returns public.reports
language plpgsql
security definer
set search_path = public
as $$
declare
  created_report public.reports;
begin
  insert into public.reports (
    org_id,
    project_id,
    company_id,
    report_type,
    composition_id,
    source_doc_set_hash,
    agent_version,
    status,
    payload,
    created_by
  )
  values (
    p_org_id,
    p_project_id,
    p_company_id,
    p_report_type,
    p_composition_id,
    p_source_doc_set_hash,
    p_agent_version,
    p_status,
    p_payload,
    p_created_by
  )
  returning * into created_report;

  insert into public.report_citations (
    report_id,
    claim_id,
    source_document_id,
    locator,
    quote,
    quote_verified
  )
  select
    created_report.id,
    entry ->> 'claim_id',
    (entry ->> 'source_document_id')::uuid,
    coalesce(entry -> 'locator', '{}'::jsonb),
    coalesce(entry ->> 'quote', ''),
    coalesce((entry ->> 'quote_verified')::boolean, false)
  from jsonb_array_elements(
    case
      when jsonb_typeof(coalesce(p_citations, '[]'::jsonb)) = 'array' then coalesce(p_citations, '[]'::jsonb)
      else '[]'::jsonb
    end
  ) entry;

  return created_report;
end;
$$;

grant execute on function public.create_report_with_citations(
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  text,
  text,
  text,
  jsonb,
  uuid,
  jsonb
) to authenticated;

revoke execute on function public.create_report_with_citations(
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  text,
  text,
  text,
  jsonb,
  uuid,
  jsonb
) from anon, public;
