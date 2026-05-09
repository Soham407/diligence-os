begin;

do $$
declare
  test_user_id uuid := '00000000-0000-0000-0000-000000000034';
  personal_org_id uuid;
  b2b_org_id uuid := '00000000-0000-0000-0000-000000003401';
  agency_org_id uuid := '00000000-0000-0000-0000-000000003402';
  company_id uuid;
  project_id uuid;
  retail_report_id uuid;
  b2b_report_id uuid;
  agency_report_id uuid;
  platform_defaults jsonb := jsonb_build_object(
    'brand_name', 'Diligence OS',
    'logo_url', 'https://platform.example/logo.png',
    'disclaimers', jsonb_build_array('Platform disclaimer'),
    'show_platform_branding', true
  );
  resolved jsonb;
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
    'issue34-user@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{"full_name":"Issue 34 User"}'::jsonb,
    now(),
    now()
  );

  select personal_org_id into personal_org_id
  from public.user_profiles
  where user_id = test_user_id;

  if personal_org_id is null then
    raise exception 'expected trigger-created personal org';
  end if;

  update public.organizations
  set white_label_config = '{}'::jsonb
  where id = personal_org_id;

  insert into public.organizations (id, name, org_type, plan, white_label_config)
  values (
    b2b_org_id,
    'Issue 34 B2B Org',
    'b2b',
    'b2b_starter',
    '{"brand_name":"Issue 34 B2B Brand","logo_url":"https://b2b.example/logo.png","disclaimers":["B2B disclaimer"]}'::jsonb
  );

  insert into public.org_members (org_id, user_id, role)
  values (b2b_org_id, test_user_id, 'admin');

  insert into public.organizations (id, name, org_type, plan, white_label_config)
  values (
    agency_org_id,
    'Issue 34 Agency Org',
    'agency',
    'agency_starter',
    '{"brand_name":"Issue 34 Agency Brand","logo_url":"https://agency.example/logo.png","disclaimers":["Agency org disclaimer"]}'::jsonb
  );

  insert into public.org_members (org_id, user_id, role)
  values (agency_org_id, test_user_id, 'admin');

  insert into public.projects (
    org_id,
    client_name,
    client_slug,
    white_label_config,
    created_by
  )
  values (
    agency_org_id,
    'Issue 34 Client',
    'issue-34-client',
    '{"brand_name":"Issue 34 Client Brand","logo_url":"https://client.example/logo.png","disclaimers":["Project disclaimer"]}'::jsonb,
    test_user_id
  )
  returning id into project_id;

  select id into company_id
  from public.companies
  where cin = 'L00000MH2000PLC000034';

  if company_id is null then
    insert into public.companies (cin, legal_name, display_name, listing_status)
    values ('L00000MH2000PLC000034', 'Issue 34 Company Ltd', 'Issue 34 Co', 'listed')
    returning id into company_id;
  end if;

  insert into public.reports (
    org_id,
    project_id,
    company_id,
    report_type,
    composition_id,
    source_doc_set_hash,
    agent_version,
    status,
    payload,
    created_by
  )
  values (
    personal_org_id,
    null,
    company_id,
    'earnings_summary',
    null,
    'issue34-retail-hash',
    'v1',
    'succeeded',
    '{"executive_summary":"retail"}'::jsonb,
    test_user_id
  )
  returning id into retail_report_id;

  insert into public.reports (
    org_id,
    project_id,
    company_id,
    report_type,
    composition_id,
    source_doc_set_hash,
    agent_version,
    status,
    payload,
    created_by
  )
  values (
    b2b_org_id,
    null,
    company_id,
    'due_diligence',
    null,
    'issue34-b2b-hash',
    'v1',
    'succeeded',
    '{"executive_summary":"b2b"}'::jsonb,
    test_user_id
  )
  returning id into b2b_report_id;

  insert into public.reports (
    org_id,
    project_id,
    company_id,
    report_type,
    composition_id,
    source_doc_set_hash,
    agent_version,
    status,
    payload,
    created_by
  )
  values (
    agency_org_id,
    project_id,
    company_id,
    'lead_intel',
    null,
    'issue34-agency-hash',
    'v1',
    'succeeded',
    '{"executive_summary":"agency"}'::jsonb,
    test_user_id
  )
  returning id into agency_report_id;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', agency_org_id::text))::text,
    true
  );

  resolved := public.resolve_report_white_label(agency_report_id, platform_defaults);

  if resolved ->> 'source' <> 'project' then
    raise exception 'expected agency source=project, got %', resolved ->> 'source';
  end if;

  if resolved ->> 'brand_name' <> 'Issue 34 Client Brand' then
    raise exception 'expected agency brand from project, got %', resolved ->> 'brand_name';
  end if;

  if resolved ->> 'logo_url' <> 'https://client.example/logo.png' then
    raise exception 'expected agency logo from project, got %', resolved ->> 'logo_url';
  end if;

  if (resolved -> 'disclaimers')::jsonb <> '["Project disclaimer"]'::jsonb then
    raise exception 'expected agency disclaimers from project, got %', resolved -> 'disclaimers';
  end if;

  if coalesce((resolved ->> 'show_platform_branding')::boolean, true) is distinct from false then
    raise exception 'expected agency show_platform_branding=false, got %', resolved ->> 'show_platform_branding';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', b2b_org_id::text))::text,
    true
  );

  resolved := public.resolve_report_white_label(b2b_report_id, platform_defaults);

  if resolved ->> 'source' <> 'organization' then
    raise exception 'expected b2b source=organization, got %', resolved ->> 'source';
  end if;

  if resolved ->> 'brand_name' <> 'Issue 34 B2B Brand' then
    raise exception 'expected b2b brand from org, got %', resolved ->> 'brand_name';
  end if;

  if resolved ->> 'logo_url' <> 'https://b2b.example/logo.png' then
    raise exception 'expected b2b logo from org, got %', resolved ->> 'logo_url';
  end if;

  if (resolved -> 'disclaimers')::jsonb <> '["B2B disclaimer"]'::jsonb then
    raise exception 'expected b2b disclaimers from org, got %', resolved -> 'disclaimers';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', personal_org_id::text))::text,
    true
  );

  resolved := public.resolve_report_white_label(retail_report_id, platform_defaults);

  if resolved ->> 'source' <> 'platform' then
    raise exception 'expected retail source=platform, got %', resolved ->> 'source';
  end if;

  if resolved ->> 'brand_name' <> 'Diligence OS' then
    raise exception 'expected retail brand from platform, got %', resolved ->> 'brand_name';
  end if;

  if resolved ->> 'logo_url' <> 'https://platform.example/logo.png' then
    raise exception 'expected retail logo from platform, got %', resolved ->> 'logo_url';
  end if;

  if (resolved -> 'disclaimers')::jsonb <> '["Platform disclaimer"]'::jsonb then
    raise exception 'expected retail disclaimers from platform, got %', resolved -> 'disclaimers';
  end if;

  reset role;
end;
$$;

rollback;
