-- Portal operational hardening.
-- 1) Assignment ownership is immutable after insert.

revoke update on table public.assignments from authenticated;
grant update (title, description, due_at, attachment_paths, updated_at)
  on table public.assignments to authenticated;


-- 2) New feedback rows record whether feedback.body was generated from
-- structured items. NULL is reserved for pre-migration legacy rows.
alter table public.feedback add column auto_composed boolean;
comment on column public.feedback.auto_composed is
  'NULL=legacy unknown, true=generated from feedback_items, false=administrator-written';

create or replace function public.review_submission_v2(
  p_submission_id uuid,
  p_body text,
  p_status public.submission_status,
  p_items jsonb,
  p_auto_composed boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  target public.submissions%rowtype;
  item jsonb;
  v_feedback_id uuid;
  v_redo_count integer := 0;
begin
  if not public.is_admin() then raise exception 'admin required'; end if;
  if p_status not in ('needs_revision', 'completed') then raise exception 'invalid review status'; end if;
  if char_length(trim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'feedback required'; end if;
  if p_auto_composed is null then raise exception 'auto_composed required'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception 'invalid items'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 20 then raise exception 'too many feedback items'; end if;

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

  insert into public.feedback (submission_id, author_id, body, auto_composed)
  values (target.id, auth.uid(), trim(p_body), p_auto_composed)
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
revoke all on function public.review_submission_v2(uuid, text, public.submission_status, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.review_submission_v2(uuid, text, public.submission_status, jsonb, boolean)
  to authenticated;

-- Mixed-version compatibility: old clients cannot state the source. Preserve
-- that uncertainty as NULL so only legacy rows use the legacy display fallback.
create or replace function public.review_submission_v2(
  p_submission_id uuid,
  p_body text,
  p_status public.submission_status,
  p_items jsonb default '[]'::jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.review_submission_v2(p_submission_id, p_body, p_status, p_items, false);
  update public.feedback
  set auto_composed = null
  where submission_id = p_submission_id;
end;
$$;
revoke all on function public.review_submission_v2(uuid, text, public.submission_status, jsonb)
  from public, anon, authenticated;
grant execute on function public.review_submission_v2(uuid, text, public.submission_status, jsonb)
  to authenticated;

create or replace function public.review_submission(
  p_submission_id uuid,
  p_body text,
  p_status public.submission_status
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status = 'needs_revision' then
    raise exception 'structured feedback required; use review_submission_v2';
  end if;
  perform public.review_submission_v2(p_submission_id, p_body, p_status, '[]'::jsonb, false);
end;
$$;
revoke all on function public.review_submission(uuid, text, public.submission_status)
  from public, anon, authenticated;
grant execute on function public.review_submission(uuid, text, public.submission_status)
  to authenticated;
