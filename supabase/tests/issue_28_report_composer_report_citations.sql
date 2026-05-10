begin;

do $$
declare
  test_user_id uuid := '00000000-0000-0000-0000-000000000028';
  personal_org_id uuid;
  company_id uuid;
  source_doc_a uuid;
  source_doc_b uuid;
  created_report_id uuid;
  citation_count int;
  duplicate_failed boolean := false;
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
    'issue28-user@example.com',
    crypt('password', gen_salt('bf')),
    now(),
    '{}'::jsonb,
    '{"full_name":"Issue 28 User"}'::jsonb,
    now(),
    now()
  );

  select personal_org_id into personal_org_id
  from public.user_profiles
  where user_id = test_user_id;

  if personal_org_id is null then
    raise exception 'expected trigger-created personal org';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'report_citations'
      and indexname = 'report_citations_report_claim_idx'
  ) then
    raise exception 'expected report_citations_report_claim_idx to exist';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'report_citations'
      and indexname = 'report_citations_source_document_idx'
  ) then
    raise exception 'expected report_citations_source_document_idx to exist';
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', personal_org_id::text))::text,
    true
  );

  select id into company_id
  from public.companies
  where cin = 'L00000MH2000PLC000028';

  if company_id is null then
    insert into public.companies (cin, legal_name, display_name, listing_status)
    values ('L00000MH2000PLC000028', 'Issue 28 Company Ltd', 'Issue 28 Co', 'listed')
    returning id into company_id;
  end if;

  delete from public.source_documents
  where source_url in ('https://example.com/issue28/a', 'https://example.com/issue28/b')
    and fetched_at_window = '2026-05-10T19';

  insert into public.source_documents (
    company_id,
    kind,
    source_url,
    fetched_at_window,
    raw_content
  )
  values (
    company_id,
    'earnings_transcript',
    'https://example.com/issue28/a',
    '2026-05-10T19',
    'Revenue increased 12% year over year.'
  )
  returning id into source_doc_a;

  insert into public.source_documents (
    company_id,
    kind,
    source_url,
    fetched_at_window,
    raw_content
  )
  values (
    company_id,
    'earnings_transcript',
    'https://example.com/issue28/b',
    '2026-05-10T19',
    'Management guided for stable demand.'
  )
  returning id into source_doc_b;

  select id into created_report_id
  from public.create_report_with_citations(
    p_org_id => personal_org_id,
    p_project_id => null,
    p_company_id => company_id,
    p_report_type => 'earnings_summary',
    p_composition_id => null,
    p_source_doc_set_hash => 'hash-issue-28',
    p_agent_version => 'v1',
    p_status => 'succeeded',
    p_payload => '{"executive_summary":"ok"}'::jsonb,
    p_created_by => test_user_id,
    p_citations => jsonb_build_array(
      jsonb_build_object(
        'claim_id', 'claim-1',
        'source_document_id', source_doc_a,
        'locator', jsonb_build_object('type', 'pdf_page', 'page', 3),
        'quote', 'Revenue increased 12% year over year',
        'quote_verified', true
      ),
      jsonb_build_object(
        'claim_id', 'claim-2',
        'source_document_id', source_doc_b,
        'locator', jsonb_build_object('type', 'text_span', 'start_char', 0, 'end_char', 24),
        'quote', 'text that misses',
        'quote_verified', false
      )
    )
  );

  if created_report_id is null then
    raise exception 'expected create_report_with_citations to return a report id';
  end if;

  select count(*) into citation_count
  from public.report_citations
  where report_id = created_report_id;

  if citation_count <> 2 then
    raise exception 'expected 2 report_citations rows, got %', citation_count;
  end if;

  if not exists (
    select 1
    from public.report_citations
    where report_id = created_report_id
      and claim_id = 'claim-2'
      and quote_verified = false
  ) then
    raise exception 'expected quote_verified=false citation row to be stored';
  end if;

  begin
    insert into public.report_citations (
      report_id,
      claim_id,
      source_document_id,
      locator,
      quote
    )
    values (
      created_report_id,
      'claim-1',
      source_doc_a,
      '{"type":"pdf_page","page":3}'::jsonb,
      'Revenue increased 12% year over year'
    );
  exception
    when unique_violation then
      duplicate_failed := true;
  end;

  if not duplicate_failed then
    raise exception 'expected unique constraint on (report_id, claim_id, source_document_id) to reject duplicates';
  end if;

  reset role;
end;
$$;

rollback;
