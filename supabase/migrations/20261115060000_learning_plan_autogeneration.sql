-- Automatic daily learning-plan drafts and the admin "next progress" queue.
-- Repository-only. Nothing here auto-publishes: a generated plan is always a draft that the
-- owner must publish through admin_publish_learning_plan. Students still see only published plans.
--
--   * student_progress_targets: admin-managed, per-student ordered queue of next-progress
--     entries. Writes only via narrow SECURITY DEFINER RPCs; admins read through RLS.
--   * daily_learning_plans.created_via: 'system' drafts carry no fake auth.uid().
--   * private.build_learning_plan_draft: deterministic draft from current sources
--     (homework → redo → carryover → auto_progress | note), max 30 items.
--   * Arrival trigger: first actual scheduled→present/late transition creates one draft.
--   * Publish consumes exactly the progress targets referenced by the published draft.

-- ── system-created learning plans ───────────────────────────────────────────
alter table public.daily_learning_plans
  add column created_via text not null default 'admin' check (created_via in ('admin', 'system'));
alter table public.daily_learning_plans alter column created_by drop not null;
alter table public.daily_learning_plans
  add constraint daily_learning_plans_created_actor_check check (
    (created_via = 'admin' and created_by is not null) or (created_via = 'system' and created_by is null)
  );

-- Attribution is derived server-side, never from caller-supplied columns.
create function private.prepare_learning_plan_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if private.trusted_actor() = 'system' then
      new.created_via := 'system';
      new.created_by := null;
    else
      if auth.uid() is null or not public.is_admin() then
        raise exception 'admin required' using errcode = '42501';
      end if;
      new.created_via := 'admin';
      new.created_by := auth.uid();
    end if;
  elsif new.created_via is distinct from old.created_via or new.created_by is distinct from old.created_by then
    raise exception 'learning plan attribution is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger prepare_daily_learning_plans before insert or update on public.daily_learning_plans
  for each row execute function private.prepare_learning_plan_row();

-- ── next-progress queue ─────────────────────────────────────────────────────
create table public.student_progress_targets (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  sequence integer not null check (sequence > 0),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  body text not null default '' check (char_length(body) <= 2000),
  status text not null default 'queued' check (status in ('queued', 'consumed', 'cancelled')),
  consumed_by_plan_id uuid references public.daily_learning_plans(id) on delete restrict,
  consumed_by uuid references public.profiles(id) on delete restrict,
  consumed_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, sequence),
  check ((status = 'consumed') = (consumed_by_plan_id is not null and consumed_by is not null and consumed_at is not null)),
  check ((status = 'cancelled') = (cancelled_by is not null and cancelled_at is not null)),
  check (status = 'consumed' or (consumed_by_plan_id is null and consumed_by is null and consumed_at is null)),
  check (status = 'cancelled' or (cancelled_by is null and cancelled_at is null))
);
create index student_progress_targets_queue_idx on public.student_progress_targets (student_id, sequence) where status = 'queued';

create function private.guard_progress_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued' then raise exception 'progress target must start queued' using errcode = '23514'; end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.student_id is distinct from old.student_id
     or new.sequence is distinct from old.sequence or new.title is distinct from old.title
     or new.body is distinct from old.body or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'progress target content is immutable' using errcode = '42501';
  end if;
  if old.status <> 'queued' then
    raise exception 'progress target state is final' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger guard_student_progress_targets before insert or update on public.student_progress_targets
  for each row execute function private.guard_progress_target();
create trigger audit_student_progress_targets after insert or update on public.student_progress_targets
  for each row execute function private.audit_operation_row();
-- Secret-free refresh signal only; the target table itself is never added to Realtime.
create trigger refresh_signal_student_progress_targets after insert or update or delete on public.student_progress_targets
  for each row execute function private.emit_operations_refresh_event();

alter table public.student_progress_targets enable row level security;
create policy "admins read progress targets" on public.student_progress_targets
  for select to authenticated using (public.is_admin());
revoke all on table public.student_progress_targets from public, anon, authenticated;
grant select on table public.student_progress_targets to authenticated;

