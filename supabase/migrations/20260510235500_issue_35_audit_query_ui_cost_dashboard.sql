create or replace function public.is_platform_admin()
returns boolean
language sql
stable
as $$
  select case lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'platform_admin', 'false'))
    when 'true' then true
    else false
  end
$$;

create or replace function public.get_org_audit_log(
  p_project_id uuid default null,
  p_limit integer default 100
)
returns table (
  id uuid,
  created_at timestamptz,
  kind text,
  project_id uuid,
  source_url text,
  cost numeric,
  agent_id text,
  report_type text,
  flagged_for_review boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  active_org_id uuid;
  is_admin boolean;
  safe_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  active_org_id := public.current_active_org();
  if active_org_id is null then
    raise exception 'active organization membership required';
  end if;

  select exists (
    select 1
    from public.org_members
    where org_id = active_org_id
      and user_id = auth.uid()
      and role = 'admin'
  )
  into is_admin;

  if not is_admin then
    raise exception 'organization admin role required';
  end if;

  if p_project_id is not null
    and not exists (
      select 1
      from public.projects
      where id = p_project_id
        and org_id = active_org_id
    ) then
    raise exception 'project_id must belong to active organization';
  end if;

  return query
  select
    ae.id,
    ae.created_at,
    ae.kind,
    ae.project_id,
    nullif(ae.payload ->> 'source_url', '') as source_url,
    case
      when jsonb_typeof(ae.payload -> 'cost') = 'number' then (ae.payload ->> 'cost')::numeric
      else null
    end as cost,
    nullif(ae.payload ->> 'agent_id', '') as agent_id,
    nullif(ae.payload ->> 'report_type', '') as report_type,
    ae.kind = 'citation_verification_failed' as flagged_for_review
  from public.audit_events ae
  where ae.org_id = active_org_id
    and (p_project_id is null or ae.project_id = p_project_id)
    and ae.kind in ('scrape', 'agent_run', 'composition_cache_hit', 'citation_verification_failed')
  order by ae.created_at desc
  limit safe_limit;
end;
$$;

create or replace function public.get_internal_cost_dashboard(
  p_days integer default 14
)
returns table (
  day date,
  agent_id text,
  org_type text,
  total_cost numeric,
  run_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_days integer := greatest(coalesce(p_days, 14), 1);
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not public.is_platform_admin() then
    raise exception 'platform admin required';
  end if;

  return query
  select
    (ae.created_at at time zone 'utc')::date as day,
    coalesce(nullif(ae.payload ->> 'agent_id', ''), 'unknown') as agent_id,
    orgs.org_type,
    coalesce(
      sum(
        case
          when jsonb_typeof(ae.payload -> 'cost') = 'number' then (ae.payload ->> 'cost')::numeric
          else 0::numeric
        end
      ),
      0::numeric
    ) as total_cost,
    count(*)::bigint as run_count
  from public.audit_events ae
  join public.organizations orgs on orgs.id = ae.org_id
  where ae.kind = 'agent_run'
    and ae.created_at >= now() - make_interval(days => safe_days)
  group by (ae.created_at at time zone 'utc')::date, coalesce(nullif(ae.payload ->> 'agent_id', ''), 'unknown'), orgs.org_type
  order by day desc, total_cost desc, agent_id asc;
end;
$$;

grant execute on function public.get_org_audit_log(uuid, integer) to authenticated;
revoke execute on function public.get_org_audit_log(uuid, integer) from anon, public;

grant execute on function public.get_internal_cost_dashboard(integer) to authenticated;
revoke execute on function public.get_internal_cost_dashboard(integer) from anon, public;
