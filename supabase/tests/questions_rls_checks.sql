-- 적용 경로: supabase/tests/questions_rls_checks.sql (신규)
-- 실행 대상: Supabase branch 또는 로컬 DB 전용. 운영 DB에서 실행 금지.
-- 사전 준비(브랜치에서): 합성 학생 2명 + 학생A 소유 과제 1건 + 관리자 1명
-- 실행:
--   psql "$BRANCH_DB_URL" \
--     -v student_a='<uuid>' -v student_b='<uuid>' \
--     -v admin='<uuid>' -v assignment_a='<uuid>' -f supabase/tests/questions_rls_checks.sql
--
-- 전부 PASS notice 가 나오고 rollback 으로 끝나면 통과.

begin;

-- ── 학생 A 세션 ──────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'student_a', 'role', 'authenticated')::text, true);

-- 1) 자기 질문은 넣을 수 있어야 한다
do $$
declare new_id uuid; new_status text;
begin
  insert into public.questions (student_id, assignment_id, category, body)
  values (auth.uid(), null, '기타', '  테스트 질문입니다.  ')
  returning id into new_id;
  select status::text into new_status from public.questions where id = new_id;
  if new_status <> 'open' then raise exception 'FAIL(1a): 상태가 open 이 아님 (%)', new_status; end if;
  if (select body from public.questions where id = new_id) <> '테스트 질문입니다.' then
    raise exception 'FAIL(1b): body 가 trim 되지 않음';
  end if;
  raise notice 'PASS(1): 자기 질문 insert · 상태 open · body trim';
end $$;

-- 2) student_id 를 남으로 위조하면 거부되어야 한다
do $$
begin
  begin
    insert into public.questions (student_id, category, body)
    values (:'student_b'::uuid, '기타', '위조 시도');
    raise exception 'FAIL(2): 남의 이름으로 질문이 등록됨';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS(2): student_id 위조 거부 (%)', sqlerrm;
  end;
end $$;

-- 3) 남의 과제에는 질문을 달 수 없어야 한다
do $$
declare other_assignment uuid;
begin
  select id into other_assignment from public.assignments where student_id <> auth.uid() limit 1;
  if other_assignment is null then raise notice 'SKIP(3): 다른 학생 과제가 없음'; return; end if;
  begin
    insert into public.questions (student_id, assignment_id, category, body)
    values (auth.uid(), other_assignment, '기타', '남의 과제 질문');
    raise exception 'FAIL(3): 남의 과제에 질문이 달림';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS(3): assignment not owned 거부';
  end;
end $$;

-- 4) 빈 질문은 거부되어야 한다
do $$
begin
  begin
    insert into public.questions (student_id, category, body) values (auth.uid(), '기타', '    ');
    raise exception 'FAIL(4): 빈 질문이 등록됨';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS(4): 빈 질문 거부';
  end;
end $$;

-- 5) 허용되지 않은 category 는 거부되어야 한다
do $$
begin
  begin
    insert into public.questions (student_id, category, body) values (auth.uid(), '아무거나', '내용');
    raise exception 'FAIL(5): 허용되지 않은 category 가 통과함';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS(5): category allowlist 동작';
  end;
end $$;

-- 6) 학생은 자기 질문을 수정하거나 지울 수 없어야 한다
do $$
declare affected integer;
begin
  begin
    update public.questions set body = '수정 시도' where student_id = auth.uid();
    get diagnostics affected = row_count;
    if affected > 0 then raise exception 'FAIL(6a): 학생이 질문을 %건 수정함', affected; end if;
    raise notice 'PASS(6a): 수정 0행';
  exception when insufficient_privilege then
    raise notice 'PASS(6a): 수정 권한 거부';
  end;
  begin
    delete from public.questions where student_id = auth.uid();
    get diagnostics affected = row_count;
    if affected > 0 then raise exception 'FAIL(6b): 학생이 질문을 %건 삭제함', affected; end if;
    raise notice 'PASS(6b): 삭제 0행';
  exception when insufficient_privilege then
    raise notice 'PASS(6b): 삭제 권한 거부';
  end;
