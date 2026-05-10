begin;

do $$
declare
  test_user_id uuid := '00000000-0000-0000-0000-000000000030';
  personal_org_id uuid;
  company_id uuid;
  source_doc_id uuid;
  report_id uuid;
  completed_status text;
  citation_count int;
  created_job_id uuid;
begin
  if to_regclass('public.jobs') is null then
    raise exception 'expected public.jobs table to exist';
  end if;

  if to_regclass('public.job_events') is null then
    raise exception 'expected public.job_events table to exist';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'job_events'
  ) then
    raise exception 'expected public.job_events in supabase_realtime publication';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reports'
  ) then
    raise exception 'expected public.reports in supabase_realtime publication';
  end if;

  if not exists (
    select 1
    from cron.job
    where jobname = 'job_runner_every_10s'
  ) then
    raise exception 'expected job_runner_every_10s pg_cron schedule';
  end if;

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
    'issue30-user@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

  select personal_org_id into personal_org_id
  from public.user_profiles
  where user_id = test_user_id;

  if personal_org_id is null then
    raise exception 'expected trigger-created personal org';
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', personal_org_id::text))::text,
    true
  );

  insert into public.companies (cin, legal_name, display_name, listing_status)
  values ('L00000MH2000PLC000030', 'Issue 30 Company Ltd', 'Issue 30 Co', 'listed')
  on conflict (cin) do update set display_name = excluded.display_name
  returning id into company_id;

  insert into public.source_documents (
    company_id,
    kind,
    source_url,
    fetched_at_window,
    raw_content
  ) values (
    company_id,
    'earnings_transcript',
    'https://example.com/issue30/a',
    '2026-05-10T22',
    'Issue 30 source quote.'
  )
  on conflict (source_url, fetched_at_window) do update
  set raw_content = excluded.raw_content
  returning id into source_doc_id;

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
    personal_org_id,
    null,
    company_id,
    'due_diligence',
    null,
    'hash-issue-30',
    'v1',
    'running',
    null,
    test_user_id
  )
  returning id into report_id;

  insert into public.jobs (org_id, report_id, anthropic_session_id, status)
  values (personal_org_id, report_id, 'sess-issue-30', 'queued')
  returning id into created_job_id;

  insert into public.job_events (job_id, kind, payload)
  values (created_job_id, 'job_enqueued', '{"report_type":"due_diligence"}'::jsonb);

  perform public.complete_report_with_citations(
    p_report_id => report_id,
    p_payload => '{"executive_summary":"Issue 30 complete"}'::jsonb,
    p_status => 'succeeded',
    p_citations => jsonb_build_array(
      jsonb_build_object(
        'claim_id', 'claim-1',
        'source_document_id', source_doc_id,
        'locator', jsonb_build_object('type', 'pdf_page', 'page', 1),
        'quote', 'Issue 30 source quote.',
        'quote_verified', true
      )
    )
  );

  select status into completed_status
  from public.reports
  where id = report_id;

  if completed_status <> 'succeeded' then
    raise exception 'expected report status succeeded, got %', completed_status;
  end if;

  select count(*) into citation_count
  from public.report_citations rc
  where rc.report_id = report_id;

  if citation_count <> 1 then
    raise exception 'expected 1 materialized citation after report completion, got %', citation_count;
  end if;

  reset role;
end;
$$;

rollback;
