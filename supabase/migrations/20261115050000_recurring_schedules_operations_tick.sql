-- Structured recurring timetable, internal operations tick, realtime publication, and
-- keyset-paged unresolved queues for the admin today-operations snapshot.
-- Repository-only until the production migration gate is approved.
--
--   * public.class_schedules: normalized weekly slots per class group (ISO weekday in
--     Asia/Seoul, local start time, duration, capacity, late/missing thresholds, date range).
--     Admin read only; every write goes through narrow SECURITY DEFINER RPCs with CAS.
--     The legacy free-text class_groups.schedule column is never parsed.
--   * private.generate_scheduled_sessions(): idempotently materializes class_sessions and
--     attendance_records for KST today and tomorrow. class_sessions(schedule_id, session_date)
--     is a durable unique source key, so concurrent ticks cannot duplicate sessions.
--     Generated rows are attributed to the trusted 'system' actor (no fake auth.uid()).
--   * public.service_operations_tick(): generation + private.run_attendance_followups(now()).
--     service_role only. public.admin_run_operations_tick(): audited admin recovery path.
--   * pg_cron schedules the service tick every 5 minutes when the extension is available.
--   * Realtime: only a secret-free refresh signal table is added to supabase_realtime.
--   * admin_today_operations(): today's sessions in full; each unresolved queue capped at
--     50 rows with full-queue aggregate counts and an opaque (timestamp, id) keyset cursor.
--     admin_operations_queue_page() returns the next page. No OFFSET.
--
-- Editing/deactivating a schedule synchronizes only future generated sessions whose attendance
-- is still untouched; a session where attendance started remains immutable operational history.

-- ── recurring class schedules ───────────────────────────────────────────────
create table public.class_schedules (
  id uuid primary key default gen_random_uuid(),
  class_group_id uuid not null references public.class_groups(id) on delete restrict,
  iso_weekday smallint not null check (iso_weekday between 1 and 7),
  local_start_time time not null check (extract(second from local_start_time) = 0),
  duration_minutes integer not null check (duration_minutes between 15 and 360),
  capacity integer not null default 8 check (capacity between 1 and 100),
  late_after_minutes integer not null default 10 check (late_after_minutes between 0 and 120),
  missing_after_minutes integer not null default 15 check (missing_after_minutes between 0 and 180),
  effective_from date not null,
  effective_to date,
  active boolean not null default true,
  revision integer not null default 1 check (revision >= 1),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deactivated_at timestamptz,
  deactivated_by uuid references public.profiles(id) on delete restrict,
  check (missing_after_minutes >= late_after_minutes),
  check (effective_to is null or effective_to >= effective_from),
  -- A slot must end on the same KST date so session_date is unambiguous.
  check ((extract(hour from local_start_time) * 60 + extract(minute from local_start_time)) + duration_minutes <= 1440),
  check (active = (deactivated_at is null))
);
-- Exact duplicate active slots are rejected by the database; overlapping windows and date
-- ranges are rejected by the RPCs under a per-group row lock.
create unique index class_schedules_active_slot_idx
  on public.class_schedules (class_group_id, iso_weekday, local_start_time, effective_from) where active;
create index class_schedules_active_weekday_idx on public.class_schedules (iso_weekday, effective_from) where active;

create function private.prepare_class_schedule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.revision := 1;
  else
    if new.class_group_id is distinct from old.class_group_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'class schedule identity is immutable' using errcode = '42501';
    end if;
    if not old.active then
      raise exception 'inactive class schedule is immutable' using errcode = '40001';
    end if;
    new.revision := old.revision + 1;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;
create trigger prepare_class_schedules before insert or update on public.class_schedules
  for each row execute function private.prepare_class_schedule();
create trigger audit_class_schedules after insert or update on public.class_schedules
  for each row execute function private.audit_operation_row();

alter table public.class_schedules enable row level security;
create policy "admins read class schedules" on public.class_schedules
  for select to authenticated using (public.is_admin());
revoke all on table public.class_schedules from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.class_schedules from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.class_schedules from authenticated';
    execute 'grant select on table public.class_schedules to authenticated';
  end if;
end;
$$;

create function private.schedule_minutes(p_time time)
returns integer
language sql
immutable
set search_path = ''
as $$ select (extract(hour from p_time) * 60 + extract(minute from p_time))::integer $$;

