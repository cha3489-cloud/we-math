import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const MIGRATION = 'supabase/migrations/20260825000000_question_answer_attachments.sql';
const sql = read(MIGRATION);
const rlsChecks = read('supabase/tests/answer_attachments_rls_checks.sql');

// 주석에 설명으로 적어둔 문자열이 검사에 걸리지 않도록 실행문만 남긴다.
const stripComments = (source) => source
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
const executable = stripComments(sql);

describe('answer attachment migration ordering', () => {
  it('sorts after every migration that came before it', () => {
    // "맨 뒤인지"로 검사하면 새 마이그레이션이 붙을 때마다 깨진다.
    // (questions-schema.test.js 에서 같은 이유로 이미 한 번 고쳤는데 여기서 반복했다.)
    // 확인하려는 것은 순서다.
    const files = readdirSync(resolve(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    const hardening = files.indexOf('20260823010000_questions_grants_hardening.sql');
    const attachments = files.indexOf('20260825000000_question_answer_attachments.sql');
    expect(hardening).toBeGreaterThan(-1);
    expect(attachments).toBe(hardening + 1);
  });

  it('leaves the two existing questions migrations untouched', () => {
    // append-only. 이미 운영에 적용된 파일을 고치면 저장소와 DB 이력이 어긋난다.
    const original = read('supabase/migrations/20260823000000_student_questions.sql');
    const hardening = read('supabase/migrations/20260823010000_questions_grants_hardening.sql');
    expect(original).not.toContain('answer_file_paths');
    expect(original).not.toContain('answer-files');
    expect(hardening).not.toContain('answer_file_paths');
    expect(hardening).not.toContain('answer-files');
  });
});

describe('answer_file_paths column and constraints', () => {
  it('adds the array column with a safe default so existing rows stay valid', () => {
    expect(executable).toMatch(/add column if not exists answer_file_paths text\[\] not null default '\{\}'::text\[\]/);
  });

  it('caps the attachments at three', () => {
    expect(executable).toContain('questions_answer_files_count_check');
    expect(executable).toMatch(/coalesce\(array_length\(answer_file_paths, 1\), 0\) <= 3/);
  });

  it('validates the path shape against the question id', () => {
    expect(executable).toContain('questions_answer_files_path_check');
    expect(executable).toContain('public.answer_file_paths_valid(id, answer_file_paths)');
    // {question_id}/{파일명} 한 단계여야 한다
    expect(executable).toMatch(/\^' \|\| p_question_id::text \|\| '\/\[\^\/\]\+\$/);
  });

  it('rejects null entries inside the array', () => {
    const fn = executable.match(/create or replace function public\.answer_file_paths_valid[\s\S]*?\$fn\$;/)?.[0] ?? '';
    expect(fn).toContain('p is not null');
  });

  it('keeps answer_body required — attachments cannot stand alone', () => {
    // 첨부가 있으면 answered 여야 하고, 기존 questions_answer_check 가
    // answered <-> answer_body 비어있지 않음을 이미 묶고 있다.
    expect(executable).toContain('questions_answer_files_answered_check');
    expect(executable).toMatch(/answer_file_paths = '\{\}'::text\[\] or status = 'answered'/);
    // 기존 제약을 건드리지 않는다
    expect(executable).not.toContain('drop constraint questions_answer_check');
    expect(executable).not.toContain('questions_answer_check');
  });
});

describe('answer-files storage bucket', () => {
  it('creates a private bucket', () => {
    expect(executable).toContain("insert into storage.buckets");
    expect(executable).toMatch(/'answer-files', 'answer-files', false/);
  });

  it('limits each file to 10MB', () => {
    expect(executable).toContain('10485760');
  });

  it('accepts images only — no pdf, because v1 does not shrink uploads', () => {
    const bucket = executable.match(/insert into storage\.buckets[\s\S]*?;/)?.[0] ?? '';
    expect(bucket).toContain("'image/jpeg'");
    expect(bucket).toContain("'image/png'");
    expect(bucket).toContain("'image/webp'");
    expect(bucket).not.toContain('application/pdf');
  });

  it('never touches the existing buckets or their policies', () => {
    expect(executable).not.toContain('submission-files');
    expect(executable).not.toContain('assignment-files');
    expect(executable).not.toMatch(/drop policy/i);
  });
});

describe('answer-files storage policies', () => {
  it('lets only admins upload', () => {
    const policy = executable.match(/create policy "admins upload answer files"[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toContain('for insert to authenticated');
    expect(policy).toContain('public.is_admin()');
  });

  it('lets only admins delete, so a failed answer can be cleaned up', () => {
    const policy = executable.match(/create policy "admins delete answer files"[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toContain('for delete to authenticated');
    expect(policy).toContain('public.is_admin()');
  });

  it('checks BOTH the path prefix and array membership before showing a file to a student', () => {
    // 경로만 보면, 관리자가 올렸다가 답변을 보내지 않고 그만둔 파일까지 학생에게 열린다.
    const policy = executable.match(/create policy "answer files readable by asker"[\s\S]*?\n  \);/)?.[0] ?? '';
    expect(policy).toBeTruthy();
    expect(policy).toContain('for select to authenticated');
    expect(policy).toContain('(storage.foldername(name))[1]');
    expect(policy).toContain('q.student_id = auth.uid()');
    expect(policy).toContain('name = any(q.answer_file_paths)');
    expect(policy).toContain('public.is_active_user()');
  });

  it('gives students no upload or delete policy at all', () => {
    // 정책이 없으면 거부가 기본이다. 학생용 쓰기 정책을 만들지 않는 것이 방어선이다.
    const answerPolicies = [...executable.matchAll(/create policy "([^"]*answer files[^"]*)"[\s\S]*?for (\w+)/g)]
      .map((m) => ({ name: m[1], cmd: m[2] }));
    expect(answerPolicies).toHaveLength(3);
    const writable = answerPolicies.filter((p) => p.cmd === 'insert' || p.cmd === 'delete');
    for (const policy of writable) expect(policy.name).toContain('admins');
    expect(answerPolicies.some((p) => p.cmd === 'update')).toBe(false);
  });

  it('never grants anything to anon', () => {
    const policies = executable.match(/create policy "[^"]*answer files[^"]*"[\s\S]*?;/g) ?? [];
    for (const policy of policies) {
      expect(policy).toContain('to authenticated');
      expect(policy).not.toContain('to anon');
      expect(policy).not.toContain('to public');
    }
  });
});

describe('answer_question RPC', () => {
  it('is recreated with a single three-argument signature, not an overload', () => {
    // 같은 이름 함수가 둘이면 PostgREST 가 모호성 오류를 낼 수 있다.
    expect(executable).toContain('drop function if exists public.answer_question(uuid, text);');
    expect(executable).toMatch(/p_file_paths text\[\] default '\{\}'::text\[\]/);
  });

  it('still requires a non-empty answer body', () => {
    const fn = executable.match(/create or replace function public\.answer_question[\s\S]*?\$fn\$;/)?.[0] ?? '';
    expect(fn).toContain("if clean = '' then raise exception 'empty answer'");
  });

  it('caps the attachments at three on the server too', () => {
    const fn = executable.match(/create or replace function public\.answer_question[\s\S]*?\$fn\$;/)?.[0] ?? '';
    expect(fn).toMatch(/array_length\(paths, 1\), 0\) > 3/);
    expect(fn).toContain("raise exception 'too many answer files'");
  });

  it('verifies each path belongs to this question and actually exists in storage', () => {
    const fn = executable.match(/create or replace function public\.answer_question[\s\S]*?\$fn\$;/)?.[0] ?? '';
    expect(fn).toContain("raise exception 'invalid answer file'");
    expect(fn).toContain("raise exception 'answer file missing'");
    expect(fn).toContain("o.bucket_id = 'answer-files'");
    expect(fn).toMatch(/p_question_id::text \|\| '\/\[\^\/\]\+\$'/);
  });

  it('keeps the admin check and the closed-question guard', () => {
    const fn = executable.match(/create or replace function public\.answer_question[\s\S]*?\$fn\$;/)?.[0] ?? '';
    expect(fn).toContain("if not public.is_admin() then raise exception 'admin required'");
    expect(fn).toContain("status <> 'closed'");
    expect(fn).toContain('security definer');
    expect(fn).toContain("set search_path = public");
  });

  it('leaves close_question alone', () => {
    expect(executable).not.toContain('drop function if exists public.close_question');
    expect(executable).not.toMatch(/create or replace function public\.close_question/);
  });
});

describe('grants — the mistake from the first questions migration must not repeat', () => {
  it('revokes from public AND anon before granting, for the RPC', () => {
    const revoke = executable.indexOf('revoke all on function public.answer_question(uuid, text, text[]) from public, anon');
    const grant = executable.indexOf('grant execute on function public.answer_question(uuid, text, text[]) to authenticated');
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
  });

  it('revokes from public AND anon before granting, for the check helper', () => {
    const revoke = executable.indexOf('revoke all on function public.answer_file_paths_valid(uuid, text[]) from public, anon');
    const grant = executable.indexOf('grant execute on function public.answer_file_paths_valid(uuid, text[]) to authenticated');
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
  });

  it('keeps the check helper callable by students, since inserts evaluate it', () => {
    // CHECK 제약은 INSERT 마다 평가된다. authenticated 가 실행할 수 없으면
    // 학생이 질문을 넣지 못한다.
    expect(executable).toContain('grant execute on function public.answer_file_paths_valid(uuid, text[]) to authenticated');
  });

  it('does not change table level grants — the new column inherits them', () => {
    expect(executable).not.toMatch(/grant[^;]*on table public\.questions/);
    expect(executable).not.toMatch(/revoke[^;]*on table public\.questions/);
  });
});

describe('blast radius', () => {
  it('changes nothing outside the answer attachment feature', () => {
    const lower = executable.toLowerCase();
    for (const forbidden of [
      'public.submissions', 'public.assignments', 'public.profiles', 'public.feedback',
      'drop table', 'drop policy', 'truncate', 'delete from',
    ]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it('creates no new table and no new enum', () => {
    expect(executable).not.toMatch(/create table/i);
    expect(executable).not.toMatch(/create type/i);
  });
});

describe('rls check script', () => {
  it('is branch only and wrapped in a rollback', () => {
    expect(rlsChecks).toContain('운영 DB에서 실행 금지');
    const executableChecks = stripComments(rlsChecks).trim();
    expect(executableChecks.startsWith('begin;')).toBe(true);
    expect(executableChecks.endsWith('rollback;')).toBe(true);
  });

  it('covers the security cases that matter', () => {
    for (const marker of [
      'PASS(2)', 'PASS(3)', 'PASS(4)', 'PASS(5)',
      'PASS(7)', 'PASS(8)', 'PASS(9)', 'PASS(10)',
      'PASS(12)', 'PASS(14)', 'PASS(15)',
    ]) {
      expect(rlsChecks).toContain(marker);
    }
  });

  it('specifically checks the orphan file case', () => {
    // 경로 첫 칸은 맞지만 answer_file_paths 에 없는 파일
    expect(rlsChecks).toContain('orphan.png');
    expect(rlsChecks).toContain('배열 소속 검사 동작');
  });
});
