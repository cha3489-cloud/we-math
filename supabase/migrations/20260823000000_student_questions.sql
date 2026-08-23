-- 적용 경로: supabase/migrations/20260823000000_student_questions.sql (신규)
-- 목적: 사진 제출과 독립적인 학생 질문 기능.
--
-- 왜 submissions 를 쓰지 않는가:
--   prepare_submission_attempt() 는 insert 마다 attempt_no 를 올리고 status 를 'submitted' 로
--   고정한다. 질문을 submissions 에 넣으면 그 과제가 잠겨서, 선생님이 "질문"을 검토 완료할
--   때까지 학생이 실제 풀이 사진을 낼 수 없다. 실측으로 확인했다(docs/20).
--   그래서 질문은 별도 테이블로 두고 attempt 체인을 건드리지 않는다.
--
-- 이 마이그레이션은 기존 테이블·정책·함수를 하나도 수정하지 않는다. 추가만 한다.

-- ── 상태값 ───────────────────────────────────────────────────────────────
-- submission_status 와 같은 방식(enum)으로 둔다. 상태는 거의 바뀌지 않기 때문이다.
create type public.question_status as enum ('open', 'answered', 'closed');

-- ── 테이블 ───────────────────────────────────────────────────────────────
create table public.questions (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,

  -- nullable 인 이유:
  --  1) "개념이 기억나지 않아요" 처럼 특정 과제에 매이지 않는 질문이 있다.
  --  2) on delete set null 이라, 과제가 지워져도 질문과 답변 이력이 남는다.
  --     not null + cascade 로 두면 과제 정리 한 번에 상담 근거가 사라진다.
  --  실제 화면은 과제 상세에서 들어가므로 대부분 값이 채워진다.
  assignment_id uuid references public.assignments(id) on delete set null,

  -- enum 이 아니라 check 로 둔 이유: 보기 문구는 운영하면서 다듬을 가능성이 높다.
  -- check 는 제약 교체 한 줄로 바꿀 수 있지만 enum 은 값 제거가 번거롭다.
  category      text not null,
  body          text not null,
  status        public.question_status not null default 'open',

  created_at    timestamptz not null default now(),
  answered_at   timestamptz,
  answered_by   uuid references public.profiles(id),
  answer_body   text,
  closed_at     timestamptz,

  constraint questions_category_check check (category in (
    '문제를 읽고 뭘 해야 할지 모르겠어요',
    '식을 어떻게 세울지 모르겠어요',
    '계산하다가 막혔어요',
    '개념이 기억나지 않아요',
    '풀이 중간에서 막혔어요',
    '기타'
  )),
  constraint questions_body_check check (btrim(body) <> ''),
  constraint questions_body_length_check check (char_length(body) <= 1000),
  constraint questions_answer_check check (
    (status = 'answered') = (answered_at is not null and answered_by is not null and btrim(coalesce(answer_body, '')) <> '')
  )
);

-- 관리자 대기열: status='open' 을 오래된 순으로 훑는다.
create index questions_status_created_idx on public.questions(status, created_at);
-- 학생 화면: 자기 질문을 최신순으로.
create index questions_student_created_idx on public.questions(student_id, created_at desc);

alter table public.questions enable row level security;

-- ── 입력 검증 트리거 ─────────────────────────────────────────────────────
-- 클라이언트가 무엇을 보내든 소유권·상태·개수는 서버가 정한다.
create or replace function public.prepare_question()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare open_count integer;
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'invalid student';
  end if;

  -- 남의 이름으로 쓰려는 시도는 조용히 고치지 않고 거부한다. submissions 와 같은 태도다.
  if new.student_id is distinct from auth.uid() then
    raise exception 'invalid student';
  end if;

  -- 과제를 지정했다면 본인에게 배정된 과제여야 한다.
  if new.assignment_id is not null and not exists (
    select 1 from public.assignments a
    where a.id = new.assignment_id and a.student_id = auth.uid()
  ) then
    raise exception 'assignment not owned';
  end if;

  new.body := btrim(new.body);
  if new.body = '' then raise exception 'empty question'; end if;

  -- 상태 계열은 전부 서버가 정한다.
  new.status := 'open';
  new.answered_at := null;
  new.answered_by := null;
  new.answer_body := null;
  new.closed_at := null;
  new.created_at := now();

  -- 도배 방지. 답을 기다리는 질문이 쌓이면 더 받지 않는다.
  select count(*) into open_count
  from public.questions
  where student_id = auth.uid() and status = 'open';
  if open_count >= 10 then raise exception 'too many open questions'; end if;

  return new;
end;
$$;

create trigger questions_prepare
  before insert on public.questions
  for each row execute function public.prepare_question();

-- ── RLS ──────────────────────────────────────────────────────────────────
-- 학생은 자기 질문만 읽는다. 정지된 계정은 자기 것도 못 읽는다.
create policy "students read own questions" on public.questions
  for select to authenticated
  using ((student_id = auth.uid() and public.is_active_user()) or public.is_admin());

-- 학생은 자기 이름으로만 쓴다. 상태 위조는 트리거가 다시 막는다.
create policy "students ask questions" on public.questions
  for insert to authenticated
  with check (public.is_active_user() and student_id = auth.uid() and status = 'open');

-- UPDATE / DELETE 정책은 만들지 않는다.
-- 정책이 없으면 거부가 기본이므로, 학생도 관리자도 직접 수정할 수 없다.
-- 답변과 상태 전이는 아래 RPC 로만 한다.

-- ── 권한 ─────────────────────────────────────────────────────────────────
grant usage on type public.question_status to authenticated;
grant select, insert on table public.questions to authenticated;
-- update/delete 는 주지 않는다.
revoke all on table public.questions from anon;

-- ── 답변 RPC ─────────────────────────────────────────────────────────────
create or replace function public.answer_question(p_question_id uuid, p_answer_body text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare clean text;
begin
  if not public.is_admin() then raise exception 'admin required'; end if;
  clean := btrim(coalesce(p_answer_body, ''));
  if clean = '' then raise exception 'empty answer'; end if;
  if char_length(clean) > 4000 then raise exception 'answer too long'; end if;

  update public.questions
     set status = 'answered',
         answer_body = clean,
         answered_by = auth.uid(),
         answered_at = now()
   where id = p_question_id and status <> 'closed';

  if not found then raise exception 'question not open'; end if;
  return true;
end;
$$;

-- 답변 없이 정리만 할 때 쓴다. (중복 질문, 대면으로 이미 해결한 질문 등)
create or replace function public.close_question(p_question_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin required'; end if;
  update public.questions
     set status = 'closed', closed_at = now()
   where id = p_question_id and status <> 'closed';
  if not found then raise exception 'question not open'; end if;
  return true;
end;
$$;

-- 함수 안에서 is_admin() 을 확인하므로 authenticated 에게 실행 권한을 준다.
grant execute on function public.answer_question(uuid, text) to authenticated;
grant execute on function public.close_question(uuid) to authenticated;
revoke execute on function public.answer_question(uuid, text) from anon;
revoke execute on function public.close_question(uuid) from anon;
