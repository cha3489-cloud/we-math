-- 적용 경로: supabase/migrations/20260829000000_review_internal_notes.sql (신규)
--
-- 고친 문제:
--   feedback.body 와 feedback_items.comment 는 학생이 그대로 읽는다.
--     20260724000000: "students read own feedback" (feedback SELECT)
--     20260726000000: "feedback items readable by owner or admin" (feedback_items SELECT)
--   원장이 "집중력 문제", "학부모 상담 필요", "난이도 낮춰야 함" 같은 내부 판단을
--   여기에 쓰면 학생 화면에 그대로 노출된다. 내부 판단을 적을 자리가 아예 없어서
--   운영자가 실수할 수밖에 없는 구조였다.
--
-- 왜 컬럼 추가가 아니라 별도 테이블인가:
--   브라우저에서 학생과 관리자는 **같은 authenticated 롤**을 쓴다. PostgreSQL 의
--   컬럼 권한은 롤 단위이므로, feedback 에 internal_note 컬럼을 붙이면 학생과
--   관리자를 컬럼 권한으로 나눌 수 없다. RLS 는 행 단위라 컬럼을 숨기지 못한다.
--   남는 방법은 "학생이 읽는 테이블에는 내부 컬럼을 두지 않는 것"뿐이다.
--
--   같은 프로젝트에 이미 선례가 있다. review_events 는 authenticated 에 SELECT 를
--   주되 RLS 를 is_admin() 으로 걸어 학생에게 0행을 준다(20260726000000).
--   2026-08-29 운영 확인: review_events 13행이 있는 상태에서 학생 세션은 0행,
--   관리자 세션은 전체를 본다. 같은 패턴을 그대로 쓴다.
--
-- 왜 feedback_id 가 아니라 submission_id 를 키로 쓰는가:
--   feedback 은 검토를 확정해야 생긴다. 그런데 내부 메모는 검토 확정 전에,
--   또는 끝내 확정하지 않는 제출에도 남길 수 있어야 한다. submission 은 제출
--   시점에 이미 존재하고 attempt 단위로 나뉘므로 회차별 메모도 자연스럽다.
--   feedback.submission_id 가 unique 라 정보 손실도 없다.
--
-- 범위 밖 (의도적으로 넣지 않는다):
--   * 학부모용 문안, 학부모 발송 승인 게이트, 원장 최종 판단 기록 → Notion 소관.
--     Supabase 는 학생 대면 기능(과제·제출·질문·재풀이·선생님 피드백)에 한정한다.
--   * 문항 단위 내부 메모(feedback_items.internal_note) → 제출 단위 하나로 시작한다.
--     운영 데이터가 문항 단위 필요를 보여주면 그때 별도 마이그레이션으로 추가한다.
--   * 변경 이력 테이블 → 내부 메모는 결정 기록이 아니라 작업 메모다.
--     결정의 감사 기록은 review_events 가 이미 불변으로 남긴다.
--   * review_submission_v2 수정 → provenance 문제로 이미 민감하다. 손대지 않는다.
--
-- 기존 데이터: 손대지 않는다. feedback / feedback_items 의 행을 읽지도 쓰지도 않는다.
--
-- 재실행 안전성: create table if not exists / 조건부 정책·제약 / create or replace.

-- ── 0) 학생 노출 필드의 의미를 스키마에 못박는다 ─────────────────────────
-- 컬럼 코멘트는 데이터를 바꾸지 않는다. 다음 사람이 여기에 내부 판단을 쓰지
-- 않도록 남기는 경고다.
comment on column public.feedback.body is
  'STUDENT-VISIBLE. 학생이 읽는 총평. 내부 판단은 public.review_internal_notes 에 쓴다.';
comment on column public.feedback_items.comment is
  'STUDENT-VISIBLE. 학생이 읽는 문항별 코멘트. 내부 판단은 public.review_internal_notes 에 쓴다.';

-- ── 1) 내부 메모 테이블 ──────────────────────────────────────────────────
create table if not exists public.review_internal_notes (
  submission_id uuid primary key references public.submissions(id) on delete cascade,
  author_id     uuid not null references public.profiles(id),
  note          text not null check (char_length(note) between 1 and 2000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.review_internal_notes is
  'ADMIN-ONLY. 학생에게 보이지 않는 운영 메모. 학부모용 문안은 여기가 아니라 Notion 소관.';

alter table public.review_internal_notes enable row level security;

-- 학생은 0행을 받는다. review_events 와 동일한 패턴.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'review_internal_notes'
      and policyname = 'admins read internal notes'
  ) then
    create policy "admins read internal notes" on public.review_internal_notes
      for select to authenticated using (public.is_admin());
  end if;
end $$;
-- INSERT/UPDATE/DELETE 정책 없음: 쓰기는 아래 security definer RPC 안에서만 일어난다.

-- ── 2) 권한 ──────────────────────────────────────────────────────────────
-- Supabase 는 public 스키마 새 테이블에 anon/authenticated ALL 을 기본 부여한다.
-- 20260828000000 과 같은 이유로 먼저 전부 회수한 뒤 필요한 것만 준다.
revoke all on table public.review_internal_notes from public, anon, authenticated;
grant select on table public.review_internal_notes to authenticated;

-- ── 3) 쓰기 RPC ──────────────────────────────────────────────────────────
-- 빈 문자열은 행을 만들지 않고 기존 행을 지운다. 원장이 메모를 비우는 유일한 경로다.
-- review_submission_v2 와 분리한다. 내부 메모는 검토 확정과 수명주기가 다르고,
-- 오버로드를 늘리면 provenance 때와 같은 문제를 반복하게 된다.
create or replace function public.upsert_review_internal_note(
  p_submission_id uuid,
  p_note text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_note text := trim(coalesce(p_note, ''));
begin
  if not public.is_admin() then raise exception 'admin required'; end if;
  if not exists (select 1 from public.submissions s where s.id = p_submission_id) then
    raise exception 'submission not found';
  end if;
  if char_length(v_note) > 2000 then raise exception 'internal note too long'; end if;

  if v_note = '' then
    delete from public.review_internal_notes where submission_id = p_submission_id;
    return;
  end if;

  insert into public.review_internal_notes (submission_id, author_id, note)
  values (p_submission_id, auth.uid(), v_note)
  on conflict (submission_id) do update
    set note = excluded.note, author_id = excluded.author_id, updated_at = now();
end;
$$;

revoke all on function public.upsert_review_internal_note(uuid, text) from public, anon;
grant execute on function public.upsert_review_internal_note(uuid, text) to authenticated;

-- ── 4) 결과 확인 ─────────────────────────────────────────────────────────
do $$
begin
  if has_table_privilege('authenticated', 'public.review_internal_notes', 'INSERT')
     or has_table_privilege('authenticated', 'public.review_internal_notes', 'UPDATE')
     or has_table_privilege('authenticated', 'public.review_internal_notes', 'DELETE')
     or has_table_privilege('authenticated', 'public.review_internal_notes', 'TRUNCATE') then
    raise exception 'review_internal_notes: authenticated 에 직접 쓰기 권한이 있다. RPC 경계가 무너진다.';
  end if;
  if has_table_privilege('anon', 'public.review_internal_notes', 'SELECT') then
    raise exception 'review_internal_notes: anon 이 읽을 수 있다.';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'review_internal_notes' and cmd <> 'SELECT'
  ) then
    raise exception 'review_internal_notes: SELECT 외의 정책이 있다. 쓰기는 RPC 로만 해야 한다.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.review_internal_notes'::regclass) then
    raise exception 'review_internal_notes: RLS 가 꺼져 있다.';
  end if;
end $$;
