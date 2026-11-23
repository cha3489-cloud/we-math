-- Today-first admin operations snapshot.
-- One population: every attendance row whose class session falls on the requested KST date,
-- plus any older row that still has open follow-up work, so unresolved items are never hidden
-- behind a history cutoff. Secrets (codes, hashes, tokens, phone numbers) are never returned.

create function private.admin_operations_snapshot_for(p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with population as (
    select r.*
    from public.attendance_records r
    join public.class_sessions s on s.id = r.class_session_id
    where (s.starts_at at time zone 'Asia/Seoul')::date = p_day
       or exists (select 1 from public.attendance_followups f where f.attendance_id = r.id and f.status = 'open')
       or (r.status = 'scheduled' and s.status = 'scheduled' and (s.starts_at at time zone 'Asia/Seoul')::date < p_day)
  )
  select jsonb_build_object(
    'day', p_day,
    'generated_at', now(),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
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
      ) order by s.starts_at, st.name, r.id)
      from population r
      join public.class_sessions s on s.id = r.class_session_id
      join public.class_groups g on g.id = s.class_group_id
      join public.students st on st.id = r.student_id
    ), '[]'::jsonb),
    'failed_messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'student_name', st.name, 'message_type', m.message_type, 'failure_code', m.failure_code,
        'failed_at', m.failed_at, 'manual_followup_at', m.manual_followup_at, 'recipient_label', m.recipient_label
      ) order by m.failed_at desc)
      from public.parent_messages m join public.students st on st.id = m.student_id
      where m.status = 'failed' and m.manual_followup_at is null
    ), '[]'::jsonb),
    'makeup_drafts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'batch_id', b.id, 'attendance_id', b.attendance_id, 'student_name', st.name, 'origin', b.origin, 'status', b.status,
        'delivery_mode', b.delivery_mode, 'manual_reason', b.manual_reason, 'created_at', b.created_at,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'starts_at', o.starts_at, 'ends_at', o.ends_at, 'sort_order', o.sort_order, 'status', o.status) order by o.sort_order)
          from public.makeup_offer_options o where o.offer_batch_id = b.id
        ), '[]'::jsonb)
      ) order by b.created_at)
      from public.makeup_offer_batches b join public.students st on st.id = b.student_id
      where b.status in ('draft', 'manual_followup')
    ), '[]'::jsonb)
  )
$$;

create function public.admin_today_operations()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  return private.admin_operations_snapshot_for((now() at time zone 'Asia/Seoul')::date);
end;
$$;

revoke all on function private.admin_operations_snapshot_for(date) from public;
revoke all on function public.admin_today_operations() from public, anon;
grant execute on function public.admin_today_operations() to authenticated;
