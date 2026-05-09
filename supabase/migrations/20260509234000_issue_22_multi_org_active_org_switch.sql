create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  app_metadata jsonb := coalesce(claims->'app_metadata', '{}'::jsonb);
  target_user_id uuid := (event->>'user_id')::uuid;
  preferred_org_id uuid;
begin
  select case
      when up.last_active_org_id is not null
        and exists (
          select 1
          from public.org_members om
          where om.user_id = up.user_id
            and om.org_id = up.last_active_org_id
        ) then up.last_active_org_id
      when up.personal_org_id is not null
        and exists (
          select 1
          from public.org_members om
          where om.user_id = up.user_id
            and om.org_id = up.personal_org_id
        ) then up.personal_org_id
      else null
    end
  into preferred_org_id
  from public.user_profiles up
  where up.user_id = target_user_id;

  if preferred_org_id is not null then
    claims := jsonb_set(
      claims,
      '{app_metadata}',
      app_metadata || jsonb_build_object('active_org_id', preferred_org_id::text),
      true
    );
  else
    claims := jsonb_set(
      claims,
      '{app_metadata}',
      app_metadata - 'active_org_id',
      true
    );
  end if;

  return jsonb_build_object('claims', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from anon, authenticated, public;

create or replace function public.set_active_org(next_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  has_membership boolean;
begin
  if actor_id is null then
    raise exception 'authenticated user required';
  end if;

  select exists (
    select 1
    from public.org_members om
    where om.user_id = actor_id
      and om.org_id = next_org_id
  ) into has_membership;

  if not has_membership then
    raise exception 'cannot switch to org without membership';
  end if;

  update public.user_profiles
  set last_active_org_id = next_org_id
  where user_id = actor_id;

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('active_org_id', next_org_id::text)
  where id = actor_id;

  return next_org_id;
end;
$$;

grant execute on function public.set_active_org(uuid) to authenticated;
revoke execute on function public.set_active_org(uuid) from anon, public;

grant select on public.organizations to authenticated;
grant select on public.org_members to authenticated;
grant select on public.user_profiles to authenticated;

alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.user_profiles enable row level security;

drop policy if exists organizations_member_read on public.organizations;
create policy organizations_member_read on public.organizations
for select
using (
  exists (
    select 1
    from public.org_members om
    where om.org_id = organizations.id
      and om.user_id = auth.uid()
  )
);

drop policy if exists org_members_self_read on public.org_members;
create policy org_members_self_read on public.org_members
for select
using (user_id = auth.uid());

drop policy if exists user_profiles_self_read on public.user_profiles;
create policy user_profiles_self_read on public.user_profiles
for select
using (user_id = auth.uid());
