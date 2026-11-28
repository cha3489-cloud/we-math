-- Sequence Math entrance kiosk attendance core.
-- Repository-only until the production migration gate is approved.
--
-- Scope of this migration:
--   * class_sessions: the scheduled class a student attends (attendance roster = public.students).
--   * student_attendance_codes: six-digit entrance numbers stored ONLY as an HMAC verifier.
--   * academy_devices: registered entrance kiosks (token hash only).
--   * private kiosk rate-limit buckets.
--   * attendance_exceptions: per student + class_session expected-late / planned-absence.
--   * attendance_followups: missing-attendance and checkout-needed admin work.
--   * operations_audit: immutable before/after audit with secret columns redacted.
--
-- Attendance-code boundary (see supabase/functions/attendance-code):
--   * The raw six-digit code never reaches PostgREST or this database. The attendance-code Edge
--     Function computes verifier = HMAC-SHA-256(function secret, code); the secret lives only in
--     the Edge Function environment, never in a table, migration, or log.
--   * service_kiosk_attendance(): kiosk transition, executable by service_role only.
--   * admin_store_attendance_code_verifier(): authenticated admin rotation of a verifier.
--   * No code is generated here. Admins issue the first code from the registry UI.
--
-- Entrance numbers are NOT login credentials. Learning tablets keep phone + PIN login.

create schema if not exists private;
revoke all on schema private from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema private from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema private from authenticated'; end if;
end;
$$;

-- ── trusted server-side actor context ───────────────────────────────────────
-- Only SECURITY DEFINER functions in this repository set these transaction-local settings.
-- Direct table writes remain blocked by RLS and grants; this marker only narrows which
-- server path performed a write so triggers can attribute it without an admin profile.
create function private.trusted_actor()
returns text
language sql
stable
set search_path = ''
as $$ select nullif(current_setting('sequence.trusted_actor', true), '') $$;

create function private.trusted_device()
returns uuid
language sql
stable
set search_path = ''
as $$ select nullif(current_setting('sequence.trusted_device', true), '')::uuid $$;

create function private.begin_trusted(p_kind text, p_device uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_kind not in ('kiosk', 'system', 'makeup_selection', 'admin_correction', 'service') then
    raise exception 'invalid trusted actor' using errcode = '22023';
  end if;
  perform set_config('sequence.trusted_actor', p_kind, true);
  perform set_config('sequence.trusted_device', coalesce(p_device::text, ''), true);
end;
$$;

create function private.end_trusted()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('sequence.trusted_actor', '', true);
  perform set_config('sequence.trusted_device', '', true);
end;
$$;

create function private.actor_kind()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when private.trusted_actor() in ('kiosk', 'system', 'makeup_selection', 'service') then private.trusted_actor()
    when auth.uid() is null then 'system'
    else 'admin'
  end
$$;

-- ── immutable operations audit ──────────────────────────────────────────────
create table public.operations_audit (
  id bigint generated always as identity primary key,
  entity text not null check (entity ~ '^[a-z_]{1,60}$'),
  entity_id uuid not null,
  action text not null check (action in ('INSERT', 'UPDATE')),
  before_data jsonb,
  after_data jsonb,
  actor_id uuid references public.profiles(id) on delete restrict,
  actor_kind text not null check (actor_kind in ('admin', 'kiosk', 'system', 'makeup_selection', 'service')),
  device_id uuid,
  occurred_at timestamptz not null default now(),
  check (actor_id is not null or actor_kind <> 'admin')
);
create index operations_audit_entity_idx on public.operations_audit (entity, entity_id, occurred_at desc);

create function private.redact_audit(p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_row - array[
    'code_verifier', 'token_hash', 'selection_token_hash', 'phone', 'recipient_phone', 'provider_secret',
    'internal_note', 'rendered_body', 'recipient_label', 'recipient_phone_last4',
    'manual_followup_note', 'owner_note', 'body'
  ]
$$;

create function private.audit_operation_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := private.actor_kind();
begin
  insert into public.operations_audit (entity, entity_id, action, before_data, after_data, actor_id, actor_kind, device_id, occurred_at)
  values (
    tg_table_name,
    new.id,
    tg_op,
    case when tg_op = 'UPDATE' then private.redact_audit(to_jsonb(old)) else null end,
    private.redact_audit(to_jsonb(new)),
    case when v_kind = 'admin' then auth.uid() else null end,
    v_kind,
    private.trusted_device(),
    now()
  );
  return new;
end;
$$;

create function private.reject_operations_audit_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'operations audit rows are immutable' using errcode = '42501';
end;
$$;

create trigger reject_operations_audit_change
  before update or delete on public.operations_audit
  for each row execute function private.reject_operations_audit_change();

alter table public.operations_audit enable row level security;
create policy "admins read operations audit" on public.operations_audit
  for select to authenticated using (public.is_admin());
revoke all on table public.operations_audit from public, anon, authenticated;
grant select on table public.operations_audit to authenticated;

-- ── class sessions ──────────────────────────────────────────────────────────
create table public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  class_group_id uuid not null references public.class_groups(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'completed')),
  capacity integer not null default 8 check (capacity between 1 and 100),
  late_after_minutes integer not null default 15 check (late_after_minutes between 0 and 120),
  missing_after_minutes integer not null default 15 check (missing_after_minutes between 0 and 180),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (missing_after_minutes >= late_after_minutes),
  unique (class_group_id, starts_at)
);
create index class_sessions_starts_idx on public.class_sessions (starts_at, status);

