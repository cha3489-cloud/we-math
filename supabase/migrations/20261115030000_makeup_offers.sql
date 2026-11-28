-- Makeup offers: exactly three capacity-valid choices, server-side capacity recheck,
-- selection allowed only until the end of the Asia/Seoul date on which the offer was sent.
-- Planned absences create a manual draft by default; the owner must press send.
-- Selection tokens are derived server-side and never stored in plaintext.

alter table public.makeup_plans
  add column class_session_id uuid references public.class_sessions(id) on delete restrict,
  add column created_via text not null default 'admin' check (created_via in ('admin', 'makeup_selection'));
alter table public.makeup_plans alter column created_by drop not null;
alter table public.makeup_plans alter column updated_by drop not null;
alter table public.makeup_plans
  add constraint makeup_plans_created_actor_check check (created_by is not null or created_via <> 'admin');
create index makeup_plans_session_idx on public.makeup_plans (class_session_id, status);

create or replace function public.prepare_makeup_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.trusted_actor() = 'makeup_selection' then
    new.created_by := null;
    new.updated_by := null;
    new.created_via := 'makeup_selection';
  else
    if auth.uid() is null or not public.is_admin() then
      raise exception 'admin required' using errcode = '42501';
    end if;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.created_via := 'admin';
  end if;
  new.id := gen_random_uuid();
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.prepare_makeup_insert() from public, anon, authenticated;

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
  if not public.is_admin() and private.trusted_actor() is distinct from 'makeup_selection' then
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
  if attendance_contact_status is distinct from 'contacted' then
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
revoke all on function public.validate_makeup_plan() from public, anon, authenticated;

create or replace function public.touch_makeup_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.attendance_id is distinct from old.attendance_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.created_via is distinct from old.created_via then
    raise exception 'makeup ownership is immutable' using errcode = '42501';
  end if;
  new.updated_by := case when private.actor_kind() = 'admin' then auth.uid() else null end;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.touch_makeup_plan() from public, anon, authenticated;

create function private.makeup_event_state(p_row public.makeup_plans)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'status', p_row.status,
    'scheduled_at', p_row.scheduled_at,
    'completed_at', p_row.completed_at,
    'method', p_row.method,
    'class_session_id', p_row.class_session_id,
    'created_via', p_row.created_via
  )
$$;

create or replace function public.record_makeup_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := private.actor_kind();
begin
  insert into public.attendance_events (attendance_id, makeup_plan_id, event_type, actor_id, actor_kind, details)
  values (
    new.attendance_id,
    new.id,
    case when tg_op = 'INSERT' then 'makeup_created' else 'makeup_updated' end,
    case when v_kind = 'admin' then auth.uid() else null end,
    v_kind,
    jsonb_build_object(
      'before', case when tg_op = 'UPDATE' then private.makeup_event_state(old) else null end,
      'after', private.makeup_event_state(new)
    )
  );
  return new;
end;
$$;
revoke all on function public.record_makeup_event() from public, anon, authenticated;

-- ── settings ───────────────────────────────────────────────────────────────
create table public.makeup_offer_settings (
  id boolean primary key default true check (id),
  planned_absence_delivery_mode text not null default 'manual' check (planned_absence_delivery_mode in ('manual', 'automatic')),
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);
insert into public.makeup_offer_settings (id) values (true);

alter table public.makeup_offer_settings enable row level security;
create policy "admins read makeup settings" on public.makeup_offer_settings for select to authenticated using (public.is_admin());
revoke all on table public.makeup_offer_settings from public, anon, authenticated;
grant select on table public.makeup_offer_settings to authenticated;