end $$;

-- 7) 학생은 answer_question 을 실행할 수 없어야 한다
do $$
declare target uuid;
begin
  select id into target from public.questions where student_id = auth.uid() limit 1;
  begin
    perform public.answer_question(target, '학생이 쓴 답');
    raise exception 'FAIL(7): 학생이 answer_question 실행에 성공함';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm like '%admin required%' then raise notice 'PASS(7): admin required 로 거부';
    else raise exception 'FAIL(7): 관리자 검사 외 오류로 거부됨 (%)', sqlerrm; end if;
  end;
end $$;

-- 8) 미답변 10건 상한
do $$
declare i integer; blocked boolean := false;
begin
  for i in 1..15 loop
    begin
      insert into public.questions (student_id, category, body)
      values (auth.uid(), '기타', '상한 테스트 ' || i);
    exception when others then
      if sqlerrm like '%too many open questions%' then blocked := true; exit;
      else raise; end if;
    end;
  end loop;
  if not blocked then raise exception 'FAIL(8): 10건 상한이 동작하지 않음'; end if;
  raise notice 'PASS(8): 미답변 10건 상한 동작';
end $$;

-- ── 학생 B 세션: 교차 접근 ───────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', :'student_b', 'role', 'authenticated')::text, true);

do $$
declare visible integer;
begin
  select count(*) into visible from public.questions where student_id <> auth.uid();
  if visible <> 0 then raise exception 'FAIL(9): 학생 B 에게 남의 질문 %건 노출', visible; end if;
  raise notice 'PASS(9): 질문 교차 접근 차단';
end $$;

-- ── 관리자 세션 ──────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);

do $$
declare visible integer; target uuid; final_status text;
begin
  select count(*) into visible from public.questions;
  if visible = 0 then raise exception 'FAIL(10): 관리자에게 질문이 하나도 안 보임'; end if;
  raise notice 'PASS(10): 관리자 전체 조회 %건', visible;

  select id into target from public.questions where status = 'open' limit 1;
  perform public.answer_question(target, '이렇게 풀어보세요.');
  select status::text into final_status from public.questions where id = target;
  if final_status <> 'answered' then raise exception 'FAIL(11a): 상태가 answered 가 아님 (%)', final_status; end if;
  if (select answered_by from public.questions where id = target) is null then
    raise exception 'FAIL(11b): answered_by 가 비어 있음';
  end if;
  if (select answered_at from public.questions where id = target) is null then
    raise exception 'FAIL(11c): answered_at 가 비어 있음';
  end if;
  raise notice 'PASS(11): 관리자 answer_question 동작';
end $$;

-- 12) 관리자도 직접 UPDATE 는 못 한다 (RPC 경유만 허용)
do $$
declare affected integer;
begin
  begin
    update public.questions set status = 'closed' where true;
    get diagnostics affected = row_count;
    if affected > 0 then raise exception 'FAIL(12): 관리자가 직접 UPDATE 로 %건 변경함', affected; end if;
    raise notice 'PASS(12): 직접 UPDATE 0행';
  exception when insufficient_privilege then
    raise notice 'PASS(12): 직접 UPDATE 권한 거부';
  end;
end $$;

-- ── 비로그인(anon) ───────────────────────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

do $$
declare visible integer;
begin
  begin
    select count(*) into visible from public.questions;
    if visible <> 0 then raise exception 'FAIL(13): anon 에게 질문 %건 노출', visible; end if;
    raise notice 'PASS(13): anon 조회 0건';
  exception when insufficient_privilege then
    raise notice 'PASS(13): anon 조회 권한 거부';
  end;
end $$;

rollback;
-- 전부 PASS notice 가 출력되고 rollback 으로 종료되면 통과.
