-- Principal-managed student portal MVP. Roles are never writable by browser users.
create type public.app_role as enum ('student', 'admin');
create type public.submission_status as enum ('submitted', 'needs_revision', 'completed');
alter table public.profiles add column if not exists suspended_at timestamptz;
alter table public.profiles add column if not exists must_change_pin boolean not null default true;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
update public.profiles set name = coalesce(nullif(name, ''), phone) where name is null or name = '';
alter table public.profiles alter column name set not null;
create table public.user_roles (user_id uuid primary key references auth.users(id) on delete cascade, role public.app_role not null default 'student', created_at timestamptz not null default now());
alter table public.user_roles enable row level security;
insert into public.user_roles (user_id, role) select id, 'student'::public.app_role from public.profiles on conflict (user_id) do nothing;
create or replace function public.is_active_user() returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.profiles where id = auth.uid() and suspended_at is null) $$;
revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id where r.user_id = auth.uid() and r.role = 'admin' and p.suspended_at is null) $$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
create or replace function public.complete_pin_change() returns void language plpgsql security definer set search_path = public as $$
begin
 if auth.uid() is null or not public.is_active_user() then raise exception 'authentication required'; end if;
 update public.profiles set must_change_pin = false where id = auth.uid();
 if not found then raise exception 'profile not found'; end if;
end;
$$;
revoke all on function public.complete_pin_change() from public, anon;
grant execute on function public.complete_pin_change() to authenticated;
create policy "roles visible to self or admin" on public.user_roles for select to authenticated using (public.is_active_user() and (user_id = auth.uid() or public.is_admin()));
drop policy if exists "본인 조회" on public.profiles;
drop policy if exists "본인 수정" on public.profiles;
create policy "active users read own profile" on public.profiles for select to authenticated using (id = auth.uid() and public.is_active_user());
create policy "admins read all profiles" on public.profiles for select to authenticated using (public.is_admin());
create policy "admins update profiles" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
 insert into public.profiles (id, phone, name) values (new.id, split_part(new.email, '@', 1), coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)));
 insert into public.user_roles (user_id, role) values (new.id, 'student'); return new;
end;
$$;
revoke all on function public.delete_own_account() from public, anon, authenticated;
revoke all on function public.is_withdrawn_phone(text) from public, anon, authenticated;
create table public.assignments (
 id uuid primary key default gen_random_uuid(), student_id uuid not null references public.profiles(id) on delete cascade,
 created_by uuid not null references public.profiles(id), title text not null check (char_length(title) between 1 and 120),
 description text not null default '', due_at timestamptz, attachment_paths text[] not null default '{}',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index assignments_student_due_idx on public.assignments(student_id, due_at);
alter table public.assignments enable row level security;
create policy "students read assigned work" on public.assignments for select to authenticated using ((student_id = auth.uid() and public.is_active_user()) or public.is_admin());
create policy "admins create assignments" on public.assignments for insert to authenticated with check (public.is_admin() and created_by = auth.uid());
create policy "admins update assignments" on public.assignments for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins delete assignments" on public.assignments for delete to authenticated using (public.is_admin());
create table public.submissions (
 id uuid primary key default gen_random_uuid(), assignment_id uuid not null references public.assignments(id) on delete cascade,
 student_id uuid not null references public.profiles(id) on delete cascade, attempt_no integer not null check (attempt_no > 0),
 status public.submission_status not null default 'submitted', body text not null default '', file_paths text[] not null default '{}',
 submitted_at timestamptz not null default now(), reviewed_at timestamptz, unique (assignment_id, attempt_no),
 check (body <> '' or cardinality(file_paths) > 0)
);
create index submissions_student_assignment_idx on public.submissions(student_id, assignment_id, attempt_no desc);
create or replace function public.prepare_submission_attempt() returns trigger language plpgsql security definer set search_path = public as $$
declare assigned_student uuid; latest public.submissions%rowtype;
begin
 if auth.uid() is null or not public.is_active_user() or new.student_id <> auth.uid() then raise exception 'invalid student'; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.assignment_id::text, 0));
 select student_id into assigned_student from public.assignments where id = new.assignment_id;
 if assigned_student is null or assigned_student <> auth.uid() then raise exception 'assignment not owned'; end if;
 select * into latest from public.submissions where assignment_id = new.assignment_id order by attempt_no desc limit 1;
 if latest.id is not null and latest.status <> 'needs_revision' then raise exception 'latest attempt is not open for revision'; end if;
 new.attempt_no := coalesce(latest.attempt_no, 0) + 1; new.status := 'submitted'; new.reviewed_at := null; return new;