-- Validates and normalizes an admin schedule request. Raises 22023 'invalid schedule'.
create function private.validated_schedule_time(
  p_iso_weekday integer, p_local_start_time text, p_duration_minutes integer, p_capacity integer,
  p_late_after_minutes integer, p_missing_after_minutes integer, p_effective_from date, p_effective_to date
)
returns time
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_time time;
begin
  if p_iso_weekday is null or p_iso_weekday not between 1 and 7
     or p_local_start_time is null or p_local_start_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or p_duration_minutes is null or p_duration_minutes not between 15 and 360
     or p_capacity is null or p_capacity not between 1 and 100
     or p_late_after_minutes is null or p_late_after_minutes not between 0 and 120
     or p_missing_after_minutes is null or p_missing_after_minutes not between 0 and 180
     or p_missing_after_minutes < p_late_after_minutes
     or p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from) then
    raise exception 'invalid schedule' using errcode = '22023';
  end if;
  v_time := p_local_start_time::time;
  if private.schedule_minutes(v_time) + p_duration_minutes > 1440 then
    raise exception 'invalid schedule' using errcode = '22023';
  end if;
  return v_time;
end;
$$;

create function private.assert_no_schedule_overlap(
  p_class_group_id uuid, p_iso_weekday integer, p_start time, p_duration_minutes integer,
  p_effective_from date, p_effective_to date, p_exclude uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Serialize schedule writes per class group so the overlap check cannot race.
  perform 1 from public.class_groups where id = p_class_group_id and is_active for update;
  if not found then raise exception 'active class group required' using errcode = '23503'; end if;
  if exists (
    select 1 from public.class_schedules c
    where c.class_group_id = p_class_group_id
      and c.active
      and c.id is distinct from p_exclude
      and c.iso_weekday = p_iso_weekday
      and daterange(c.effective_from, c.effective_to, '[]') && daterange(p_effective_from, p_effective_to, '[]')
      and private.schedule_minutes(c.local_start_time) < private.schedule_minutes(p_start) + p_duration_minutes
      and private.schedule_minutes(p_start) < private.schedule_minutes(c.local_start_time) + c.duration_minutes
  ) then
    raise exception 'overlapping schedule for this class group' using errcode = '23P01';
  end if;
end;
$$;

create function public.admin_create_class_schedule(
  p_class_group_id uuid,
  p_iso_weekday integer,
  p_local_start_time text,
  p_duration_minutes integer,
  p_capacity integer,
  p_late_after_minutes integer,
  p_missing_after_minutes integer,
  p_effective_from date,
  p_effective_to date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_time time;
  v_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  v_time := private.validated_schedule_time(p_iso_weekday, p_local_start_time, p_duration_minutes, p_capacity,
    p_late_after_minutes, p_missing_after_minutes, p_effective_from, p_effective_to);
  perform private.assert_no_schedule_overlap(p_class_group_id, p_iso_weekday, v_time, p_duration_minutes, p_effective_from, p_effective_to, null);
  insert into public.class_schedules (
    class_group_id, iso_weekday, local_start_time, duration_minutes, capacity,
    late_after_minutes, missing_after_minutes, effective_from, effective_to, created_by, updated_by
  ) values (
    p_class_group_id, p_iso_weekday, v_time, p_duration_minutes, p_capacity,
    p_late_after_minutes, p_missing_after_minutes, p_effective_from, p_effective_to, auth.uid(), auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

create function public.admin_update_class_schedule(
  p_schedule_id uuid,
  p_expected_revision integer,
  p_iso_weekday integer,
  p_local_start_time text,
  p_duration_minutes integer,
  p_capacity integer,
  p_late_after_minutes integer,
  p_missing_after_minutes integer,
  p_effective_from date,
  p_effective_to date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_time time;
  v_group uuid;
  v_revision integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  v_time := private.validated_schedule_time(p_iso_weekday, p_local_start_time, p_duration_minutes, p_capacity,
    p_late_after_minutes, p_missing_after_minutes, p_effective_from, p_effective_to);
  select class_group_id into v_group from public.class_schedules where id = p_schedule_id;
  if v_group is null then raise exception 'class schedule state changed' using errcode = '40001'; end if;
  perform private.assert_no_schedule_overlap(v_group, p_iso_weekday, v_time, p_duration_minutes, p_effective_from, p_effective_to, p_schedule_id);
  update public.class_schedules set
    iso_weekday = p_iso_weekday, local_start_time = v_time, duration_minutes = p_duration_minutes,
    capacity = p_capacity, late_after_minutes = p_late_after_minutes, missing_after_minutes = p_missing_after_minutes,
    effective_from = p_effective_from, effective_to = p_effective_to
  where id = p_schedule_id and active and revision = p_expected_revision
  returning revision into v_revision;
  if v_revision is null then raise exception 'class schedule state changed' using errcode = '40001'; end if;
  perform private.sync_future_schedule_sessions(p_schedule_id, now());
  return v_revision;
end;
$$;

-- p_now is explicit so the cancellation boundary is testable; the public RPC passes now().
create function private.admin_deactivate_class_schedule_at(p_schedule_id uuid, p_expected_revision integer, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancelled integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.class_schedules
    set active = false, deactivated_at = p_now, deactivated_by = auth.uid()
    where id = p_schedule_id and active and revision = p_expected_revision;
  if not found then raise exception 'class schedule state changed' using errcode = '40001'; end if;
  update public.class_sessions s set status = 'cancelled'
    where s.schedule_id = p_schedule_id
      and s.status = 'scheduled'
      and s.starts_at > p_now
      and not exists (select 1 from public.attendance_records r where r.class_session_id = s.id and r.status <> 'scheduled');
  get diagnostics v_cancelled = row_count;
  return v_cancelled;
end;
$$;

create function public.admin_deactivate_class_schedule(p_schedule_id uuid, p_expected_revision integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  return private.admin_deactivate_class_schedule_at(p_schedule_id, p_expected_revision, now());
end;
$$;

create function public.admin_list_class_schedules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  return jsonb_build_object('groups', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'course_name', c.name,
      'is_active', g.is_active,
      'schedules', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', sc.id,
          'iso_weekday', sc.iso_weekday,
          'local_start_time', left(sc.local_start_time::text, 5),
          'duration_minutes', sc.duration_minutes,
          'capacity', sc.capacity,
          'late_after_minutes', sc.late_after_minutes,
          'missing_after_minutes', sc.missing_after_minutes,
          'effective_from', sc.effective_from,
          'effective_to', sc.effective_to,
          'active', sc.active,
          'revision', sc.revision
        ) order by sc.iso_weekday, sc.local_start_time, sc.effective_from, sc.id)
        from public.class_schedules sc where sc.class_group_id = g.id and sc.active
      ), '[]'::jsonb)
    ) order by g.name, g.id)
    from public.class_groups g join public.courses c on c.id = g.course_id
    where g.is_active
  ), '[]'::jsonb));