-- Applies only to batches created after the change. Existing drafts are never sent retroactively.
create function public.admin_set_planned_absence_delivery_mode(p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if p_mode not in ('manual', 'automatic') then raise exception 'invalid delivery mode' using errcode = '22023'; end if;
  select planned_absence_delivery_mode into v_before from public.makeup_offer_settings where id for update;
  update public.makeup_offer_settings set planned_absence_delivery_mode = p_mode, updated_by = auth.uid(), updated_at = now() where id;
  insert into public.operations_audit (entity, entity_id, action, before_data, after_data, actor_id, actor_kind)
  values ('makeup_offer_settings', '00000000-0000-0000-0000-000000000000', 'UPDATE',
    jsonb_build_object('planned_absence_delivery_mode', v_before),
    jsonb_build_object('planned_absence_delivery_mode', p_mode), auth.uid(), 'admin');
end;
$$;
revoke all on function public.admin_set_planned_absence_delivery_mode(text) from public, anon;
grant execute on function public.admin_set_planned_absence_delivery_mode(text) to authenticated;

-- ── batches and options ────────────────────────────────────────────────────
create table public.makeup_offer_batches (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete restrict,
  student_id uuid not null references public.students(id) on delete restrict,
  guardian_id uuid references public.guardians(id) on delete restrict,
  exception_id uuid references public.attendance_exceptions(id) on delete restrict,
  origin text not null check (origin in ('planned_absence', 'absence')),
  status text not null default 'draft' check (status in ('draft', 'offered', 'selected', 'expired', 'manual_followup', 'cancelled')),
  delivery_mode text not null default 'manual' check (delivery_mode in ('manual', 'automatic')),
  requires_manual_send boolean not null default true,
  selection_token_hash text unique,
  offered_at timestamptz,
  expires_at timestamptz,
  offered_by uuid references public.profiles(id) on delete restrict,
  selected_option_id uuid,
  selected_at timestamptz,
  makeup_plan_id uuid references public.makeup_plans(id) on delete restrict,
  manual_reason text check (manual_reason is null or char_length(manual_reason) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requires_manual_send = (delivery_mode = 'manual')),
  check ((offered_at is null) = (expires_at is null)),
  check ((offered_at is null) = (selection_token_hash is null)),
  check (status <> 'draft' or offered_at is null),
  check (status not in ('offered', 'selected', 'expired') or offered_at is not null),
  -- selected + makeup_plan_id null  = reservation (attendance still scheduled; holds one seat)
  -- selected + makeup_plan_id set   = finalized (immutable)
  -- cancelled may keep the selection fields as history of a released reservation.
  check ((selected_option_id is null) = (selected_at is null)),
  check (status <> 'selected' or selected_option_id is not null),
  check (makeup_plan_id is null or status = 'selected')
);
create unique index makeup_offer_batches_one_open_idx on public.makeup_offer_batches (attendance_id) where status in ('draft', 'offered');

create table public.makeup_offer_options (
  id uuid primary key default gen_random_uuid(),
  offer_batch_id uuid not null references public.makeup_offer_batches(id) on delete restrict,
  class_session_id uuid not null references public.class_sessions(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity_snapshot integer not null check (capacity_snapshot >= 0),
  status text not null default 'available' check (status in ('available', 'selected', 'closed')),
  sort_order integer not null check (sort_order between 1 and 3),
  unique (offer_batch_id, sort_order),
  unique (offer_batch_id, class_session_id)
);
alter table public.makeup_offer_batches
  add constraint makeup_offer_batches_selected_option_fkey foreign key (selected_option_id) references public.makeup_offer_options(id) on delete restrict;
alter table public.parent_messages
  add constraint parent_messages_makeup_offer_batch_fkey foreign key (makeup_offer_batch_id) references public.makeup_offer_batches(id) on delete restrict;

create function private.guard_makeup_offer_batch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    new.created_at := now();
    new.updated_at := now();
    if new.status <> 'draft' and new.status <> 'manual_followup' then
      raise exception 'makeup offers start as drafts' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.attendance_id is distinct from old.attendance_id or new.student_id is distinct from old.student_id
     or new.origin is distinct from old.origin or new.delivery_mode is distinct from old.delivery_mode
     or new.requires_manual_send is distinct from old.requires_manual_send or new.created_at is distinct from old.created_at
     or (old.selection_token_hash is not null and new.selection_token_hash is distinct from old.selection_token_hash)
     or (old.offered_at is not null and (new.offered_at, new.expires_at) is distinct from (old.offered_at, old.expires_at)) then
    raise exception 'makeup offer identity is immutable' using errcode = '42501';
  end if;
  if (old.selected_option_id is not null and new.selected_option_id is distinct from old.selected_option_id)
     or (old.selected_at is not null and new.selected_at is distinct from old.selected_at)
     or (old.makeup_plan_id is not null and new.makeup_plan_id is distinct from old.makeup_plan_id) then
    raise exception 'makeup selection is immutable' using errcode = '23514';
  end if;
  if old.makeup_plan_id is not null and new.status is distinct from old.status then
    raise exception 'finalized makeup selection is immutable' using errcode = '23514';
  end if;
  -- The only exit from a selection is the explicit pre-finalization cancellation path
  -- (unexpected arrival / planned-absence cancellation).
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('offered', 'cancelled', 'manual_followup'))
    or (old.status = 'offered' and new.status in ('selected', 'expired', 'manual_followup', 'cancelled'))
    or (old.status = 'selected' and old.makeup_plan_id is null and new.status = 'cancelled')
    or (old.status = 'manual_followup' and new.status = 'cancelled')
  ) then
    raise exception 'invalid makeup offer transition' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_makeup_offer_batches before insert or update on public.makeup_offer_batches
  for each row execute function private.guard_makeup_offer_batch();