end;
$$;
revoke all on function public.prepare_submission_attempt() from public, anon, authenticated;
create trigger prepare_submission_attempt before insert on public.submissions for each row execute function public.prepare_submission_attempt();
alter table public.submissions enable row level security;
create policy "students read own submissions" on public.submissions for select to authenticated using ((student_id = auth.uid() and public.is_active_user()) or public.is_admin());
create policy "students submit assigned work" on public.submissions for insert to authenticated with check (public.is_active_user() and student_id = auth.uid() and status = 'submitted');
-- No student UPDATE/DELETE policy: reviewed attempts are immutable to students.
create policy "admins update submission reviews" on public.submissions for update to authenticated using (public.is_admin()) with check (public.is_admin());
create table public.feedback (
 id uuid primary key default gen_random_uuid(), submission_id uuid not null unique references public.submissions(id) on delete cascade,
 author_id uuid not null references public.profiles(id), body text not null check (char_length(body) between 1 and 4000), created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
create policy "students read own feedback" on public.feedback for select to authenticated using (public.is_admin() or (public.is_active_user() and exists (select 1 from public.submissions s where s.id = submission_id and s.student_id = auth.uid())));
create policy "admins read feedback" on public.feedback for select to authenticated using (public.is_admin());
create or replace function public.review_submission(p_submission_id uuid, p_body text, p_status public.submission_status) returns void language plpgsql security definer set search_path = public as $$
declare target public.submissions%rowtype;
begin
 if not public.is_admin() then raise exception 'admin required'; end if;
 if p_status not in ('needs_revision', 'completed') then raise exception 'invalid review status'; end if;
 if char_length(trim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'feedback required'; end if;
 select * into target from public.submissions where id = p_submission_id for update;
 if target.id is null or target.status <> 'submitted' then raise exception 'submission is not reviewable'; end if;
 if exists (select 1 from public.submissions newer where newer.assignment_id = target.assignment_id and newer.attempt_no > target.attempt_no) then raise exception 'only latest attempt is reviewable'; end if;
 insert into public.feedback (submission_id, author_id, body) values (target.id, auth.uid(), trim(p_body));
 update public.submissions set status = p_status, reviewed_at = now() where id = target.id;
end;
$$;
revoke all on function public.review_submission(uuid, text, public.submission_status) from public, anon;
grant execute on function public.review_submission(uuid, text, public.submission_status) to authenticated;
insert into storage.buckets (id, name, public, file_size_limit) values ('assignment-files', 'assignment-files', false, 10485760), ('submission-files', 'submission-files', false, 10485760) on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
create policy "assignment files readable by assignee" on storage.objects for select to authenticated using (bucket_id = 'assignment-files' and (public.is_admin() or (public.is_active_user() and exists (select 1 from public.assignments a where a.student_id = auth.uid() and name = any(a.attachment_paths)))));
create policy "admins upload assignment files" on storage.objects for insert to authenticated with check (bucket_id = 'assignment-files' and public.is_admin());
create policy "admins modify assignment files" on storage.objects for update to authenticated using (bucket_id = 'assignment-files' and public.is_admin()) with check (bucket_id = 'assignment-files' and public.is_admin());
create policy "admins delete assignment files" on storage.objects for delete to authenticated using (bucket_id = 'assignment-files' and public.is_admin());
create policy "submission files readable by owner" on storage.objects for select to authenticated using (bucket_id = 'submission-files' and ((public.is_active_user() and (storage.foldername(name))[1] = auth.uid()::text) or public.is_admin()));
create policy "students upload submission files" on storage.objects for insert to authenticated with check (bucket_id = 'submission-files' and public.is_active_user() and (storage.foldername(name))[1] = auth.uid()::text and exists (select 1 from public.assignments a where a.id::text = (storage.foldername(name))[2] and a.student_id = auth.uid()));
create policy "students delete unsubmitted files" on storage.objects for delete to authenticated using (bucket_id = 'submission-files' and public.is_active_user() and (storage.foldername(name))[1] = auth.uid()::text and not exists (select 1 from public.submissions s where name = any(s.file_paths)));
