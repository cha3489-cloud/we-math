-- Dedicated learning-plan devices and device-bound, read-only learning sessions.
-- Repository-only until the production migration gate is approved.
--
-- Boundary:
--   * The six-digit attendance number is NEVER a learning credential. Nothing here reads
--     student_attendance_codes. Account-linked students keep the existing tablet phone + PIN login.
--   * academy_devices.device_kind ('kiosk' | 'learning_plan') is server-controlled and immutable.
--     Kiosk attendance accepts only kiosk devices; the plan reader accepts only learning_plan devices.
--   * learning_device_sessions binds one active learning device to one present/late, not checked-out,
--     account-unlinked attendance row of today (KST). Admins assign/revoke through narrow RPCs only.
--   * learning_device_today_plan(token): anon/authenticated, read-only. It returns the published plan
--     items for the bound attendance and nothing that identifies the student. No write function exists
--     for the device: it cannot submit, complete, or change anything except its own last_seen_at and
--     the lazy expiry of its own stale session.
--   * Sessions end automatically on checkout, attendance correction, class cancellation, device
--     revocation, account linking, student deactivation, or reassignment. No guardian notification.
--   * Realtime: only operations_refresh_events is published. Neither sessions nor devices are.

-- ── device kind guard and learning-device registration ─────────────────────
create index academy_devices_kind_idx on public.academy_devices (device_kind, status);

create function private.guard_academy_device()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.device_kind is distinct from old.device_kind
     or new.token_hash is distinct from old.token_hash or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'device identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'revoked' and new.status is distinct from 'revoked' then
    raise exception 'revoked device cannot be reactivated' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger guard_academy_devices before update on public.academy_devices
  for each row execute function private.guard_academy_device();

