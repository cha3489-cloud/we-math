-- Sequence Math attendance source of truth.
-- Repository-only until the production migration gate is approved.
-- Attendance is an academy business record: once a profile has records, physical
-- account deletion is intentionally blocked by ON DELETE RESTRICT. Use the
-- existing suspend/reactivate workflow instead of deleting the profile.

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete restrict,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'present', 'late', 'absent', 'excused')),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  absence_reason text check (absence_reason is null or char_length(trim(absence_reason)) between 1 and 500),
  guardian_contact_status text check (guardian_contact_status in ('contacted', 'unreachable')),
  guardian_contacted_at timestamptz,
  note text not null default '' check (char_length(note) <= 1000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, scheduled_at),
  check (checked_out_at is null or (checked_in_at is not null and checked_out_at >= checked_in_at)),
  check (absence_reason is null or status in ('absent', 'excused')),
  check (
    (guardian_contact_status is null and guardian_contacted_at is null)
    or (
      status in ('absent', 'excused')
      and guardian_contact_status in ('contacted', 'unreachable')
      and guardian_contacted_at is not null
    )
  ),
  check (
    (status = 'scheduled' and checked_in_at is null and checked_out_at is null)
    or (status in ('present', 'late') and checked_in_at is not null)
    or (status in ('absent', 'excused') and checked_in_at is null and checked_out_at is null)
  )
);

create index attendance_records_scheduled_idx
  on public.attendance_records (scheduled_at, status);
create index attendance_records_student_idx
  on public.attendance_records (student_id, scheduled_at desc);

alter table public.attendance_records enable row level security;

create policy "attendance records visible to admins"
  on public.attendance_records
  for select to authenticated
  using (public.is_admin());

create policy "admins create attendance records"
  on public.attendance_records
  for insert to authenticated
  with check (
    public.is_admin()
    and created_by = auth.uid()
    and updated_by = auth.uid()
  );

create policy "admins update attendance records"
  on public.attendance_records
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create or replace function public.touch_attendance_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if new.student_id is distinct from old.student_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'attendance ownership is immutable' using errcode = '42501';
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.touch_attendance_record() from public, anon, authenticated;

create trigger touch_attendance_record
  before update on public.attendance_records
  for each row execute function public.touch_attendance_record();

revoke all on table public.attendance_records from public, anon, authenticated;
grant select, insert on table public.attendance_records to authenticated;
grant update (scheduled_at, status, checked_in_at, checked_out_at, absence_reason, guardian_contact_status, guardian_contacted_at, note)
  on table public.attendance_records to authenticated;

create table public.makeup_plans (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null unique references public.attendance_records(id) on delete restrict,
  status text not null default 'planned'
    check (status in ('planned', 'completed', 'cancelled')),
  scheduled_at timestamptz not null,
  completed_at timestamptz,
  method text not null check (method in ('in_person', 'video', 'assignment')),
  note text not null default '' check (char_length(note) <= 1000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'planned' and completed_at is null)
    or (status = 'completed' and completed_at is not null)
    or (status = 'cancelled' and completed_at is null)
  )
);

create index makeup_plans_status_scheduled_idx
  on public.makeup_plans (status, scheduled_at);

alter table public.makeup_plans enable row level security;

create policy "makeup plans visible to admins"
  on public.makeup_plans
  for select to authenticated
  using (public.is_admin());

create policy "admins create makeup plans"
  on public.makeup_plans
  for insert to authenticated
  with check (
    public.is_admin()
    and created_by = auth.uid()
    and updated_by = auth.uid()
  );

