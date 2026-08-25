-- 적용 경로: supabase/tests/answer_attachments_rls_checks.sql (신규)
-- 실행 대상: Supabase branch 또는 로컬 DB 전용. 운영 DB에서 실행 금지.
-- 사전 준비: 20260825000000_question_answer_attachments.sql 적용 +
--            합성 학생 2명(A, B) + 학생 A 소유 질문 1건 + 관리자 1명
-- 실행:
--   psql "$BRANCH_DB_URL" \
--     -v student_a='<uuid>' -v student_b='<uuid>' \
--     -v admin='<uuid>' -v question_a='<uuid>' \
--     -f supabase/tests/answer_attachments_rls_checks.sql
--
-- 전부 PASS notice 가 나오고 rollback 으로 끝나면 통과.

begin;

-- ── 준비: 답변과 첨부를 붙인다 (관리자 세션) ─────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);

-- RPC 가 파일 존재를 확인하므로 storage.objects 에 행을 먼저 넣는다.
-- (rollback 으로 사라진다. 실제 파일 업로드가 아니라 메타데이터 행만 만든다.)
reset role;
insert into storage.objects (bucket_id, name, owner, metadata)
values ('answer-files', :'question_a' || '/aaaa-shot.png', null, '{}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);

-- 1) 관리자가 첨부와 함께 답변할 수 있어야 한다
do $$
declare ok boolean; st text; files text[];
begin
  select public.answer_question(
    :'question_a'::uuid,
    '이렇게 풀어보세요.',
    array[:'question_a' || '/aaaa-shot.png']) into ok;
  select status::text, answer_file_paths into st, files
    from public.questions where id = :'question_a'::uuid;
  if st <> 'answered' then raise exception 'FAIL(1a): 상태가 answered 가 아님 (%)', st; end if;
  if coalesce(array_length(files,1),0) <> 1 then raise exception 'FAIL(1b): 첨부가 저장되지 않음'; end if;
  raise notice 'PASS(1): 관리자 첨부 답변 저장';
end $$;

-- 2) 글 없이 이미지만 보내는 답변은 거부되어야 한다
do $$
begin
  begin
    perform public.answer_question(:'question_a'::uuid, '   ',
      array[:'question_a' || '/aaaa-shot.png']);
    raise exception 'FAIL(2): 빈 답변이 통과함';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm like '%empty answer%' then raise notice 'PASS(2): 글 없는 답변 거부';
    else raise exception 'FAIL(2): 다른 이유로 거부됨 (%)', sqlerrm; end if;
  end;
end $$;

-- 3) 4장 이상은 거부되어야 한다
do $$
declare many text[];
begin
  select array_agg(:'question_a' || '/f' || i || '.png') into many from generate_series(1,4) i;
  begin
    perform public.answer_question(:'question_a'::uuid, '답변', many);
    raise exception 'FAIL(3): 4장이 통과함';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm like '%too many answer files%' then raise notice 'PASS(3): 3장 상한 동작';
    else raise exception 'FAIL(3): 다른 이유로 거부됨 (%)', sqlerrm; end if;
  end;
end $$;

-- 4) 다른 질문 id 로 시작하는 경로는 거부되어야 한다
do $$
begin
  begin
    perform public.answer_question(:'question_a'::uuid, '답변',
      array['00000000-0000-0000-0000-000000000000/x.png']);
    raise exception 'FAIL(4): 남의 경로가 통과함';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm like '%invalid answer file%' then raise notice 'PASS(4): 경로 형식 검증 동작';
    else raise exception 'FAIL(4): 다른 이유로 거부됨 (%)', sqlerrm; end if;
  end;
end $$;

-- 5) Storage 에 없는 파일을 가리키면 거부되어야 한다
do $$
begin
  begin
    perform public.answer_question(:'question_a'::uuid, '답변',
      array[:'question_a' || '/does-not-exist.png']);
    raise exception 'FAIL(5): 없는 파일이 통과함';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm like '%answer file missing%' then raise notice 'PASS(5): 파일 존재 검증 동작';
    else raise exception 'FAIL(5): 다른 이유로 거부됨 (%)', sqlerrm; end if;
  end;
end $$;

-- 6) 관리자는 자기 답변 파일을 읽을 수 있어야 한다
do $$
declare visible integer;
begin
  select count(*) into visible from storage.objects
   where bucket_id='answer-files' and name = :'question_a' || '/aaaa-shot.png';
  if visible <> 1 then raise exception 'FAIL(6): 관리자에게 답변 파일이 안 보임'; end if;
  raise notice 'PASS(6): 관리자 읽기';
end $$;

-- ── 질문한 학생 A 세션 ───────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', :'student_a', 'role', 'authenticated')::text, true);