create trigger prepare_class_sessions before insert or update on public.class_sessions
  for each row execute function public.prepare_student_registry_row();
create trigger audit_class_sessions after insert or update on public.class_sessions
  for each row execute function private.audit_operation_row();

alter table public.class_sessions enable row level security;
create policy "admins read class sessions" on public.class_sessions
  for select to authenticated using (public.is_admin());
revoke all on table public.class_sessions from public, anon, authenticated;
grant select on table public.class_sessions to authenticated;

-- ── attendance record extensions ───────────────────────────────────────────
alter table public.attendance_records
  add column class_session_id uuid references public.class_sessions(id) on delete restrict,
  add column check_in_source text check (check_in_source in ('kiosk', 'admin_manual')),
  add column check_in_device_id uuid,
  add column check_in_reason text check (check_in_reason is null or char_length(btrim(check_in_reason)) between 1 and 300),
  add column checkout_source text check (checkout_source in ('kiosk', 'admin_manual', 'admin_correction')),
  add column checkout_reason text check (checkout_reason is null or char_length(btrim(checkout_reason)) between 1 and 300),
  add column updated_via text not null default 'admin' check (updated_via in ('admin', 'kiosk', 'system', 'makeup_selection', 'service'));

alter table public.attendance_records alter column updated_by drop not null;
alter table public.attendance_records
  add constraint attendance_records_updated_actor_check check (updated_by is not null or updated_via <> 'admin'),
  add constraint attendance_records_student_session_key unique (student_id, class_session_id),
  add constraint attendance_records_checkout_origin_check check (checked_out_at is null or checkout_source is not null or updated_via = 'admin');
create index attendance_records_session_idx on public.attendance_records (class_session_id, status);

alter table public.attendance_events alter column actor_id drop not null;
alter table public.attendance_events
  add column actor_kind text not null default 'admin' check (actor_kind in ('admin', 'kiosk', 'system', 'makeup_selection', 'service')),
  add column device_id uuid,
  add constraint attendance_events_actor_check check (actor_id is not null or actor_kind <> 'admin');

create or replace function public.touch_attendance_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trusted text := private.trusted_actor();
begin
  if v_trusted is null and not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if v_trusted = 'admin_correction' and not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if new.student_id is distinct from old.student_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'attendance ownership is immutable' using errcode = '42501';
  end if;
  if old.class_session_id is not null and new.class_session_id is distinct from old.class_session_id then
    raise exception 'attendance session is immutable' using errcode = '42501';
  end if;
  if old.checked_out_at is not null
     and new.checked_out_at is distinct from old.checked_out_at
     and v_trusted is distinct from 'admin_correction' then
    raise exception 'checkout time changes require an admin correction' using errcode = '23514';
  end if;
  if v_trusted is null or v_trusted = 'admin_correction' then
    new.updated_by := auth.uid();
    new.updated_via := 'admin';
  else
    new.updated_by := null;
    new.updated_via := v_trusted;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.touch_attendance_record() from public, anon, authenticated;

create function private.attendance_event_state(p_row public.attendance_records)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'status', p_row.status,
    'scheduled_at', p_row.scheduled_at,
    'class_session_id', p_row.class_session_id,
    'checked_in_at', p_row.checked_in_at,
    'checked_out_at', p_row.checked_out_at,
    'check_in_source', p_row.check_in_source,
    'checkout_source', p_row.checkout_source,
    'check_in_device_id', p_row.check_in_device_id,
    'guardian_contact_status', p_row.guardian_contact_status,
    'guardian_contacted_at', p_row.guardian_contacted_at,
    'updated_via', p_row.updated_via
  )
$$;

create or replace function public.record_attendance_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := private.actor_kind();
begin
  insert into public.attendance_events (attendance_id, event_type, actor_id, actor_kind, device_id, details)
  values (
    new.id,
    case when tg_op = 'INSERT' then 'attendance_created' else 'attendance_updated' end,
    case when v_kind = 'admin' then auth.uid() else null end,
    v_kind,
    private.trusted_device(),
    jsonb_build_object(
      'before', case when tg_op = 'UPDATE' then private.attendance_event_state(old) else null end,
      'after', private.attendance_event_state(new)
    )
  );
  return new;
