-- Sequence Math student operations registry.
-- This ledger is intentionally separate from public.profiles, which remains the login-account table.
-- No synthetic or real student rows are seeded by this migration.

create table public.students (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  grade text not null default '' check (char_length(grade) <= 40),
  school text not null default '' check (char_length(school) <= 120),
  status text not null default 'active' check (status in ('active', 'paused', 'returning', 'withdrawn')),
  is_test_data boolean not null default false,
  account_profile_id uuid unique references public.profiles(id) on delete set null,
  registered_on date not null default current_date,
  note text not null default '' check (char_length(note) <= 1000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.guardians (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  name text not null default '' check (char_length(name) <= 80),
  phone text not null default '' check (char_length(phone) <= 30),
  is_primary boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (name <> '' or phone <> '')
);
create unique index guardians_one_primary_per_student_idx on public.guardians(student_id) where is_primary;

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  level text not null default '' check (char_length(level) <= 40),
  is_active boolean not null default true,
  is_test_data boolean not null default false,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.class_groups (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  schedule text not null default '' check (char_length(schedule) <= 200),
  is_active boolean not null default true,
  is_test_data boolean not null default false,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, course_id),
  unique (course_id, name)
);

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  course_id uuid not null references public.courses(id) on delete restrict,
  class_group_id uuid,
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'withdrawn')),
  enrolled_on date not null default current_date,
  ended_on date,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (class_group_id, course_id) references public.class_groups (id, course_id) on delete restrict,
  check (ended_on is null or ended_on >= enrolled_on)
);
create index enrollments_student_status_idx on public.enrollments(student_id, status);

create table public.student_registry_audit (
  id bigint generated always as identity primary key,
  record_table text not null check (record_table in ('students', 'guardians', 'courses', 'class_groups', 'enrollments')),
  record_id uuid not null,
  action text not null check (action in ('INSERT', 'UPDATE')),
  before_data jsonb,
  after_data jsonb,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  occurred_at timestamptz not null default now()
);
create index student_registry_audit_record_idx on public.student_registry_audit(record_table, record_id, occurred_at desc);

create function public.prepare_student_registry_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'admin required';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.prepare_student_registry_row() from public, anon, authenticated;

create function public.audit_student_registry_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.student_registry_audit (
    record_table, record_id, action, before_data, after_data, actor_id
  ) values (
    tg_table_name,
    new.id,
    tg_op,
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    to_jsonb(new),
    auth.uid()
  );
  return new;
end;
$$;
revoke all on function public.audit_student_registry_row() from public, anon, authenticated;

create function public.reject_student_registry_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'audit rows are immutable';
end;
$$;
revoke all on function public.reject_student_registry_audit_change() from public, anon, authenticated;

create trigger prepare_students before insert or update on public.students
for each row execute function public.prepare_student_registry_row();
create trigger prepare_guardians before insert or update on public.guardians
for each row execute function public.prepare_student_registry_row();
create trigger prepare_courses before insert or update on public.courses
for each row execute function public.prepare_student_registry_row();
create trigger prepare_class_groups before insert or update on public.class_groups
for each row execute function public.prepare_student_registry_row();
create trigger prepare_enrollments before insert or update on public.enrollments
for each row execute function public.prepare_student_registry_row();

create trigger audit_students after insert or update on public.students
for each row execute function public.audit_student_registry_row();
create trigger audit_guardians after insert or update on public.guardians
for each row execute function public.audit_student_registry_row();
create trigger audit_courses after insert or update on public.courses
for each row execute function public.audit_student_registry_row();
create trigger audit_class_groups after insert or update on public.class_groups
for each row execute function public.audit_student_registry_row();
create trigger audit_enrollments after insert or update on public.enrollments
for each row execute function public.audit_student_registry_row();
create trigger reject_student_registry_audit_change before update or delete on public.student_registry_audit
for each row execute function public.reject_student_registry_audit_change();

alter table public.students enable row level security;
alter table public.guardians enable row level security;
alter table public.courses enable row level security;
alter table public.class_groups enable row level security;
alter table public.enrollments enable row level security;
alter table public.student_registry_audit enable row level security;

create policy "admins read students" on public.students for select to authenticated using (public.is_admin());
create policy "admins read guardians" on public.guardians for select to authenticated using (public.is_admin());
create policy "admins read courses" on public.courses for select to authenticated using (public.is_admin());
create policy "admins read class groups" on public.class_groups for select to authenticated using (public.is_admin());
create policy "admins read enrollments" on public.enrollments for select to authenticated using (public.is_admin());
create policy "admins read student registry audit" on public.student_registry_audit for select to authenticated using (public.is_admin());

