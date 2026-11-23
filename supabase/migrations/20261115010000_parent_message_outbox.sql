-- Parent message outbox and delivery attempts.
-- Repository-only. No provider credentials live in the database or browser.
-- The dispatcher Edge Function runs a dry-run provider by default; failures stay failed
-- (no SMS/LMS fallback) and surface in the admin manual follow-up queue.

create table public.message_templates (
  template_code text primary key check (template_code ~ '^[a-z_]{3,40}$'),
  message_type text not null unique check (message_type in ('present', 'late', 'missing', 'absent', 'checkout', 'makeup_offer')),
  template_version integer not null default 1 check (template_version > 0),
  body text not null check (char_length(body) between 1 and 1000),
  approved boolean not null default false,
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  check ((approved and approved_by is not null and approved_at is not null) or (not approved and approved_at is null))
);

insert into public.message_templates (template_code, message_type, body) values
  ('attendance_present', 'present', E'[시퀀스 수학]\n#{학생명} 학생이 #{출석시각}에 출석했습니다.\n오늘 학습을 시작합니다.'),
  ('attendance_late', 'late', E'[시퀀스 수학]\n#{학생명} 학생이 예정 수업 #{수업시각}보다 늦은 #{출석시각}에 출석했습니다.\n수업은 정상적으로 시작했습니다.'),
  ('attendance_missing', 'missing', E'[시퀀스 수학]\n#{학생명} 학생의 #{수업시각} 수업 출석이 아직 확인되지 않았습니다.\n등원 여부를 확인 부탁드립니다.'),
  ('attendance_absent', 'absent', E'[시퀀스 수학]\n#{학생명} 학생의 #{수업시각} 수업이 결석으로 확인되었습니다.'),
  ('attendance_checkout', 'checkout', E'[시퀀스 수학]\n#{학생명} 학생이 #{하원시각}에 학원에서 하원했습니다.'),
  ('makeup_offer', 'makeup_offer', E'[시퀀스 수학]\n#{학생명} 학생의 보강 일정을 아래 링크에서 선택해 주세요.\n선택은 #{선택기한}까지 가능합니다.\n#{선택링크}');

alter table public.message_templates enable row level security;
create policy "admins read message templates" on public.message_templates for select to authenticated using (public.is_admin());
revoke all on table public.message_templates from public, anon, authenticated;
grant select on table public.message_templates to authenticated;

