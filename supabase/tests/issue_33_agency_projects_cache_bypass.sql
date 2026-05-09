begin;

do $$
declare
  user_agency uuid := '00000000-0000-0000-0000-000000000033';
  personal_org uuid;
  agency_org uuid;
  created_project uuid;
  company_id uuid;
  report_with_project uuid;
  report_without_project uuid;
  composition_id uuid;
  failed boolean := false;
begin
  delete from auth.users where id = user_agency;

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
    user_agency,
    'authenticated',
    'authenticated',
    'issue33-agency@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{"full_name":"Issue 33 Agency User"}'::jsonb,
    now(),
    now()
  );

  select personal_org_id into personal_org
  from public.user_profiles
  where user_id = user_agency;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', user_agency::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', personal_org::text))::text,
    true
  );

  select id into agency_org
  from public.create_organization(
    p_name => 'Acme Agency Org',
    p_plan => 'agency_basic',
    p_billing_email => 'billing@acme.example',
    p_gstin => '27ABCDE1234F1Z5'
  );

  if agency_org is null then
    raise exception 'expected create_organization to return org';
  end if;

  if (select org_type from public.organizations where id = agency_org) <> 'agency' then
    raise exception 'expected org_type agency for agency plan';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', agency_org::text))::text,
    true
  );

  select id into created_project
  from public.create_project(
    p_client_name => 'Client One',
    p_client_slug => 'client-one',
    p_white_label_config => '{"logo":"https://example.com/logo.png"}'::jsonb
  );

  if created_project is null then
    raise exception 'expected create_project to return id';
  end if;

  if (select org_id from public.projects where id = created_project) <> agency_org then
    raise exception 'expected project org_id to match active agency org';
  end if;

  select id into company_id
  from public.companies
  where cin = 'L00000MH2000PLC000033';

  if company_id is null then
    insert into public.companies (cin, legal_name, display_name, listing_status)
    values ('L00000MH2000PLC000033', 'Issue 33 Co Pvt Ltd', 'Issue 33 Co', 'listed')
    returning id into company_id;
  end if;

  insert into public.compositions (
    company_id,
    report_type,
    source_doc_set_hash,
    agent_version,
    payload,
    expires_at
  ) values (
    company_id,
    'lead_intel',
    'hash-issue-33',
    'v1',
    '{"summary":"cached"}'::jsonb,
    now() + interval '6 hours'
  ) returning id into composition_id;

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
  ) values (
    agency_org,
    created_project,
    company_id,
    'lead_intel',
    null,
    'hash-issue-33',
    'v1',
    'succeeded',
    '{"summary":"project report"}'::jsonb,
    user_agency
  ) returning id into report_with_project;

  if report_with_project is null then
    raise exception 'expected report with project insert to succeed';
  end if;

  begin
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
    ) values (
      agency_org,
      created_project,
      company_id,
      'lead_intel',
      composition_id,
      'hash-issue-33',
      'v1',
      'succeeded',
      '{"summary":"invalid report"}'::jsonb,
      user_agency
    );
  exception
    when check_violation then
      failed := true;
  end;

  if not failed then
    raise exception 'expected check_violation when project_id and composition_id are both set';
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
  ) values (
    agency_org,
    null,
    company_id,
    'lead_intel',
    composition_id,
    'hash-issue-33',
    'v1',
    'succeeded',
    '{"summary":"non-project report"}'::jsonb,
    user_agency
  ) returning id into report_without_project;

  if report_without_project is null then
    raise exception 'expected non-project report insert with composition to succeed';
  end if;

  reset role;
end;
$$;

rollback;
