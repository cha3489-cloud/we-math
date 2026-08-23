-- 적용 경로: supabase/migrations/20260823010000_questions_grants_hardening.sql (신규)
--
-- 왜 필요한가:
--   20260823000000 은 grant 만 하고 revoke 를 하지 않았다. 그런데 Supabase 는
--     * public 스키마의 새 테이블에 authenticated/anon 에게 ALL 을
--     * 새 함수에 PUBLIC 에게 EXECUTE 를
--   기본으로 부여한다. 그래서 grant select, insert 를 해도 UPDATE/DELETE 가 남았고,
--   anon 도 RPC 를 호출할 수 있는 상태였다.
--
--   RLS 가 행을 막고 RPC 가 is_admin() 을 확인하므로 데이터가 새지는 않았지만,
--   설계했던 "select, insert 만" 경계가 실제로는 서지 않았다.
--
--   기존 마이그레이션(20260724000000)이 쓰는 "revoke 먼저, grant 나중" 순서로 맞춘다.
--   운영 DB에는 2026-08-23 에 같은 내용을 이미 적용했다(docs/22).
--
-- 이 마이그레이션도 기존 테이블·정책·함수를 수정하지 않는다. questions 관련 권한만 정리한다.

-- ── 테이블 권한 ──────────────────────────────────────────────────────────
revoke all on table public.questions from anon;
revoke all on table public.questions from authenticated;

grant usage on type public.question_status to authenticated;
grant select, insert on table public.questions to authenticated;
-- update / delete 는 주지 않는다. 상태 변경은 아래 RPC 로만 한다.

-- ── 함수 권한 ────────────────────────────────────────────────────────────
-- 트리거 함수는 아무도 직접 호출할 필요가 없다.
revoke all on function public.prepare_question() from public, anon, authenticated;

-- RPC 는 authenticated 만 호출할 수 있고, 함수 안에서 is_admin() 을 다시 확인한다.
revoke all on function public.answer_question(uuid, text) from public, anon;
grant execute on function public.answer_question(uuid, text) to authenticated;

revoke all on function public.close_question(uuid) from public, anon;
grant execute on function public.close_question(uuid) to authenticated;