create function public.admin_enqueue_progress_target(p_student_id uuid, p_title text, p_body text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence integer;
  v_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200 then
    raise exception 'progress title required' using errcode = '22023';
  end if;
  if char_length(coalesce(p_body, '')) > 2000 then raise exception 'progress body too long' using errcode = '22023'; end if;
  -- The student row lock serializes sequence allocation and publish-time consumption.
  perform 1 from public.students where id = p_student_id for update;
  if not found then raise exception 'student not found' using errcode = '23503'; end if;
  -- Sequences are never reused, even after cancellation, so queue order stays stable.
  select coalesce(max(sequence), 0) + 1 into v_sequence from public.student_progress_targets where student_id = p_student_id;
  insert into public.student_progress_targets (student_id, sequence, title, body, created_by)
  values (p_student_id, v_sequence, btrim(p_title), btrim(coalesce(p_body, '')), auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'sequence', v_sequence);
end;
$$;

-- Compare-and-set: only a still-queued target can be cancelled.
create function public.admin_cancel_progress_target(p_target_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  select student_id into v_student from public.student_progress_targets where id = p_target_id;
  if v_student is null then raise exception 'progress target not found' using errcode = '23503'; end if;
  perform 1 from public.students where id = v_student for update;
  update public.student_progress_targets
    set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), updated_at = now()
    where id = p_target_id and status = 'queued';
  if not found then raise exception 'progress target state changed' using errcode = '40001'; end if;
end;
$$;

-- ── draft generation ────────────────────────────────────────────────────────
-- The plan date is the KST calendar date of the class session (falling back to the record).
create function private.attendance_plan_date(p_record public.attendance_records)
returns date
language sql
stable
set search_path = ''
as $$
  select (coalesce(s.starts_at, p_record.scheduled_at) at time zone 'Asia/Seoul')::date
  from (select 1) one
  left join public.class_sessions s on s.id = p_record.class_session_id
$$;

-- Builds one draft revision from current sources. p_force = false returns the latest existing
-- draft/published plan for the student and session date instead of adding a revision.
-- Caller context decides attribution (system trusted actor or authenticated admin).
create function private.build_learning_plan_draft(p_attendance_id uuid, p_force boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
  v_student public.students%rowtype;
  v_date date;
  v_day_end timestamptz;
  v_prior uuid;
  v_target public.student_progress_targets%rowtype;
  v_progress_source text;
  v_items jsonb;
  v_revision integer;
  v_plan uuid;
begin
  -- Lock order everywhere in this feature: attendance row, then student row.
  select * into v_record from public.attendance_records where id = p_attendance_id for update;
  if v_record.id is null then raise exception 'attendance record required' using errcode = '23503'; end if;
  select * into v_student from public.students where id = v_record.student_id for update;
  if v_student.id is null then raise exception 'student not found' using errcode = '23503'; end if;
  v_date := private.attendance_plan_date(v_record);

  if not p_force then
    select id into v_plan from public.daily_learning_plans
      where student_id = v_student.id and plan_date = v_date and status in ('draft', 'published')
      order by source_revision desc limit 1;
    if v_plan is not null then return v_plan; end if;
  end if;

  v_day_end := (v_date + 1)::timestamp at time zone 'Asia/Seoul';

  select id into v_prior from public.daily_learning_plans
    where student_id = v_student.id and status = 'published' and plan_date < v_date
    order by plan_date desc limit 1;

  -- A target already consumed by today's published revision stays today's progress;
  -- otherwise the first queued target. Nothing is invented when the queue is empty.
  select t.* into v_target from public.student_progress_targets t
    join public.daily_learning_plans p on p.id = t.consumed_by_plan_id
    where t.student_id = v_student.id and t.status = 'consumed' and p.plan_date = v_date
    order by t.sequence limit 1;
  if v_target.id is null then
    select * into v_target from public.student_progress_targets
      where student_id = v_student.id and status = 'queued'
      order by sequence limit 1;
  end if;
  v_progress_source := case when v_target.id is null then null else 'progress_target:' || v_target.id::text end;

  with homework as (
    select 1 as rank,
           row_number() over (order by a.due_at, a.created_at, a.id) as ord,
           'homework'::text as item_type,
           coalesce(nullif(btrim(a.title), ''), '숙제') as title,
           '마감 ' || to_char(a.due_at at time zone 'Asia/Seoul', 'MM/DD HH24:MI') as body,
           'assignment:' || a.id::text as source_id,
           null::integer as progress_sequence,
           null::text as origin_source
    from public.assignments a
    where v_student.account_profile_id is not null
      and a.student_id = v_student.account_profile_id
      and a.due_at is not null
      and a.due_at < v_day_end
      -- Missed homework means no attempt at all; pending review / needs_revision are not missed.
      and not exists (select 1 from public.submissions s where s.assignment_id = a.id)
  ),
  latest as (
    select distinct on (s.assignment_id) s.id, s.assignment_id, s.status::text as status
    from public.submissions s
    join public.assignments a on a.id = s.assignment_id
    where v_student.account_profile_id is not null
      and a.student_id = v_student.account_profile_id
    order by s.assignment_id, s.attempt_no desc
  ),
  redo as (
    select 2 as rank,
           row_number() over (order by a.due_at nulls last, a.created_at, a.id, fi.created_at, fi.id) as ord,
           'redo'::text as item_type,
           left(coalesce(nullif(btrim(a.title), ''), '재풀이') || ' · ' || fi.problem_ref, 200) as title,
           left(fi.review_tag || case when btrim(fi.comment) <> '' then ' · ' || btrim(fi.comment) else '' end, 2000) as body,
           'feedback_item:' || fi.id::text as source_id,
           null::integer as progress_sequence,
           null::text as origin_source
    from latest l
    join public.assignments a on a.id = l.assignment_id
    join public.feedback f on f.submission_id = l.id
    join public.feedback_items fi on fi.feedback_id = f.id and fi.redo_required
    where l.status = 'needs_revision'
  ),
  carry as (
    select 3 as rank,
           row_number() over (order by i.sort_order) as ord,
           'carryover'::text as item_type,
           i.title,
           i.body,
           'plan_item:' || i.id::text as source_id,
           i.progress_sequence,
           i.source_id as origin_source
    from public.daily_learning_plan_items i
    where v_prior is not null and i.plan_id = v_prior
      and i.teacher_status <> 'confirmed'
      and i.item_type <> 'note'
  ),
  fresh_sources as (
    select source_id from homework
    union all select source_id from redo
    union all select v_progress_source where v_progress_source is not null
  ),
  candidates as (
    select * from homework
    union all select * from redo
    -- Work already regenerated from its live source today is not carried over a second time.
    union all select c.* from carry c
      where c.origin_source is null or not exists (select 1 from fresh_sources f where f.source_id = c.origin_source)
  ),
  deduped as (
    select c.*, row_number() over (partition by c.source_id order by c.rank, c.ord) as dup from candidates c
  ),
  limited as (
    -- 29 priority slots; the 30th is always the progress item or the "enter next progress" note.
    select * from deduped where dup = 1 order by rank, ord limit 29
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_type', item_type, 'title', title, 'body', body,
           'source_id', source_id, 'progress_sequence', progress_sequence
         ) order by rank, ord), '[]'::jsonb)
    into v_items
  from limited;

  v_items := v_items || jsonb_build_array(
    case when v_target.id is not null then jsonb_build_object(
      'item_type', 'auto_progress', 'title', v_target.title, 'body', v_target.body,
      'source_id', v_progress_source, 'progress_sequence', v_target.sequence)
    else jsonb_build_object(
      'item_type', 'note', 'title', '다음 진도 확인 필요',
      'body', '원장님이 다음 진도를 입력·확인해야 합니다. 자동으로 정한 진도는 없습니다.',
      'source_id', 'next_progress_required', 'progress_sequence', null)
    end);

  select coalesce(max(source_revision), 0) + 1 into v_revision
    from public.daily_learning_plans where student_id = v_student.id and plan_date = v_date;
  insert into public.daily_learning_plans (student_id, class_session_id, plan_date, source_revision, owner_note)
  values (v_student.id, v_record.class_session_id, v_date, v_revision, '')
  returning id into v_plan;

  insert into public.daily_learning_plan_items (plan_id, item_type, title, body, sort_order, source_id, progress_sequence)
  select v_plan, x.item ->> 'item_type', x.item ->> 'title', coalesce(x.item ->> 'body', ''), x.ord::integer,
         x.item ->> 'source_id', (x.item ->> 'progress_sequence')::integer
  from jsonb_array_elements(v_items) with ordinality as x(item, ord);
  return v_plan;