create function public.admin_register_learning_plan_device(p_device_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := private.random_token();
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  insert into public.academy_devices (device_name, device_kind, token_hash, created_by)
  values (btrim(coalesce(p_device_name, '')), 'learning_plan', private.token_hash(v_token), auth.uid());
  return v_token;
end;
$$;

create function public.admin_revoke_learning_plan_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.academy_devices set status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
    where id = p_device_id and status = 'active' and device_kind = 'learning_plan';
  if not found then raise exception 'device state changed' using errcode = '40001'; end if;
end;
$$;

-- ── learning device sessions ────────────────────────────────────────────────
create table public.learning_device_sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.academy_devices(id) on delete restrict,
  student_id uuid not null references public.students(id) on delete restrict,
  attendance_id uuid not null references public.attendance_records(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  revision integer not null default 1 check (revision > 0),
  assigned_by uuid not null references public.profiles(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete restrict,
  revoke_reason text check (revoke_reason in (
    'admin_revoked', 'reassigned', 'checked_out', 'attendance_changed', 'session_cancelled',
    'device_revoked', 'account_linked', 'student_inactive', 'expired'
  )),
  updated_at timestamptz not null default now(),
  check (expires_at > assigned_at),
  check ((status = 'active') = (revoked_at is null and revoke_reason is null)),
  check ((status = 'expired') = (revoke_reason is not distinct from 'expired')),
  check (revoked_by is null or status = 'revoked')
);
create unique index learning_device_sessions_one_active_device_idx on public.learning_device_sessions (device_id) where status = 'active';
create unique index learning_device_sessions_one_active_student_idx on public.learning_device_sessions (student_id) where status = 'active';
create index learning_device_sessions_attendance_idx on public.learning_device_sessions (attendance_id) where status = 'active';

-- Writes happen only inside this migration's SECURITY DEFINER functions, which raise a
-- transaction-local marker. Browser roles have no write grants at all; the marker is defense in depth.
create function private.guard_learning_device_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('sequence.learning_session_write', true), '') <> 'on' then
    raise exception 'learning device sessions change only through server functions' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is null or not public.is_admin() then
      raise exception 'admin required' using errcode = '42501';
    end if;
    new.id := gen_random_uuid();
    new.status := 'active';
    new.revision := 1;
    new.assigned_by := auth.uid();
    new.assigned_at := now();
    new.revoked_at := null;
    new.revoked_by := null;
    new.revoke_reason := null;
    new.updated_at := now();
    return new;
  end if;
  if new.id is distinct from old.id or new.device_id is distinct from old.device_id
     or new.student_id is distinct from old.student_id or new.attendance_id is distinct from old.attendance_id
     or new.assigned_by is distinct from old.assigned_by or new.assigned_at is distinct from old.assigned_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'learning device session identity is immutable' using errcode = '42501';
  end if;
  if old.status <> 'active' then
    raise exception 'ended learning device session is immutable' using errcode = '23514';
  end if;
  if new.status = 'active' then
    raise exception 'learning device session can only end' using errcode = '23514';
  end if;
  new.revision := old.revision + 1;
  new.revoked_at := now();
  new.revoked_by := case when new.status = 'revoked' and private.actor_kind() = 'admin' then auth.uid() else null end;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_learning_device_sessions before insert or update on public.learning_device_sessions
  for each row execute function private.guard_learning_device_session();
-- Rows hold no token or contact data, so the redacted before/after snapshot is secret-free.
create trigger audit_learning_device_sessions after insert or update on public.learning_device_sessions
  for each row execute function private.audit_operation_row();
create trigger refresh_signal_learning_device_sessions after insert or update or delete on public.learning_device_sessions
  for each row execute function private.emit_operations_refresh_event();

alter table public.learning_device_sessions enable row level security;
create policy "admins read learning device sessions" on public.learning_device_sessions
  for select to authenticated using (public.is_admin());
revoke all on table public.learning_device_sessions from public, anon, authenticated;
grant select on table public.learning_device_sessions to authenticated;

create function private.learning_session_write_begin()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_prev text := coalesce(current_setting('sequence.learning_session_write', true), '');
begin
  perform set_config('sequence.learning_session_write', 'on', true);
  return v_prev;
end;
$$;

create function private.learning_session_write_end(p_prev text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('sequence.learning_session_write', coalesce(p_prev, ''), true);
end;
$$;

-- Ends every active session matching the scope. 'expired' ends as expired; everything else as revoked.
create function private.end_learning_device_sessions(p_scope text, p_key uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
  v_count integer;
begin
  if p_scope not in ('id', 'device', 'student', 'attendance', 'class_session') or p_key is null then
    raise exception 'invalid learning session scope' using errcode = '22023';
  end if;
  v_prev := private.learning_session_write_begin();
  update public.learning_device_sessions ls
    set status = case when p_reason = 'expired' then 'expired' else 'revoked' end,
        revoke_reason = p_reason
    where ls.status = 'active'
      and case p_scope
        when 'id' then ls.id = p_key
        when 'device' then ls.device_id = p_key
        when 'student' then ls.student_id = p_key
        when 'attendance' then ls.attendance_id = p_key
        else ls.attendance_id in (select r.id from public.attendance_records r where r.class_session_id = p_key)
      end;
  get diagnostics v_count = row_count;
  perform private.learning_session_write_end(v_prev);
  return v_count;
end;
$$;

-- ── automatic revocation ────────────────────────────────────────────────────
create function private.revoke_learning_sessions_on_attendance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.checked_out_at is not null and old.checked_out_at is null then
    perform private.end_learning_device_sessions('attendance', new.id, 'checked_out');
  elsif new.status not in ('present', 'late') or new.checked_out_at is not null then
    perform private.end_learning_device_sessions('attendance', new.id, 'attendance_changed');
  end if;
  return new;
end;
$$;
create trigger revoke_learning_sessions_on_attendance after update of status, checked_out_at on public.attendance_records
  for each row execute function private.revoke_learning_sessions_on_attendance();

create function private.revoke_learning_sessions_on_class_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform private.end_learning_device_sessions('class_session', new.id, 'session_cancelled');
  end if;
  return new;
end;
$$;
create trigger revoke_learning_sessions_on_class_session after update of status on public.class_sessions
  for each row execute function private.revoke_learning_sessions_on_class_session();

create function private.revoke_learning_sessions_on_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'revoked' and old.status = 'active' then
    perform private.end_learning_device_sessions('device', new.id, 'device_revoked');
  end if;
  return new;
end;
$$;
create trigger revoke_learning_sessions_on_device after update of status on public.academy_devices
  for each row execute function private.revoke_learning_sessions_on_device();

create function private.revoke_learning_sessions_on_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.account_profile_id is not null then
    perform private.end_learning_device_sessions('student', new.id, 'account_linked');
  elsif new.status not in ('active', 'returning') then
    perform private.end_learning_device_sessions('student', new.id, 'student_inactive');
  end if;
  return new;
end;
$$;
create trigger revoke_learning_sessions_on_student after update of account_profile_id, status on public.students
  for each row execute function private.revoke_learning_sessions_on_student();

-- ── admin assignment / revocation ───────────────────────────────────────────
-- Lock order: attendance → student → device → sessions. Kiosk checkout locks attendance then
-- sessions; device revocation locks device then sessions; the plan reader locks device then session.
create function private.assign_learning_device_at(p_device_id uuid, p_attendance_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
  v_class public.class_sessions%rowtype;
  v_student public.students%rowtype;
  v_device public.academy_devices%rowtype;
  v_day date := (p_now at time zone 'Asia/Seoul')::date;
  v_expires timestamptz;
  v_prev text;
  v_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  select * into v_record from public.attendance_records where id = p_attendance_id for update;
  if v_record.id is null or v_record.class_session_id is null then
    raise exception 'attendance not eligible for a learning device' using errcode = '23514';
  end if;
  select * into v_class from public.class_sessions where id = v_record.class_session_id;
  select * into v_student from public.students where id = v_record.student_id for update;
  if v_record.status not in ('present', 'late') or v_record.checked_in_at is null or v_record.checked_out_at is not null
     or v_class.status = 'cancelled' or (v_class.starts_at at time zone 'Asia/Seoul')::date <> v_day
     or v_student.status not in ('active', 'returning') then
    raise exception 'attendance not eligible for a learning device' using errcode = '23514';
  end if;
  if v_student.account_profile_id is not null then
    raise exception 'account-linked students use their own phone login' using errcode = '23514';
  end if;
  v_expires := least(((v_day + 1)::timestamp at time zone 'Asia/Seoul'), v_class.ends_at + interval '4 hours');
  if v_expires <= p_now then
    raise exception 'learning device session would already be expired' using errcode = '23514';
  end if;
  select * into v_device from public.academy_devices where id = p_device_id for update;
  if v_device.id is null or v_device.status <> 'active' or v_device.device_kind <> 'learning_plan' then
    raise exception 'learning device not available' using errcode = '23514';
  end if;

  v_prev := private.learning_session_write_begin();
  -- Stale sessions end as expired, not as a reassignment.
  update public.learning_device_sessions set status = 'expired', revoke_reason = 'expired'
    where status = 'active' and (device_id = p_device_id or student_id = v_student.id) and expires_at <= p_now;
  perform private.end_learning_device_sessions('device', p_device_id, 'reassigned');
  perform private.end_learning_device_sessions('student', v_student.id, 'reassigned');
  insert into public.learning_device_sessions (device_id, student_id, attendance_id, expires_at, assigned_by)
    values (p_device_id, v_student.id, v_record.id, v_expires, auth.uid())
    returning id into v_id;
  perform private.learning_session_write_end(v_prev);
  return jsonb_build_object('session_id', v_id, 'revision', 1, 'expires_at', v_expires);
end;
$$;

create function public.admin_assign_learning_device(p_device_id uuid, p_attendance_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  return private.assign_learning_device_at(p_device_id, p_attendance_id, now());
end;
$$;

create function public.admin_revoke_learning_device_session(p_session_id uuid, p_expected_revision integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  v_prev := private.learning_session_write_begin();
  update public.learning_device_sessions set status = 'revoked', revoke_reason = 'admin_revoked'
    where id = p_session_id and status = 'active' and revision = p_expected_revision;
  if not found then raise exception 'learning device session changed' using errcode = '40001'; end if;
  perform private.learning_session_write_end(v_prev);
end;
$$;

-- Narrow device list: id/name/kind/status/last_seen plus the current assignment. Never token_hash,
-- never guardian or account data.
create function public.admin_list_devices()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id,
      'device_name', d.device_name,
      'device_kind', d.device_kind,
      'status', d.status,
      'last_seen_at', d.last_seen_at,
      'assignment', (
        select jsonb_build_object('session_id', ls.id, 'revision', ls.revision, 'attendance_id', ls.attendance_id,
                                  'student_name', st.name, 'expires_at', ls.expires_at)
        from public.learning_device_sessions ls
        join public.students st on st.id = ls.student_id
        where ls.device_id = d.id and ls.status = 'active' and ls.expires_at > now()
      )
    ) order by d.status, d.device_kind, d.device_name, d.id)
    from public.academy_devices d
  ), '[]'::jsonb);
end;
$$;

-- ── device-bound read-only plan ─────────────────────────────────────────────
create function private.learning_device_today_plan_at(p_device_token text, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_none constant jsonb := jsonb_build_object('state', 'no_session');
  v_device uuid;
  v_ls public.learning_device_sessions%rowtype;
  v_record public.attendance_records%rowtype;
  v_class public.class_sessions%rowtype;
  v_student public.students%rowtype;
  v_plan public.daily_learning_plans%rowtype;
  v_reason text;
  v_day date;
begin
  if coalesce(p_device_token, '') !~ '^[0-9a-f]{64}$' then return c_none; end if;
  select id into v_device from public.academy_devices
    where token_hash = private.token_hash(p_device_token) and status = 'active' and device_kind = 'learning_plan';
  if v_device is null then return c_none; end if;
  update public.academy_devices set last_seen_at = p_now where id = v_device;

  select * into v_ls from public.learning_device_sessions where device_id = v_device and status = 'active' for update;
  if v_ls.id is null then return c_none; end if;
  select * into v_record from public.attendance_records where id = v_ls.attendance_id;
  select * into v_class from public.class_sessions where id = v_record.class_session_id;
  select * into v_student from public.students where id = v_ls.student_id;
  v_reason := case
    when v_ls.expires_at <= p_now then 'expired'
    when v_record.checked_out_at is not null then 'checked_out'
    when v_record.status not in ('present', 'late') then 'attendance_changed'
    when v_class.id is null or v_class.status = 'cancelled' then 'session_cancelled'
    when v_student.account_profile_id is not null then 'account_linked'
    when v_student.status not in ('active', 'returning') then 'student_inactive'
    else null
  end;
  if v_reason is not null then
    -- Attribute the lazy end to the system, never to whichever browser session polled.
    perform private.begin_trusted('system');
    perform private.end_learning_device_sessions('id', v_ls.id, v_reason);
    perform private.end_trusted();
    return c_none;
  end if;

  v_day := (v_class.starts_at at time zone 'Asia/Seoul')::date;
  select * into v_plan from public.daily_learning_plans
    where student_id = v_ls.student_id and plan_date = v_day and status = 'published';
  if v_plan.id is null then
    return jsonb_build_object('state', 'preparing', 'plan_date', v_day);
  end if;
  return jsonb_build_object(
    'state', 'ready',
    'plan_date', v_plan.plan_date,
    'source_revision', v_plan.source_revision,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('item_type', i.item_type, 'title', i.title, 'body', i.body, 'teacher_status', i.teacher_status) order by i.sort_order)
      from public.daily_learning_plan_items i where i.plan_id = v_plan.id
    ), '[]'::jsonb)
  );