create function public.admin_approve_message_template(p_template_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.message_templates set approved = true, approved_by = auth.uid(), approved_at = now()
    where template_code = p_template_code and not approved;
  if not found and not exists (select 1 from public.message_templates where template_code = p_template_code) then
    raise exception 'template not found' using errcode = '23503';
  end if;
end;
$$;
revoke all on function public.admin_approve_message_template(text) from public, anon;
grant execute on function public.admin_approve_message_template(text) to authenticated;

create table public.parent_messages (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  guardian_id uuid references public.guardians(id) on delete restrict,
  attendance_id uuid references public.attendance_records(id) on delete restrict,
  makeup_offer_batch_id uuid,
  message_type text not null check (message_type in ('present', 'late', 'missing', 'absent', 'checkout', 'makeup_offer')),
  template_code text not null references public.message_templates(template_code) on delete restrict,
  template_version integer not null,
  rendered_body text not null check (char_length(rendered_body) between 1 and 1000),
  recipient_label text not null default '' check (char_length(recipient_label) <= 80),
  recipient_phone_last4 text not null default '' check (recipient_phone_last4 ~ '^[0-9]{0,4}$'),
  status text not null check (status in ('draft', 'approved', 'queued', 'sent', 'delivered', 'failed', 'cancelled')),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  queued_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  failure_code text check (failure_code is null or char_length(failure_code) <= 80),
  cancelled_at timestamptz,
  dry_run boolean not null default false,
  dispatch_locked_until timestamptz,
  manual_followup_at timestamptz,
  manual_followup_by uuid references public.profiles(id) on delete restrict,
  manual_followup_note text check (manual_followup_note is null or char_length(manual_followup_note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'failed' or (failed_at is not null and failure_code is not null)),
  check (manual_followup_at is null or status = 'failed')
);
create index parent_messages_status_idx on public.parent_messages (status, created_at);
create index parent_messages_attendance_idx on public.parent_messages (attendance_id, message_type);

-- Freeze the actual recipient at enqueue time. The full phone number is kept outside
-- the browser-readable outbox and outside audit snapshots; only the service dispatcher
-- can read it. Later guardian edits must never silently retarget an existing message.
create table private.parent_message_recipients (
  message_id uuid primary key references public.parent_messages(id) on delete restrict,
  phone text not null check (char_length(phone) <= 30)
);
revoke all on table private.parent_message_recipients from public;

create table public.message_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.parent_messages(id) on delete restrict,
  provider text not null check (provider in ('dry_run', 'kakao_alimtalk')),
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 120),
  attempt_no integer not null check (attempt_no between 1 and 3),
  -- requested: claimed, provider outcome unknown. accepted: provider accepted the send; the
  -- attempt stays open for a later delivered/failed receipt. delivered/failed: closed.
  status text not null default 'requested' check (status in ('requested', 'accepted', 'delivered', 'failed')),
  result_code text check (result_code is null or char_length(result_code) <= 80),
  requested_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  accepted_at timestamptz,
  completed_at timestamptz,
  unique (message_id, attempt_no),
  check ((status in ('requested', 'accepted')) = (completed_at is null)),
  check (status <> 'accepted' or (accepted_at is not null and provider_request_id is not null)),
  check (status <> 'requested' or accepted_at is null)
);

-- Claim ownership. Only the SHA-256 of the per-claim nonce is stored, outside every
-- browser-readable table and outside the operations audit. The plaintext nonce exists only
-- in the service-role claim response held by the dispatcher worker.
create table private.parent_message_claims (
  message_id uuid not null references public.parent_messages(id) on delete restrict,
  attempt_no integer not null,
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz not null,
  primary key (message_id, attempt_no),
  foreign key (message_id, attempt_no) references public.message_delivery_attempts(message_id, attempt_no) on delete restrict
);
revoke all on table private.parent_message_claims from public;

create function private.guard_parent_message()
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
    return new;
  end if;
  if new.student_id is distinct from old.student_id or new.guardian_id is distinct from old.guardian_id
     or new.attendance_id is distinct from old.attendance_id or new.message_type is distinct from old.message_type
     or new.idempotency_key is distinct from old.idempotency_key or new.template_code is distinct from old.template_code
     or new.recipient_phone_last4 is distinct from old.recipient_phone_last4 or new.created_at is distinct from old.created_at then
    raise exception 'parent message identity is immutable' using errcode = '42501';
  end if;
  if old.status not in ('draft', 'approved') and new.rendered_body is distinct from old.rendered_body then
    raise exception 'queued message body is immutable' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('approved', 'queued', 'cancelled'))
    or (old.status = 'approved' and new.status in ('queued', 'cancelled'))
    or (old.status = 'queued' and new.status in ('sent', 'failed', 'cancelled'))
    or (old.status = 'sent' and new.status in ('delivered', 'failed'))
  ) then
    raise exception 'invalid parent message transition' using errcode = '23514';
  end if;
  if old.manual_followup_at is not null and (new.manual_followup_at, new.manual_followup_by, new.manual_followup_note)
       is distinct from (old.manual_followup_at, old.manual_followup_by, old.manual_followup_note) then
    raise exception 'manual follow-up is immutable' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_parent_messages before insert or update on public.parent_messages
  for each row execute function private.guard_parent_message();
create trigger audit_parent_messages after insert or update on public.parent_messages
  for each row execute function private.audit_operation_row();
