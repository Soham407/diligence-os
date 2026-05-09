create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  org_type text not null check (org_type in ('personal', 'b2b', 'agency')),
  plan text not null,
  billing_email text,
  gstin text,
  white_label_config jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'analyst', 'viewer')),
  created_at timestamptz default now(),
  primary key (org_id, user_id)
);

create index if not exists org_members_user_id_idx on public.org_members (user_id);

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  personal_org_id uuid not null references public.organizations(id),
  last_active_org_id uuid references public.organizations(id),
  display_name text,
  created_at timestamptz default now()
);

create or replace function public.current_active_org() returns uuid
language sql
stable
as $$
  select org_id
  from public.org_members
  where user_id = auth.uid()
    and org_id = (auth.jwt() -> 'app_metadata' ->> 'active_org_id')::uuid
  limit 1
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  personal_org_id uuid;
  inferred_display_name text;
begin
  inferred_display_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))), '');

  insert into public.organizations (name, org_type, plan)
  values (
    coalesce(inferred_display_name, 'User') || '''s Personal Org',
    'personal',
    'retail_free'
  )
  returning id into personal_org_id;

  insert into public.org_members (org_id, user_id, role)
  values (personal_org_id, new.id, 'admin');

  insert into public.user_profiles (user_id, personal_org_id, last_active_org_id, display_name)
  values (new.id, personal_org_id, personal_org_id, inferred_display_name);

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('active_org_id', personal_org_id::text)
  where id = new.id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

create table if not exists public.org_private_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  note text not null,
  created_at timestamptz default now()
);

grant select, insert on public.org_private_notes to authenticated;

alter table public.org_private_notes enable row level security;

drop policy if exists org_member_read on public.org_private_notes;
create policy org_member_read on public.org_private_notes
for select
using (org_id = public.current_active_org());

drop policy if exists org_member_write on public.org_private_notes;
create policy org_member_write on public.org_private_notes
for insert
with check (org_id = public.current_active_org());

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id),
  actor_id uuid references auth.users(id),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists audit_events_org_created_at_idx on public.audit_events (org_id, created_at desc);

grant insert on public.audit_events to authenticated;

alter table public.audit_events enable row level security;

drop policy if exists audit_events_insert on public.audit_events;
create policy audit_events_insert on public.audit_events
for insert
with check (org_id = public.current_active_org());