end;
$$;

create function public.learning_device_today_plan(p_device_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.learning_device_today_plan_at(left(coalesce(p_device_token, ''), 128), now());
  -- Defense in depth: only the documented keys ever leave the database.
  return (select coalesce(jsonb_object_agg(key, value), jsonb_build_object('state', 'no_session'))
          from jsonb_each(v_result) where key in ('state', 'plan_date', 'source_revision', 'items'));
end;
$$;

-- ── admin snapshot row: account link + current device assignment ───────────
-- Identical to 20261115050000 plus 'account_linked' and 'learning_device'.
create or replace function private.operations_session_json(p_attendance_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'attendance_id', r.id,
    'class_session_id', s.id,
    'student_id', st.id,
    'student_name', st.name,
    'grade', st.grade,
    'class_name', g.name,
    'starts_at', s.starts_at,
    'ends_at', s.ends_at,
    'session_status', s.status,
    'missing_after_minutes', s.missing_after_minutes,
    'status', r.status,
    'checked_in_at', r.checked_in_at,
    'checked_out_at', r.checked_out_at,
    'check_in_source', r.check_in_source,
    'checkout_source', r.checkout_source,
    'exception', (
      select jsonb_build_object('id', e.id, 'type', e.exception_type, 'status', e.status, 'expected_arrival_at', e.expected_arrival_at, 'reason_category', e.reason_category)
      from public.attendance_exceptions e
      where e.student_id = r.student_id and e.class_session_id = r.class_session_id and e.status <> 'cancelled'
      order by e.created_at desc limit 1
    ),
    'open_followups', coalesce((
      select jsonb_agg(f.kind order by f.kind) from public.attendance_followups f where f.attendance_id = r.id and f.status = 'open'
    ), '[]'::jsonb),
    'plan_status', (
      select p.status from public.daily_learning_plans p
      where p.student_id = r.student_id and p.plan_date = (s.starts_at at time zone 'Asia/Seoul')::date and p.status in ('published', 'draft')
      order by (p.status = 'published') desc, p.source_revision desc limit 1
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('type', m.message_type, 'status', m.status, 'dry_run', m.dry_run) order by m.created_at)
      from public.parent_messages m where m.attendance_id = r.id
    ), '[]'::jsonb),
    'account_linked', st.account_profile_id is not null,
    'learning_device', (
      select jsonb_build_object('session_id', ls.id, 'revision', ls.revision, 'device_id', ls.device_id,
                                'device_name', d.device_name, 'expires_at', ls.expires_at)
      from public.learning_device_sessions ls
      join public.academy_devices d on d.id = ls.device_id
      where ls.attendance_id = r.id and ls.status = 'active' and ls.expires_at > now()
    )
  )
  from public.attendance_records r
  join public.class_sessions s on s.id = r.class_session_id
  join public.class_groups g on g.id = s.class_group_id
  join public.students st on st.id = r.student_id
  where r.id = p_attendance_id