end;
$$;

-- ── system-generated class sessions and attendance rows ─────────────────────
alter table public.class_sessions
  add column schedule_id uuid references public.class_schedules(id) on delete restrict,
  add column session_date date,
  add column created_via text not null default 'admin' check (created_via in ('admin', 'system'));
alter table public.class_sessions alter column created_by drop not null;
alter table public.class_sessions alter column updated_by drop not null;
alter table public.class_sessions
  add constraint class_sessions_created_actor_check check (created_by is not null or created_via <> 'admin'),
  add constraint class_sessions_schedule_source_check check ((schedule_id is null) = (session_date is null)),
  add constraint class_sessions_schedule_source_key unique (schedule_id, session_date);

create function private.prepare_class_session_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_system boolean := coalesce(private.trusted_actor() = 'system', false);
begin
  if not v_system and (auth.uid() is null or not public.is_admin()) then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := case when v_system then null else auth.uid() end;
    new.created_via := case when v_system then 'system' else 'admin' end;
    new.created_at := now();
    if not v_system and new.schedule_id is not null then
      raise exception 'scheduled sessions are generated by the system' using errcode = '42501';
    end if;
  else
    if new.schedule_id is distinct from old.schedule_id or new.session_date is distinct from old.session_date then
      raise exception 'class session source is immutable' using errcode = '42501';
    end if;
    new.created_by := old.created_by;
    new.created_via := old.created_via;
    new.created_at := old.created_at;
  end if;
  new.updated_by := case when v_system then null else auth.uid() end;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger prepare_class_sessions on public.class_sessions;
create trigger prepare_class_sessions before insert or update on public.class_sessions
  for each row execute function private.prepare_class_session_row();

