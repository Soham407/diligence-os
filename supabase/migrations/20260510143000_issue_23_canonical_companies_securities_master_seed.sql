create extension if not exists http with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.securities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  isin text unique not null,
  security_type text check (security_type in ('equity', 'debt', 'preference')),
  nse_symbol text,
  bse_code text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists securities_company_id_idx on public.securities (company_id);
create index if not exists securities_nse_symbol_idx on public.securities (nse_symbol);
create index if not exists securities_bse_code_idx on public.securities (bse_code);
create unique index if not exists one_primary_per_company
  on public.securities (company_id)
  where is_primary = true;

alter table public.companies disable row level security;
alter table public.securities disable row level security;

grant select on public.companies to anon, authenticated;
grant select on public.securities to anon, authenticated;

create or replace function public.refresh_canonical_companies_securities_master(
  p_nse_csv text default null,
  p_bse_csv text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  nse_url text := 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';
  bse_url text := 'https://api.bseindia.com/BseIndiaAPI/api/LitsOfScripCSVDownload/w?Group=&Scripcode=&segment=Equity&status=Active';
  nse_response extensions.http_response;
  bse_response extensions.http_response;
  nse_csv text;
  bse_csv text;
  rec record;
  v_company_id uuid;
  touched_company_count int := 0;
  nse_rows int := 0;
  bse_rows int := 0;
  company_inserts int := 0;
  security_upserts int := 0;
begin
  nse_csv := p_nse_csv;
  bse_csv := p_bse_csv;

  if nse_csv is null then
    select * into nse_response from extensions.http_get(nse_url);
    if nse_response.status < 200 or nse_response.status >= 300 then
      raise exception 'nse master csv fetch failed with status %', nse_response.status;
    end if;
    nse_csv := nse_response.content;
  end if;

  if bse_csv is null then
    select *
    into bse_response
    from extensions.http((
      'GET',
      bse_url,
      array[
        extensions.http_header('accept', 'text/csv,*/*'),
        extensions.http_header('origin', 'https://www.bseindia.com'),
        extensions.http_header('referer', 'https://www.bseindia.com/corporates/List_Scrips.html'),
        extensions.http_header('user-agent', 'Mozilla/5.0 (compatible; diligence-os-master-seeder/1.0)')
      ]::extensions.http_header[],
      null,
      null
    )::extensions.http_request);

    if bse_response.status < 200 or bse_response.status >= 300 then
      raise exception 'bse master csv fetch failed with status %', bse_response.status;
    end if;
    bse_csv := bse_response.content;
  end if;

  create temp table tmp_nse_master (
    isin text primary key,
    nse_symbol text,
    legal_name text,
    security_type text,
    exchange_rank int
  ) on commit drop;

  insert into tmp_nse_master (isin, nse_symbol, legal_name, security_type, exchange_rank)
  select
    upper(trim((m.captures)[7])) as isin,
    nullif(upper(trim((m.captures)[1])), '') as nse_symbol,
    nullif(trim(both '"' from (m.captures)[2]), '') as legal_name,
    'equity'::text,
    1
  from regexp_split_to_table(replace(nse_csv, E'\r', ''), E'\n') as line
  cross join lateral regexp_match(line, '^([^,]+),(.*),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+)$') as m(captures)
  where line !~* '^SYMBOL,'
    and nullif(trim(line), '') is not null
    and upper(trim((m.captures)[3])) in ('EQ', 'BE')
    and nullif(trim((m.captures)[7]), '') is not null
  on conflict (isin) do update
  set
    nse_symbol = excluded.nse_symbol,
    legal_name = excluded.legal_name,
    security_type = excluded.security_type,
    exchange_rank = excluded.exchange_rank;

  get diagnostics nse_rows = row_count;

  create temp table tmp_bse_master (
    isin text primary key,
    bse_code text,
    bse_symbol text,
    legal_name text,
    security_type text,
    exchange_rank int
  ) on commit drop;

  insert into tmp_bse_master (isin, bse_code, bse_symbol, legal_name, security_type, exchange_rank)
  select
    upper(trim(split_part(line, ',', 8))) as isin,
    nullif(trim(split_part(line, ',', 1)), '') as bse_code,
    nullif(upper(trim(split_part(line, ',', 3))), '') as bse_symbol,
    nullif(trim(split_part(line, ',', 2)), '') as legal_name,
    'equity'::text,
    2
  from regexp_split_to_table(replace(bse_csv, E'\r', ''), E'\n') as line
  where line !~* '^Security Code,'
    and nullif(trim(line), '') is not null
    and upper(trim(split_part(line, ',', 9))) = 'EQUITY'
    and nullif(trim(split_part(line, ',', 8)), '') is not null
  on conflict (isin) do update
  set
    bse_code = excluded.bse_code,
    bse_symbol = excluded.bse_symbol,
    legal_name = excluded.legal_name,
    security_type = excluded.security_type,
    exchange_rank = excluded.exchange_rank;

  get diagnostics bse_rows = row_count;

  create temp table tmp_master_merge (
    isin text primary key,
    nse_symbol text,
    bse_code text,
    legal_name text,
    display_name text,
    security_type text,
    exchange_rank int
  ) on commit drop;

  insert into tmp_master_merge (isin, nse_symbol, bse_code, legal_name, display_name, security_type, exchange_rank)
  select
    coalesce(n.isin, b.isin) as isin,
    n.nse_symbol,
    b.bse_code,
    coalesce(n.legal_name, b.legal_name) as legal_name,
    coalesce(nullif(n.nse_symbol, ''), nullif(b.bse_symbol, ''), coalesce(n.legal_name, b.legal_name)) as display_name,
    coalesce(n.security_type, b.security_type, 'equity') as security_type,
    least(coalesce(n.exchange_rank, 99), coalesce(b.exchange_rank, 99)) as exchange_rank
  from tmp_nse_master n
  full outer join tmp_bse_master b
    on b.isin = n.isin
  where coalesce(n.isin, b.isin) is not null;

  create temp table tmp_touched_companies (
    company_id uuid primary key
  ) on commit drop;

  for rec in
    select *
    from tmp_master_merge
    order by legal_name, exchange_rank, isin
  loop
    select s.company_id
      into v_company_id
    from public.securities s
    where s.isin = rec.isin
    limit 1;

    if v_company_id is null then
      select c.id
        into v_company_id
      from public.companies c
      where lower(c.legal_name) = lower(rec.legal_name)
      order by c.created_at asc
      limit 1;
    end if;

    if v_company_id is null then
      insert into public.companies (cin, legal_name, display_name, listing_status)
      values (null, rec.legal_name, rec.display_name, 'listed')
      returning id into v_company_id;
      company_inserts := company_inserts + 1;
    end if;

    insert into public.securities (company_id, isin, security_type, nse_symbol, bse_code, is_primary)
    values (v_company_id, rec.isin, rec.security_type, rec.nse_symbol, rec.bse_code, false)
    on conflict (isin) do update
    set
      company_id = excluded.company_id,
      security_type = excluded.security_type,
      nse_symbol = excluded.nse_symbol,
      bse_code = excluded.bse_code;

    security_upserts := security_upserts + 1;

    insert into tmp_touched_companies (company_id)
    values (v_company_id)
    on conflict (company_id) do nothing;
  end loop;

  select count(*) into touched_company_count from tmp_touched_companies;

  update public.securities s
  set is_primary = false
  where s.company_id in (select company_id from tmp_touched_companies);

  with ranked as (
    select
      s.id,
      row_number() over (
        partition by s.company_id
        order by
          case
            when s.security_type = 'equity' and s.nse_symbol is not null then 1
            when s.security_type = 'equity' and s.bse_code is not null then 2
            when s.security_type = 'equity' then 3
            else 99
          end,
          coalesce(s.nse_symbol, s.bse_code, s.isin)
      ) as rn
    from public.securities s
    where s.company_id in (select company_id from tmp_touched_companies)
  )
  update public.securities s
  set is_primary = (ranked.rn = 1)
  from ranked
  where ranked.id = s.id;

  return jsonb_build_object(
    'nse_rows', nse_rows,
    'bse_rows', bse_rows,
    'touched_companies', touched_company_count,
    'company_inserts', company_inserts,
    'security_upserts', security_upserts
  );
end;
$$;

-- Seed once at deploy time.
select public.refresh_canonical_companies_securities_master();

-- Nightly refresh job.
do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'refresh_canonical_companies_securities_master'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'refresh_canonical_companies_securities_master',
    '10 1 * * *',
    'select public.refresh_canonical_companies_securities_master();'
  );
end;
$$;
