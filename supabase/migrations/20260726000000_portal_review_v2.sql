-- 적용 경로: supabase/migrations/20260726000000_portal_review_v2.sql
-- Portal review v2: structured feedback + review events. No AI tables.
-- Backward compatible for feedback.body; legacy review_submission() completed calls delegate to v2,
-- while legacy needs_revision calls fail closed because they cannot carry structured items.
-- DO NOT run on production. Apply on a Supabase branch / local only.

-- 1) feedback_items ----------------------------------------------------------
create table public.feedback_items (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.feedback(id) on delete cascade,
  problem_ref text not null check (char_length(problem_ref) between 1 and 40),
  review_tag text not null check (review_tag in
    ('풀이 시작 보완','조건·문제 이해 확인','개념 연결 보완','계산·부호 확인','풀이 마무리·검산')),
  comment text not null default '' check (char_length(comment) <= 1000),
  redo_required boolean not null default false,
  created_at timestamptz not null default now()
);
create index feedback_items_feedback_idx on public.feedback_items(feedback_id);
alter table public.feedback_items enable row level security;

-- Students read items only for their own submissions; admins read all.
create policy "feedback items readable by owner or admin" on public.feedback_items
for select to authenticated using (
  public.is_admin() or (
    public.is_active_user() and exists (
      select 1 from public.feedback f
      join public.submissions s on s.id = f.submission_id
      where f.id = public.feedback_items.feedback_id and s.student_id = auth.uid()
    )
  )
);
-- No INSERT/UPDATE/DELETE policies for authenticated:
-- writes happen only inside review_submission_v2 (security definer).

-- 2) review_events -----------------------------------------------------------
create table public.review_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  event_type text not null check (event_type in ('review_opened','review_decided')),
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index review_events_submission_idx on public.review_events(submission_id, created_at);
alter table public.review_events enable row level security;
create policy "admins read review events" on public.review_events
for select to authenticated using (public.is_admin());
-- Browser may only log 'review_opened' as itself. 'review_decided' is RPC-only.
create policy "admins log review opened" on public.review_events
for insert to authenticated with check (
  public.is_admin() and actor_id = auth.uid() and event_type = 'review_opened'
);

-- 3) grants ------------------------------------------------------------------
revoke all on table public.feedback_items from public, anon, authenticated;
revoke all on table public.review_events from public, anon, authenticated;
grant select on table public.feedback_items to authenticated;
grant select, insert on table public.review_events to authenticated;

-- 4) review_submission_v2 ----------------------------------------------------
create or replace function public.review_submission_v2(
  p_submission_id uuid,
  p_body text,
  p_status public.submission_status,
  p_items jsonb default '[]'::jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  target public.submissions%rowtype;
  item jsonb;
  v_feedback_id uuid;
  v_redo_count integer := 0;
begin
  -- Admin is verified in DB, never trusted from the browser.
  if not public.is_admin() then raise exception 'admin required'; end if;
  if p_status not in ('needs_revision', 'completed') then raise exception 'invalid review status'; end if;
  if char_length(trim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'feedback required'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception 'invalid items'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 20 then raise exception 'too many feedback items'; end if;

  -- Row lock prevents concurrent double review; unique feedback.submission_id is a second guard.
  select * into target from public.submissions where id = p_submission_id for update;
  if target.id is null or target.status <> 'submitted' then raise exception 'submission is not reviewable'; end if;
  if exists (
    select 1 from public.submissions newer
    where newer.assignment_id = target.assignment_id and newer.attempt_no > target.attempt_no
  ) then raise exception 'only latest attempt is reviewable'; end if;

  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if char_length(trim(coalesce(item->>'problem_ref', ''))) not between 1 and 40 then
      raise exception 'invalid problem_ref';
    end if;
    if coalesce(item->>'review_tag', '') not in
      ('풀이 시작 보완','조건·문제 이해 확인','개념 연결 보완','계산·부호 확인','풀이 마무리·검산') then
      raise exception 'invalid review_tag';
    end if;
    if char_length(coalesce(item->>'comment', '')) > 1000 then raise exception 'comment too long'; end if;
    if coalesce((item->>'redo_required')::boolean, false) then v_redo_count := v_redo_count + 1; end if;
  end loop;
  if p_status = 'needs_revision' and v_redo_count = 0 then
    raise exception 'needs_revision requires at least one redo item';
  end if;
  if p_status = 'completed' and v_redo_count > 0 then
    raise exception 'completed cannot include redo items';
  end if;

  -- Single transaction: feedback + items + status + event.
  insert into public.feedback (submission_id, author_id, body)
  values (target.id, auth.uid(), trim(p_body))
  returning id into v_feedback_id;

  insert into public.feedback_items (feedback_id, problem_ref, review_tag, comment, redo_required)
  select v_feedback_id,
         trim(i->>'problem_ref'),
         i->>'review_tag',
         coalesce(i->>'comment', ''),
         coalesce((i->>'redo_required')::boolean, false)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as i;

  update public.submissions set status = p_status, reviewed_at = now() where id = target.id;

  insert into public.review_events (submission_id, event_type, actor_id)
  values (target.id, 'review_decided', auth.uid());
end;
$$;
revoke all on function public.review_submission_v2(uuid, text, public.submission_status, jsonb) from public, anon, authenticated;
grant execute on function public.review_submission_v2(uuid, text, public.submission_status, jsonb) to authenticated;


-- ── 4. 구형 RPC 호환 경로 잠금 ──────────────────────────────────────────
-- 완료 처리는 빈 구조화 항목으로 v2에 위임하고, 수정 요청은 v2 사용을 강제한다.
create or replace function public.review_submission(
  p_submission_id uuid,
  p_body text,
  p_status public.submission_status
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status = 'needs_revision' then
    raise exception 'structured feedback required; use review_submission_v2';
  end if;
  perform public.review_submission_v2(p_submission_id, p_body, p_status, '[]'::jsonb);
end;
$$;
revoke all on function public.review_submission(uuid, text, public.submission_status) from public, anon, authenticated;
grant execute on function public.review_submission(uuid, text, public.submission_status) to authenticated;
