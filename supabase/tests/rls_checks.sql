-- 적용 경로: supabase/tests/rls_checks.sql (신규)
-- 실행 대상: Supabase branch 또는 로컬 DB 전용. 운영 DB에서 실행 금지.
-- 사전 준비(브랜치에서): admin-users 함수 또는 Studio로 합성 계정 생성
--   학생A(합성): 이름 "테스트학생A", 전화 01000000001
--   학생B(합성): 이름 "테스트학생B", 전화 01000000002
--   과제 각 1건 + 학생B 제출 1건 + 학생B 제출에 대한 검토 1건(feedback_items 포함)
-- 아래 :student_a / :student_b 를 실제 auth.users UUID로 바꿔 실행:
--   psql "$BRANCH_DB_URL" -v student_a='<uuid>' -v student_b='<uuid>' -f supabase/tests/rls_checks.sql

begin;

-- ── 학생 A 세션 시뮬레이션 ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'student_a', 'role', 'authenticated')::text, true);

-- 1) A는 B의 제출을 볼 수 없어야 함
do $$
begin
  if exists (select 1 from public.submissions where student_id <> auth.uid()) then
    raise exception 'FAIL(1): 학생 A가 다른 학생의 제출을 볼 수 있음';
  end if;
  raise notice 'PASS(1): 제출 교차 접근 차단';
end $$;

-- 2) A는 B의 피드백을 볼 수 없어야 함
do $$
begin
  if exists (
    select 1 from public.feedback f
    join public.submissions s on s.id = f.submission_id
    where s.student_id <> auth.uid()
  ) then
    raise exception 'FAIL(2): 학생 A가 다른 학생의 피드백을 볼 수 있음';
  end if;
  raise notice 'PASS(2): 피드백 교차 접근 차단';
end $$;

-- 3) A는 B의 feedback_items를 볼 수 없어야 함 (RLS가 join 자체를 걸러 0건이어야 함)
do $$
declare cnt integer;
begin
  select count(*) into cnt from public.feedback_items;
  -- A 본인 항목이 없다는 전제(A는 검토받은 제출 없음)에서 0건이어야 함
  if cnt <> 0 then
    raise exception 'FAIL(3): 학생 A에게 feedback_items %건 노출', cnt;
  end if;
  raise notice 'PASS(3): feedback_items 교차 접근 차단';
end $$;

-- 4) 학생은 제출 상태를 직접 변경할 수 없어야 함 (UPDATE 정책·권한 부재 → 오류 또는 0행)
do $$
declare updated integer;
begin
  begin
    update public.submissions set status = 'completed' where true;
    get diagnostics updated = row_count;
    if updated > 0 then
      raise exception 'FAIL(4): 학생이 제출 상태를 %건 변경함', updated;
    end if;
    raise notice 'PASS(4): 상태 변경 0행 (정책 없음)';
  exception when insufficient_privilege then
    raise notice 'PASS(4): 상태 변경 권한 거부';
  end;
end $$;

-- 5) 학생은 review_submission_v2를 실행할 수 없어야 함
do $$
begin
  begin
    perform public.review_submission_v2(gen_random_uuid(), '시도', 'completed', '[]'::jsonb);
    raise exception 'FAIL(5): 학생이 review_submission_v2 실행에 성공함';
  exception
    when others then
      if sqlerrm like '%admin required%' then
        raise notice 'PASS(5): admin required로 거부';
      else
        raise exception 'FAIL(5): 관리자 검사 외 오류로만 거부됨 (%)', sqlerrm;
      end if;
  end;
end $$;

-- 6) 학생은 review_events를 읽거나 쓸 수 없어야 함
do $$
declare cnt integer;
begin
  select count(*) into cnt from public.review_events;
  if cnt <> 0 then raise exception 'FAIL(6a): 학생에게 review_events 노출'; end if;
  begin
    insert into public.review_events (submission_id, event_type, actor_id)
    values (gen_random_uuid(), 'review_opened', auth.uid());
    raise exception 'FAIL(6b): 학생이 review_events에 기록함';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise notice 'PASS(6): review_events 접근 차단';
  end;
end $$;

-- 7) 학생은 feedback_items를 RPC 밖에서 직접 쓸 테이블 권한이 없어야 함
-- has_table_privilege는 RLS 이전의 GRANT 경계를 검증한다.
do $$
begin
  if has_table_privilege(current_user, 'public.feedback_items', 'INSERT')
     or has_table_privilege(current_user, 'public.feedback_items', 'UPDATE')
     or has_table_privilege(current_user, 'public.feedback_items', 'DELETE') then
    raise exception 'FAIL(7): authenticated 역할에 feedback_items 직접 쓰기 권한이 있음';
  end if;
  raise notice 'PASS(7): feedback_items 직접 쓰기 권한 없음';
end $$;

rollback;
-- 전부 PASS notice가 출력되고 rollback으로 종료되면 통과.
