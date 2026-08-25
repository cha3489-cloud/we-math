-- 적용 경로: supabase/migrations/20260825000000_question_answer_attachments.sql (신규)
-- 목적: 관리자가 질문 답변에 이미지·스크린샷을 첨부할 수 있게 한다.
--
-- 이 마이그레이션은 기존 마이그레이션 파일을 하나도 수정하지 않는다. 추가만 한다.
-- 20260823000000(questions) 과 20260823010000(권한 보정) 은 그대로 둔다.
--
-- 설계 근거는 docs/32. 요약하면:
--   * assignment-files 가 이미 "관리자가 올리고 배정된 학생만 읽는" 형태로 돌고 있다.
--     그 패턴을 questions 에 옮긴다. 새 보안 모델을 만들지 않는다.
--   * submission-files 는 재사용하지 않는다. 그 버킷에는
--     "students delete unsubmitted files" 정책이 있어서, 답변 이미지를 학생 폴더에 두면
--     학생이 선생님 답변 이미지를 지울 수 있다.
--
-- 결정사항(차저씨 승인):
--   1. 첨부 최대 3장
--   2. answer_body 는 계속 필수. 글 없이 이미지만 보내는 답변은 허용하지 않는다
--   3. 업로드 축소 없음. 이미지 파일만, 파일당 10MB 이하
--   4. 답변 완료 목록은 이번 범위 밖

-- ── 첨부 경로 컬럼 ───────────────────────────────────────────────────────
-- submissions.file_paths / assignments.attachment_paths 와 같은 형태로 둔다.
-- 기본값이 빈 배열이라 기존 3행도 그대로 통과한다.
alter table public.questions
  add column if not exists answer_file_paths text[] not null default '{}'::text[];

-- ── 경로 형식 검사 함수 ──────────────────────────────────────────────────
-- CHECK 제약에서는 서브쿼리를 쓸 수 없어서 immutable 함수로 뺀다.
-- 경로는 {question_id}/{파일명} 한 단계여야 한다. Storage 정책이 첫 칸으로
-- 질문을 찾기 때문에, 형식이 어긋나면 정책이 판단할 수 없다.
-- NULL 원소도 거부한다(bool_and 가 NULL 을 삼키지 않도록 명시적으로 확인).
create or replace function public.answer_file_paths_valid(p_question_id uuid, p_paths text[])
returns boolean
language sql
immutable
as $fn$
  select coalesce(
    bool_and(p is not null and p ~ ('^' || p_question_id::text || '/[^/]+$')),
    true)
  from unnest(coalesce(p_paths, '{}'::text[])) as p;
$fn$;

-- CHECK 제약이 INSERT 마다 이 함수를 부른다. 학생이 질문을 넣을 때도 평가되므로
-- authenticated 에게 실행 권한이 있어야 한다. anon 은 애초에 테이블을 못 쓴다.
revoke all on function public.answer_file_paths_valid(uuid, text[]) from public, anon;
grant execute on function public.answer_file_paths_valid(uuid, text[]) to authenticated;

-- ── 제약 ─────────────────────────────────────────────────────────────────
alter table public.questions
  add constraint questions_answer_files_count_check
  check (coalesce(array_length(answer_file_paths, 1), 0) <= 3);

alter table public.questions
  add constraint questions_answer_files_path_check
  check (public.answer_file_paths_valid(id, answer_file_paths));

-- 첨부가 있으면 답변된 질문이어야 한다.
-- 기존 questions_answer_check 가 answered <-> answer_body 비어있지 않음을 이미 묶고 있으므로,
-- 여기서 status 만 걸어도 "이미지만 있고 글은 없는 답변"이 함께 막힌다.
alter table public.questions
  add constraint questions_answer_files_answered_check
  check (answer_file_paths = '{}'::text[] or status = 'answered');

