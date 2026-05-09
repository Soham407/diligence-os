begin;

do $$
declare
  test_user_id uuid := '00000000-0000-0000-0000-000000000022';
  personal_org_id_value uuid;
  second_org_id uuid := '00000000-0000-0000-0000-000000000122';
  outsider_org_id uuid := '00000000-0000-0000-0000-000000000222';
  resolved_org uuid;
  hook_response jsonb;
  active_org_claim text;
  visible_count int;
  metadata_active_org text;
  denied_switch_error text;
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
    'issue22-user@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{"full_name":"Issue 22 User"}'::jsonb,
    now(),
    now()
  );

  select personal_org_id into personal_org_id_value
  from public.user_profiles
  where user_id = test_user_id;

  if personal_org_id_value is null then
    raise exception 'expected personal_org_id to exist for user %', test_user_id;
  end if;

  insert into public.organizations (id, name, org_type, plan)
  values (second_org_id, 'Issue 22 Work Org', 'b2b', 'b2b_basic');

  insert into public.org_members (org_id, user_id, role)
  values (second_org_id, test_user_id, 'admin');

  insert into public.organizations (id, name, org_type, plan)
  values (outsider_org_id, 'Issue 22 Outsider Org', 'b2b', 'b2b_basic');

  insert into public.org_private_notes (org_id, note)
  values (personal_org_id_value, 'personal-note'), (second_org_id, 'work-note');

  update public.user_profiles
  set last_active_org_id = second_org_id
  where user_id = test_user_id;

  hook_response := public.custom_access_token_hook(
    jsonb_build_object(
      'user_id', test_user_id::text,
      'claims', jsonb_build_object('app_metadata', '{}'::jsonb)
    )
  );

  active_org_claim := hook_response -> 'claims' -> 'app_metadata' ->> 'active_org_id';

  if active_org_claim is null or active_org_claim::uuid is distinct from second_org_id then
    raise exception 'expected hook to set active_org_id to last_active_org_id %, got %', second_org_id, active_org_claim;
  end if;

  update public.user_profiles
  set last_active_org_id = null
  where user_id = test_user_id;

  hook_response := public.custom_access_token_hook(
    jsonb_build_object(
      'user_id', test_user_id::text,
      'claims', jsonb_build_object('app_metadata', '{}'::jsonb)
    )
  );

  active_org_claim := hook_response -> 'claims' -> 'app_metadata' ->> 'active_org_id';

  if active_org_claim is null or active_org_claim::uuid is distinct from personal_org_id_value then
    raise exception 'expected hook fallback active_org_id to personal_org_id %, got %', personal_org_id_value, active_org_claim;
  end if;

  update public.user_profiles
  set last_active_org_id = outsider_org_id
  where user_id = test_user_id;

  hook_response := public.custom_access_token_hook(
    jsonb_build_object(
      'user_id', test_user_id::text,
      'claims', jsonb_build_object('app_metadata', '{}'::jsonb)
    )
  );

  active_org_claim := hook_response -> 'claims' -> 'app_metadata' ->> 'active_org_id';

  if active_org_claim is null or active_org_claim::uuid is distinct from personal_org_id_value then
    raise exception 'expected hook to ignore non-member last_active_org_id and fallback to personal_org_id %, got %', personal_org_id_value, active_org_claim;
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', personal_org_id_value::text))::text,
    true
  );

  select public.set_active_org(second_org_id) into resolved_org;

  if resolved_org is distinct from second_org_id then
    raise exception 'expected set_active_org() to return % got %', second_org_id, resolved_org;
  end if;

  select raw_app_meta_data ->> 'active_org_id' into metadata_active_org
  from auth.users
  where id = test_user_id;

  if metadata_active_org is null or metadata_active_org::uuid is distinct from second_org_id then
    raise exception 'expected auth.users raw_app_meta_data.active_org_id to be % got %', second_org_id, metadata_active_org;
  end if;

  begin
    perform public.set_active_org(outsider_org_id);
  exception
    when others then
      denied_switch_error := sqlerrm;
  end;

  if denied_switch_error is null then
    raise exception 'expected set_active_org() to reject switching to non-member org';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', second_org_id::text))::text,
    true
  );

  select count(*) into visible_count from public.org_private_notes;
  if visible_count != 1 then
    raise exception 'expected active-org switch to scope data to one org row, got %', visible_count;
  end if;

  delete from public.org_members
  where org_id = second_org_id
    and user_id = test_user_id;

  select public.current_active_org() into resolved_org;
  if resolved_org is not null then
    raise exception 'expected current_active_org() to return null after membership removal, got %', resolved_org;
  end if;

  select count(*) into visible_count from public.org_private_notes;
  if visible_count != 0 then
    raise exception 'expected stale-jwt replay to return zero rows after membership removal, got %', visible_count;
  end if;

  reset role;
end;
$$;

rollback;
