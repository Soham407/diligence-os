begin;

do $$
declare
  user_a uuid := '00000000-0000-0000-0000-0000000032a1';
  org_a uuid;
  remaining integer;
  allowed boolean;
begin
  delete from auth.users where id = user_a;

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
    'issue32-user-a@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{"full_name":"Issue 32 User A"}'::jsonb,
    now(),
    now()
  );

  select personal_org_id into org_a from public.user_profiles where user_id = user_a;

  if org_a is null then
    raise exception 'expected trigger-created personal org for user';
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', user_a::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', org_a::text))::text,
    true
  );

  select public.entitlement_quota_remaining(org_a, 'reports.earnings_summary') into remaining;
  if remaining <> 3 then
    raise exception 'expected retail_free monthly earnings quota 3, got %', remaining;
  end if;

  insert into public.usage_events (org_id, user_id, action, metadata)
  values
    (org_a, user_a, 'reports.earnings_summary', '{"origin":"test"}'::jsonb),
    (org_a, user_a, 'reports.earnings_summary', '{"origin":"test"}'::jsonb),
    (org_a, user_a, 'reports.earnings_summary', '{"origin":"test"}'::jsonb);

  select public.entitlement_can(org_a, 'reports.earnings_summary') into allowed;
  if allowed then
    raise exception 'expected N+1 to be rejected for retail_free earnings_summary';
  end if;

  select public.entitlement_quota_remaining(org_a, 'reports.earnings_summary') into remaining;
  if remaining <> 0 then
    raise exception 'expected quota remaining 0 after three runs, got %', remaining;
  end if;

  delete from public.usage_events
  where org_id = org_a
    and action = 'reports.earnings_summary';

  insert into public.usage_events (org_id, user_id, action, metadata, created_at)
  values (org_a, user_a, 'reports.earnings_summary', '{"origin":"test-old"}'::jsonb, now() - interval '40 days');

  select public.entitlement_quota_remaining(org_a, 'reports.earnings_summary') into remaining;
  if remaining <> 3 then
    raise exception 'expected 40-day-old usage event to be excluded from 30-day window';
  end if;

  select public.entitlement_quota_remaining(org_a, 'reports.due_diligence') into remaining;
  if remaining <> 0 then
    raise exception 'expected due_diligence disabled for retail_free';
  end if;

  reset role;
end;
$$;

rollback;