create policy "admins update makeup plans"
  on public.makeup_plans
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create or replace function public.validate_makeup_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  attendance_status text;
  attendance_contact_status text;
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  select status, guardian_contact_status
    into attendance_status, attendance_contact_status
    from public.attendance_records
    where id = new.attendance_id
    for update;
  if attendance_status is null then
    raise exception 'attendance record required' using errcode = '23503';
  end if;
  if attendance_status not in ('absent', 'excused') then
    raise exception 'makeup requires an absence' using errcode = '23514';
  end if;
  if attendance_contact_status is null or attendance_contact_status not in ('contacted', 'unreachable') then
    raise exception 'guardian contact outcome required' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE'
     and old.status = 'completed'
     and (
       new.status is distinct from old.status
       or new.scheduled_at is distinct from old.scheduled_at
       or new.completed_at is distinct from old.completed_at
       or new.method is distinct from old.method
       or new.note is distinct from old.note
     ) then
    raise exception 'completed makeup is immutable' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE'
     and old.status = 'cancelled'
     and new.status = 'completed' then
    raise exception 'cancelled makeup must be replanned before completion' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.touch_makeup_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.attendance_id is distinct from old.attendance_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'makeup ownership is immutable' using errcode = '42501';
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.validate_makeup_plan() from public, anon, authenticated;
revoke all on function public.touch_makeup_plan() from public, anon, authenticated;

create trigger validate_makeup_plan
  before insert or update on public.makeup_plans
  for each row execute function public.validate_makeup_plan();
create trigger touch_makeup_plan
  before update on public.makeup_plans
  for each row execute function public.touch_makeup_plan();

create or replace function public.validate_attendance_makeup_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
       new.status not in ('absent', 'excused')
       or new.guardian_contact_status is null
       or new.guardian_contacted_at is null
     )
     and exists (
       select 1 from public.makeup_plans where attendance_id = new.id
     ) then
    raise exception 'attendance with a makeup plan must retain absence and contact outcome' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_attendance_makeup_state() from public, anon, authenticated;
create trigger validate_attendance_makeup_state
  before update of status, guardian_contact_status, guardian_contacted_at on public.attendance_records
  for each row execute function public.validate_attendance_makeup_state();

revoke all on table public.makeup_plans from public, anon, authenticated;
grant select, insert on table public.makeup_plans to authenticated;
grant update (status, scheduled_at, completed_at, method, note)
  on table public.makeup_plans to authenticated;

create table public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete restrict,
  makeup_plan_id uuid references public.makeup_plans(id) on delete restrict,
  event_type text not null
    check (event_type in ('attendance_created', 'attendance_updated', 'makeup_created', 'makeup_updated')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index attendance_events_attendance_idx
  on public.attendance_events (attendance_id, created_at desc);

alter table public.attendance_events enable row level security;
create policy "attendance events visible to admins"
  on public.attendance_events
  for select to authenticated
  using (public.is_admin());

create or replace function public.record_attendance_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.attendance_events (attendance_id, event_type, actor_id, details)
  values (
    new.id,
    case when tg_op = 'INSERT' then 'attendance_created' else 'attendance_updated' end,
    auth.uid(),
    jsonb_build_object(
      'status', new.status,
      'scheduled_at', new.scheduled_at,
      'guardian_contact_status', new.guardian_contact_status,
      'guardian_contacted_at', new.guardian_contacted_at
    )
  );
  return new;
end;
$$;

create or replace function public.record_makeup_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.attendance_events (attendance_id, makeup_plan_id, event_type, actor_id, details)
  values (
    new.attendance_id,
    new.id,
    case when tg_op = 'INSERT' then 'makeup_created' else 'makeup_updated' end,
    auth.uid(),
    jsonb_build_object(
      'status', new.status,
      'scheduled_at', new.scheduled_at,
      'completed_at', new.completed_at,
      'method', new.method
    )
  );
  return new;
end;
$$;

revoke all on function public.record_attendance_event() from public, anon, authenticated;
revoke all on function public.record_makeup_event() from public, anon, authenticated;

create trigger record_attendance_event
  after insert or update on public.attendance_records
  for each row execute function public.record_attendance_event();
create trigger record_makeup_event
  after insert or update on public.makeup_plans
  for each row execute function public.record_makeup_event();

revoke all on table public.attendance_events from public, anon, authenticated;
grant select on table public.attendance_events to authenticated;
