begin;

do $$
declare
  user_a uuid := '00000000-0000-0000-0000-0000000000a1';
  user_b uuid := '00000000-0000-0000-0000-0000000000b2';
  org_a uuid;
  org_b uuid;
  resolved_org uuid;
  visible_count int;
begin
  delete from auth.users where id in (user_a, user_b);

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
    user_a,
    'authenticated',
    'authenticated',
    'issue21-user-a@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{"full_name":"Issue 21 User A"}'::jsonb,
    now(),
    now()
  );

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
    user_b,
    'authenticated',
    'authenticated',
    'issue21-user-b@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{"full_name":"Issue 21 User B"}'::jsonb,
    now(),
    now()
  );

  select personal_org_id into org_a from public.user_profiles where user_id = user_a;
  select personal_org_id into org_b from public.user_profiles where user_id = user_b;

  if org_a is null or org_b is null then
    raise exception 'expected trigger-created personal orgs for both users';
  end if;

  if org_a = org_b then
    raise exception 'expected unique personal org per user';
  end if;

  insert into public.org_private_notes (org_id, note)
  values (org_a, 'org-a-note'), (org_b, 'org-b-note');

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', user_a::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', org_a::text))::text,
    true
  );

  select public.current_active_org() into resolved_org;
  if resolved_org is distinct from org_a then
    raise exception 'expected current_active_org() to return % but got %', org_a, resolved_org;
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', org_b::text))::text,
    true
  );

  select public.current_active_org() into resolved_org;
  if resolved_org is not null then
    raise exception 'expected current_active_org() to return null for missing membership, got %', resolved_org;
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', org_a::text))::text,
    true
  );

  select count(*) into visible_count from public.org_private_notes;
  if visible_count != 1 then
    raise exception 'expected cross-org SELECT isolation (count=1), got %', visible_count;
  end if;

  reset role;
end;
$$;

rollback;
