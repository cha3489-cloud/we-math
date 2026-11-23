-- Daily learning plan snapshots shared by the admin workspace and the authenticated learning tablet.
-- Repository-only. Owner confirmation (publish) is required before a student can see a plan.
-- Student completion is only 'submitted'; an authorized teacher confirmation is final.

create table public.daily_learning_plans (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  class_session_id uuid references public.class_sessions(id) on delete restrict,
  plan_date date not null,
  source_revision integer not null check (source_revision > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'superseded')),
  owner_note text not null default '' check (char_length(owner_note) <= 1000),
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete restrict,
  new_progress_approved_at timestamptz,
  new_progress_approved_by uuid references public.profiles(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, plan_date, source_revision),
  check ((status = 'draft') = (published_at is null)),
  check ((new_progress_approved_at is null) = (new_progress_approved_by is null))
);
create unique index daily_learning_plans_one_published_idx on public.daily_learning_plans (student_id, plan_date) where status = 'published';

create table public.daily_learning_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.daily_learning_plans(id) on delete restrict,
  item_type text not null check (item_type in ('homework', 'redo', 'carryover', 'auto_progress', 'mathflat', 'note')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  body text not null default '' check (char_length(body) <= 2000),
  sort_order integer not null check (sort_order > 0),
  source_id text check (source_id is null or char_length(source_id) <= 200),
  progress_sequence integer check (progress_sequence is null or progress_sequence > 0),
  internal_note text not null default '' check (char_length(internal_note) <= 1000),
  student_status text not null default 'pending' check (student_status in ('pending', 'submitted')),
  submitted_at timestamptz,
  teacher_status text not null default 'pending' check (teacher_status in ('pending', 'confirmed')),
  confirmed_by uuid references public.profiles(id) on delete restrict,
  confirmed_at timestamptz,
  unique (plan_id, sort_order),
  check ((student_status = 'submitted') = (submitted_at is not null)),
  check ((teacher_status = 'confirmed') = (confirmed_at is not null and confirmed_by is not null))
);

