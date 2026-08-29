-- 적용 경로: supabase/migrations/20260828010000_review_v2_provenance_fail_closed.sql (신규)
--
-- 고친 문제:
--   20260726010000 의 4인자 review_submission_v2 는 5인자에 false 로 위임한 뒤
--   같은 submission 의 feedback 을 auto_composed = null 로 덮어썼다.
--
--     perform public.review_submission_v2(..., false);
--     update public.feedback set auto_composed = null where submission_id = ...;
--
--   당시 의도는 "구버전 클라이언트는 출처를 말할 수 없으니 그 불확실성을 NULL 로
--   보존한다" 였고, 그 자체는 정직한 선택이다. 하지만 결과적으로 두 가지가 어긋난다.
--
--   1) 5인자 함수는 `if p_auto_composed is null then raise exception` 로
--      "새 feedback 은 반드시 출처를 밝힌다" 는 불변식을 세운다.
--      4인자 경로는 그 불변식을 함수 밖 UPDATE 로 사후에 되돌린다.
--      DB 가 스스로 세운 규칙을 DB 안의 다른 함수가 깨는 구조다.
--
--   2) UPDATE 대상이 방금 insert 한 feedback id 가 아니라 submission_id 다.
--      지금은 feedback.submission_id 가 unique 라 1건만 맞지만, 재검토를 허용해
--      unique 를 푸는 순간 해당 제출의 과거 검토까지 전부 NULL 이 된다.
--
-- 왜 지금 닫는가 (2026-08-28 운영 DB 조회 결과):
--   public.feedback 8건 — auto_composed true 2건 / false 6건 / NULL 0건.
--   즉 4인자 경로는 운영에서 한 번도 실행된 적이 없고, 보존해야 할 legacy NULL
--   행도 존재하지 않는다. 지금이 이 경로를 닫는 가장 비용이 낮은 시점이다.
--
-- 선택한 방식: 4인자 오버로드를 fail-closed 로 만든다 (drop 하지 않는다).
--   * drop 하면 구버전 클라이언트는 PGRST202 만 받는다. 함수를 남겨두면
--     원장이 읽을 수 있는 안내 문구를 그대로 돌려줄 수 있다.
--   * false 로 위임만 하는 방식은 출처를 모르는 호출에 "원장이 직접 씀" 이라는
--     값을 만들어낸다. 모르는 것을 아는 것처럼 기록하느니 거절한다.
--   * execute 권한은 authenticated 에 유지한다. 권한을 회수하면 안내 문구 대신
--     'permission denied for function' 이 나가서 원인 파악이 어려워진다.
--
-- 기존 데이터: 손대지 않는다. 과거 NULL 행을 false 로 일괄 변환하지 않는다.
--   아래 check 제약은 not valid 로 추가하므로 기존 행은 검사 대상에서 제외되고,
--   새로 들어오는 행만 출처를 반드시 밝히게 된다.
--
-- 20260726010000 은 수정하지 않는다. 이미 운영에 적용된 마이그레이션이므로
-- 고치면 저장소와 DB 이력이 어긋난다. append-only 로 덮어쓴다.
--
-- 재실행 안전성: create or replace / 조건부 제약 추가 / revoke·grant 로만 구성한다.

-- ── 0) 선행 조건: 5인자 경로가 살아 있어야 한다 ──────────────────────────
-- 4인자를 닫는 마이그레이션이므로, 5인자가 없으면 검토가 전면 중단된다.
do $$
begin
  if to_regprocedure(
       'public.review_submission_v2(uuid, text, public.submission_status, jsonb, boolean)'
     ) is null then
    raise exception
      '5인자 review_submission_v2 가 없다. 4인자 경로를 닫으면 검토가 전면 중단된다. 20260726010000 적용 여부를 먼저 확인할 것.';
  end if;
end $$;

-- ── 1) 4인자 오버로드를 fail-closed 로 교체 ──────────────────────────────
create or replace function public.review_submission_v2(
  p_submission_id uuid,
  p_body text,
  p_status public.submission_status,
  p_items jsonb default '[]'::jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
  raise exception using
    errcode = 'P0001',
    message = '구버전 화면입니다. 새로고침 후 다시 확정해 주세요.',
    detail  = 'review_submission_v2(uuid, text, submission_status, jsonb) is retired: the caller cannot state feedback provenance.',
    hint    = 'Use review_submission_v2(uuid, text, submission_status, jsonb, boolean) with an explicit p_auto_composed.';
end;
$$;

-- 안내 문구가 클라이언트까지 도달해야 하므로 execute 는 유지한다.
revoke all on function public.review_submission_v2(uuid, text, public.submission_status, jsonb)
  from public, anon;
grant execute on function public.review_submission_v2(uuid, text, public.submission_status, jsonb)
  to authenticated;

-- ── 2) 불변식을 함수가 아니라 스키마에 건다 ──────────────────────────────
-- 함수마다 규칙을 지키게 하는 대신, 새 행이 NULL 이면 애초에 들어가지 못하게 한다.
-- not valid: 기존 행은 검사하지 않는다(= 과거 NULL 의 의미를 그대로 보존한다).
-- validate 하지 않는다. validate 하는 순간 과거 NULL 행이 있으면 실패한다.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.feedback'::regclass
      and conname = 'feedback_auto_composed_known'
  ) then
    alter table public.feedback
      add constraint feedback_auto_composed_known
      check (auto_composed is not null) not valid;
  end if;
end $$;

comment on constraint feedback_auto_composed_known on public.feedback is
  'New rows must state provenance. NOT VALID on purpose: pre-20260726010000 rows keep NULL = legacy unknown.';

-- ── 3) 결과 확인 ─────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure(
       'public.review_submission_v2(uuid, text, public.submission_status, jsonb)'
     ) is null then
    raise exception '4인자 오버로드가 사라졌다. 구버전 클라이언트가 안내 문구 대신 PGRST202 를 받는다.';
  end if;
  if not has_function_privilege(
       'authenticated',
       'public.review_submission_v2(uuid, text, public.submission_status, jsonb)',
       'EXECUTE'
     ) then
    raise exception '4인자 오버로드의 execute 권한이 없다. 안내 문구가 클라이언트에 도달하지 못한다.';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.feedback'::regclass
      and conname = 'feedback_auto_composed_known'
      and not convalidated
  ) then
    raise exception 'feedback_auto_composed_known 이 없거나 validate 되었다. 과거 NULL 행의 의미가 보존되지 않는다.';
  end if;
end $$;
