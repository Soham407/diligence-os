create table if not exists public.watchlists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, company_id)
);

create index if not exists watchlists_org_created_at_idx
  on public.watchlists (org_id, created_at desc);

create index if not exists watchlists_company_id_idx
  on public.watchlists (company_id);

grant select, insert, delete on public.watchlists to authenticated;

alter table public.watchlists enable row level security;

drop policy if exists watchlists_member_read on public.watchlists;
create policy watchlists_member_read on public.watchlists
for select
using (org_id = public.current_active_org());

drop policy if exists watchlists_member_write on public.watchlists;
create policy watchlists_member_write on public.watchlists
for insert
with check (
  org_id = public.current_active_org()
  and exists (
    select 1
    from public.organizations
    where id = org_id
      and org_type = 'personal'
  )
);

drop policy if exists watchlists_member_delete on public.watchlists;
create policy watchlists_member_delete on public.watchlists
for delete
using (
  org_id = public.current_active_org()
  and exists (
    select 1
    from public.organizations
    where id = org_id
      and org_type = 'personal'
  )
);