-- ── Storage 버킷 ─────────────────────────────────────────────────────────
-- 비공개. 이미지만 받는다(v1 은 축소를 하지 않으므로 PDF 는 받지 않는다).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('answer-files', 'answer-files', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Storage 정책 ─────────────────────────────────────────────────────────
-- 올리는 것은 관리자만.
create policy "admins upload answer files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'answer-files' and public.is_admin());

-- 읽기는 두 겹으로 막는다.
--   1) 경로 첫 칸이 그 학생의 질문이어야 하고
--   2) 그 질문의 answer_file_paths 에 실제로 들어 있어야 한다
-- 2번이 없으면, 관리자가 올렸다가 답변을 보내지 않고 그만둔 파일까지 학생에게 열린다.
create policy "answer files readable by asker" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'answer-files'
    and (
      public.is_admin()
      or (
        public.is_active_user()
        and exists (
          select 1
          from public.questions q
          where q.id::text = (storage.foldername(name))[1]
            and q.student_id = auth.uid()
            and name = any(q.answer_file_paths)
        )
      )
    )
  );

-- 답변 전송이 실패했을 때 방금 올린 파일을 되돌릴 수 있어야 한다.
create policy "admins delete answer files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'answer-files' and public.is_admin());

-- UPDATE 정책은 만들지 않는다. 첨부는 한 번 올리고 끝이다.
-- 학생 INSERT/DELETE 정책도 만들지 않는다. 정책이 없으면 거부가 기본이다.

-- ── 답변 RPC 확장 ────────────────────────────────────────────────────────
-- 인자를 늘려야 하는데, 같은 이름 함수를 두 개 두면 PostgREST 가 어느 쪽인지
-- 몰라 모호성 오류를 낼 수 있다. 그래서 오버로드 대신 drop 후 다시 만든다.
-- 세 번째 인자에 기본값이 있어 기존 2인자 호출도 그대로 동작한다.
drop function if exists public.answer_question(uuid, text);

create or replace function public.answer_question(
  p_question_id uuid,
  p_answer_body text,
  p_file_paths text[] default '{}'::text[]
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  clean text;
  paths text[];
  path text;
begin
  if not public.is_admin() then raise exception 'admin required'; end if;

  -- 글은 계속 필수다. 이미지만 보내는 답변은 허용하지 않는다.
  clean := btrim(coalesce(p_answer_body, ''));
  if clean = '' then raise exception 'empty answer'; end if;
  if char_length(clean) > 4000 then raise exception 'answer too long'; end if;

  paths := coalesce(p_file_paths, '{}'::text[]);
  if coalesce(array_length(paths, 1), 0) > 3 then
    raise exception 'too many answer files';
  end if;

  -- 클라이언트가 보낸 경로를 그대로 믿지 않는다. 제출 파일에 하는 검사와 같은 방식이다.
  foreach path in array paths loop
    if path is null or path !~ ('^' || p_question_id::text || '/[^/]+$') then
      raise exception 'invalid answer file';
    end if;
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'answer-files' and o.name = path
    ) then
      raise exception 'answer file missing';
    end if;
  end loop;

  update public.questions
     set status = 'answered',
         answer_body = clean,
         answer_file_paths = paths,
         answered_by = auth.uid(),
         answered_at = now()
   where id = p_question_id and status <> 'closed';

  if not found then raise exception 'question not open'; end if;
  return true;
end;
$fn$;

-- drop 하면 권한도 함께 사라진다. 새로 만든 함수에는 PUBLIC 실행 권한이 기본으로
-- 붙으므로, 반드시 revoke 를 먼저 하고 grant 를 한다.
-- (20260823000000 에서 이 순서를 빠뜨려 anon 이 RPC 를 부를 수 있었다. docs/22·23)
revoke all on function public.answer_question(uuid, text, text[]) from public, anon;
grant execute on function public.answer_question(uuid, text, text[]) to authenticated;

-- close_question 은 건드리지 않는다. 첨부 없이 기존 의미 그대로다.