$$;

-- ── function privileges ─────────────────────────────────────────────────────
revoke all on function public.admin_register_learning_plan_device(text) from public, anon;
grant execute on function public.admin_register_learning_plan_device(text) to authenticated;
revoke all on function public.admin_revoke_learning_plan_device(uuid) from public, anon;
grant execute on function public.admin_revoke_learning_plan_device(uuid) to authenticated;
revoke all on function public.admin_assign_learning_device(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_learning_device(uuid, uuid) to authenticated;
revoke all on function public.admin_revoke_learning_device_session(uuid, integer) from public, anon;
grant execute on function public.admin_revoke_learning_device_session(uuid, integer) to authenticated;
revoke all on function public.admin_list_devices() from public, anon;
grant execute on function public.admin_list_devices() to authenticated;
revoke all on function public.learning_device_today_plan(text) from public;
grant execute on function public.learning_device_today_plan(text) to anon, authenticated;

do $$
declare
  fn text;
begin
  for fn in
    select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'
  loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || fn || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || fn || ' from service_role'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.admin_register_learning_plan_device(text) from service_role';
    execute 'revoke all on function public.admin_assign_learning_device(uuid, uuid) from service_role';
    execute 'revoke all on function public.admin_revoke_learning_device_session(uuid, integer) from service_role';
    execute 'revoke all on function public.admin_revoke_learning_plan_device(uuid) from service_role';
    execute 'revoke all on function public.admin_list_devices() from service_role';
  end if;
end;
$$;
