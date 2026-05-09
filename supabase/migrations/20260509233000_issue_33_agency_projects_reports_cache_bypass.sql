create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  cin text unique,
  pan text unique,
  legal_name text not null,
  display_name text not null,
  sector text,
  listing_status text check (listing_status in ('listed', 'private', 'delisted')),
  mca_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

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

create table if not exists public.compositions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  report_type text not null check (report_type in ('earnings_summary', 'due_diligence', 'lead_intel')),
  source_doc_set_hash text not null,
  agent_version text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (company_id, report_type, source_doc_set_hash, agent_version)
);

create index if not exists compositions_expires_at_idx on public.compositions (expires_at);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_name text not null,
  client_slug text not null,
  white_label_config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (org_id, client_slug)
);

create index if not exists projects_org_created_at_idx on public.projects (org_id, created_at desc);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id),
  company_id uuid not null references public.companies(id),
  report_type text not null check (report_type in ('earnings_summary', 'due_diligence', 'lead_intel')),
  composition_id uuid references public.compositions(id),
  source_doc_set_hash text not null,
  agent_version text not null,
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed')),
  payload jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists reports_org_created_at_idx on public.reports (org_id, created_at desc);
create index if not exists reports_project_id_idx on public.reports (project_id) where project_id is not null;

alter table public.audit_events
  add column if not exists project_id uuid references public.projects(id);

create index if not exists audit_events_project_id_idx
  on public.audit_events (project_id)
  where project_id is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reports_project_cache_bypass_ck'
      and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports
      add constraint reports_project_cache_bypass_ck
      check (project_id is null or composition_id is null);
  end if;
end;
$$;

create or replace function public.create_organization(
  p_name text,
  p_plan text,
  p_billing_email text default null,
  p_gstin text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_user_id uuid;
  resolved_org_type text;
  created_org public.organizations;
begin
  acting_user_id := auth.uid();
  if acting_user_id is null then
    raise exception 'authentication required';
  end if;

  if p_plan like 'agency_%' then
    resolved_org_type := 'agency';
  elsif p_plan like 'b2b_%' then
    resolved_org_type := 'b2b';
  else
    raise exception 'unsupported organization plan: %', p_plan;
  end if;

  insert into public.organizations (name, org_type, plan, billing_email, gstin)
  values (p_name, resolved_org_type, p_plan, p_billing_email, p_gstin)
  returning * into created_org;

  insert into public.org_members (org_id, user_id, role)
  values (created_org.id, acting_user_id, 'admin');

  update public.user_profiles
  set last_active_org_id = created_org.id
  where user_id = acting_user_id;

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('active_org_id', created_org.id::text)
  where id = acting_user_id;

  return created_org;
end;
$$;

grant execute on function public.create_organization(text, text, text, text) to authenticated;

create or replace function public.create_project(
  p_client_name text,
  p_client_slug text,
  p_white_label_config jsonb default '{}'::jsonb
)
returns public.projects
language plpgsql
security invoker
set search_path = public
as $$
declare
  active_org_id uuid;
  acting_user_id uuid;
  org_kind text;
  created_project public.projects;
begin
  active_org_id := public.current_active_org();
  acting_user_id := auth.uid();

  if active_org_id is null or acting_user_id is null then
    raise exception 'active organization membership required';
  end if;

  select org_type into org_kind
  from public.organizations
  where id = active_org_id;

  if org_kind is distinct from 'agency' then
    raise exception 'projects can only be created in agency organizations';
  end if;

  insert into public.projects (org_id, client_name, client_slug, white_label_config, created_by)
  values (active_org_id, p_client_name, p_client_slug, p_white_label_config, acting_user_id)
  returning * into created_project;

  return created_project;
end;
$$;

grant execute on function public.create_project(text, text, jsonb) to authenticated;

grant select, insert on public.projects to authenticated;
grant select, insert on public.reports to authenticated;

alter table public.projects enable row level security;
alter table public.reports enable row level security;

drop policy if exists projects_member_read on public.projects;
create policy projects_member_read on public.projects
for select
using (org_id = public.current_active_org());

drop policy if exists projects_member_write on public.projects;
create policy projects_member_write on public.projects
for insert
with check (
  org_id = public.current_active_org()
  and exists (
    select 1
    from public.organizations
    where id = org_id
      and org_type = 'agency'
  )
);

drop policy if exists reports_member_read on public.reports;
create policy reports_member_read on public.reports
for select
using (org_id = public.current_active_org());

drop policy if exists reports_member_write on public.reports;
create policy reports_member_write on public.reports
for insert
with check (
  org_id = public.current_active_org()
  and (
    project_id is null
    or exists (
      select 1
      from public.projects
      where id = project_id
        and org_id = public.current_active_org()
    )
  )
);
