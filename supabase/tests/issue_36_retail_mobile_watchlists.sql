begin;

do $$
declare
  test_user_id uuid := '00000000-0000-0000-0000-000000000036';
  personal_org_id uuid;
  b2b_org_id uuid := '00000000-0000-0000-0000-000000003601';
  company_id uuid;
  inserted_watchlist_id uuid;
  blocked_insert boolean := false;
begin
  delete from auth.users where id = test_user_id;

  insert into auth.users (
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  )
  values (
    test_user_id,
    'authenticated',
    'authenticated',
    'issue36-user@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{"full_name":"Issue 36 User"}'::jsonb,
    now(),
    now()
  );

  select personal_org_id into personal_org_id
  from public.user_profiles
  where user_id = test_user_id;

  if personal_org_id is null then
    raise exception 'expected trigger-created personal org';
  end if;

  insert into public.organizations (id, name, org_type, plan)
  values (b2b_org_id, 'Issue 36 B2B Org', 'b2b', 'b2b_starter');

  insert into public.org_members (org_id, user_id, role)
  values (b2b_org_id, test_user_id, 'admin');

  select id into company_id
  from public.companies
  where cin = 'L00000MH2000PLC000036';

  if company_id is null then
    insert into public.companies (cin, legal_name, display_name, listing_status)
    values ('L00000MH2000PLC000036', 'Issue 36 Company Ltd', 'Issue 36 Co', 'listed')
    returning id into company_id;
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', personal_org_id::text))::text,
    true
  );

  insert into public.watchlists (org_id, company_id, created_by)
  values (personal_org_id, company_id, test_user_id)
  returning id into inserted_watchlist_id;

  if inserted_watchlist_id is null then
    raise exception 'expected insert into watchlists in personal org to succeed';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', b2b_org_id::text))::text,
    true
  );

  begin
    insert into public.watchlists (org_id, company_id, created_by)
    values (b2b_org_id, company_id, test_user_id);
  exception
    when insufficient_privilege then
      blocked_insert := true;
  end;

  if not blocked_insert then
    raise exception 'expected watchlist insert in non-personal active org to be blocked';
  end if;

  if exists (
    select 1
    from public.watchlists
    where id = inserted_watchlist_id
      and org_id = personal_org_id
  ) then
    raise exception 'expected watchlists rows from personal org to be invisible from b2b active org';
  end if;

  reset role;
end;
$$;

rollback;
