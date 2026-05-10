begin;

do $$
declare
  nse_csv text := E'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE\nI23NSE,Issue 23 Canonical Co Limited,EQ,01-JAN-2020,10,1,INEXAMPLE0011,10';
  bse_csv text := E'Security Code,Issuer Name,Security Id,Security Name,Status,Group,Face Value,ISIN No,Instrument\n900001,Issue 23 Canonical Co Limited,I23NSE,Issue 23 Canonical Co Limited,Active,A,10,INEXAMPLE0011,Equity\n900002,Issue 23 Canonical Co Limited,I23BSE,Issue 23 Canonical Co Limited,Active,A,10,INEXAMPLE0012,Equity';
  seeded jsonb;
  v_company_id uuid;
  v_security_count int;
  v_primary_count int;
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'securities'
  ) then
    raise exception 'expected public.securities table to exist';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'securities'
      and indexname = 'one_primary_per_company'
      and indexdef ilike '% where (is_primary = true)%'
  ) then
    raise exception 'expected one_primary_per_company partial unique index on securities';
  end if;

  if (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'companies') then
    raise exception 'expected companies relrowsecurity to be disabled';
  end if;

  if (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'securities') then
    raise exception 'expected securities relrowsecurity to be disabled';
  end if;

  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'companies' and grantee = 'anon' and privilege_type = 'SELECT'
  ) then
    raise exception 'expected anon select grant on companies';
  end if;

  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'securities' and grantee = 'anon' and privilege_type = 'SELECT'
  ) then
    raise exception 'expected anon select grant on securities';
  end if;

  select public.refresh_canonical_companies_securities_master(nse_csv, bse_csv)
  into seeded;

  if coalesce((seeded ->> 'nse_rows')::int, 0) < 1 then
    raise exception 'expected nse_rows >= 1 from seeded result, got %', seeded;
  end if;

  if coalesce((seeded ->> 'bse_rows')::int, 0) < 2 then
    raise exception 'expected bse_rows >= 2 from seeded result, got %', seeded;
  end if;

  select id into v_company_id
  from public.companies
  where legal_name = 'Issue 23 Canonical Co Limited'
  order by created_at desc
  limit 1;

  if v_company_id is null then
    raise exception 'expected seeded company for fixture legal_name';
  end if;

  select count(*) into v_security_count
  from public.securities
  where company_id = v_company_id;

  if v_security_count <> 2 then
    raise exception 'expected exactly 2 securities rows for fixture company, got %', v_security_count;
  end if;

  select count(*) into v_primary_count
  from public.securities
  where company_id = v_company_id and is_primary = true;

  if v_primary_count <> 1 then
    raise exception 'expected exactly one primary security, got %', v_primary_count;
  end if;

  if not exists (
    select 1
    from public.securities
    where company_id = v_company_id
      and isin = 'INEXAMPLE0011'
      and is_primary = true
      and nse_symbol = 'I23NSE'
  ) then
    raise exception 'expected NSE-linked security to be selected as deterministic primary';
  end if;

  if not exists (
    select 1
    from cron.job
    where jobname = 'refresh_canonical_companies_securities_master'
      and command ilike '%refresh_canonical_companies_securities_master%'
  ) then
    raise exception 'expected nightly cron job for master seeder';
  end if;
end;
$$;

rollback;