create function private.sync_future_schedule_sessions(p_schedule_id uuid, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.class_schedules%rowtype;
  v_session public.class_sessions%rowtype;
  v_start timestamptz;
  v_changed integer := 0;
begin
  select * into v_schedule from public.class_schedules where id = p_schedule_id;
  if v_schedule.id is null then raise exception 'class schedule state changed' using errcode = '40001'; end if;
  for v_session in
    select s.* from public.class_sessions s
    where s.schedule_id = p_schedule_id and s.status = 'scheduled' and s.starts_at > p_now
      and not exists (
        select 1 from public.attendance_records r
        where r.class_session_id = s.id and r.status <> 'scheduled'
      )
    order by s.starts_at, s.id
    for update
  loop
    if not v_schedule.active
       or v_session.session_date < v_schedule.effective_from
       or (v_schedule.effective_to is not null and v_session.session_date > v_schedule.effective_to)
       or extract(isodow from v_session.session_date)::integer <> v_schedule.iso_weekday then
      update public.class_sessions set status = 'cancelled' where id = v_session.id;
    else
      v_start := (v_session.session_date + v_schedule.local_start_time) at time zone 'Asia/Seoul';
      update public.attendance_records
        set scheduled_at = v_start
        where class_session_id = v_session.id and status = 'scheduled';
      update public.class_sessions
        set starts_at = v_start,
            ends_at = v_start + make_interval(mins => v_schedule.duration_minutes),
            capacity = v_schedule.capacity,
            late_after_minutes = v_schedule.late_after_minutes,
            missing_after_minutes = v_schedule.missing_after_minutes
        where id = v_session.id;
    end if;
    v_changed := v_changed + 1;
  end loop;
  return v_changed;
end;
$$;

alter table public.attendance_records
  add column created_via text not null default 'admin' check (created_via in ('admin', 'system'));
alter table public.attendance_records alter column created_by drop not null;
alter table public.attendance_records
  add constraint attendance_records_created_actor_check check (created_by is not null or created_via <> 'admin');

create or replace function public.prepare_attendance_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.trusted_actor() = 'system' then
    new.created_by := null;
    new.updated_by := null;
    new.created_via := 'system';
    new.updated_via := 'system';
  else
    if auth.uid() is null or not public.is_admin() then
      raise exception 'admin required' using errcode = '42501';
    end if;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.created_via := 'admin';
    new.updated_via := 'admin';
  end if;
  new.id := gen_random_uuid();
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.prepare_attendance_insert() from public;

create function private.generate_scheduled_sessions(p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (p_now at time zone 'Asia/Seoul')::date;
  v_sessions integer;
  v_records integer;
begin
  if p_now is null then raise exception 'tick time required' using errcode = '22023'; end if;
  if private.trusted_actor() is distinct from 'system' then
    raise exception 'system actor required' using errcode = '42501';
  end if;

  -- (KST date + local time) at time zone 'Asia/Seoul' yields the exact UTC instant.
  insert into public.class_sessions (
    class_group_id, starts_at, ends_at, capacity, late_after_minutes, missing_after_minutes, schedule_id, session_date
  )
  select c.class_group_id,
         (d.on_date + c.local_start_time) at time zone 'Asia/Seoul',
         ((d.on_date + c.local_start_time) at time zone 'Asia/Seoul') + make_interval(mins => c.duration_minutes),
         c.capacity, c.late_after_minutes, c.missing_after_minutes, c.id, d.on_date
  from (values (v_today), (v_today + 1)) as d(on_date)
  join public.class_schedules c
    on c.active
   and c.iso_weekday = extract(isodow from d.on_date)
   and c.effective_from <= d.on_date
   and (c.effective_to is null or d.on_date <= c.effective_to)
  join public.class_groups g on g.id = c.class_group_id and g.is_active
  order by d.on_date, c.local_start_time, c.id
  on conflict do nothing;
  get diagnostics v_sessions = row_count;

  insert into public.attendance_records (student_id, scheduled_at, status, class_session_id)
  select e.student_id, cs.starts_at, 'scheduled', cs.id
  from public.class_sessions cs
  join public.enrollments e
    on e.class_group_id = cs.class_group_id
   and e.status = 'active'
   and e.enrolled_on <= cs.session_date
   and (e.ended_on is null or e.ended_on >= cs.session_date)
  join public.students st on st.id = e.student_id and st.status in ('active', 'returning')
  where cs.schedule_id is not null
    and cs.session_date in (v_today, v_today + 1)
    and cs.status = 'scheduled'
    and cs.ends_at > p_now
  order by cs.starts_at, e.student_id
  on conflict do nothing;
  get diagnostics v_records = row_count;

  return jsonb_build_object('sessions_created', v_sessions, 'records_created', v_records, 'days', jsonb_build_array(v_today, v_today + 1));
end;
$$;

-- ── operations tick ─────────────────────────────────────────────────────────
create table public.operations_tick_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_kind text not null check (trigger_kind in ('service', 'admin')),
  triggered_by uuid references public.profiles(id) on delete restrict,
  tick_at timestamptz not null,
  started_at timestamptz not null default clock_timestamp(),
  result jsonb not null default '{}'::jsonb,
  check ((trigger_kind = 'admin') = (triggered_by is not null))
);
create index operations_tick_runs_started_idx on public.operations_tick_runs (started_at desc);
create trigger reject_operations_tick_run_change
  before update or delete on public.operations_tick_runs
  for each row execute function private.reject_operations_audit_change();
alter table public.operations_tick_runs enable row level security;
create policy "admins read operations tick runs" on public.operations_tick_runs
  for select to authenticated using (public.is_admin());
revoke all on table public.operations_tick_runs from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.operations_tick_runs from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.operations_tick_runs from authenticated';
    execute 'grant select on table public.operations_tick_runs to authenticated';
  end if;
end;
$$;

create function private.run_operations_tick(p_now timestamptz, p_trigger text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation jsonb;
  v_followups jsonb;
  v_result jsonb;
begin
  if p_trigger is null or p_trigger not in ('service', 'admin') then
    raise exception 'invalid tick trigger' using errcode = '22023';
  end if;
  if p_trigger = 'admin' and (auth.uid() is null or not public.is_admin()) then
    raise exception 'admin required' using errcode = '42501';
  end if;
  -- One tick at a time; a concurrent tick waits and then finds nothing left to create.
  perform pg_advisory_xact_lock(hashtext('sequence.operations_tick'));
  perform private.begin_trusted('system');
  v_generation := private.generate_scheduled_sessions(p_now);
  v_followups := private.run_attendance_followups(p_now);
  perform private.end_trusted();
  v_result := jsonb_build_object('tick_at', p_now, 'generation', v_generation, 'followups', v_followups);
  -- Keep an audit row for every manual recovery, but avoid 288 no-op service rows per day.
  if p_trigger = 'admin'
     or coalesce((v_generation ->> 'sessions_created')::integer, 0) > 0
     or coalesce((v_generation ->> 'records_created')::integer, 0) > 0
     or coalesce((v_followups ->> 'expired_exceptions')::integer, 0) > 0
     or coalesce((v_followups ->> 'missing_opened')::integer, 0) > 0
     or coalesce((v_followups ->> 'checkout_opened')::integer, 0) > 0 then
    insert into public.operations_tick_runs (trigger_kind, triggered_by, tick_at, result)
    values (p_trigger, case when p_trigger = 'admin' then auth.uid() else null end, p_now, v_result);
  end if;
  delete from public.operations_refresh_events where occurred_at < now() - interval '7 days';
  return v_result;
end;
$$;

create function public.service_operations_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.run_operations_tick(now(), 'service');
end;
$$;

create function public.admin_run_operations_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  return private.run_operations_tick(now(), 'admin');
end;
$$;

-- ── keyset-paged unresolved queues ──────────────────────────────────────────
create function private.operations_session_json(p_attendance_id uuid)
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
    ), '[]'::jsonb)
  )
  from public.attendance_records r
  join public.class_sessions s on s.id = r.class_session_id
  join public.class_groups g on g.id = s.class_group_id
  join public.students st on st.id = r.student_id
  where r.id = p_attendance_id
