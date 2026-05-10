begin;

do $$
declare
  v_company_id uuid;
  deleted_count integer;
  remaining_count integer;
begin
  insert into public.companies (cin, legal_name, display_name, listing_status)
  values ('L00000MH2000PLC000029', 'Issue 29 Co Pvt Ltd', 'Issue 29 Co', 'listed')
  returning id into v_company_id;

  insert into public.compositions (
    company_id,
    report_type,
    source_doc_set_hash,
    agent_version,
    payload,
    expires_at
  ) values
    (v_company_id, 'earnings_summary', 'hash-expired-29', 'v1', '{"summary":"expired"}'::jsonb, now() - interval '1 hour'),
    (v_company_id, 'earnings_summary', 'hash-active-29', 'v1', '{"summary":"active"}'::jsonb, now() + interval '1 hour');

  select public.delete_expired_compositions() into deleted_count;

  if deleted_count <> 1 then
    raise exception 'expected delete_expired_compositions to delete 1 row, got %', deleted_count;
  end if;

  select count(*) into remaining_count
  from public.compositions
  where company_id = v_company_id
    and source_doc_set_hash = 'hash-active-29';

  if remaining_count <> 1 then
    raise exception 'expected active composition to remain, got % rows', remaining_count;
  end if;

  if exists (
    select 1
    from public.compositions
    where company_id = v_company_id
      and source_doc_set_hash = 'hash-expired-29'
  ) then
    raise exception 'expected expired composition to be deleted';
  end if;
end;
$$;

rollback;
