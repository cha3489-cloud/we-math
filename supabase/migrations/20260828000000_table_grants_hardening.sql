-- 적용 경로: supabase/migrations/20260828000000_table_grants_hardening.sql (신규)
--
-- 왜 필요한가:
--   Supabase 는 public 스키마의 새 테이블에 anon/authenticated 에게 ALL 을 기본
--   부여한다(ALTER DEFAULT PRIVILEGES). 그래서 아래 두 테이블에 설계하지 않은
--   권한이 남아 있었다.
--
--   1) public.profiles
--      20260724000000 은 `revoke insert, update, delete` 만 했다. 그 결과
--      TRUNCATE / TRIGGER / REFERENCES / MAINTAIN 이 authenticated 에 남았다.
--      TRUNCATE 는 RLS 정책의 적용을 받지 않으므로, 정책이 아무리 촘촘해도
--      막아주지 못한다.
--
--   2) public.withdrawn_phones
--      20260711190000 은 함수 권한만 정리하고 테이블 권한은 한 번도 정리하지
--      않았다. anon / authenticated 가 ALL(TRUNCATE 포함)을 갖고 있었다.
--      RLS 정책이 0개라 행 단위 조회·수정은 이미 막혀 있었지만 TRUNCATE 는
--      뚫려 있었다.
--
--      이 테이블은 delete_own_account() 와 is_withdrawn_phone(text) 두
--      security definer 함수로만 접근한다. 두 함수는 정의자 권한으로 실행되므로
--      호출자 롤의 테이블 권한을 필요로 하지 않는다. 따라서 API 롤에는
--      아무 권한도 남기지 않는다.
--
--   기존 마이그레이션(20260724000000, 20260823010000)이 쓰는
--   "revoke 먼저, grant 나중" 순서를 그대로 따른다.
--   운영 DB 에는 2026-08-28 에 같은 내용을 이미 적용했다.
--
-- 범위 밖 (의도적으로 건드리지 않는다):
--   * public.assignments
--     20260726010000 이 세운 컬럼 단위 update 경계
--     (title, description, due_at, attachment_paths, updated_at)를 유지한다.
--     테이블 전체 update 를 다시 부여하면 student_id / created_by 가 함께 열려
--     과제 소유권이 사후 변경 가능해진다.
--   * ALTER DEFAULT PRIVILEGES
--     신규 테이블이 anon 전권을 갖고 생성되는 근본 원인이지만, 바꾸면 이후
--     모든 마이그레이션에서 grant 를 명시해야 한다. 별도 후속 작업으로 분리한다.
--
-- 재실행 안전성:
--   revoke / grant 는 멱등이다. 스키마·정책·함수·데이터를 전혀 바꾸지 않으므로
--   이미 적용된 DB 에 다시 실행해도 결과가 같다.

-- ── public.profiles: authenticated 는 select 만 남긴다 ────────────────────
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
grant select on table public.profiles to authenticated;

-- ── public.withdrawn_phones: API 롤에는 아무 권한도 남기지 않는다 ─────────
revoke all on table public.withdrawn_phones from anon;
revoke all on table public.withdrawn_phones from authenticated;
-- grant 없음. 접근 경로는 security definer 함수뿐이다.

-- ── 회귀 방지 확인 ───────────────────────────────────────────────────────
-- 이 마이그레이션이 의도한 상태가 실제로 섰는지, 그리고 assignments 의 컬럼
-- 단위 경계가 유지되는지 확인한다. has_table_privilege 는 테이블 단위 권한만
-- 본다(컬럼 단위 grant 는 has_column_privilege 로 따로 확인한다).
do $$
begin
  -- profiles
  if not has_table_privilege('authenticated', 'public.profiles', 'SELECT') then
    raise exception 'profiles: authenticated 의 SELECT 권한이 사라졌다. 학생 프로필 조회가 깨진다.';
  end if;
  if has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE') then
    raise exception 'profiles: authenticated 에 TRUNCATE 가 남아 있다. TRUNCATE 는 RLS 적용을 받지 않는다.';
  end if;

  -- withdrawn_phones
  if has_any_column_privilege('anon', 'public.withdrawn_phones', 'SELECT, INSERT, UPDATE, REFERENCES')
     or has_table_privilege('anon', 'public.withdrawn_phones', 'DELETE, TRUNCATE, TRIGGER') then
    raise exception 'withdrawn_phones: anon 에 권한이 남아 있다.';
  end if;
  if has_any_column_privilege('authenticated', 'public.withdrawn_phones', 'SELECT, INSERT, UPDATE, REFERENCES')
     or has_table_privilege('authenticated', 'public.withdrawn_phones', 'DELETE, TRUNCATE, TRIGGER') then
    raise exception 'withdrawn_phones: authenticated 에 권한이 남아 있다.';
  end if;

  -- assignments: 테이블 전체 update 가 다시 생기면 소유권 컬럼이 열린다.
  if has_table_privilege('authenticated', 'public.assignments', 'UPDATE') then
    raise exception 'assignments: 테이블 단위 UPDATE 가 부여되어 있다. 20260726010000 의 컬럼 단위 경계가 깨졌다.';
  end if;

  -- assignments: 원장이 과제를 수정할 수 있어야 한다. 이 마이그레이션이 만드는
  -- 상태가 아니라 20260726010000 이 만드는 상태이므로 경고로만 남긴다.
  if not has_column_privilege('authenticated', 'public.assignments', 'title', 'UPDATE') then
    raise warning 'assignments: 컬럼 단위 UPDATE 권한이 없다. 20260726010000 적용 여부를 확인할 것.';
  end if;
end $$;