end;
$$;

-- Idempotent system generation. Runs under the 'system' trusted actor and restores the caller's
-- trusted context (e.g. kiosk + device) so later triggers on the same statement keep attribution.
create function private.generate_learning_plan_for_attendance(p_attendance_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev_actor text := private.trusted_actor();
  v_prev_device uuid := private.trusted_device();
  v_plan uuid;
begin
  perform private.begin_trusted('system');
  v_plan := private.build_learning_plan_draft(p_attendance_id, false);
  perform set_config('sequence.trusted_actor', coalesce(v_prev_actor, ''), true);
  perform set_config('sequence.trusted_device', coalesce(v_prev_device::text, ''), true);
  return v_plan;
end;
$$;

-- Only an actual arrival creates the initial draft. Attendance is the primary fact: a generation
-- failure is rolled back to its savepoint (restoring trusted context) and never blocks check-in;
-- the session then shows as "plan missing" and the owner can regenerate.
create function private.learning_plan_draft_on_arrival()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'scheduled' and new.status in ('present', 'late') then
    begin
      perform private.generate_learning_plan_for_attendance(new.id);
    exception when others then
      raise warning 'learning plan draft not generated for attendance % (sqlstate %)', new.id, sqlstate;
    end;
  end if;
  return new;
end;
$$;
create trigger learning_plan_draft_on_arrival after update of status on public.attendance_records
  for each row execute function private.learning_plan_draft_on_arrival();

-- Owner regeneration: always a new draft revision from current sources. The published revision
-- is never touched; p_expected_revision (latest revision the owner saw, 0 for none) is a CAS guard.
create function public.admin_regenerate_learning_plan(p_attendance_id uuid, p_expected_revision integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
  v_date date;
  v_latest integer;
  v_plan uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  select * into v_record from public.attendance_records where id = p_attendance_id for update;
  if v_record.id is null then raise exception 'attendance record required' using errcode = '23503'; end if;
  perform 1 from public.students where id = v_record.student_id for update;
  v_date := private.attendance_plan_date(v_record);
  select coalesce(max(source_revision), 0) into v_latest
    from public.daily_learning_plans where student_id = v_record.student_id and plan_date = v_date;
  if p_expected_revision is not null and p_expected_revision <> v_latest then
    raise exception 'learning plan revision changed' using errcode = '40001';
  end if;
  v_plan := private.build_learning_plan_draft(p_attendance_id, true);
  return jsonb_build_object('plan_id', v_plan, 'revision', v_latest + 1, 'plan_date', v_date);
end;
$$;

-- ── publish: atomically consume referenced progress targets ────────────────
create or replace function public.admin_publish_learning_plan(p_plan_id uuid, p_expected_revision integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.daily_learning_plans%rowtype;
  v_refs uuid[];
  v_target record;
  v_found integer := 0;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  -- Identify the lock key without trusting this unlocked snapshot, then serialize
  -- against draft creation on the same student row and re-read the plan under lock.
  select * into v_plan from public.daily_learning_plans where id = p_plan_id;
  if v_plan.id is null then raise exception 'learning plan revision changed' using errcode = '40001'; end if;
  perform 1 from public.students where id = v_plan.student_id for update;
  select * into v_plan from public.daily_learning_plans where id = p_plan_id for update;
  if v_plan.id is null or v_plan.status <> 'draft' or v_plan.source_revision <> p_expected_revision
     or exists (select 1 from public.daily_learning_plans p where p.student_id = v_plan.student_id and p.plan_date = v_plan.plan_date and p.source_revision > v_plan.source_revision) then
    raise exception 'learning plan revision changed' using errcode = '40001';
  end if;

  if exists (
    select 1 from public.daily_learning_plan_items i
    where i.plan_id = p_plan_id and i.source_id like 'progress\_target:%'
      and i.source_id !~ '^progress_target:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'invalid progress target reference' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct substr(i.source_id, 17)::uuid), '{}') into v_refs
    from public.daily_learning_plan_items i
    where i.plan_id = p_plan_id and i.source_id like 'progress\_target:%';

  for v_target in
    select t.id, t.student_id, t.status, cp.student_id as consumed_student, cp.plan_date as consumed_date
    from public.student_progress_targets t
    left join public.daily_learning_plans cp on cp.id = t.consumed_by_plan_id
    where t.id = any (v_refs)
    order by t.id
    for update of t
  loop
    v_found := v_found + 1;
    if v_target.student_id <> v_plan.student_id then
      raise exception 'progress target changed' using errcode = '40001';
    end if;
    if v_target.status = 'queued' then
      update public.student_progress_targets
        set status = 'consumed', consumed_by_plan_id = p_plan_id, consumed_by = auth.uid(), consumed_at = now(), updated_at = now()
        where id = v_target.id and status = 'queued';
    elsif v_target.status = 'consumed' and v_target.consumed_student = v_plan.student_id and v_target.consumed_date = v_plan.plan_date then
      -- Same-day revision of an already-published plan: the original consumption stands.
      null;
    else
      raise exception 'progress target changed' using errcode = '40001';
    end if;
  end loop;
  if v_found <> coalesce(array_length(v_refs, 1), 0) then
    raise exception 'progress target changed' using errcode = '40001';
  end if;

  -- Superseding never unconsumes: targets stay linked to the plan that first consumed them.
  update public.daily_learning_plans set status = 'superseded', updated_at = now()
    where student_id = v_plan.student_id and plan_date = v_plan.plan_date and status = 'published';
  update public.daily_learning_plans set status = 'published', published_at = now(), published_by = auth.uid(), updated_at = now()
    where id = p_plan_id and status = 'draft';
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────
revoke all on function public.admin_enqueue_progress_target(uuid, text, text) from public, anon;
grant execute on function public.admin_enqueue_progress_target(uuid, text, text) to authenticated;
revoke all on function public.admin_cancel_progress_target(uuid) from public, anon;
grant execute on function public.admin_cancel_progress_target(uuid) to authenticated;
revoke all on function public.admin_regenerate_learning_plan(uuid, integer) from public, anon;
grant execute on function public.admin_regenerate_learning_plan(uuid, integer) to authenticated;
revoke all on function public.admin_publish_learning_plan(uuid, integer) from public, anon;
grant execute on function public.admin_publish_learning_plan(uuid, integer) to authenticated;

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
end;
$$;
