alter table public.organizations
  add constraint organizations_plan_supported
  check (plan in ('retail_free', 'retail_pro', 'b2b_starter', 'b2b_team', 'agency_starter', 'agency_pro'));

create table if not exists public.entitlement_tiers (
  tier text primary key
    check (tier in ('retail_free', 'retail_pro', 'b2b_starter', 'b2b_team', 'agency_starter', 'agency_pro')),
  feature_flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.entitlement_policies (
  tier text not null references public.entitlement_tiers(tier) on delete cascade,
  action text not null
    check (action in ('reports.earnings_summary', 'reports.due_diligence', 'reports.lead_intel')),
  quota_limit integer not null check (quota_limit >= 0),
  rolling_window_days integer not null check (rolling_window_days > 0),
  created_at timestamptz not null default now(),
  primary key (tier, action)
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_org_action_created_at_idx
  on public.usage_events (org_id, action, created_at);

insert into public.entitlement_tiers (tier, feature_flags)
values
  ('retail_free', '{"due_diligence_enabled":false,"lead_intel_enabled":false}'::jsonb),
  ('retail_pro', '{"due_diligence_enabled":false,"lead_intel_enabled":false}'::jsonb),
  ('b2b_starter', '{"due_diligence_enabled":true,"lead_intel_enabled":false}'::jsonb),
  ('b2b_team', '{"due_diligence_enabled":true,"lead_intel_enabled":false}'::jsonb),
  ('agency_starter', '{"due_diligence_enabled":true,"lead_intel_enabled":true}'::jsonb),
  ('agency_pro', '{"due_diligence_enabled":true,"lead_intel_enabled":true}'::jsonb)
on conflict (tier) do update
set feature_flags = excluded.feature_flags;

insert into public.entitlement_policies (tier, action, quota_limit, rolling_window_days)
values
  ('retail_free', 'reports.earnings_summary', 3, 30),
  ('retail_free', 'reports.due_diligence', 0, 30),
  ('retail_free', 'reports.lead_intel', 0, 30),
  ('retail_pro', 'reports.earnings_summary', 100, 30),
  ('retail_pro', 'reports.due_diligence', 0, 30),
  ('retail_pro', 'reports.lead_intel', 0, 30),
  ('b2b_starter', 'reports.earnings_summary', 300, 30),
  ('b2b_starter', 'reports.due_diligence', 40, 30),
  ('b2b_starter', 'reports.lead_intel', 0, 30),
  ('b2b_team', 'reports.earnings_summary', 1200, 30),
  ('b2b_team', 'reports.due_diligence', 250, 30),
  ('b2b_team', 'reports.lead_intel', 0, 30),
  ('agency_starter', 'reports.earnings_summary', 1500, 30),
  ('agency_starter', 'reports.due_diligence', 300, 30),
  ('agency_starter', 'reports.lead_intel', 100, 30),
  ('agency_pro', 'reports.earnings_summary', 5000, 30),
  ('agency_pro', 'reports.due_diligence', 1200, 30),
  ('agency_pro', 'reports.lead_intel', 500, 30)
on conflict (tier, action) do update
set
  quota_limit = excluded.quota_limit,
  rolling_window_days = excluded.rolling_window_days;

create or replace function public.entitlement_quota_remaining(
  p_org_id uuid,
  p_action text,
  p_now timestamptz default now()
)
returns integer
language sql
stable
as $$
  with selected_policy as (
    select ep.quota_limit, ep.rolling_window_days
    from public.organizations o
    join public.entitlement_policies ep on ep.tier = o.plan
    where o.id = p_org_id
      and ep.action = p_action
    limit 1
  ),
  usage_count as (
    select count(*)::integer as used
    from public.usage_events ue
    join selected_policy sp on true
    where ue.org_id = p_org_id
      and ue.action = p_action
      and ue.created_at >= (p_now - make_interval(days => sp.rolling_window_days))
      and ue.created_at <= p_now
  )
  select coalesce(
    greatest((select quota_limit from selected_policy) - (select used from usage_count), 0),
    0
  );
$$;

create or replace function public.entitlement_can(
  p_org_id uuid,
  p_action text,
  p_now timestamptz default now()
)
returns boolean
language sql
stable
as $$
  select public.entitlement_quota_remaining(p_org_id, p_action, p_now) > 0;
$$;

grant select on public.entitlement_tiers, public.entitlement_policies to authenticated;
grant select, insert on public.usage_events to authenticated;

alter table public.entitlement_tiers enable row level security;
alter table public.entitlement_policies enable row level security;
alter table public.usage_events enable row level security;

drop policy if exists entitlement_tiers_read on public.entitlement_tiers;
create policy entitlement_tiers_read on public.entitlement_tiers
for select
using (auth.role() = 'authenticated');

drop policy if exists entitlement_policies_read on public.entitlement_policies;
create policy entitlement_policies_read on public.entitlement_policies
for select
using (auth.role() = 'authenticated');

drop policy if exists usage_events_read on public.usage_events;
create policy usage_events_read on public.usage_events
for select
using (org_id = public.current_active_org());

drop policy if exists usage_events_insert on public.usage_events;
create policy usage_events_insert on public.usage_events
for insert
with check (org_id = public.current_active_org());