end;
$$;
revoke all on function public.record_attendance_event() from public, anon, authenticated;

-- Attendance records generated from a class session are created by the admin RPC below.
create function public.admin_create_class_session(
  p_class_group_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_capacity integer default 8
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'invalid class session time' using errcode = '22023';
  end if;
  if p_ends_at - p_starts_at > interval '6 hours' then
    raise exception 'class session is too long' using errcode = '22023';
  end if;
  if not exists (select 1 from public.class_groups where id = p_class_group_id and is_active) then
    raise exception 'active class group required' using errcode = '23503';
  end if;

  insert into public.class_sessions (class_group_id, starts_at, ends_at, capacity)
  values (p_class_group_id, p_starts_at, p_ends_at, coalesce(p_capacity, 8))
  returning id into v_session_id;

  insert into public.attendance_records (student_id, scheduled_at, status, class_session_id, created_by, updated_by)
  select e.student_id, p_starts_at, 'scheduled', v_session_id, auth.uid(), auth.uid()
  from public.enrollments e
  join public.students st on st.id = e.student_id
  where e.class_group_id = p_class_group_id
    and e.status = 'active'
    and st.status in ('active', 'returning')
  on conflict do nothing;

  return v_session_id;
end;
$$;

create function public.admin_cancel_class_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.class_sessions set status = 'cancelled' where id = p_session_id and status = 'scheduled';
  if not found then raise exception 'class session state changed' using errcode = '40001'; end if;
end;
$$;

revoke all on function public.admin_create_class_session(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.admin_create_class_session(uuid, timestamptz, timestamptz, integer) to authenticated;
revoke all on function public.admin_cancel_class_session(uuid) from public, anon;
grant execute on function public.admin_cancel_class_session(uuid) to authenticated;

-- ── student attendance codes ───────────────────────────────────────────────
-- code_verifier is the Edge Function's HMAC-SHA-256 output (64 lowercase hex). It is unique across
-- the whole history, so siblings can never share an active number and a revoked number is never
-- handed out again.
create table public.student_attendance_codes (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  code_verifier text not null unique check (code_verifier ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  issue_kind text not null check (issue_kind in ('issued', 'rotated')),
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason in ('rotated', 'revoked')),
  created_by uuid references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  check ((active and revoked_at is null and revoke_reason is null) or (not active and revoked_at is not null and revoke_reason is not null))
);
create unique index student_attendance_codes_one_active_idx on public.student_attendance_codes (student_id) where active;

create function private.prepare_attendance_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    new.issued_at := now();
    new.created_by := case when private.actor_kind() = 'admin' then auth.uid() else null end;
  else
    if new.student_id is distinct from old.student_id or new.code_verifier is distinct from old.code_verifier
       or new.issued_at is distinct from old.issued_at or new.created_by is distinct from old.created_by then
      raise exception 'attendance code identity is immutable' using errcode = '42501';
    end if;
    if not old.active and new.active then
      raise exception 'revoked attendance code cannot be reactivated' using errcode = '23514';
    end if;
  end if;
  new.updated_by := case when private.actor_kind() = 'admin' then auth.uid() else null end;
  new.updated_at := now();
  return new;
end;
$$;
create trigger prepare_student_attendance_codes before insert or update on public.student_attendance_codes
  for each row execute function private.prepare_attendance_code();
create trigger audit_student_attendance_codes after insert or update on public.student_attendance_codes
  for each row execute function private.audit_operation_row();

alter table public.student_attendance_codes enable row level security;
create policy "admins read attendance code status" on public.student_attendance_codes
  for select to authenticated using (public.is_admin());
revoke all on table public.student_attendance_codes from public, anon, authenticated;
-- code_verifier is intentionally not granted to any browser role.
grant select (id, student_id, active, issue_kind, issued_at, revoked_at, revoke_reason) on table public.student_attendance_codes to authenticated;

-- Called by the attendance-code Edge Function with the admin's own JWT (user-scoped client), so
-- is_admin() and auth.uid() describe the real operator. Only the verifier is accepted; the
-- plaintext code is generated and returned once by the Edge Function and never reaches here.
-- Rotation is atomic: a verifier collision (23505) aborts the whole call, leaving the current
-- code active, and the Edge Function retries with a fresh random code.
create function public.admin_store_attendance_code_verifier(p_student_id uuid, p_code_verifier text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rotating boolean;
  v_issued_at timestamptz;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if coalesce(p_code_verifier, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid attendance code verifier' using errcode = '22023';
  end if;
  perform 1 from public.students where id = p_student_id and status <> 'withdrawn' for update;
  if not found then raise exception 'student not found' using errcode = '23503'; end if;
  -- History-wide uniqueness: never reuse a sibling's or a revoked verifier.
  if exists (select 1 from public.student_attendance_codes where code_verifier = p_code_verifier) then
    raise exception 'attendance code verifier already used' using errcode = '23505';
  end if;
  v_rotating := exists (select 1 from public.student_attendance_codes where student_id = p_student_id and active);
  update public.student_attendance_codes
    set active = false, revoked_at = now(), revoke_reason = 'rotated'
    where student_id = p_student_id and active;
  insert into public.student_attendance_codes (student_id, code_verifier, issue_kind)
    values (p_student_id, p_code_verifier, case when v_rotating then 'rotated' else 'issued' end)
    returning issued_at into v_issued_at;
  return jsonb_build_object('issue_kind', case when v_rotating then 'rotated' else 'issued' end, 'issued_at', v_issued_at);
end;
$$;

create function public.admin_revoke_attendance_code(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.student_attendance_codes
    set active = false, revoked_at = now(), revoke_reason = 'revoked'
    where student_id = p_student_id and active;
  if not found then raise exception 'no active attendance code' using errcode = '40001'; end if;
end;
$$;

revoke all on function public.admin_store_attendance_code_verifier(uuid, text) from public, anon;
grant execute on function public.admin_store_attendance_code_verifier(uuid, text) to authenticated;
revoke all on function public.admin_revoke_attendance_code(uuid) from public, anon;
grant execute on function public.admin_revoke_attendance_code(uuid) to authenticated;

-- Intentionally no insert trigger or backfill: a code generated here could never be shown to an
-- operator. Existing and new students start without a code; admins issue one from the registry.

-- ── registered kiosk devices ───────────────────────────────────────────────
create table public.academy_devices (
  id uuid primary key default gen_random_uuid(),
  device_name text not null check (char_length(btrim(device_name)) between 1 and 60),
  device_kind text not null default 'kiosk' check (device_kind in ('kiosk', 'learning_plan')),
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  revoked_by uuid references public.profiles(id) on delete restrict,
  revoked_at timestamptz,
  check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null))
);
create trigger audit_academy_devices after insert or update of device_name, status, revoked_at on public.academy_devices
  for each row execute function private.audit_operation_row();

alter table public.academy_devices enable row level security;
create policy "admins read devices" on public.academy_devices for select to authenticated using (public.is_admin());
revoke all on table public.academy_devices from public, anon, authenticated;
grant select (id, device_name, device_kind, status, last_seen_at, created_at, revoked_at) on table public.academy_devices to authenticated;

create function private.token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$ select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') $$;

create function private.random_token()
returns text
language sql
volatile
set search_path = ''
as $$ select encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex') $$;

create function public.admin_register_kiosk_device(p_device_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := private.random_token();
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  insert into public.academy_devices (device_name, device_kind, token_hash, created_by)
  values (btrim(coalesce(p_device_name, '')), 'kiosk', private.token_hash(v_token), auth.uid());
  -- Shown once for kiosk setup; only the hash is stored.
  return v_token;
end;
$$;

create function public.admin_revoke_kiosk_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.academy_devices set status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
    where id = p_device_id and status = 'active' and device_kind = 'kiosk';
  if not found then raise exception 'device state changed' using errcode = '40001'; end if;
end;
$$;
revoke all on function public.admin_register_kiosk_device(text) from public, anon;
grant execute on function public.admin_register_kiosk_device(text) to authenticated;
revoke all on function public.admin_revoke_kiosk_device(uuid) from public, anon;
grant execute on function public.admin_revoke_kiosk_device(uuid) to authenticated;

-- ── kiosk rate limiting ────────────────────────────────────────────────────
create table private.kiosk_attempt_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  failures integer not null default 0 check (failures >= 0),
  primary key (bucket_key, window_start)
);
revoke all on table private.kiosk_attempt_buckets from public;

create function private.kiosk_window(p_now timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select to_timestamp(floor(extract(epoch from p_now) / 600) * 600) $$;

create function private.kiosk_is_limited(p_keys text[], p_now timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from private.kiosk_attempt_buckets b
    where b.bucket_key = any(p_keys)
      and b.window_start = private.kiosk_window(p_now)
      and b.failures >= case
        when b.bucket_key like 'code:%' then 10
        when b.bucket_key like 'device:%' then 50
        when b.bucket_key like 'ip:%' then 100
        else 10
      end
  )
$$;

create function private.kiosk_note_failure(p_keys text[], p_now timestamptz)
returns void
language sql
set search_path = ''
as $$
  insert into private.kiosk_attempt_buckets (bucket_key, window_start, failures)
  select k, private.kiosk_window(p_now), 1 from unnest(p_keys) k where k is not null
  on conflict (bucket_key, window_start) do update set failures = private.kiosk_attempt_buckets.failures + 1
$$;

-- ── attendance exceptions ──────────────────────────────────────────────────
create table public.attendance_exceptions (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete restrict,
  student_id uuid not null references public.students(id) on delete restrict,
  class_session_id uuid not null references public.class_sessions(id) on delete restrict,
  exception_type text not null check (exception_type in ('expected_late', 'planned_absence')),
  expected_arrival_at timestamptz,
  reason_category text check (reason_category in ('medical', 'family', 'school', 'other')),
  internal_note text not null default '' check (char_length(internal_note) <= 500),
  suppress_late_message boolean not null default true,
  suppress_missing_message boolean not null default true,
  suppress_absence_message boolean not null default true,
  status text not null default 'active' check (status in ('active', 'cancelled', 'consumed', 'expired')),
  created_by uuid references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (exception_type = 'expected_late' or expected_arrival_at is null)
);
create unique index attendance_exceptions_one_active_idx
  on public.attendance_exceptions (student_id, class_session_id) where status = 'active';

create function private.prepare_attendance_exception()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_actor uuid := case when private.actor_kind() = 'admin' then auth.uid() else null end;
begin
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    new.created_by := v_admin_actor;
    new.created_at := now();
    new.status := 'active';
  else
    if new.attendance_id is distinct from old.attendance_id or new.student_id is distinct from old.student_id
       or new.class_session_id is distinct from old.class_session_id or new.exception_type is distinct from old.exception_type
       or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'attendance exception scope is immutable' using errcode = '42501';
    end if;
    if old.status <> 'active' and new.status is distinct from old.status then
      raise exception 'final attendance exception status is immutable' using errcode = '23514';
    end if;
  end if;
  new.updated_by := v_admin_actor;
  new.updated_at := now();
  return new;
end;
$$;
create trigger prepare_attendance_exceptions before insert or update on public.attendance_exceptions
  for each row execute function private.prepare_attendance_exception();
create trigger audit_attendance_exceptions after insert or update on public.attendance_exceptions
  for each row execute function private.audit_operation_row();

alter table public.attendance_exceptions enable row level security;
create policy "admins read attendance exceptions" on public.attendance_exceptions
  for select to authenticated using (public.is_admin());
revoke all on table public.attendance_exceptions from public, anon, authenticated;
grant select on table public.attendance_exceptions to authenticated;

-- Any non-cancelled exception scoped to the exact student + class_session suppresses
-- late / missing / absence outbox generation for that session only.
create function private.has_suppressing_exception(p_student_id uuid, p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_session_id is not null and exists (
    select 1 from public.attendance_exceptions e
    where e.student_id = p_student_id and e.class_session_id = p_session_id and e.status <> 'cancelled'
  )
$$;

create function public.admin_set_attendance_exception(
  p_attendance_id uuid,
  p_exception_type text,
  p_expected_arrival_at timestamptz default null,
  p_reason_category text default null,
  p_internal_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
  v_session public.class_sessions%rowtype;
  v_id uuid;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if p_exception_type not in ('expected_late', 'planned_absence') then raise exception 'invalid exception type' using errcode = '22023'; end if;
  select * into v_record from public.attendance_records where id = p_attendance_id for update;
  if v_record.id is null or v_record.class_session_id is null then raise exception 'scheduled class attendance required' using errcode = '23503'; end if;
  if v_record.status <> 'scheduled' then raise exception 'attendance state changed' using errcode = '40001'; end if;
  select * into v_session from public.class_sessions where id = v_record.class_session_id;
  if v_session.status <> 'scheduled' or v_session.ends_at <= now() then
    raise exception 'class session already ended' using errcode = '23514';
  end if;
  insert into public.attendance_exceptions (
    attendance_id, student_id, class_session_id, exception_type, expected_arrival_at, reason_category, internal_note
  ) values (
    v_record.id, v_record.student_id, v_record.class_session_id, p_exception_type,
    case when p_exception_type = 'expected_late' then p_expected_arrival_at else null end,
    p_reason_category, btrim(coalesce(p_internal_note, ''))
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'an active exception already exists for this class' using errcode = '40001';
end;
$$;

create function public.admin_cancel_attendance_exception(p_exception_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  -- Lock the attendance row first: arrival and makeup selection lock attendance before the
  -- exception / offer rows, so cancellation must use the same order to serialize, not deadlock.
  perform 1 from public.attendance_records
    where id = (select attendance_id from public.attendance_exceptions where id = p_exception_id)
    for update;
  update public.attendance_exceptions set status = 'cancelled' where id = p_exception_id and status = 'active';
  if not found then raise exception 'attendance exception state changed' using errcode = '40001'; end if;
end;
$$;
revoke all on function public.admin_set_attendance_exception(uuid, text, timestamptz, text, text) from public, anon;
grant execute on function public.admin_set_attendance_exception(uuid, text, timestamptz, text, text) to authenticated;
revoke all on function public.admin_cancel_attendance_exception(uuid) from public, anon;
grant execute on function public.admin_cancel_attendance_exception(uuid) to authenticated;

-- ── attendance follow-ups ──────────────────────────────────────────────────
create table public.attendance_followups (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete restrict,
  kind text not null check (kind in ('missing', 'checkout_needed')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (resolution in ('arrived', 'checked_out', 'absence_recorded', 'session_cancelled')),
  unique (attendance_id, kind),
  check ((status = 'open' and resolved_at is null and resolution is null) or (status = 'resolved' and resolved_at is not null and resolution is not null))
);
create index attendance_followups_open_idx on public.attendance_followups (status, kind, opened_at);
create trigger audit_attendance_followups after insert or update on public.attendance_followups
  for each row execute function private.audit_operation_row();

create function private.guard_attendance_followup()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.attendance_id is distinct from old.attendance_id or new.kind is distinct from old.kind or new.opened_at is distinct from old.opened_at then
    raise exception 'attendance follow-up identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'resolved' and (new.status, new.resolved_at, new.resolution) is distinct from (old.status, old.resolved_at, old.resolution) then
    raise exception 'resolved follow-up is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger guard_attendance_followups before update on public.attendance_followups
  for each row execute function private.guard_attendance_followup();

alter table public.attendance_followups enable row level security;
create policy "admins read attendance followups" on public.attendance_followups
  for select to authenticated using (public.is_admin());
revoke all on table public.attendance_followups from public, anon, authenticated;
grant select on table public.attendance_followups to authenticated;

-- Keep follow-ups and exceptions consistent with the actual attendance state.
create function private.sync_attendance_followups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'scheduled' and new.status in ('present', 'late') then
    update public.attendance_followups set status = 'resolved', resolved_at = now(), resolution = 'arrived'
      where attendance_id = new.id and kind = 'missing' and status = 'open';
    update public.attendance_exceptions set status = 'consumed'
      where student_id = new.student_id and class_session_id = new.class_session_id and status = 'active';
  elsif old.status = 'scheduled' and new.status in ('absent', 'excused') then
    update public.attendance_followups set status = 'resolved', resolved_at = now(), resolution = 'absence_recorded'
      where attendance_id = new.id and kind = 'missing' and status = 'open';
  end if;
  if old.checked_out_at is null and new.checked_out_at is not null then
    update public.attendance_followups set status = 'resolved', resolved_at = now(), resolution = 'checked_out'
      where attendance_id = new.id and kind = 'checkout_needed' and status = 'open';
  end if;
  return new;
end;
$$;
create trigger sync_attendance_followups after update of status, checked_out_at on public.attendance_records
  for each row execute function private.sync_attendance_followups();

create function private.run_attendance_followups(p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired integer;
  v_missing integer;
  v_checkout integer;
begin
  update public.attendance_exceptions e set status = 'expired'
    from public.class_sessions s
    where s.id = e.class_session_id and e.status = 'active' and s.ends_at < p_now;
  get diagnostics v_expired = row_count;

  insert into public.attendance_followups (attendance_id, kind, opened_at)
  select r.id, 'missing', p_now
  from public.attendance_records r
  join public.class_sessions s on s.id = r.class_session_id
  where s.status = 'scheduled'
    and r.status = 'scheduled'
    and r.checked_in_at is null
    and p_now > s.starts_at + make_interval(mins => s.missing_after_minutes)
    and not private.has_suppressing_exception(r.student_id, r.class_session_id)
  on conflict (attendance_id, kind) do nothing;
  get diagnostics v_missing = row_count;

  -- Checkout follow-up is admin-only work. No parent message is ever generated here.
  insert into public.attendance_followups (attendance_id, kind, opened_at)
  select r.id, 'checkout_needed', p_now
  from public.attendance_records r
  join public.class_sessions s on s.id = r.class_session_id
  where r.status in ('present', 'late')
    and r.checked_out_at is null
    and p_now > s.ends_at + interval '30 minutes'
  on conflict (attendance_id, kind) do nothing;
  get diagnostics v_checkout = row_count;

  return jsonb_build_object('expired_exceptions', v_expired, 'missing_opened', v_missing, 'checkout_opened', v_checkout);
end;
$$;

create function public.admin_run_attendance_followups()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  return private.run_attendance_followups(now());
end;
$$;

create function public.service_run_attendance_followups()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.begin_trusted('system');
  v_result := private.run_attendance_followups(now());
  perform private.end_trusted();
  return v_result;
end;
$$;
revoke all on function public.admin_run_attendance_followups() from public, anon;
grant execute on function public.admin_run_attendance_followups() to authenticated;
revoke all on function public.service_run_attendance_followups() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.service_run_attendance_followups() to service_role';
  end if;
end;
$$;

-- ── admin manual fallback (device or network failure) ──────────────────────
create function public.admin_record_manual_arrival(p_attendance_id uuid, p_arrived_at timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
  v_start timestamptz;
  v_status text;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 300 then raise exception 'manual reason required' using errcode = '22023'; end if;
  if p_arrived_at is null or p_arrived_at > now() + interval '1 minute' then raise exception 'invalid arrival time' using errcode = '22023'; end if;
  select * into v_record from public.attendance_records where id = p_attendance_id for update;
  if v_record.id is null then raise exception 'attendance record required' using errcode = '23503'; end if;
  if v_record.status <> 'scheduled' then raise exception 'attendance state changed' using errcode = '40001'; end if;
  select coalesce(s.starts_at, v_record.scheduled_at) into v_start
    from (select 1) one left join public.class_sessions s on s.id = v_record.class_session_id;
  v_status := case when p_arrived_at <= v_start then 'present' else 'late' end;
  update public.attendance_records
    set status = v_status, checked_in_at = p_arrived_at, check_in_source = 'admin_manual', check_in_reason = btrim(p_reason)
    where id = p_attendance_id and status = 'scheduled';
  if not found then raise exception 'attendance state changed' using errcode = '40001'; end if;
  return jsonb_build_object('status', v_status, 'checked_in_at', p_arrived_at);
end;
$$;

create function public.admin_record_manual_checkout(
  p_attendance_id uuid,
  p_checked_out_at timestamptz,
  p_reason text,
  p_expected_checked_out_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 300 then raise exception 'manual reason required' using errcode = '22023'; end if;
  if p_checked_out_at is null or p_checked_out_at > now() + interval '1 minute' then raise exception 'invalid checkout time' using errcode = '22023'; end if;
  select * into v_record from public.attendance_records where id = p_attendance_id for update;
  if v_record.id is null then raise exception 'attendance record required' using errcode = '23503'; end if;
  if v_record.status not in ('present', 'late') or v_record.checked_in_at is null then
    raise exception 'check-in required before checkout' using errcode = '23514';
  end if;
  if v_record.checked_out_at is distinct from p_expected_checked_out_at then
    raise exception 'attendance state changed' using errcode = '40001';
  end if;
  if p_checked_out_at < v_record.checked_in_at then raise exception 'checkout before check-in' using errcode = '22023'; end if;
  if v_record.checked_out_at is not null then perform private.begin_trusted('admin_correction'); end if;
  update public.attendance_records
    set checked_out_at = p_checked_out_at,
        checkout_source = case when v_record.checked_out_at is null then 'admin_manual' else 'admin_correction' end,
        checkout_reason = btrim(p_reason)
    where id = p_attendance_id and checked_out_at is not distinct from p_expected_checked_out_at;
  if not found then raise exception 'attendance state changed' using errcode = '40001'; end if;
  perform private.end_trusted();
  return jsonb_build_object('checked_out_at', p_checked_out_at);
end;
$$;
revoke all on function public.admin_record_manual_arrival(uuid, timestamptz, text) from public, anon;
grant execute on function public.admin_record_manual_arrival(uuid, timestamptz, text) to authenticated;
revoke all on function public.admin_record_manual_checkout(uuid, timestamptz, text, timestamptz) from public, anon;
grant execute on function public.admin_record_manual_checkout(uuid, timestamptz, text, timestamptz) to authenticated;

-- ── kiosk entry point ──────────────────────────────────────────────────────
-- p_code_verifier is the Edge Function's HMAC of the typed number; the plaintext never arrives here.
create function private.kiosk_attendance_at(
  p_device_token text,
  p_action text,
  p_code_verifier text,
  p_now timestamptz,
  p_ip text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device_id uuid;
  v_ip_key text := case when coalesce(p_ip, '') = '' then null else 'ip:' || private.token_hash(p_ip) end;
  v_keys text[];
  v_student public.students%rowtype;
  v_record public.attendance_records%rowtype;
  v_session public.class_sessions%rowtype;
  v_status text;
begin
  if p_action not in ('check_in', 'check_out') then
    return jsonb_build_object('result', 'not_found');
  end if;

  select id into v_device_id from public.academy_devices
    where token_hash = private.token_hash(p_device_token) and status = 'active' and device_kind = 'kiosk';
  if v_device_id is null then
    if v_ip_key is not null then
      if private.kiosk_is_limited(array[v_ip_key], p_now) then return jsonb_build_object('result', 'rate_limited'); end if;
      perform private.kiosk_note_failure(array[v_ip_key], p_now);
    end if;
    return jsonb_build_object('result', 'device_not_registered');
  end if;

  v_keys := array_remove(array['device:' || v_device_id::text, v_ip_key], null);
  if private.kiosk_is_limited(v_keys, p_now) then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  update public.academy_devices set last_seen_at = p_now where id = v_device_id;

  if coalesce(p_code_verifier, '') !~ '^[0-9a-f]{64}$' then
    perform private.kiosk_note_failure(v_keys, p_now);
    return jsonb_build_object('result', 'not_found');
  end if;

  -- A distributed attacker must not evade limits by rotating devices or source IPs
  -- while repeating the same guessed number. The bucket key is the keyed verifier,
  -- never the plaintext code.
  v_keys := array_append(v_keys, 'code:' || p_code_verifier);
  if private.kiosk_is_limited(v_keys, p_now) then
    return jsonb_build_object('result', 'rate_limited');
  end if;

  select st.* into v_student
    from public.student_attendance_codes c
    join public.students st on st.id = c.student_id
    where c.code_verifier = p_code_verifier and c.active and st.status in ('active', 'returning');
  if v_student.id is null then
    perform private.kiosk_note_failure(v_keys, p_now);
    return jsonb_build_object('result', 'not_found');
  end if;

  perform private.begin_trusted('kiosk', v_device_id);

  if p_action = 'check_in' then
    select r.* into v_record
      from public.attendance_records r
      join public.class_sessions s on s.id = r.class_session_id
      where r.student_id = v_student.id
        and s.status = 'scheduled'
        and p_now between s.starts_at - interval '90 minutes' and s.ends_at
      order by abs(extract(epoch from (s.starts_at - p_now)))
      limit 1
      for update of r;
    if v_record.id is null then
      perform private.end_trusted();
      return jsonb_build_object('result', 'not_found');
    end if;
    if v_record.status in ('present', 'late') then
      perform private.end_trusted();
      return jsonb_build_object('result', 'already_checked_in', 'status', v_record.status,
        'student_label', public.kiosk_mask_name(v_student.name), 'at', v_record.checked_in_at);
    end if;
    if v_record.status <> 'scheduled' then
      perform private.end_trusted();
      return jsonb_build_object('result', 'needs_staff');
    end if;
    select * into v_session from public.class_sessions where id = v_record.class_session_id;
    v_status := case when p_now <= v_session.starts_at then 'present' else 'late' end;
    update public.attendance_records
      set status = v_status, checked_in_at = p_now, check_in_source = 'kiosk', check_in_device_id = v_device_id
      where id = v_record.id and status = 'scheduled';
    perform private.end_trusted();
    return jsonb_build_object('result', 'checked_in', 'status', v_status,
      'student_label', public.kiosk_mask_name(v_student.name), 'at', p_now);
  end if;

  -- check_out: same six-digit number, only after an existing check-in.
  select r.* into v_record
    from public.attendance_records r
    join public.class_sessions s on s.id = r.class_session_id
    where r.student_id = v_student.id
      and r.status in ('present', 'late')
      and p_now between s.starts_at - interval '90 minutes' and s.ends_at + interval '6 hours'
    order by (r.checked_out_at is null) desc, s.starts_at desc
    limit 1
    for update of r;
  if v_record.id is null then
    perform private.end_trusted();
    if exists (
      select 1 from public.attendance_records r
      join public.class_sessions s on s.id = r.class_session_id
      where r.student_id = v_student.id and s.status = 'scheduled'
        and p_now between s.starts_at - interval '90 minutes' and s.ends_at + interval '6 hours'
    ) then
      return jsonb_build_object('result', 'not_checked_in');
    end if;
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_record.checked_out_at is not null then
    perform private.end_trusted();
    return jsonb_build_object('result', 'already_checked_out',
      'student_label', public.kiosk_mask_name(v_student.name), 'at', v_record.checked_out_at);
  end if;
  update public.attendance_records
    set checked_out_at = greatest(p_now, v_record.checked_in_at), checkout_source = 'kiosk'
    where id = v_record.id and checked_out_at is null;
  perform private.end_trusted();
  return jsonb_build_object('result', 'checked_out',
    'student_label', public.kiosk_mask_name(v_student.name), 'at', greatest(p_now, v_record.checked_in_at));
end;
$$;

create function public.kiosk_mask_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when char_length(btrim(coalesce(p_name, ''))) = 0 then '학생'
    else left(btrim(p_name), 1) || repeat('○', char_length(btrim(p_name)) - 1)
  end
$$;

-- The only kiosk transition entry point. Executable by service_role only: the attendance-code Edge
-- Function calls it with the verifier and the gateway-observed client IP. Server time is always now().
create function public.service_kiosk_attendance(
  p_device_token text,
  p_action text,
  p_code_verifier text,
  p_client_ip text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.kiosk_attendance_at(p_device_token, p_action, p_code_verifier, now(), left(btrim(coalesce(p_client_ip, '')), 45));
  -- Defense in depth: only the masked minimal fields ever leave the database.
  return (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(v_result)
          where key in ('result', 'status', 'student_label', 'at'));
end;
$$;

revoke all on function public.service_kiosk_attendance(text, text, text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.service_kiosk_attendance(text, text, text, text) to service_role';
  end if;
end;
$$;
revoke all on function public.kiosk_mask_name(text) from public;

do $$
declare
  fn text;
begin
  for fn in
    select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'
  loop
    execute 'revoke all on function ' || fn || ' from public';
  end loop;
end;
$$;
