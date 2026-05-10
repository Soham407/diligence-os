create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  report_id uuid references public.reports(id) on delete set null,
  anthropic_session_id text,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists jobs_org_created_at_idx on public.jobs (org_id, created_at desc);
create index if not exists jobs_status_created_at_idx on public.jobs (status, created_at asc);
create index if not exists job_events_job_created_at_idx on public.job_events (job_id, created_at asc);

grant select, insert on public.jobs to authenticated;
grant select, insert on public.job_events to authenticated;

alter table public.jobs enable row level security;
alter table public.job_events enable row level security;

drop policy if exists jobs_member_read on public.jobs;
create policy jobs_member_read on public.jobs
for select
using (org_id = public.current_active_org());

drop policy if exists jobs_member_write on public.jobs;
create policy jobs_member_write on public.jobs
for insert
with check (
  org_id = public.current_active_org()
  and (
    report_id is null
    or exists (
      select 1
      from public.reports r
      where r.id = report_id
        and r.org_id = public.current_active_org()
    )
  )
);

drop policy if exists job_events_member_read on public.job_events;
create policy job_events_member_read on public.job_events
for select
using (
  exists (
    select 1
    from public.jobs j
    where j.id = job_id
      and j.org_id = public.current_active_org()
  )
);

drop policy if exists job_events_member_write on public.job_events;
create policy job_events_member_write on public.job_events
for insert
with check (
  exists (
    select 1
    from public.jobs j
    where j.id = job_id
      and j.org_id = public.current_active_org()
  )
);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'job_events'
  ) then
    execute 'alter publication supabase_realtime add table public.job_events';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reports'
  ) then
    execute 'alter publication supabase_realtime add table public.reports';
  end if;
end;
$$;

create or replace function public.complete_report_with_citations(
  p_report_id uuid,
  p_payload jsonb,
  p_status text,
  p_citations jsonb default '[]'::jsonb,
  p_composition_id uuid default null,
  p_agent_version text default null,
  p_source_doc_set_hash text default null
)
returns public.reports
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_report public.reports;
begin
  update public.reports
  set
    payload = p_payload,
    status = p_status,
    composition_id = coalesce(p_composition_id, composition_id),
    agent_version = coalesce(p_agent_version, agent_version),
    source_doc_set_hash = coalesce(p_source_doc_set_hash, source_doc_set_hash)
  where id = p_report_id
  returning * into updated_report;

  if updated_report.id is null then
    raise exception 'report % not found', p_report_id;
  end if;

  delete from public.report_citations
  where report_id = updated_report.id;

  insert into public.report_citations (
    report_id,
    claim_id,
    source_document_id,
    locator,
    quote,
    quote_verified
  )
  select
    updated_report.id,
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

  return updated_report;
end;
$$;

grant execute on function public.complete_report_with_citations(
  uuid,
  jsonb,
  text,
  jsonb,
  uuid,
  text,
  text
) to authenticated;

revoke execute on function public.complete_report_with_citations(
  uuid,
  jsonb,
  text,
  jsonb,
  uuid,
  text,
  text
) from anon, public;

create or replace function public.invoke_job_runner_every_10s()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  job_runner_url text := coalesce(
    nullif(current_setting('app.settings.job_runner_url', true), ''),
    'http://127.0.0.1:54321/functions/v1/job-runner'
  );
  job_runner_token text := coalesce(
    nullif(current_setting('app.settings.job_runner_token', true), ''),
    ''
  );
  headers jsonb := jsonb_build_object('Content-Type', 'application/json');
begin
  if job_runner_token <> '' then
    headers := headers || jsonb_build_object('x-job-runner-token', job_runner_token);
  end if;

  perform net.http_post(
    url := job_runner_url,
    body := '{}'::jsonb,
    headers := headers,
    timeout_milliseconds := 9000
  );
end;
$$;

-- Every 10 seconds, invoke the Edge Function worker that advances long-running report jobs.
do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'job_runner_every_10s'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'job_runner_every_10s',
    '10 seconds',
    'select public.invoke_job_runner_every_10s();'
  );
end;
$$;
