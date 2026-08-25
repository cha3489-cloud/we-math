-- 적용 경로: supabase/migrations/20260825010000_answer_file_paths_valid_search_path.sql (신규)
--
-- 왜 필요한가:
--   20260825000000 에서 answer_file_paths_valid 를 만들 때 search_path 를 지정하지
--   않았다. 이 저장소의 다른 함수는 전부 지정하는데 이 함수만 빠졌고,
--   Supabase advisor 가 function_search_path_mutable (WARN) 으로 잡았다(docs/34).
--
--   실질 위험은 낮다. 이 함수는 SECURITY INVOKER 라 권한 상승 경로가 아니고,
--   본문이 쓰는 것은 unnest·bool_and·coalesce·연산자뿐이라 전부 pg_catalog 에 있다.
--   그래도 표준에서 벗어난 상태이고 린터가 계속 잡으므로 맞춘다.
--
-- 왜 '' 인가:
--   이 함수는 public 스키마의 객체를 하나도 쓰지 않는다. pg_catalog 은 search_path 에
--   적지 않아도 항상 먼저 검색되므로, 빈 문자열로 두는 쪽이 더 좁고 안전하다.
--   저장소의 review_submission_v2 도 같은 이유로 '' 를 쓴다.
--
-- 이 마이그레이션은 기존 파일을 하나도 수정하지 않는다. 함수 본문도 그대로다.
-- 20260825000000 은 이미 운영에 적용됐으므로 손대지 않는다(append-only).

-- 본문은 20260825000000 과 글자 그대로 같다. search_path 절만 더한다.
-- create or replace 이므로 기존 권한(ACL)은 유지되지만, 아래에서 다시 못박는다.
create or replace function public.answer_file_paths_valid(p_question_id uuid, p_paths text[])
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    bool_and(p is not null and p ~ ('^' || p_question_id::text || '/[^/]+$')),
    true)
  from unnest(coalesce(p_paths, '{}'::text[])) as p;
$fn$;

-- CHECK 제약이 INSERT 마다 이 함수를 부른다. authenticated 가 실행할 수 없으면
-- 학생이 질문을 등록하지 못한다. 순서는 revoke 먼저, grant 나중.
revoke all on function public.answer_file_paths_valid(uuid, text[]) from public, anon;
grant execute on function public.answer_file_paths_valid(uuid, text[]) to authenticated;

-- answer_question / close_question / questions 정책·제약·컬럼은 건드리지 않는다.