revoke all on table public.students from public, anon, authenticated;
revoke all on table public.guardians from public, anon, authenticated;
revoke all on table public.courses from public, anon, authenticated;
revoke all on table public.class_groups from public, anon, authenticated;
revoke all on table public.enrollments from public, anon, authenticated;
revoke all on table public.student_registry_audit from public, anon, authenticated;

grant select on table public.students to authenticated;
grant select on table public.guardians to authenticated;
grant select on table public.courses to authenticated;
grant select on table public.class_groups to authenticated;
grant select on table public.enrollments to authenticated;
grant select on table public.student_registry_audit to authenticated;

create function public.admin_create_student(
  p_name text,
  p_grade text default '',
  p_school text default '',
  p_status text default 'active',
  p_is_test_data boolean default false,
  p_guardian_name text default '',
  p_guardian_phone text default '',
  p_registered_on date default current_date,
  p_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_guardian_name text := btrim(coalesce(p_guardian_name, ''));
  v_guardian_phone text := btrim(coalesce(p_guardian_phone, ''));
begin
  if not public.is_admin() then raise exception 'admin required'; end if;
  if char_length(v_name) not between 1 and 80 then raise exception 'invalid student name'; end if;
  if char_length(coalesce(p_grade, '')) > 40 then raise exception 'invalid grade'; end if;
  if char_length(coalesce(p_school, '')) > 120 then raise exception 'invalid school'; end if;
  if p_status not in ('active', 'paused', 'returning', 'withdrawn') then raise exception 'invalid student status'; end if;
  if char_length(coalesce(p_note, '')) > 1000 then raise exception 'invalid note'; end if;
  if char_length(v_guardian_name) > 80 or char_length(v_guardian_phone) > 30 then raise exception 'invalid guardian'; end if;

  insert into public.students (name, grade, school, status, is_test_data, registered_on, note)
  values (v_name, btrim(coalesce(p_grade, '')), btrim(coalesce(p_school, '')), p_status, p_is_test_data, coalesce(p_registered_on, current_date), btrim(coalesce(p_note, '')))
  returning id into v_student_id;

  if v_guardian_name <> '' or v_guardian_phone <> '' then
    insert into public.guardians (student_id, name, phone, is_primary)
    values (v_student_id, v_guardian_name, v_guardian_phone, true);
  end if;
  return v_student_id;
end;
$$;

create function public.admin_update_student(
  p_student_id uuid,
  p_name text,
  p_grade text,
  p_school text,
  p_status text,
  p_guardian_name text,
  p_guardian_phone text,
  p_registered_on date,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_guardian_name text := btrim(coalesce(p_guardian_name, ''));
  v_guardian_phone text := btrim(coalesce(p_guardian_phone, ''));
begin
  if not public.is_admin() then raise exception 'admin required'; end if;
  if char_length(v_name) not between 1 and 80 then raise exception 'invalid student name'; end if;
  if char_length(coalesce(p_grade, '')) > 40 then raise exception 'invalid grade'; end if;
  if char_length(coalesce(p_school, '')) > 120 then raise exception 'invalid school'; end if;
  if p_status not in ('active', 'paused', 'returning', 'withdrawn') then raise exception 'invalid student status'; end if;
  if char_length(coalesce(p_note, '')) > 1000 then raise exception 'invalid note'; end if;
  if char_length(v_guardian_name) > 80 or char_length(v_guardian_phone) > 30 then raise exception 'invalid guardian'; end if;
  if v_guardian_name = '' and v_guardian_phone = '' and exists (
    select 1
    from public.guardians
    where student_id = p_student_id and is_primary
  ) then
    raise exception 'primary guardian cannot be cleared';
  end if;

  update public.students
  set name = v_name,
      grade = btrim(coalesce(p_grade, '')),
      school = btrim(coalesce(p_school, '')),
      status = p_status,
      registered_on = coalesce(p_registered_on, registered_on),
      note = btrim(coalesce(p_note, ''))
  where id = p_student_id;
  if not found then raise exception 'student not found'; end if;

  if v_guardian_name <> '' or v_guardian_phone <> '' then
    update public.guardians
    set name = v_guardian_name, phone = v_guardian_phone
    where student_id = p_student_id and is_primary;
    if not found then
      insert into public.guardians (student_id, name, phone, is_primary)
      values (p_student_id, v_guardian_name, v_guardian_phone, true);
    end if;
  end if;
end;
$$;

revoke all on function public.admin_create_student(text, text, text, text, boolean, text, text, date, text) from public, anon;
grant execute on function public.admin_create_student(text, text, text, text, boolean, text, text, date, text) to authenticated;
revoke all on function public.admin_update_student(uuid, text, text, text, text, text, text, date, text) from public, anon;
grant execute on function public.admin_update_student(uuid, text, text, text, text, text, text, date, text) to authenticated;
