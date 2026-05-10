create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.delete_expired_compositions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.compositions
  where expires_at <= now();

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Nightly eviction for expired Layer 2 compositions.
do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'evict_expired_compositions_nightly'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'evict_expired_compositions_nightly',
    '17 2 * * *',
    'select public.delete_expired_compositions();'
  );
end;
$$;