create trigger audit_makeup_offer_batches after insert or update on public.makeup_offer_batches
  for each row execute function private.audit_operation_row();
create trigger audit_makeup_offer_options after insert or update on public.makeup_offer_options
  for each row execute function private.audit_operation_row();

alter table public.makeup_offer_batches enable row level security;
alter table public.makeup_offer_options enable row level security;
create policy "admins read makeup offers" on public.makeup_offer_batches for select to authenticated using (public.is_admin());
create policy "admins read makeup options" on public.makeup_offer_options for select to authenticated using (public.is_admin());
revoke all on table public.makeup_offer_batches from public, anon, authenticated;
revoke all on table public.makeup_offer_options from public, anon, authenticated;
grant select (id, attendance_id, student_id, guardian_id, exception_id, origin, status, delivery_mode, requires_manual_send,
  offered_at, expires_at, offered_by, selected_option_id, selected_at, makeup_plan_id, manual_reason, created_at, updated_at)
  on table public.makeup_offer_batches to authenticated;
grant select on table public.makeup_offer_options to authenticated;

-- ── helpers ────────────────────────────────────────────────────────────────
create function private.session_occupancy(p_session_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  -- A guardian's selection holds a seat before its makeup plan exists. Once finalized, the plan
  -- counts instead (makeup_plan_id is set), so a seat is never counted twice.
  select (
    (select count(*) from public.attendance_records r where r.class_session_id = p_session_id and r.status not in ('absent', 'excused'))
    + (select count(*) from public.makeup_plans m where m.class_session_id = p_session_id and m.status = 'planned')
    + (select count(*) from public.makeup_offer_options o
         join public.makeup_offer_batches b on b.id = o.offer_batch_id
         where o.class_session_id = p_session_id and o.status = 'selected'
           and b.status = 'selected' and b.selected_option_id = o.id and b.makeup_plan_id is null)
  )::integer
$$;

create function private.kst_end_of_day(p_value timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select (((p_value at time zone 'Asia/Seoul')::date + 1)::timestamp at time zone 'Asia/Seoul') - interval '1 millisecond'
$$;

-- Server-only key for deriving makeup selection links. Unrelated to attendance codes, whose HMAC
-- secret lives only in the attendance-code Edge Function environment.
create table private.makeup_link_key (
  singleton boolean primary key default true check (singleton),
  value text not null check (char_length(value) >= 32)
);
revoke all on table private.makeup_link_key from public;
insert into private.makeup_link_key (value)
  values (encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text || gen_random_uuid()::text, 'UTF8')), 'hex'));

create function private.makeup_token(p_batch_id uuid, p_offered_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(k.value || ':' || p_batch_id::text || ':' || extract(epoch from p_offered_at)::text, 'UTF8')), 'hex')
  from private.makeup_link_key k