create function private.learning_item_rank(p_type text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'homework' then 1 when 'redo' then 2 when 'carryover' then 3
    when 'auto_progress' then 4 when 'mathflat' then 5 else 6 end
$$;

create function private.guard_learning_plan_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.plan_id is distinct from old.plan_id or new.item_type is distinct from old.item_type
     or new.title is distinct from old.title or new.body is distinct from old.body
     or new.sort_order is distinct from old.sort_order or new.progress_sequence is distinct from old.progress_sequence then
    raise exception 'published plan item content is immutable' using errcode = '42501';
  end if;
  if old.student_status = 'submitted' and new.student_status <> 'submitted' then
    raise exception 'submitted item cannot be withdrawn' using errcode = '23514';
  end if;
  if old.teacher_status = 'confirmed' and (new.teacher_status, new.confirmed_at, new.confirmed_by) is distinct from (old.teacher_status, old.confirmed_at, old.confirmed_by) then
    raise exception 'teacher confirmation is final' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger guard_daily_learning_plan_items before update on public.daily_learning_plan_items
  for each row execute function private.guard_learning_plan_item();
create trigger audit_daily_learning_plans after insert or update on public.daily_learning_plans
  for each row execute function private.audit_operation_row();
create trigger audit_daily_learning_plan_items after insert or update on public.daily_learning_plan_items
  for each row execute function private.audit_operation_row();

alter table public.daily_learning_plans enable row level security;
alter table public.daily_learning_plan_items enable row level security;
create policy "admins read learning plans" on public.daily_learning_plans for select to authenticated using (public.is_admin());
create policy "admins read learning plan items" on public.daily_learning_plan_items for select to authenticated using (public.is_admin());
revoke all on table public.daily_learning_plans from public, anon, authenticated;
revoke all on table public.daily_learning_plan_items from public, anon, authenticated;
grant select on table public.daily_learning_plans to authenticated;
grant select on table public.daily_learning_plan_items to authenticated;

create function public.admin_save_learning_plan_draft(
  p_student_id uuid,
  p_plan_date date,
  p_class_session_id uuid,
  p_items jsonb,
  p_owner_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan_id uuid;
  v_revision integer;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'plan items required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.students where id = p_student_id) then raise exception 'student not found' using errcode = '23503'; end if;
  perform 1 from public.students where id = p_student_id for update;
  select coalesce(max(source_revision), 0) + 1 into v_revision
    from public.daily_learning_plans where student_id = p_student_id and plan_date = p_plan_date;
  insert into public.daily_learning_plans (student_id, class_session_id, plan_date, source_revision, owner_note, created_by)
  values (p_student_id, p_class_session_id, p_plan_date, v_revision, btrim(coalesce(p_owner_note, '')), auth.uid())
  returning id into v_plan_id;

  insert into public.daily_learning_plan_items (plan_id, item_type, title, body, sort_order, source_id, progress_sequence, internal_note)
  select v_plan_id, x.item ->> 'item_type', btrim(x.item ->> 'title'), coalesce(x.item ->> 'body', ''),
         row_number() over (order by private.learning_item_rank(x.item ->> 'item_type'), x.ord),
         x.item ->> 'source_id', (x.item ->> 'progress_sequence')::integer, coalesce(x.item ->> 'internal_note', '')
  from jsonb_array_elements(p_items) with ordinality as x(item, ord);
  return v_plan_id;
end;
$$;

-- Owner confirmation: compare-and-set on the latest draft revision.
create function public.admin_publish_learning_plan(p_plan_id uuid, p_expected_revision integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.daily_learning_plans%rowtype;
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
  update public.daily_learning_plans set status = 'superseded', updated_at = now()
    where student_id = v_plan.student_id and plan_date = v_plan.plan_date and status = 'published';
  update public.daily_learning_plans set status = 'published', published_at = now(), published_by = auth.uid(), updated_at = now()
    where id = p_plan_id and status = 'draft';
end;
$$;

create function public.admin_confirm_learning_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.daily_learning_plan_items i set teacher_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now()
    from public.daily_learning_plans p
    where i.id = p_item_id and p.id = i.plan_id and p.status = 'published'
      and i.student_status = 'submitted' and i.teacher_status = 'pending';
  if not found then
    if exists (
      select 1 from public.daily_learning_plan_items i
      join public.daily_learning_plans p on p.id = i.plan_id
      where i.id = p_item_id and p.status = 'published'
        and i.student_status = 'pending' and i.teacher_status = 'pending'
    ) then
      raise exception 'student completion submission required' using errcode = '23514';
    end if;
    raise exception 'learning item state changed' using errcode = '40001';
  end if;
end;
$$;

create function private.remaining_priority_items(p_plan_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'item_type', i.item_type, 'title', i.title, 'student_status', i.student_status) order by i.sort_order), '[]'::jsonb)
  from public.daily_learning_plan_items i
  where i.plan_id = p_plan_id and i.item_type in ('homework', 'redo', 'carryover') and i.teacher_status <> 'confirmed'
$$;

-- Teacher explicitly allows new progress despite remaining work; the remaining items are audited.
create function public.admin_approve_new_progress(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining jsonb;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  v_remaining := private.remaining_priority_items(p_plan_id);
  update public.daily_learning_plans set new_progress_approved_at = now(), new_progress_approved_by = auth.uid(), updated_at = now()
    where id = p_plan_id and status = 'published' and new_progress_approved_at is null;
  if not found then raise exception 'learning plan state changed' using errcode = '40001'; end if;
  insert into public.operations_audit (entity, entity_id, action, before_data, after_data, actor_id, actor_kind)
  values ('new_progress_override', p_plan_id, 'INSERT', null, jsonb_build_object('remaining_items', v_remaining), auth.uid(), 'admin');
end;
$$;

create function private.student_for_current_user()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select st.id from public.students st
  join public.profiles pr on pr.id = st.account_profile_id
  join public.user_roles ur on ur.user_id = pr.id and ur.role::text = 'student'
  where st.account_profile_id = auth.uid()
    and pr.suspended_at is null
    and pr.must_change_pin = false
    and st.status in ('active', 'returning')
$$;

create function public.student_today_learning_plan()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_student uuid := private.student_for_current_user();
  v_plan public.daily_learning_plans%rowtype;
  v_remaining integer;
  v_unlocked boolean;
begin
  if auth.uid() is null then raise exception 'login required' using errcode = '42501'; end if;
  if v_student is null then return jsonb_build_object('status', 'unlinked'); end if;
  select * into v_plan from public.daily_learning_plans
    where student_id = v_student and plan_date = (now() at time zone 'Asia/Seoul')::date and status = 'published';
  if v_plan.id is null then return jsonb_build_object('status', 'preparing'); end if;
  select count(*) into v_remaining from public.daily_learning_plan_items
    where plan_id = v_plan.id and item_type in ('homework', 'redo', 'carryover') and teacher_status <> 'confirmed';
  v_unlocked := v_remaining = 0 or v_plan.new_progress_approved_at is not null;
  return jsonb_build_object(
    'status', 'ready',
    'plan_id', v_plan.id,
    'plan_date', v_plan.plan_date,
    'revision', v_plan.source_revision,
    'published_at', v_plan.published_at,
    'remaining_priority_count', v_remaining,
    'new_progress_approved', v_plan.new_progress_approved_at is not null,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'item_type', i.item_type, 'title', i.title, 'body', i.body, 'sort_order', i.sort_order,
        'student_status', i.student_status, 'teacher_status', i.teacher_status,
        'locked', i.item_type in ('auto_progress', 'mathflat') and not v_unlocked
      ) order by i.sort_order)
      from public.daily_learning_plan_items i where i.plan_id = v_plan.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Idempotent: repeated taps never create a second completion event.
create function public.student_submit_learning_item(p_item_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student uuid := private.student_for_current_user();
  v_item public.daily_learning_plan_items%rowtype;
  v_unlocked boolean;
begin
  if auth.uid() is null or v_student is null then raise exception 'student account required' using errcode = '42501'; end if;
  select i.* into v_item from public.daily_learning_plan_items i
    join public.daily_learning_plans p on p.id = i.plan_id
    where i.id = p_item_id and p.student_id = v_student and p.status = 'published'
      and p.plan_date = (now() at time zone 'Asia/Seoul')::date
    for update of i;
  if v_item.id is null then raise exception 'learning item not found' using errcode = '23503'; end if;
  if v_item.item_type = 'note' then raise exception 'note items cannot be submitted' using errcode = '22023'; end if;
  if v_item.item_type in ('auto_progress', 'mathflat') then
    select (not exists (
      select 1 from public.daily_learning_plan_items r where r.plan_id = v_item.plan_id and r.item_type in ('homework', 'redo', 'carryover') and r.teacher_status <> 'confirmed'
    )) or p.new_progress_approved_at is not null into v_unlocked
    from public.daily_learning_plans p where p.id = v_item.plan_id;
    if not v_unlocked then raise exception 'priority items must be checked first' using errcode = '23514'; end if;
  end if;
  if v_item.teacher_status = 'confirmed' then return 'confirmed'; end if;
  if v_item.student_status = 'submitted' then return 'already_submitted'; end if;
  update public.daily_learning_plan_items set student_status = 'submitted', submitted_at = now()
    where id = p_item_id and student_status = 'pending';
  return 'submitted';
end;
$$;

revoke all on function public.admin_save_learning_plan_draft(uuid, date, uuid, jsonb, text) from public, anon;
grant execute on function public.admin_save_learning_plan_draft(uuid, date, uuid, jsonb, text) to authenticated;
revoke all on function public.admin_publish_learning_plan(uuid, integer) from public, anon;
grant execute on function public.admin_publish_learning_plan(uuid, integer) to authenticated;
revoke all on function public.admin_confirm_learning_item(uuid) from public, anon;
grant execute on function public.admin_confirm_learning_item(uuid) to authenticated;
revoke all on function public.admin_approve_new_progress(uuid) from public, anon;
grant execute on function public.admin_approve_new_progress(uuid) to authenticated;
revoke all on function public.student_today_learning_plan() from public, anon;
grant execute on function public.student_today_learning_plan() to authenticated;
revoke all on function public.student_submit_learning_item(uuid) from public, anon;
grant execute on function public.student_submit_learning_item(uuid) to authenticated;

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