$$;

create function private.operations_failed_message_json(p_message_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id, 'student_name', st.name, 'message_type', m.message_type, 'failure_code', m.failure_code,
    'failed_at', m.failed_at, 'manual_followup_at', m.manual_followup_at, 'recipient_label', m.recipient_label
  )
  from public.parent_messages m join public.students st on st.id = m.student_id
  where m.id = p_message_id
$$;

-- Draft parent messages an admin can approve (or cancel) individually. Makeup-offer messages are
-- excluded because admin_approve_parent_message rejects them; they are handled via makeup drafts.
create function private.is_draft_parent_message(p_message public.parent_messages)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select p_message.status in ('draft', 'approved') and p_message.message_type <> 'makeup_offer' $$;

create function private.operations_draft_message_json(p_message_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id, 'attendance_id', m.attendance_id, 'student_name', st.name, 'message_type', m.message_type,
    'status', m.status, 'created_at', m.created_at, 'recipient_label', m.recipient_label,
    'template_approved', coalesce(t.approved and t.template_version = m.template_version, false)
  )
  from public.parent_messages m
  join public.students st on st.id = m.student_id
  left join public.message_templates t on t.template_code = m.template_code
  where m.id = p_message_id
$$;

create function private.operations_makeup_draft_json(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'batch_id', b.id, 'attendance_id', b.attendance_id, 'student_name', st.name, 'origin', b.origin, 'status', b.status,
    'delivery_mode', b.delivery_mode, 'manual_reason', b.manual_reason, 'created_at', b.created_at,
    'options', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'starts_at', o.starts_at, 'ends_at', o.ends_at, 'sort_order', o.sort_order, 'status', o.status) order by o.sort_order)
      from public.makeup_offer_options o where o.offer_batch_id = b.id
    ), '[]'::jsonb)
  )
  from public.makeup_offer_batches b join public.students st on st.id = b.student_id
  where b.id = p_batch_id
$$;

-- Opaque cursor: "<UTC timestamp with microseconds>~<uuid>" of the last row on the page.
create function private.queue_cursor(p_at timestamptz, p_id uuid)
returns text
language sql
stable
set search_path = ''
as $$ select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '~' || p_id::text $$;