$$;

-- The token lives only in the URL fragment so it is not sent to servers in Referer/logs.
-- A cancelled / expired / manual batch has no live link; the dispatcher then cancels the message.
create function private.makeup_selection_url(p_batch_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'https://sequencemath.co.kr/makeup/#t=' || private.makeup_token(b.id, b.offered_at)
  from public.makeup_offer_batches b
  where b.id = p_batch_id and b.offered_at is not null and b.status in ('offered', 'selected')
$$;

create function private.create_makeup_offer(
  p_attendance_id uuid,
  p_origin text,
  p_exception_id uuid,
  p_mode text,
  p_now timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
  v_session public.class_sessions%rowtype;
  v_guardian_id uuid;
  v_batch_id uuid;
  v_candidates uuid[];
begin
  select * into v_record from public.attendance_records where id = p_attendance_id;
  if v_record.id is null or v_record.class_session_id is null then return null; end if;
  if exists (select 1 from public.makeup_offer_batches where attendance_id = p_attendance_id and status in ('draft', 'offered', 'selected')) then
    return null;
  end if;
  select * into v_session from public.class_sessions where id = v_record.class_session_id;
  select id into v_guardian_id from public.guardians where student_id = v_record.student_id and is_primary;

  select array_agg(c.id order by c.starts_at, c.id) into v_candidates
  from (
    select s2.id, s2.starts_at
    from public.class_sessions s2
    join public.class_groups g on g.id = s2.class_group_id
    where s2.status = 'scheduled'
      and s2.id <> v_session.id
      and s2.starts_at > greatest(p_now, v_session.ends_at)
      and s2.starts_at < greatest(p_now, v_session.ends_at) + interval '21 days'
      and g.course_id in (select e.course_id from public.enrollments e where e.student_id = v_record.student_id and e.status = 'active')
      and not exists (select 1 from public.attendance_records r where r.student_id = v_record.student_id and r.class_session_id = s2.id)
      and private.session_occupancy(s2.id) < s2.capacity
    order by s2.starts_at, s2.id
    limit 3
  ) c;

  insert into public.makeup_offer_batches (
    attendance_id, student_id, guardian_id, exception_id, origin, status, delivery_mode, requires_manual_send, manual_reason
  ) values (
    v_record.id, v_record.student_id, v_guardian_id, p_exception_id, p_origin,
    case when coalesce(array_length(v_candidates, 1), 0) = 3 then 'draft' else 'manual_followup' end,
    p_mode, p_mode = 'manual',
    case when coalesce(array_length(v_candidates, 1), 0) = 3 then null else 'insufficient_capacity' end
  ) returning id into v_batch_id;

  if coalesce(array_length(v_candidates, 1), 0) = 3 then
    insert into public.makeup_offer_options (offer_batch_id, class_session_id, starts_at, ends_at, capacity_snapshot, sort_order)
    select v_batch_id, s.id, s.starts_at, s.ends_at, s.capacity - private.session_occupancy(s.id), u.ord
    from unnest(v_candidates) with ordinality as u(session_id, ord)
    join public.class_sessions s on s.id = u.session_id;
    if p_mode = 'automatic' and exists (select 1 from public.message_templates where message_type = 'makeup_offer' and approved) then
      perform private.offer_makeup_batch(v_batch_id, p_now, null);
    end if;
  end if;
  return v_batch_id;
end;
$$;

create function private.offer_makeup_batch(p_batch_id uuid, p_now timestamptz, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.makeup_offer_batches%rowtype;
  v_record public.attendance_records%rowtype;
  v_valid integer;
  v_expires timestamptz := private.kst_end_of_day(p_now);
begin
  -- Lock order everywhere: attendance → batch → option → class session.
  select * into v_record from public.attendance_records
    where id = (select attendance_id from public.makeup_offer_batches where id = p_batch_id)
    for update;
  select * into v_batch from public.makeup_offer_batches where id = p_batch_id for update;
  if v_batch.id is null or v_batch.status <> 'draft' or v_record.id is null then
    raise exception 'makeup offer state changed' using errcode = '40001';
  end if;
  -- Revalidate the parent state under lock (CAS): a cancelled exception or an arrival must not send.
  if v_batch.origin = 'planned_absence' then
    if v_record.status <> 'scheduled' or not exists (
      select 1 from public.attendance_exceptions e
      where e.id = v_batch.exception_id and e.exception_type = 'planned_absence' and e.status = 'active'
    ) then
      raise exception 'makeup offer state changed' using errcode = '40001';
    end if;
  elsif v_record.status not in ('absent', 'excused') then
    raise exception 'makeup offer state changed' using errcode = '40001';
  end if;
  if not exists (select 1 from public.message_templates where message_type = 'makeup_offer' and approved) then
    raise exception 'approved makeup template required' using errcode = '23514';
  end if;
  select count(*) into v_valid
  from public.makeup_offer_options o
  join public.class_sessions s on s.id = o.class_session_id
  where o.offer_batch_id = p_batch_id and o.status = 'available'
    and s.status = 'scheduled' and s.starts_at > p_now and private.session_occupancy(s.id) < s.capacity;
  if v_valid <> 3 then
    raise exception 'exactly three available makeup options are required' using errcode = '23514';
  end if;
  update public.makeup_offer_batches
    set status = 'offered', offered_at = p_now, expires_at = v_expires, offered_by = p_actor,
        selection_token_hash = private.token_hash(private.makeup_token(p_batch_id, p_now))
    where id = p_batch_id and status = 'draft';
  perform private.enqueue_parent_message(
    v_batch.student_id,
    'makeup_offer',
    'makeup_offer:' || p_batch_id::text,
    jsonb_build_object('선택기한', to_char(v_expires at time zone 'Asia/Seoul', 'FMMM"월" FMDD"일" HH24:MI')),
    v_batch.attendance_id,
    p_batch_id,
    'queued'
  );
end;
$$;

create function public.admin_send_makeup_offer(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.makeup_offer_batches%rowtype;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  perform private.offer_makeup_batch(p_batch_id, now(), auth.uid());
  select * into v_batch from public.makeup_offer_batches where id = p_batch_id;
  return jsonb_build_object('status', v_batch.status, 'offered_at', v_batch.offered_at, 'expires_at', v_batch.expires_at);
end;
$$;

create function public.admin_prepare_makeup_offer(p_attendance_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if not exists (select 1 from public.attendance_records where id = p_attendance_id and status in ('absent', 'excused')) then
    raise exception 'makeup requires an absence' using errcode = '23514';
  end if;
  v_id := private.create_makeup_offer(p_attendance_id, 'absence', null, 'manual', now());
  if v_id is null then raise exception 'makeup offer already exists' using errcode = '40001'; end if;
  return v_id;
end;
$$;

revoke all on function public.admin_send_makeup_offer(uuid) from public, anon;
grant execute on function public.admin_send_makeup_offer(uuid) to authenticated;
revoke all on function public.admin_prepare_makeup_offer(uuid) from public, anon;
grant execute on function public.admin_prepare_makeup_offer(uuid) to authenticated;

-- Planned absence → three-option draft (manual by default).
create function private.makeup_offer_for_planned_absence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text;
begin
  if tg_op = 'INSERT' and new.exception_type = 'planned_absence' then
    select planned_absence_delivery_mode into v_mode from public.makeup_offer_settings where id;
    perform private.create_makeup_offer(new.attendance_id, 'planned_absence', new.id, coalesce(v_mode, 'manual'), now());
  elsif tg_op = 'UPDATE' and new.exception_type = 'planned_absence' and old.status = 'active' and new.status = 'cancelled' then
    perform private.cancel_unfinalized_makeup_offers(new.attendance_id, 'exception_cancelled');
  end if;
  return new;
end;
$$;
create trigger makeup_offer_for_planned_absence after insert or update of status on public.attendance_exceptions
  for each row execute function private.makeup_offer_for_planned_absence();

-- Pre-finalization cancellation: draft / offered / selected-but-not-finalized offers are cancelled,
-- their reserved option is released, the selection link stops resolving, and only still-pending
-- (draft/approved/queued) parent messages are withdrawn. Sent provider history is never touched.
create function private.cancel_unfinalized_makeup_offers(p_attendance_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.makeup_offer_batches%rowtype;
  v_count integer := 0;
begin
  perform 1 from public.attendance_records where id = p_attendance_id for update;
  for v_batch in
    select * from public.makeup_offer_batches
    where attendance_id = p_attendance_id
      and (status in ('draft', 'offered', 'manual_followup') or (status = 'selected' and makeup_plan_id is null))
    order by created_at, id
    for update
  loop
    update public.makeup_offer_options set status = 'closed'
      where offer_batch_id = v_batch.id and status in ('available', 'selected');
    update public.makeup_offer_batches set status = 'cancelled', manual_reason = left(p_reason, 80)
      where id = v_batch.id;
    update public.parent_messages set status = 'cancelled', cancelled_at = now(), dispatch_locked_until = null
      where makeup_offer_batch_id = v_batch.id and status in ('draft', 'approved', 'queued');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Turns a guardian's reservation into exactly one makeup plan once the attendance is explicitly
-- absent/excused. Idempotent: an already finalized batch returns its plan.
create function private.finalize_makeup_selection(p_attendance_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
  v_batch public.makeup_offer_batches%rowtype;
  v_option public.makeup_offer_options%rowtype;
  v_plan_id uuid;
  v_prev_actor text := coalesce(current_setting('sequence.trusted_actor', true), '');
  v_prev_device text := coalesce(current_setting('sequence.trusted_device', true), '');
begin
  select * into v_record from public.attendance_records where id = p_attendance_id for update;
  if v_record.id is null or v_record.status not in ('absent', 'excused') then return null; end if;
  select * into v_batch from public.makeup_offer_batches
    where attendance_id = p_attendance_id and status = 'selected'
    order by (makeup_plan_id is null), created_at desc
    limit 1
    for update;
  if v_batch.id is null then return null; end if;
  if v_batch.makeup_plan_id is not null then return v_batch.makeup_plan_id; end if;
  if exists (select 1 from public.makeup_plans where attendance_id = p_attendance_id) then
    -- Staff already planned a makeup by hand; release the reservation instead of double-booking.
    perform private.cancel_unfinalized_makeup_offers(p_attendance_id, 'plan_exists');
    return null;
  end if;
  select * into v_option from public.makeup_offer_options where id = v_batch.selected_option_id;
  if v_record.guardian_contact_status is distinct from 'contacted' then
    -- The guardian's own selection is the contact fact.
    update public.attendance_records set guardian_contact_status = 'contacted', guardian_contacted_at = v_batch.selected_at
      where id = p_attendance_id;
  end if;
  perform private.begin_trusted('makeup_selection');
  insert into public.makeup_plans (attendance_id, status, scheduled_at, method, note, class_session_id)
  values (p_attendance_id, 'planned', v_option.starts_at, 'in_person', '학부모 보강 선택', v_option.class_session_id)
  returning id into v_plan_id;
  update public.makeup_offer_batches set makeup_plan_id = v_plan_id where id = v_batch.id;
  perform set_config('sequence.trusted_actor', v_prev_actor, true);
  perform set_config('sequence.trusted_device', v_prev_device, true);
  return v_plan_id;
end;
$$;

-- The guardian contact fact is applied in the same row write that finalizes the absence, so the
-- makeup-plan invariants (absence + contact outcome) already hold when the plan is inserted.
create function private.apply_makeup_selection_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_selected_at timestamptz;
begin
  if old.status = 'scheduled' and new.status in ('absent', 'excused')
     and new.guardian_contact_status is distinct from 'contacted' then
    select selected_at into v_selected_at from public.makeup_offer_batches
      where attendance_id = new.id and status = 'selected' and makeup_plan_id is null
      limit 1;
    if v_selected_at is not null then
      new.guardian_contact_status := 'contacted';
      new.guardian_contacted_at := v_selected_at;
    end if;
  end if;
  return new;
end;
$$;
create trigger apply_makeup_selection_contact before update of status on public.attendance_records
  for each row execute function private.apply_makeup_selection_contact();

-- Attendance transitions drive the offer state machine:
--   scheduled → present/late : unexpected arrival cancels unfinalized offers (normal check-in proceeds)
--   scheduled → absent/excused: finalize a reservation; ordinary absence gets the automatic offer path
create function private.makeup_offer_sync_attendance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'scheduled' and new.status in ('present', 'late') then
    perform private.cancel_unfinalized_makeup_offers(new.id, 'student_arrived');
  elsif old.status = 'scheduled' and new.status in ('absent', 'excused') then
    perform private.finalize_makeup_selection(new.id);
    if new.status = 'absent' and new.class_session_id is not null
       and not private.has_suppressing_exception(new.student_id, new.class_session_id) then
      perform private.create_makeup_offer(new.id, 'absence', null, 'automatic', now());
    end if;
  end if;
  return new;
end;
$$;
create trigger makeup_offer_sync_attendance after update of status on public.attendance_records
  for each row execute function private.makeup_offer_sync_attendance();

-- ── public selection (token in URL fragment; anon) ─────────────────────────
create function private.expire_makeup_offers(p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.makeup_offer_batches set status = 'expired' where status = 'offered' and expires_at < p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function private.makeup_public_options(p_batch_id uuid, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'starts_at', o.starts_at, 'ends_at', o.ends_at, 'sort_order', o.sort_order,
    'available', o.status = 'available' and s.status = 'scheduled' and s.starts_at > p_now and private.session_occupancy(s.id) < s.capacity
  ) order by o.sort_order), '[]'::jsonb)
  from public.makeup_offer_options o join public.class_sessions s on s.id = o.class_session_id
  where o.offer_batch_id = p_batch_id
$$;

create function private.makeup_offer_view_at(p_token text, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.makeup_offer_batches%rowtype;
  v_name text;
  v_option public.makeup_offer_options%rowtype;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('result', 'not_found'); end if;
  perform private.begin_trusted('makeup_selection');
  perform private.expire_makeup_offers(p_now);
  perform private.end_trusted();
  select * into v_batch from public.makeup_offer_batches where selection_token_hash = private.token_hash(p_token);
  if v_batch.id is null then return jsonb_build_object('result', 'not_found'); end if;
  select name into v_name from public.students where id = v_batch.student_id;
  if v_batch.status = 'expired' or (v_batch.status = 'offered' and p_now > v_batch.expires_at) then
    return jsonb_build_object('result', 'expired', 'student_label', public.kiosk_mask_name(v_name));
  end if;
  if v_batch.status = 'selected' then
    select * into v_option from public.makeup_offer_options where id = v_batch.selected_option_id;
    return jsonb_build_object('result', 'selected', 'student_label', public.kiosk_mask_name(v_name),
      'finalized', v_batch.makeup_plan_id is not null,
      'selected', jsonb_build_object('starts_at', v_option.starts_at, 'ends_at', v_option.ends_at));
  end if;
  if v_batch.status <> 'offered' then
    return jsonb_build_object('result', 'closed');
  end if;
  return jsonb_build_object('result', 'open', 'student_label', public.kiosk_mask_name(v_name),
    'expires_at', v_batch.expires_at, 'options', private.makeup_public_options(v_batch.id, p_now));
end;
$$;

create function private.makeup_offer_select_at(p_token text, p_option_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.makeup_offer_batches%rowtype;
  v_option public.makeup_offer_options%rowtype;
  v_session public.class_sessions%rowtype;
  v_record public.attendance_records%rowtype;
  v_batch_id uuid;
  v_attendance_id uuid;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('result', 'not_found'); end if;
  select id, attendance_id into v_batch_id, v_attendance_id
    from public.makeup_offer_batches where selection_token_hash = private.token_hash(p_token);
  if v_batch_id is null then return jsonb_build_object('result', 'not_found'); end if;
  -- Same lock order as arrival / exception cancellation (attendance → batch) so select-vs-arrival
  -- and select-vs-cancel serialize instead of deadlocking; every check below re-reads under lock.
  select * into v_record from public.attendance_records where id = v_attendance_id for update;
  select * into v_batch from public.makeup_offer_batches where id = v_batch_id for update;
  if v_batch.status = 'selected' then
    return jsonb_build_object('result', case when v_batch.selected_option_id = p_option_id then 'already_selected' else 'closed' end);
  end if;
  perform private.begin_trusted('makeup_selection');
  if v_batch.status = 'offered' and p_now > v_batch.expires_at then
    update public.makeup_offer_batches set status = 'expired' where id = v_batch.id;
    perform private.end_trusted();
    return jsonb_build_object('result', 'expired');
  end if;
  if v_batch.status <> 'offered' then
    perform private.end_trusted();
    return jsonb_build_object('result', case when v_batch.status = 'expired' then 'expired' else 'closed' end);
  end if;

  select * into v_option from public.makeup_offer_options where id = p_option_id and offer_batch_id = v_batch.id for update;
  if v_option.id is null then
    perform private.end_trusted();
    return jsonb_build_object('result', 'not_found');
  end if;
  -- Serialize capacity decisions on the target class session.
  select * into v_session from public.class_sessions where id = v_option.class_session_id for update;
  if v_option.status <> 'available' or v_session.status <> 'scheduled' or v_session.starts_at <= p_now
     or private.session_occupancy(v_session.id) >= v_session.capacity then
    update public.makeup_offer_options set status = 'closed' where id = v_option.id and status = 'available';
    perform private.end_trusted();
    return jsonb_build_object('result', 'full', 'options', private.makeup_public_options(v_batch.id, p_now));
  end if;

  if v_record.status in ('present', 'late') or exists (select 1 from public.makeup_plans where attendance_id = v_record.id) then
    update public.makeup_offer_batches set status = 'manual_followup', manual_reason = 'attendance_changed' where id = v_batch.id;
    perform private.end_trusted();
    return jsonb_build_object('result', 'closed');
  end if;
  if v_record.status = 'scheduled' then
    -- Reservation only: the absence is NOT confirmed by the selection. It must still be a live
    -- planned absence; attendance stays scheduled and no makeup plan exists yet.
    if v_batch.origin <> 'planned_absence' or not exists (
      select 1 from public.attendance_exceptions e
      where e.id = v_batch.exception_id and e.exception_type = 'planned_absence' and e.status = 'active'
    ) then
      perform private.end_trusted();
      return jsonb_build_object('result', 'closed');
    end if;
  elsif v_record.guardian_contact_status is distinct from 'contacted' then
    update public.attendance_records set guardian_contact_status = 'contacted', guardian_contacted_at = p_now where id = v_record.id;
  end if;

  update public.makeup_offer_options set status = case when id = v_option.id then 'selected' else 'closed' end
    where offer_batch_id = v_batch.id;
  update public.makeup_offer_batches
    set status = 'selected', selected_option_id = v_option.id, selected_at = p_now
    where id = v_batch.id;
  if v_record.status in ('absent', 'excused') then
    -- Ordinary absence path: finalize the plan in the same transaction.
    perform private.finalize_makeup_selection(v_record.id);
  end if;
  perform private.end_trusted();
  return jsonb_build_object('result', 'selected', 'finalized', v_record.status in ('absent', 'excused'),
    'starts_at', v_session.starts_at, 'ends_at', v_session.ends_at);
end;
$$;

create function public.makeup_offer_view(p_token text)
returns jsonb
language sql
security definer
set search_path = ''
as $$ select private.makeup_offer_view_at(p_token, now()) $$;

create function public.makeup_offer_select(p_token text, p_option_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$ select private.makeup_offer_select_at(p_token, p_option_id, now()) $$;

revoke all on function public.makeup_offer_view(text) from public;
revoke all on function public.makeup_offer_select(text, uuid) from public;
grant execute on function public.makeup_offer_view(text) to anon, authenticated;
grant execute on function public.makeup_offer_select(text, uuid) to anon, authenticated;

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