-- 7) 자기 질문에 붙은 답변 파일은 읽을 수 있어야 한다
do $$
declare visible integer;
begin
  select count(*) into visible from storage.objects
   where bucket_id='answer-files' and name = :'question_a' || '/aaaa-shot.png';
  if visible <> 1 then raise exception 'FAIL(7): 질문한 학생이 답변 파일을 못 읽음'; end if;
  raise notice 'PASS(7): 질문자 읽기';
end $$;

-- 8) 경로 첫 칸은 자기 질문이지만 answer_file_paths 에 없는 파일은 못 읽어야 한다
--    (관리자가 올렸다가 답변을 보내지 않고 그만둔 파일)
do $$
declare visible integer;
begin
  select count(*) into visible from storage.objects
   where bucket_id='answer-files' and name = :'question_a' || '/orphan.png';
  if visible <> 0 then raise exception 'FAIL(8): 배열에 없는 파일이 %건 노출', visible; end if;
  raise notice 'PASS(8): 배열 소속 검사 동작 (고아 파일 차단)';
end $$;

-- 9) 학생은 답변 파일을 올릴 수 없어야 한다
do $$
begin
  begin
    insert into storage.objects (bucket_id, name, owner, metadata)
    values ('answer-files', :'question_a' || '/student-upload.png', auth.uid(), '{}'::jsonb);
    raise exception 'FAIL(9): 학생이 답변 파일을 올림';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS(9): 학생 업로드 거부 (%)', sqlerrm;
  end;
end $$;

-- 10) 학생은 답변 파일을 지울 수 없어야 한다
do $$
declare affected integer;
begin
  begin
    delete from storage.objects
     where bucket_id='answer-files' and name = :'question_a' || '/aaaa-shot.png';
    get diagnostics affected = row_count;
    if affected > 0 then raise exception 'FAIL(10): 학생이 답변 파일을 %건 삭제함', affected; end if;
    raise notice 'PASS(10): 학생 삭제 0행';
  exception when insufficient_privilege then
    raise notice 'PASS(10): 학생 삭제 권한 거부';
  end;
end $$;

-- 11) 학생은 questions 를 직접 수정할 수 없어야 한다 (기존 규칙 유지)
do $$
declare affected integer;
begin
  begin
    update public.questions set answer_file_paths = '{}'::text[]
     where id = :'question_a'::uuid;
    get diagnostics affected = row_count;
    if affected > 0 then raise exception 'FAIL(11): 학생이 첨부를 %건 수정함', affected; end if;
    raise notice 'PASS(11): 학생 직접 UPDATE 0행';
  exception when insufficient_privilege then
    raise notice 'PASS(11): 학생 직접 UPDATE 권한 거부';
  end;
end $$;

-- ── 다른 학생 B 세션 ─────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', :'student_b', 'role', 'authenticated')::text, true);

-- 12) 남의 질문 답변 파일은 못 읽어야 한다
do $$
declare visible integer;
begin
  select count(*) into visible from storage.objects where bucket_id='answer-files';
  if visible <> 0 then raise exception 'FAIL(12): 다른 학생에게 답변 파일 %건 노출', visible; end if;
  raise notice 'PASS(12): 교차 접근 차단';
end $$;

-- 13) 다른 학생이 answer_question 을 부를 수 없어야 한다
do $$
begin
  begin
    perform public.answer_question(:'question_a'::uuid, '학생이 쓴 답');
    raise exception 'FAIL(13): 학생이 answer_question 실행에 성공함';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm like '%admin required%' then raise notice 'PASS(13): admin required 로 거부';
    else raise exception 'FAIL(13): 관리자 검사 외 오류 (%)', sqlerrm; end if;
  end;
end $$;

-- ── 비로그인(anon) ───────────────────────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

-- 14) anon 은 답변 파일을 못 읽어야 한다
do $$
declare visible integer;
begin
  begin
    select count(*) into visible from storage.objects where bucket_id='answer-files';
    if visible <> 0 then raise exception 'FAIL(14): anon 에게 답변 파일 %건 노출', visible; end if;
    raise notice 'PASS(14): anon 읽기 0건';
  exception when insufficient_privilege then
    raise notice 'PASS(14): anon 읽기 권한 거부';
  end;
end $$;

-- 15) anon 은 answer_question 을 부를 수 없어야 한다 (GRANT 단계에서 막힘)
do $$
begin
  begin
    perform public.answer_question(:'question_a'::uuid, '답변');
    raise exception 'FAIL(15): anon 이 RPC 를 실행함';
  exception when insufficient_privilege then
    raise notice 'PASS(15): anon RPC 권한 거부';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS(15): anon RPC 거부 (%)', sqlerrm;
  end;
end $$;

rollback;
-- 전부 PASS notice 가 출력되고 rollback 으로 종료되면 통과.
