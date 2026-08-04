create table if not exists public.consultation_intake_rate_limits (
  client_hash text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 1 check (request_count > 0),
  updated_at timestamptz not null default now()
);

create index if not exists consultation_intake_rate_limits_window_started_at_idx
  on public.consultation_intake_rate_limits (window_started_at);

alter table public.consultation_intake_rate_limits enable row level security;
revoke all on table public.consultation_intake_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.consultation_intake_rate_limits to service_role;

create or replace function public.check_consultation_intake_rate_limit(
  p_client_hash text,
  p_max_requests integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  is_allowed boolean;
begin
  if p_client_hash is null or length(p_client_hash) <> 64
    or p_max_requests is null or p_max_requests < 1 or p_max_requests > 100 then
    return false;
  end if;

  delete from public.consultation_intake_rate_limits
  where window_started_at < now() - interval '7 days';

  insert into public.consultation_intake_rate_limits (
    client_hash,
    window_started_at,
    request_count,
    updated_at
  )
  values (p_client_hash, now(), 1, now())
  on conflict (client_hash) do update
  set
    window_started_at = case
      when consultation_intake_rate_limits.window_started_at < now() - interval '1 hour' then now()
      else consultation_intake_rate_limits.window_started_at
    end,
    request_count = case
      when consultation_intake_rate_limits.window_started_at < now() - interval '1 hour' then 1
      else consultation_intake_rate_limits.request_count + 1
    end,
    updated_at = now()
  returning request_count <= p_max_requests into is_allowed;

  return is_allowed;
end;
$$;

revoke all on function public.check_consultation_intake_rate_limit(text, integer) from public, anon, authenticated;
grant execute on function public.check_consultation_intake_rate_limit(text, integer) to service_role;

create table if not exists public.consultation_intake_submissions (
  submission_id uuid primary key,
  status text not null check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  notion_page_id text
);

create index if not exists consultation_intake_submissions_updated_at_idx
  on public.consultation_intake_submissions (updated_at);

alter table public.consultation_intake_submissions enable row level security;
revoke all on table public.consultation_intake_submissions from public, anon, authenticated;
grant select, insert, update, delete on table public.consultation_intake_submissions to service_role;

create or replace function public.claim_consultation_intake_submission(p_submission_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
  current_status text;
  current_updated_at timestamptz;
begin
  if p_submission_id is null then
    raise exception 'submission id is required';
  end if;

  delete from public.consultation_intake_submissions
  where (status = 'failed' and updated_at < now() - interval '7 days')
     or (status = 'completed' and completed_at < now() - interval '1 year')
     or (status = 'pending' and updated_at < now() - interval '1 year');

  insert into public.consultation_intake_submissions (submission_id, status)
  values (p_submission_id, 'pending')
  on conflict (submission_id) do nothing;
  get diagnostics inserted_count = row_count;

  if inserted_count = 1 then
    return 'claimed';
  end if;

  select status, updated_at into current_status, current_updated_at
  from public.consultation_intake_submissions
  where submission_id = p_submission_id
  for update;

  if current_status = 'completed' then
    return 'completed';
  elsif current_status = 'failed' then
    update public.consultation_intake_submissions
    set status = 'pending', updated_at = now(), completed_at = null, notion_page_id = null
    where submission_id = p_submission_id;
    return 'claimed';
  elsif current_status = 'pending' and current_updated_at < now() - interval '2 minutes' then
    update public.consultation_intake_submissions
    set updated_at = now()
    where submission_id = p_submission_id;
    return 'reconcile';
  end if;

  return 'pending';
end;
$$;

create or replace function public.complete_consultation_intake_submission(
  p_submission_id uuid,
  p_notion_page_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_notion_page_id is null or btrim(p_notion_page_id) = '' then
    return false;
  end if;

  update public.consultation_intake_submissions
  set status = 'completed', updated_at = now(), completed_at = now(), notion_page_id = p_notion_page_id
  where submission_id = p_submission_id and status = 'pending';
  return found;
end;
$$;

create or replace function public.fail_consultation_intake_submission(p_submission_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.consultation_intake_submissions
  set status = 'failed', updated_at = now(), completed_at = null, notion_page_id = null
  where submission_id = p_submission_id and status = 'pending';
  return found;
end;
$$;

revoke all on function public.claim_consultation_intake_submission(uuid) from public, anon, authenticated;
revoke all on function public.complete_consultation_intake_submission(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_consultation_intake_submission(uuid) from public, anon, authenticated;
grant execute on function public.claim_consultation_intake_submission(uuid) to service_role;
grant execute on function public.complete_consultation_intake_submission(uuid, text) to service_role;
grant execute on function public.fail_consultation_intake_submission(uuid) to service_role;