create function private.parse_queue_cursor(p_cursor text, out cursor_at timestamptz, out cursor_id uuid)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_cursor is null then return; end if;
  if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z~[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  begin
    cursor_at := split_part(p_cursor, '~', 1)::timestamptz;
    cursor_id := split_part(p_cursor, '~', 2)::uuid;
  exception when others then
    raise exception 'invalid cursor' using errcode = '22023';
  end;
end;
$$;

-- Older unresolved attendance work: before the requested KST day, session not cancelled,
-- and any open obligation: an open follow-up, a stale scheduled row, an arrived visit whose
-- learning plan was drafted but never published, or a parent message still awaiting approval.
-- There is no rolling cutoff: an obligation stays here until it is actually resolved.
create function private.is_older_unresolved(p_record public.attendance_records, p_session public.class_sessions, p_day date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (p_session.starts_at at time zone 'Asia/Seoul')::date < p_day
     and p_session.status <> 'cancelled'
     and (
       exists (select 1 from public.attendance_followups f where f.attendance_id = p_record.id and f.status = 'open')
       or (p_record.status = 'scheduled' and p_session.status = 'scheduled')
       or (
         p_record.status in ('present', 'late')
         and exists (
           select 1 from public.daily_learning_plans p
           where p.student_id = p_record.student_id and p.plan_date = (p_session.starts_at at time zone 'Asia/Seoul')::date and p.status = 'draft'
         )
         and not exists (
           select 1 from public.daily_learning_plans p
           where p.student_id = p_record.student_id and p.plan_date = (p_session.starts_at at time zone 'Asia/Seoul')::date and p.status = 'published'
         )
       )
       or exists (select 1 from public.parent_messages m where m.attendance_id = p_record.id and private.is_draft_parent_message(m))
     )
$$;

create function private.operations_queue_page(p_queue text, p_day date, p_cursor text, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
  v_id uuid;
  v_ids uuid[];
  v_ats timestamptz[];
  v_has_more boolean;
  v_items jsonb;
begin
  if p_queue is null or p_queue not in ('unresolved_sessions', 'failed_messages', 'draft_messages', 'makeup_drafts') then
    raise exception 'invalid queue' using errcode = '22023';
  end if;
  if p_day is null or p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid page request' using errcode = '22023';
  end if;
  select c.cursor_at, c.cursor_id into v_at, v_id from private.parse_queue_cursor(p_cursor) c;

  if p_queue = 'unresolved_sessions' then
    select coalesce(array_agg(q.id order by q.sort_at, q.id), '{}'), coalesce(array_agg(q.sort_at order by q.sort_at, q.id), '{}')
      into v_ids, v_ats
    from (
      select r.id, s.starts_at as sort_at
      from public.attendance_records r
      join public.class_sessions s on s.id = r.class_session_id
      where private.is_older_unresolved(r, s, p_day)
        and (v_at is null or (s.starts_at, r.id) > (v_at, v_id))
      order by s.starts_at, r.id
      limit p_limit + 1
    ) q;
  elsif p_queue = 'failed_messages' then
    select coalesce(array_agg(q.id order by q.sort_at desc, q.id desc), '{}'), coalesce(array_agg(q.sort_at order by q.sort_at desc, q.id desc), '{}')
      into v_ids, v_ats
    from (
      select m.id, m.failed_at as sort_at
      from public.parent_messages m
      where m.status = 'failed' and m.manual_followup_at is null
        and (v_at is null or (m.failed_at, m.id) < (v_at, v_id))
      order by m.failed_at desc, m.id desc
      limit p_limit + 1
    ) q;
  elsif p_queue = 'draft_messages' then
    select coalesce(array_agg(q.id order by q.sort_at, q.id), '{}'), coalesce(array_agg(q.sort_at order by q.sort_at, q.id), '{}')
      into v_ids, v_ats
    from (
      select m.id, m.created_at as sort_at
      from public.parent_messages m
      where private.is_draft_parent_message(m)
        and (v_at is null or (m.created_at, m.id) > (v_at, v_id))
      order by m.created_at, m.id
      limit p_limit + 1
    ) q;
  else
    select coalesce(array_agg(q.id order by q.sort_at, q.id), '{}'), coalesce(array_agg(q.sort_at order by q.sort_at, q.id), '{}')
      into v_ids, v_ats
    from (
      select b.id, b.created_at as sort_at
      from public.makeup_offer_batches b
      where b.status in ('draft', 'manual_followup')
        and (v_at is null or (b.created_at, b.id) > (v_at, v_id))
      order by b.created_at, b.id
      limit p_limit + 1
    ) q;
  end if;

  v_has_more := cardinality(v_ids) > p_limit;
  if v_has_more then
    v_ids := v_ids[1:p_limit];
    v_ats := v_ats[1:p_limit];
  end if;
  select coalesce(jsonb_agg(
    case p_queue
      when 'unresolved_sessions' then private.operations_session_json(u.id)
      when 'failed_messages' then private.operations_failed_message_json(u.id)
      when 'draft_messages' then private.operations_draft_message_json(u.id)
      else private.operations_makeup_draft_json(u.id)
    end order by u.ord), '[]'::jsonb)
    into v_items
  from unnest(v_ids) with ordinality as u(id, ord);
  return jsonb_build_object(
    'items', v_items,
    'has_more', v_has_more,
    'next_cursor', case when v_has_more then private.queue_cursor(v_ats[p_limit], v_ids[p_limit]) else null end
  );
end;
$$;

-- Full-queue aggregates. Bucket rules mirror buildOperationsBuckets() in
-- src/portal/operations-dashboard.js so a card never equals only the loaded page length.
create function private.operations_queue_counts(p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'unresolved_sessions', (
      select jsonb_build_object(
        'total', count(*),
        'missing', count(*) filter (where r.status = 'scheduled' and not x.active_exception),
        'planned_exceptions', count(*) filter (where r.status = 'scheduled' and x.active_exception),
        'present', count(*) filter (where r.status = 'present'),
        'late', count(*) filter (where r.status = 'late'),
        'absent', count(*) filter (where r.status in ('absent', 'excused')),
        'checkout_needed', count(*) filter (where r.status in ('present', 'late') and (x.checkout_open or (r.checked_out_at is null and now() > s.ends_at + interval '30 minutes'))),
        'plan_missing', count(*) filter (where r.status in ('present', 'late') and not x.plan_published)
      )
      from public.attendance_records r
      join public.class_sessions s on s.id = r.class_session_id
      cross join lateral (
        select
          exists (select 1 from public.attendance_exceptions e where e.student_id = r.student_id and e.class_session_id = r.class_session_id and e.status = 'active') as active_exception,
          exists (select 1 from public.attendance_followups f where f.attendance_id = r.id and f.kind = 'checkout_needed' and f.status = 'open') as checkout_open,
          exists (select 1 from public.daily_learning_plans p where p.student_id = r.student_id and p.plan_date = (s.starts_at at time zone 'Asia/Seoul')::date and p.status = 'published') as plan_published
      ) x
      where private.is_older_unresolved(r, s, p_day)
    ),
    'failed_messages', (
      select jsonb_build_object('total', count(*))
      from public.parent_messages m where m.status = 'failed' and m.manual_followup_at is null
    ),
    'draft_messages', (
      select jsonb_build_object('total', count(*))
      from public.parent_messages m where private.is_draft_parent_message(m)
    ),
    'makeup_drafts', (
      select jsonb_build_object(
        'total', count(*),
        'planned_absence_drafts', count(*) filter (where b.origin = 'planned_absence' and b.status = 'draft'),
        'makeup_followup', count(*) filter (where b.status = 'manual_followup')
      )
      from public.makeup_offer_batches b where b.status in ('draft', 'manual_followup')
    )
  )
$$;

create or replace function private.admin_operations_snapshot_for(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_page_size constant integer := 50;
  v_counts jsonb := private.operations_queue_counts(p_day);
  v_unresolved jsonb := private.operations_queue_page('unresolved_sessions', p_day, null, c_page_size);
  v_failed jsonb := private.operations_queue_page('failed_messages', p_day, null, c_page_size);
  v_draft_messages jsonb := private.operations_queue_page('draft_messages', p_day, null, c_page_size);
  v_drafts jsonb := private.operations_queue_page('makeup_drafts', p_day, null, c_page_size);
  v_meta jsonb;
begin
  v_meta := jsonb_build_object(
    'unresolved_sessions', (v_counts -> 'unresolved_sessions') || jsonb_build_object('has_more', v_unresolved -> 'has_more', 'next_cursor', v_unresolved -> 'next_cursor'),
    'failed_messages', (v_counts -> 'failed_messages') || jsonb_build_object('has_more', v_failed -> 'has_more', 'next_cursor', v_failed -> 'next_cursor'),
    'draft_messages', (v_counts -> 'draft_messages') || jsonb_build_object('has_more', v_draft_messages -> 'has_more', 'next_cursor', v_draft_messages -> 'next_cursor'),
    'makeup_drafts', (v_counts -> 'makeup_drafts') || jsonb_build_object('has_more', v_drafts -> 'has_more', 'next_cursor', v_drafts -> 'next_cursor')
  );
  return jsonb_build_object(
    'day', p_day,
    'generated_at', now(),
    'page_size', c_page_size,
    'sessions', coalesce((
      select jsonb_agg(private.operations_session_json(r.id) order by s.starts_at, st.name, r.id)
      from public.attendance_records r
      join public.class_sessions s on s.id = r.class_session_id
      join public.students st on st.id = r.student_id
      where (s.starts_at at time zone 'Asia/Seoul')::date = p_day
    ), '[]'::jsonb),
    'unresolved_sessions', v_unresolved -> 'items',
    'failed_messages', v_failed -> 'items',
    'draft_messages', v_draft_messages -> 'items',
    'makeup_drafts', v_drafts -> 'items',
    'queues', v_meta
  );
end;
$$;

create function public.admin_operations_queue_page(p_queue text, p_cursor text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  return private.operations_queue_page(p_queue, (now() at time zone 'Asia/Seoul')::date, p_cursor, 50);
end;
$$;

-- ── function privileges ─────────────────────────────────────────────────────
revoke all on function public.admin_create_class_schedule(uuid, integer, text, integer, integer, integer, integer, date, date) from public;
revoke all on function public.admin_update_class_schedule(uuid, integer, integer, text, integer, integer, integer, integer, date, date) from public;
revoke all on function public.admin_deactivate_class_schedule(uuid, integer) from public;
revoke all on function public.admin_list_class_schedules() from public;
revoke all on function public.admin_run_operations_tick() from public;
revoke all on function public.admin_operations_queue_page(text, text) from public;
revoke all on function public.service_operations_tick() from public;
do $$
declare
  fn text;
  admin_fns text[] := array[
    'public.admin_create_class_schedule(uuid, integer, text, integer, integer, integer, integer, date, date)',
    'public.admin_update_class_schedule(uuid, integer, integer, text, integer, integer, integer, integer, date, date)',
    'public.admin_deactivate_class_schedule(uuid, integer)',
    'public.admin_list_class_schedules()',
    'public.admin_run_operations_tick()',
    'public.admin_operations_queue_page(text, text)'
  ];
begin
  foreach fn in array admin_fns loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || fn || ' from service_role'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || fn || ' to authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.service_operations_tick() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.service_operations_tick() from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.service_operations_tick() to service_role'; end if;

  -- Private helpers are never callable by API roles (Supabase may add default grants).
  for fn in
    select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'
  loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || fn || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || fn || ' from service_role'; end if;
  end loop;
end;
$$;

-- ── realtime refresh signal ─────────────────────────────────────────────────
-- Never publish operational rows themselves: some contain free text, message copy, or token
-- verifiers. Admin clients need only a secret-free signal telling them to reload via the
-- narrow snapshot RPC.
create table public.operations_refresh_events (
  id bigint generated always as identity primary key,
  entity text not null check (entity ~ '^[a-z_]{1,60}$'),
  entity_id uuid,
  occurred_at timestamptz not null default now()
);
create index operations_refresh_events_occurred_idx on public.operations_refresh_events (occurred_at desc, id desc);
alter table public.operations_refresh_events enable row level security;
create policy "admins read operations refresh events" on public.operations_refresh_events
  for select to authenticated using (public.is_admin());
revoke all on table public.operations_refresh_events from public, anon, authenticated;
grant select on table public.operations_refresh_events to authenticated;

create function private.emit_operations_refresh_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := case when tg_op = 'DELETE' then old.id else new.id end;
  insert into public.operations_refresh_events (entity, entity_id) values (tg_table_name, v_id);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger refresh_signal_attendance_records after insert or update or delete on public.attendance_records
  for each row execute function private.emit_operations_refresh_event();
create trigger refresh_signal_attendance_followups after insert or update or delete on public.attendance_followups
  for each row execute function private.emit_operations_refresh_event();
create trigger refresh_signal_parent_messages after insert or update or delete on public.parent_messages
  for each row execute function private.emit_operations_refresh_event();
create trigger refresh_signal_makeup_offer_batches after insert or update or delete on public.makeup_offer_batches
  for each row execute function private.emit_operations_refresh_event();
create trigger refresh_signal_daily_learning_plans after insert or update or delete on public.daily_learning_plans
  for each row execute function private.emit_operations_refresh_event();
create trigger refresh_signal_class_sessions after insert or update or delete on public.class_sessions
  for each row execute function private.emit_operations_refresh_event();

revoke all on function private.emit_operations_refresh_event() from public, anon, authenticated;

-- Only the signal table enters Realtime. Secret/code and operational data tables are excluded.
do $$
declare v_pub_all boolean;
begin
  select puballtables into v_pub_all from pg_publication where pubname = 'supabase_realtime';
  if not found or v_pub_all then return; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'operations_refresh_events'
  ) then
    execute 'alter publication supabase_realtime add table public.operations_refresh_events';
  end if;
end;
$$;

-- ── pg_cron operations tick ─────────────────────────────────────────────────
-- Supabase Cron: enable the extension in pg_catalog and schedule a named job. Everything
-- that touches the extension schema runs through dynamic SQL so databases without the
-- extension (local PGlite tests) parse and skip this block. Re-running replaces the job.
do $$
declare
  v_available boolean := false;
begin
  -- Only the availability probe is guarded; install/schedule failures must fail the migration.
  begin
    v_available := exists (select 1 from pg_available_extensions where name = 'pg_cron');
  exception when others then
    v_available := false;
  end;
  if not v_available then
    raise notice 'pg_cron unavailable; operations tick must be triggered externally';
    return;
  end if;
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  execute 'select cron.unschedule(jobid) from cron.job where jobname = ''sequence-operations-tick''';
  execute 'select cron.schedule(''sequence-operations-tick'', ''*/5 * * * *'', ''select public.service_operations_tick()'')';
  execute 'select cron.unschedule(jobid) from cron.job where jobname = ''sequence-cron-history-cleanup''';
  execute 'select cron.schedule(''sequence-cron-history-cleanup'', ''0 0 * * *'', ''delete from cron.job_run_details where end_time < now() - interval ''''7 days'''''')';
end;
$$;
