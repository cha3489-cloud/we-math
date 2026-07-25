-- Serialize PIN reset/change work that crosses Postgres and Supabase Auth.
-- Lease (1 minute) exceeds the Edge Functions' bounded Auth request timeout.
-- reset_pin_expires_at is NULL for initial-account changes and non-NULL only for fixed-PIN resets.
-- Deploy both new Edge Functions and drain old invocations before applying this migration.

alter table public.profiles add column if not exists reset_pin_expires_at timestamptz;
alter table public.profiles add column if not exists pin_operation_id uuid;
alter table public.profiles add column if not exists pin_operation_kind text;
alter table public.profiles add column if not exists pin_operation_expires_at timestamptz;
alter table public.profiles drop constraint if exists profiles_pin_operation_complete;
alter table public.profiles add constraint profiles_pin_operation_complete check (
  (pin_operation_id is null and pin_operation_kind is null and pin_operation_expires_at is null)
  or (pin_operation_id is not null and pin_operation_kind in ('reset', 'change') and pin_operation_expires_at is not null)
);

create or replace function public.begin_student_pin_reset(p_user_id uuid, p_operation_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  target_role public.app_role; target_suspended_at timestamptz;
  target_operation_id uuid; target_operation_expires_at timestamptz; next_generation bigint;
begin
  if p_operation_id is null then raise exception 'operation id required' using errcode = '22023'; end if;
  select r.role, p.suspended_at, p.pin_operation_id, p.pin_operation_expires_at
    into target_role, target_suspended_at, target_operation_id, target_operation_expires_at
    from public.user_roles as r join public.profiles as p on p.id = r.user_id
   where r.user_id = p_user_id for update of r, p;
  if not found or target_role is distinct from 'student'::public.app_role or target_suspended_at is not null then
    raise exception 'active student account required' using errcode = '42501';
  end if;
  if target_operation_id is not null and target_operation_expires_at > now() then
    raise exception 'PIN operation already in progress' using errcode = '55P03';
  end if;
  update public.profiles
     set must_change_pin = true, pin_generation = pin_generation + 1,
         reset_pin_expires_at = now() + interval '10 minutes',
         pin_operation_id = p_operation_id, pin_operation_kind = 'reset',
         pin_operation_expires_at = now() + interval '1 minute', updated_at = now()
   where id = p_user_id returning pin_generation into next_generation;
  return next_generation;
end;
$$;

create or replace function public.finish_student_pin_reset(p_user_id uuid, p_generation bigint, p_operation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set pin_operation_id = null, pin_operation_kind = null,
         pin_operation_expires_at = null, updated_at = now()
   where id = p_user_id and pin_generation = p_generation and must_change_pin = true
     and pin_operation_id = p_operation_id and pin_operation_kind = 'reset';
  return found;
end;
$$;

create or replace function public.begin_student_pin_change(p_user_id uuid, p_generation bigint, p_operation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target public.profiles%rowtype;
begin
  if p_operation_id is null then raise exception 'operation id required' using errcode = '22023'; end if;
  select * into target from public.profiles where id = p_user_id for update;
  if not found or target.suspended_at is not null then raise exception 'active account required' using errcode = '42501'; end if;
  if target.pin_generation is distinct from p_generation or not target.must_change_pin then
    raise exception 'PIN change state changed' using errcode = '40001';
  end if;
  if target.reset_pin_expires_at is not null and target.reset_pin_expires_at <= now() then
    raise exception 'reset PIN expired; ask an administrator to reset it again' using errcode = '28000';
  end if;
  if target.pin_operation_id is not null and target.pin_operation_expires_at > now() then
    raise exception 'PIN operation already in progress' using errcode = '55P03';
  end if;
  update public.profiles set pin_operation_id = p_operation_id, pin_operation_kind = 'change',
         pin_operation_expires_at = now() + interval '1 minute', updated_at = now() where id = p_user_id;
  return true;
end;
$$;

create or replace function public.finish_student_pin_change(p_user_id uuid, p_generation bigint, p_operation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set must_change_pin = false, reset_pin_expires_at = null,
         pin_operation_id = null, pin_operation_kind = null,
         pin_operation_expires_at = null, updated_at = now()
   where id = p_user_id and pin_generation = p_generation and must_change_pin = true
     and pin_operation_id = p_operation_id and pin_operation_kind = 'change';
  return found;
end;
$$;

-- Old Edge invocations must be drained before this migration; fail closed on rollback.
drop function if exists public.mark_pin_reset(uuid);

revoke all on function public.begin_student_pin_reset(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_student_pin_reset(uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.begin_student_pin_change(uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.finish_student_pin_change(uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.begin_student_pin_reset(uuid, uuid) to service_role;
grant execute on function public.finish_student_pin_reset(uuid, bigint, uuid) to service_role;
grant execute on function public.begin_student_pin_change(uuid, bigint, uuid) to service_role;
grant execute on function public.finish_student_pin_change(uuid, bigint, uuid) to service_role;
