begin;

do $$
declare
  user_admin uuid := '00000000-0000-0000-0000-000000000351';
  user_viewer uuid := '00000000-0000-0000-0000-000000000352';
  user_other uuid := '00000000-0000-0000-0000-000000000353';
  org_admin uuid;
  org_other uuid;
  project_a uuid;
  can_view boolean := false;
  can_view_cost boolean := false;
  org_rows int;
  project_rows int;
  flagged_rows int;
  operator_rows int;
  operator_cost numeric;
begin
  delete from auth.users where id in (user_admin, user_viewer, user_other);

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
  values
    (
      user_admin,
      'authenticated',
      'authenticated',
      'issue35-admin@example.com',
      crypt('password', gen_salt('bf')),
      now(),
      '{}'::jsonb,
      '{"full_name":"Issue 35 Admin"}'::jsonb,
      now(),
      now()
    ),
    (
      user_viewer,
      'authenticated',
      'authenticated',
      'issue35-viewer@example.com',
      crypt('password', gen_salt('bf')),
      now(),
      '{}'::jsonb,
      '{"full_name":"Issue 35 Viewer"}'::jsonb,
      now(),
      now()
    ),
    (
      user_other,
      'authenticated',
      'authenticated',
      'issue35-other@example.com',
      crypt('password', gen_salt('bf')),
      now(),
      '{}'::jsonb,
      '{"full_name":"Issue 35 Other"}'::jsonb,
      now(),
      now()
    );

  select personal_org_id into org_admin from public.user_profiles where user_id = user_admin;
  select personal_org_id into org_other from public.user_profiles where user_id = user_other;

  insert into public.org_members (org_id, user_id, role)
  values (org_admin, user_viewer, 'viewer')
  on conflict (org_id, user_id) do update set role = excluded.role;

  insert into public.projects (org_id, client_name, client_slug, created_by)
  values (org_admin, 'Issue 35 Client', 'issue-35-client', user_admin)
  returning id into project_a;

  insert into public.audit_events (org_id, project_id, actor_id, kind, payload)
  values
    (
      org_admin,
      null,
      user_admin,
      'scrape',
      jsonb_build_object(
        'source_url',
        'https://example.com/source-a',
        'cost',
        1.25,
        'report_type',
        'due_diligence'
      )
    ),
    (
      org_admin,
      project_a,
      user_admin,
      'agent_run',
      jsonb_build_object(
        'agent_id',
        'due-diligence-analyst',
        'cost',
        2.5,
        'report_type',
        'due_diligence'
      )
    ),
    (
      org_admin,
      project_a,
      user_admin,
      'citation_verification_failed',
      jsonb_build_object(
        'claim_id',
        'claim-35-1',
        'source_document_id',
        '11111111-1111-1111-1111-111111111111',
        'quote',
        'mismatch quote'
      )
    ),
    (
      org_other,
      null,
      user_other,
      'agent_run',
      jsonb_build_object(
        'agent_id',
        'earnings-reviewer',
        'cost',
        9.0,
        'report_type',
        'earnings_summary'
      )
    );

  execute 'set local role authenticated';

  perform set_config('request.jwt.claim.sub', user_admin::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', org_admin::text))::text,
    true
  );

  select count(*)::int into org_rows
  from public.get_org_audit_log(null, 100);

  if org_rows <> 3 then
    raise exception 'expected 3 org-scoped audit rows, got %', org_rows;
  end if;

  select count(*)::int into project_rows
  from public.get_org_audit_log(project_a, 100);

  if project_rows <> 2 then
    raise exception 'expected 2 project-scoped rows, got %', project_rows;
  end if;

  select count(*)::int into flagged_rows
  from public.get_org_audit_log(project_a, 100)
  where kind = 'citation_verification_failed';

  if flagged_rows <> 1 then
    raise exception 'expected 1 citation_verification_failed row for review queue, got %', flagged_rows;
  end if;

  perform set_config('request.jwt.claim.sub', user_viewer::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', org_admin::text))::text,
    true
  );

  begin
    perform * from public.get_org_audit_log(null, 10);
    can_view := true;
  exception
    when others then
      can_view := false;
  end;

  if can_view then
    raise exception 'expected viewer role to be blocked from org audit log';
  end if;

  perform set_config('request.jwt.claim.sub', user_admin::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('app_metadata', json_build_object('active_org_id', org_admin::text))::text,
    true
  );

  begin
    perform * from public.get_internal_cost_dashboard(30);
    can_view_cost := true;
  exception
    when others then
      can_view_cost := false;
  end;

  if can_view_cost then
    raise exception 'expected non-platform-admin to be blocked from internal cost dashboard';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'app_metadata',
      json_build_object(
        'active_org_id',
        org_admin::text,
        'platform_admin',
        true
      )
    )::text,
    true
  );

  select count(*)::int, coalesce(sum(total_cost), 0)::numeric
  into operator_rows, operator_cost
  from public.get_internal_cost_dashboard(30);

  if operator_rows <> 2 then
    raise exception 'expected 2 grouped operator rows across org types, got %', operator_rows;
  end if;

  if operator_cost <> 11.5::numeric then
    raise exception 'expected grouped operator total cost 11.5, got %', operator_cost;
  end if;

  reset role;
end;
$$;

rollback;