create trigger audit_message_delivery_attempts after insert or update on public.message_delivery_attempts
  for each row execute function private.audit_operation_row();

alter table public.parent_messages enable row level security;
alter table public.message_delivery_attempts enable row level security;
create policy "admins read parent messages" on public.parent_messages for select to authenticated using (public.is_admin());
create policy "admins read delivery attempts" on public.message_delivery_attempts for select to authenticated using (public.is_admin());
revoke all on table public.parent_messages from public, anon, authenticated;
revoke all on table public.message_delivery_attempts from public, anon, authenticated;
grant select on table public.parent_messages to authenticated;
grant select on table public.message_delivery_attempts to authenticated;

create function private.kst_time(p_value timestamptz)
returns text
language sql
stable
set search_path = ''
as $$ select to_char(p_value at time zone 'Asia/Seoul', 'HH24:MI') $$;

-- Creates (at most once per idempotency key) a message for the student's single primary guardian.
create function private.enqueue_parent_message(
  p_student_id uuid,
  p_type text,
  p_idempotency_key text,
  p_vars jsonb,
  p_attendance_id uuid default null,
  p_batch_id uuid default null,
  p_force_status text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_student_name text;
  v_guardian public.guardians%rowtype;
  v_template public.message_templates%rowtype;
  v_body text;
  v_key text;
  v_status text;
  v_digits text;
  v_id uuid;
begin
  select id into v_existing from public.parent_messages where idempotency_key = p_idempotency_key;
  if v_existing is not null then return v_existing; end if;

  select name into v_student_name from public.students where id = p_student_id;
  select * into v_guardian from public.guardians where student_id = p_student_id and is_primary;
  select * into v_template from public.message_templates where message_type = p_type;
  if v_template.template_code is null then raise exception 'message template missing' using errcode = '23503'; end if;

  v_body := replace(v_template.body, '#{학생명}', v_student_name);
  for v_key in select jsonb_object_keys(coalesce(p_vars, '{}'::jsonb)) loop
    v_body := replace(v_body, '#{' || v_key || '}', coalesce(p_vars ->> v_key, ''));
  end loop;

  v_digits := regexp_replace(coalesce(v_guardian.phone, ''), '[^0-9]', '', 'g');
  v_status := case
    when v_guardian.id is null or v_digits = '' then 'failed'
    when p_force_status is not null then p_force_status
    when v_template.approved then 'queued'
    else 'draft'
  end;

  insert into public.parent_messages (
    student_id, guardian_id, attendance_id, makeup_offer_batch_id, message_type, template_code, template_version,
    rendered_body, recipient_label, recipient_phone_last4, status, idempotency_key, queued_at, failed_at, failure_code
  ) values (
    p_student_id, v_guardian.id, p_attendance_id, p_batch_id, p_type, v_template.template_code, v_template.template_version,
    v_body, coalesce(v_guardian.name, ''), right(v_digits, 4), v_status, p_idempotency_key,
    case when v_status = 'queued' then now() else null end,
    case when v_status = 'failed' then now() else null end,
    case when v_status = 'failed' then 'no_primary_guardian_phone' else null end
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.parent_messages where idempotency_key = p_idempotency_key;
  else
    insert into private.parent_message_recipients (message_id, phone)
    values (v_id, coalesce(v_guardian.phone, ''));
  end if;
  return v_id;
end;
$$;

create function private.enqueue_attendance_message(p_record public.attendance_records, p_type text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
begin
  select coalesce(s.starts_at, p_record.scheduled_at) into v_start
    from (select 1) one left join public.class_sessions s on s.id = p_record.class_session_id;
  return private.enqueue_parent_message(
    p_record.student_id,
    p_type,
    'attendance:' || p_record.id::text || ':' || p_type,
    jsonb_build_object(
      '수업시각', private.kst_time(v_start),
      '출석시각', coalesce(private.kst_time(p_record.checked_in_at), ''),
      '하원시각', coalesce(private.kst_time(p_record.checked_out_at), '')
    ),
    p_record.id
  );
end;
$$;

create function private.enqueue_attendance_messages()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_suppressed boolean := private.has_suppressing_exception(new.student_id, new.class_session_id);
begin
  if old.status = 'scheduled' and new.status in ('present', 'late') then
    -- A pending "출석 미확인" message is withdrawn once the student actually arrives.
    update public.parent_messages set status = 'cancelled', cancelled_at = now()
      where attendance_id = new.id and message_type = 'missing' and status in ('draft', 'approved', 'queued');
    -- Real arrival is always notified. An expected-late exception only suppresses the "late" wording.
    perform private.enqueue_attendance_message(new, case when new.status = 'late' and v_suppressed then 'present' else new.status end);
  elsif old.status = 'scheduled' and new.status in ('absent', 'excused') and not v_suppressed then
    perform private.enqueue_attendance_message(new, 'absent');
  end if;
  if old.checked_out_at is null and new.checked_out_at is not null then
    perform private.enqueue_attendance_message(new, 'checkout');
  end if;
  return new;
end;
$$;
create trigger enqueue_attendance_messages after update of status, checked_out_at on public.attendance_records
  for each row execute function private.enqueue_attendance_messages();

create function private.enqueue_missing_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.attendance_records%rowtype;
begin
  if new.kind <> 'missing' then return new; end if;
  select * into v_record from public.attendance_records where id = new.attendance_id;
  if v_record.status = 'scheduled' and not private.has_suppressing_exception(v_record.student_id, v_record.class_session_id) then
    perform private.enqueue_attendance_message(v_record, 'missing');
  end if;
  return new;
end;
$$;
create trigger enqueue_missing_message after insert on public.attendance_followups
  for each row execute function private.enqueue_missing_message();

-- ── admin actions ──────────────────────────────────────────────────────────
create function public.admin_approve_parent_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.parent_messages m
    set status = 'queued', approved_by = auth.uid(), approved_at = now(), queued_at = now()
    from public.message_templates t, private.parent_message_recipients r
    where m.id = p_message_id
      and m.status in ('draft', 'approved')
      and m.message_type <> 'makeup_offer'
      and t.template_code = m.template_code
      and t.template_version = m.template_version
      and t.approved
      and r.message_id = m.id
      and btrim(r.phone) <> '';
  if not found then
    if exists (select 1 from public.parent_messages where id = p_message_id and status in ('draft', 'approved') and message_type <> 'makeup_offer') then
      raise exception 'approved current template and recipient snapshot required' using errcode = '23514';
    end if;
    raise exception 'parent message state changed' using errcode = '40001';
  end if;
end;
$$;

-- "발송 안 함" exists only on the draft_messages queue (draft/approved, never makeup offers).
-- Exact expected-state CAS: the caller passes the status it displayed, and the row is cancelled
-- only if it is still in exactly that pre-dispatch state. A message another admin already
-- queued, or one the dispatcher claimed (lease lock + requested attempt), is never cancelled here.
create function public.admin_cancel_parent_message(p_message_id uuid, p_expected_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if p_expected_status is null or p_expected_status not in ('draft', 'approved') then
    raise exception 'only a draft or approved message can be cancelled' using errcode = '22023';
  end if;
  update public.parent_messages m set status = 'cancelled', cancelled_at = now()
    where m.id = p_message_id
      and m.status = p_expected_status
      and m.message_type <> 'makeup_offer'
      and m.dispatch_locked_until is null
      and not exists (
        select 1 from public.message_delivery_attempts a
        where a.message_id = m.id and a.status in ('requested', 'accepted')
      );
  if not found then raise exception 'parent message state changed' using errcode = '40001'; end if;
end;
$$;

-- The original delivery status stays 'failed'; only the manual contact fact is added.
create function public.admin_record_message_manual_followup(p_message_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  update public.parent_messages
    set manual_followup_at = now(), manual_followup_by = auth.uid(), manual_followup_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_message_id and status = 'failed' and manual_followup_at is null;
  if not found then raise exception 'parent message state changed' using errcode = '40001'; end if;
end;
$$;

revoke all on function public.admin_approve_parent_message(uuid) from public, anon;
grant execute on function public.admin_approve_parent_message(uuid) to authenticated;
revoke all on function public.admin_cancel_parent_message(uuid, text) from public, anon;
grant execute on function public.admin_cancel_parent_message(uuid, text) to authenticated;
revoke all on function public.admin_record_message_manual_followup(uuid, text) from public, anon;
grant execute on function public.admin_record_message_manual_followup(uuid, text) to authenticated;

-- ── dispatcher (service role only) ─────────────────────────────────────────
-- Each claim creates a new attempt with a fresh high-entropy nonce and a lease. Only the
-- holder of the current, unexpired (message_id, attempt_no, nonce) may record its result.
-- The provider idempotency key is the message idempotency_key and is stable across attempts.
create function private.claim_parent_messages_at(p_provider text, p_limit integer, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.parent_messages%rowtype;
  v_attempt integer;
  v_body text;
  v_link text;
  v_phone text;
  v_nonce text;
  v_lease timestamptz := p_now + interval '5 minutes';
  v_claims jsonb := '[]'::jsonb;
begin
  if p_provider not in ('dry_run', 'kakao_alimtalk') then raise exception 'invalid provider' using errcode = '22023'; end if;
  perform private.begin_trusted('service');
  for v_message in
    select m.* from public.parent_messages m
    where m.status = 'queued' and (m.dispatch_locked_until is null or m.dispatch_locked_until < p_now)
    order by queued_at, id
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
    for update skip locked
  loop
    -- A previous owner whose lease expired without recording a result loses ownership.
    -- The provider may still have accepted it; the retry reuses the same idempotency key.
    update public.message_delivery_attempts
      set status = 'failed', result_code = 'lease_expired', completed_at = p_now
      where message_id = v_message.id and status = 'requested';
    select coalesce(max(attempt_no), 0) + 1 into v_attempt from public.message_delivery_attempts where message_id = v_message.id;
    if v_attempt > 3 then
      update public.parent_messages set status = 'failed', failed_at = p_now, failure_code = 'retry_exhausted', dispatch_locked_until = null where id = v_message.id;
      continue;
    end if;
    v_body := v_message.rendered_body;
    if v_message.message_type = 'makeup_offer' then
      v_link := private.makeup_selection_url(v_message.makeup_offer_batch_id);
      if v_link is null then
        -- The selection link was invalidated (arrival / exception cancellation); never send a dead link.
        update public.parent_messages set status = 'cancelled', cancelled_at = p_now, dispatch_locked_until = null where id = v_message.id;
        continue;
      end if;
      v_body := replace(v_body, '#{선택링크}', v_link);
    end if;
    v_nonce := private.random_token();
    insert into public.message_delivery_attempts (message_id, provider, attempt_no, requested_at, lease_expires_at)
      values (v_message.id, p_provider, v_attempt, p_now, v_lease);
    insert into private.parent_message_claims (message_id, attempt_no, nonce_hash, lease_expires_at)
      values (v_message.id, v_attempt, private.token_hash(v_nonce), v_lease);
    update public.parent_messages set dispatch_locked_until = v_lease where id = v_message.id;
    select phone into v_phone from private.parent_message_recipients where message_id = v_message.id;
    v_claims := v_claims || jsonb_build_array(jsonb_build_object(
      'message_id', v_message.id, 'attempt_no', v_attempt, 'claim_nonce', v_nonce, 'lease_expires_at', v_lease,
      'template_code', v_message.template_code, 'template_version', v_message.template_version,
      'body', v_body, 'recipient_phone', v_phone, 'idempotency_key', v_message.idempotency_key
    ));
  end loop;
  perform private.end_trusted();
  return v_claims;
end;
$$;

create function public.service_claim_parent_messages(p_provider text, p_limit integer default 20)
returns jsonb
language sql
security definer
set search_path = ''
as $$ select private.claim_parent_messages_at(p_provider, p_limit, now()) $$;

create function private.record_delivery_result_at(
  p_message_id uuid,
  p_attempt_no integer,
  p_claim_nonce text,
  p_outcome text,
  p_result_code text,
  p_provider_request_id text,
  p_dry_run boolean,
  p_now timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.parent_messages%rowtype;
  v_attempt public.message_delivery_attempts%rowtype;
  v_claim private.parent_message_claims%rowtype;
  v_target text;
  v_code text := left(p_result_code, 80);
  v_request text := left(p_provider_request_id, 120);
  v_status text;
begin
  if p_outcome not in ('sent', 'delivered', 'failed', 'retryable') then raise exception 'invalid outcome' using errcode = '22023'; end if;
  if coalesce(p_claim_nonce, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'delivery attempt ownership changed' using errcode = '40001';
  end if;
  select * into v_message from public.parent_messages where id = p_message_id for update;
  select * into v_claim from private.parent_message_claims where message_id = p_message_id and attempt_no = p_attempt_no;
  if v_message.id is null or v_claim.message_id is null or v_claim.nonce_hash <> private.token_hash(p_claim_nonce) then
    raise exception 'delivery attempt ownership changed' using errcode = '40001';
  end if;
  -- A re-claim supersedes every earlier owner, even one that never recorded anything.
  if exists (select 1 from public.message_delivery_attempts where message_id = p_message_id and attempt_no > p_attempt_no) then
    raise exception 'delivery attempt ownership changed' using errcode = '40001';
  end if;
  select * into v_attempt from public.message_delivery_attempts where message_id = p_message_id and attempt_no = p_attempt_no for update;
  v_target := case p_outcome when 'sent' then 'accepted' when 'delivered' then 'delivered' else 'failed' end;
  if v_attempt.status <> 'requested' then
    -- Exact duplicate from the same owner (e.g. a lost response) is idempotent; anything else conflicts.
    if v_attempt.status = v_target and v_attempt.provider_request_id is not distinct from v_request
       and v_attempt.result_code is not distinct from v_code then
      return v_message.status;
    end if;
    raise exception 'delivery attempt state changed' using errcode = '40001';
  end if;
  if p_now > v_claim.lease_expires_at then
    raise exception 'delivery lease expired' using errcode = '40001';
  end if;
  if v_target = 'accepted' and v_request is null then
    raise exception 'provider request id required for an accepted send' using errcode = '22023';
  end if;

  perform private.begin_trusted('service');
  update public.message_delivery_attempts
    set status = v_target, result_code = v_code, provider_request_id = v_request,
        accepted_at = case when v_target in ('accepted', 'delivered') then p_now else null end,
        completed_at = case when v_target in ('delivered', 'failed') then p_now else null end
    where id = v_attempt.id;

  -- A message cancelled while in flight keeps its cancelled state; the attempt still records the provider fact.
  if p_outcome = 'sent' and v_message.status = 'queued' then
    update public.parent_messages set status = 'sent', sent_at = p_now, dry_run = coalesce(p_dry_run, false), dispatch_locked_until = null where id = p_message_id;
  elsif p_outcome = 'delivered' and v_message.status in ('queued', 'sent') then
    if v_message.status = 'queued' then
      update public.parent_messages set status = 'sent', sent_at = p_now, dry_run = coalesce(p_dry_run, false) where id = p_message_id;
    end if;
    update public.parent_messages set status = 'delivered', delivered_at = p_now, dispatch_locked_until = null where id = p_message_id;
  elsif p_outcome = 'failed' and v_message.status in ('queued', 'sent') then
    update public.parent_messages set status = 'failed', failed_at = p_now, failure_code = coalesce(v_code, 'provider_failed'), dispatch_locked_until = null where id = p_message_id;
  elsif p_outcome = 'retryable' and v_message.status = 'queued' then
    if p_attempt_no >= 3 then
      update public.parent_messages set status = 'failed', failed_at = p_now, failure_code = 'retry_exhausted', dispatch_locked_until = null where id = p_message_id;
    else
      update public.parent_messages set dispatch_locked_until = null where id = p_message_id;
    end if;
  end if;
  select status into v_status from public.parent_messages where id = p_message_id;
  perform private.end_trusted();
  return v_status;
end;
$$;

create function public.service_record_delivery_result(
  p_message_id uuid,
  p_attempt_no integer,
  p_claim_nonce text,
  p_outcome text,
  p_result_code text default null,
  p_provider_request_id text default null,
  p_dry_run boolean default false
)
returns text
language sql
security definer
set search_path = ''
as $$
  select private.record_delivery_result_at(p_message_id, p_attempt_no, p_claim_nonce, p_outcome, p_result_code, p_provider_request_id, p_dry_run, now())
$$;

-- Asynchronous provider receipt (delivered / failed) for an attempt the provider already accepted.
-- Matched by the stable idempotency key plus the provider's own request id; no claim lease applies.
create function public.service_record_delivery_receipt(
  p_provider text,
  p_idempotency_key text,
  p_provider_request_id text,
  p_outcome text,
  p_result_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.parent_messages%rowtype;
  v_attempt public.message_delivery_attempts%rowtype;
  v_code text := left(p_result_code, 80);
  v_status text;
begin
  if p_outcome not in ('delivered', 'failed') then raise exception 'invalid receipt outcome' using errcode = '22023'; end if;
  select * into v_message from public.parent_messages where idempotency_key = p_idempotency_key for update;
  if v_message.id is null or coalesce(p_provider_request_id, '') = '' then
    raise exception 'delivery receipt does not match an accepted attempt' using errcode = '40001';
  end if;
  select * into v_attempt from public.message_delivery_attempts
    where message_id = v_message.id and provider = p_provider and provider_request_id = left(p_provider_request_id, 120)
      and status in ('accepted', 'delivered', 'failed')
    order by attempt_no desc limit 1
    for update;
  if v_attempt.id is null then
    raise exception 'delivery receipt does not match an accepted attempt' using errcode = '40001';
  end if;
  if v_attempt.status = p_outcome and v_attempt.accepted_at is not null then
    return v_message.status; -- duplicate receipt
  end if;
  if v_attempt.status <> 'accepted' then
    raise exception 'delivery receipt conflicts with the recorded outcome' using errcode = '40001';
  end if;

  perform private.begin_trusted('service');
  update public.message_delivery_attempts
    set status = p_outcome, completed_at = now(), result_code = coalesce(v_code, result_code)
    where id = v_attempt.id;
  if v_message.status = 'sent' and p_outcome = 'delivered' then
    update public.parent_messages set status = 'delivered', delivered_at = now() where id = v_message.id;
  elsif v_message.status = 'sent' and p_outcome = 'failed' then
    update public.parent_messages set status = 'failed', failed_at = now(), failure_code = coalesce(v_code, 'provider_failed') where id = v_message.id;
  end if;
  select status into v_status from public.parent_messages where id = v_message.id;
  perform private.end_trusted();
  return v_status;
end;
$$;

revoke all on function public.service_claim_parent_messages(text, integer) from public, anon, authenticated;
revoke all on function public.service_record_delivery_result(uuid, integer, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.service_record_delivery_receipt(text, text, text, text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.service_claim_parent_messages(text, integer) to service_role';
    execute 'grant execute on function public.service_record_delivery_result(uuid, integer, text, text, text, text, boolean) to service_role';
    execute 'grant execute on function public.service_record_delivery_receipt(text, text, text, text, text) to service_role';
  end if;
end;
$$;

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
