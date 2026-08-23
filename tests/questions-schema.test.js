import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const MIGRATION = 'supabase/migrations/20260823000000_student_questions.sql';
const HARDENING = 'supabase/migrations/20260823010000_questions_grants_hardening.sql';
const sql = read(MIGRATION);
const hardening = read(HARDENING);
const rlsChecks = read('supabase/tests/questions_rls_checks.sql');

// 설명 주석에 기존 함수 이름이 등장하는 것과, 실제로 그 함수를 건드리는 것은 다르다.
// 아래 검사들은 실행되는 SQL 만 본다.
const stripComments = (source) => source
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
const executableSql = stripComments(sql);
const executableChecks = stripComments(rlsChecks);

describe('questions migration ordering', () => {
  it('sorts after every existing migration', () => {
    const files = readdirSync(resolve(root, 'supabase/migrations')).sort();
    expect(files.slice(-2)).toEqual([
      '20260823000000_student_questions.sql',
      '20260823010000_questions_grants_hardening.sql',
    ]);
  });

  it('adds only new objects and never alters the existing ones', () => {
    // 기존 흐름을 건드리지 않는다는 것이 이 마이그레이션의 핵심 약속이다.
    for (const forbidden of [
      'alter table public.submissions',
      'alter table public.assignments',
      'alter table public.profiles',
      'alter table public.feedback',
      'drop policy',
      'drop table',
      'drop function',
      'prepare_submission_attempt',
      'review_submission',
    ]) {
      expect(executableSql.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('questions table shape', () => {
  it('creates the table and the status type', () => {
    expect(sql).toContain("create type public.question_status as enum ('open', 'answered', 'closed')");
    expect(sql).toContain('create table public.questions');
  });

  it('carries every column the feature needs', () => {
    for (const column of [
      'id            uuid primary key',
      'student_id    uuid not null',
      'assignment_id uuid references public.assignments(id) on delete set null',
      'category      text not null',
      'body          text not null',
      'status        public.question_status not null default \'open\'',
      'created_at    timestamptz not null default now()',
      'answered_at   timestamptz',
      'answered_by   uuid references public.profiles(id)',
      'answer_body   text',
      'closed_at     timestamptz',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it('keeps a question alive when its assignment is deleted', () => {
    // 과제를 정리해도 상담 근거가 사라지면 안 된다.
    expect(sql).toContain('assignment_id uuid references public.assignments(id) on delete set null');
    expect(sql).not.toContain('assignment_id uuid references public.assignments(id) on delete cascade');
  });

  it('restricts the category to a fixed list', () => {
    expect(sql).toContain('questions_category_check');
    for (const category of [
      '문제를 읽고 뭘 해야 할지 모르겠어요',
      '식을 어떻게 세울지 모르겠어요',
      '계산하다가 막혔어요',
      '개념이 기억나지 않아요',
      '풀이 중간에서 막혔어요',
      '기타',
    ]) {
      expect(sql).toContain(category);
    }
  });

  it('refuses an empty or oversized question body', () => {
    expect(sql).toContain("check (btrim(body) <> '')");
    expect(sql).toContain('char_length(body) <= 1000');
  });

  it('keeps an answered row internally consistent', () => {
    // answered 인데 답변 본문이 없거나, 답변이 있는데 상태가 answered 가 아닌 상태를 막는다.
    expect(sql).toContain('questions_answer_check');
    expect(sql).toMatch(/\(status = 'answered'\) = \(answered_at is not null and answered_by is not null/);
  });

  it('indexes what the admin queue and the student screen actually read', () => {
    expect(sql).toContain('questions_status_created_idx on public.questions(status, created_at)');
    expect(sql).toContain('questions_student_created_idx on public.questions(student_id, created_at desc)');
  });
});

describe('questions row level security', () => {
  it('turns RLS on', () => {
    expect(sql).toContain('alter table public.questions enable row level security');
  });

  it('lets a student read only their own questions', () => {
    expect(sql).toMatch(/create policy "students read own questions"[\s\S]*?for select to authenticated/);
    expect(sql).toMatch(/using \(\(student_id = auth\.uid\(\) and public\.is_active_user\(\)\) or public\.is_admin\(\)\)/);
  });

  it('lets a student insert only under their own id and only as open', () => {
    expect(sql).toMatch(/create policy "students ask questions"[\s\S]*?for insert to authenticated/);
    expect(sql).toMatch(/with check \(public\.is_active_user\(\) and student_id = auth\.uid\(\) and status = 'open'\)/);
  });

  it('creates no update or delete policy at all', () => {
    // 정책이 없으면 거부가 기본이다. submissions 와 같은 판단.
    expect(sql).not.toMatch(/create policy[^;]*on public\.questions\s+for update/i);
    expect(sql).not.toMatch(/create policy[^;]*on public\.questions\s+for delete/i);
  });

  it('grants only select and insert, and nothing to anon', () => {
    expect(sql).toContain('grant select, insert on table public.questions to authenticated');
    expect(sql).not.toMatch(/grant[^;]*update[^;]*on table public\.questions/i);
    expect(sql).not.toMatch(/grant[^;]*delete[^;]*on table public\.questions/i);
    expect(sql).toContain('revoke all on table public.questions from anon');
    expect(sql).not.toMatch(/grant[^;]*on table public\.questions to anon/i);
  });
});

// Supabase 는 public 스키마의 새 테이블에 ALL 을, 새 함수에 PUBLIC EXECUTE 를 기본으로 준다.
// grant 만 해서는 의도한 경계가 서지 않는다. 반드시 먼저 revoke 해야 한다.
describe('grants hardening migration', () => {
  it('revokes the Supabase default grants before granting', () => {
    expect(hardening).toContain('revoke all on table public.questions from anon');
    expect(hardening).toContain('revoke all on table public.questions from authenticated');
    const revokeIndex = hardening.indexOf('revoke all on table public.questions from authenticated');
    const grantIndex = hardening.indexOf('grant select, insert on table public.questions to authenticated');
    expect(revokeIndex).toBeGreaterThan(-1);
    expect(grantIndex).toBeGreaterThan(revokeIndex);
  });

  it('leaves the table with select and insert only', () => {
    const statements = stripComments(hardening);
    expect(statements).toContain('grant select, insert on table public.questions to authenticated');
    expect(statements).not.toMatch(/grant[^;]*update[^;]*on table public\.questions/i);
    expect(statements).not.toMatch(/grant[^;]*delete[^;]*on table public\.questions/i);
  });

  it('takes the trigger function away from every caller', () => {
    expect(hardening).toContain('revoke all on function public.prepare_question() from public, anon, authenticated');
    expect(hardening).not.toMatch(/grant execute on function public\.prepare_question/);
  });

  it('revokes the RPCs from public as well as anon', () => {
    // anon 만 revoke 하면 PUBLIC 기본 권한이 남아 anon 이 계속 호출할 수 있다.
    for (const fn of ['public.answer_question(uuid, text)', 'public.close_question(uuid)']) {
      expect(hardening).toContain('revoke all on function ' + fn + ' from public, anon');
      expect(hardening).toContain('grant execute on function ' + fn + ' to authenticated');
    }
  });

  it('follows the same order the original portal migration uses', () => {
    const original = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(original).toContain('revoke all on table public.submissions from authenticated');
    expect(original).toContain('grant select, insert on table public.submissions to authenticated');
  });

  it('changes nothing outside the questions feature', () => {
    for (const forbidden of [
      'public.submissions', 'public.assignments', 'public.profiles', 'public.feedback',
      'drop', 'alter table', 'create table',
    ]) {
      expect(stripComments(hardening).toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('prepare_question trigger', () => {
  it('runs before insert as a definer with a pinned search path', () => {
    expect(sql).toContain('create or replace function public.prepare_question()');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = public');
    expect(sql).toContain('create trigger questions_prepare\n  before insert on public.questions');
  });

  it('rejects a forged student id rather than silently rewriting it', () => {
    expect(sql).toMatch(/if new\.student_id is distinct from auth\.uid\(\) then\s*raise exception 'invalid student'/);
  });

  it('rejects a suspended account', () => {
    expect(sql).toMatch(/if auth\.uid\(\) is null or not public\.is_active_user\(\) then/);
  });

  it('rejects an assignment the student does not own', () => {
    expect(sql).toMatch(/where a\.id = new\.assignment_id and a\.student_id = auth\.uid\(\)/);
    expect(sql).toContain("raise exception 'assignment not owned'");
  });

  it('lets the server decide every status field', () => {
    for (const line of [
      "new.status := 'open'",
      'new.answered_at := null',
      'new.answered_by := null',
      'new.answer_body := null',
      'new.closed_at := null',
    ]) {
      expect(sql).toContain(line);
    }
  });

  it('trims the body and refuses an empty one', () => {
    expect(sql).toContain('new.body := btrim(new.body)');
    expect(sql).toContain("raise exception 'empty question'");
  });

  it('caps how many unanswered questions one student can pile up', () => {
    expect(sql).toMatch(/where student_id = auth\.uid\(\) and status = 'open'/);
    expect(sql).toContain("if open_count >= 10 then raise exception 'too many open questions'");
  });
});

describe('answer and close RPCs', () => {
  it('requires an admin', () => {
    const answer = sql.match(/create or replace function public\.answer_question[\s\S]*?\$\$;/)?.[0] ?? '';
    const close = sql.match(/create or replace function public\.close_question[\s\S]*?\$\$;/)?.[0] ?? '';
    for (const fn of [answer, close]) {
      expect(fn).toContain("if not public.is_admin() then raise exception 'admin required'");
      expect(fn).toContain('security definer');
    }
  });

  it('records who answered and when', () => {
    const answer = sql.match(/create or replace function public\.answer_question[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(answer).toContain("status = 'answered'");
    expect(answer).toContain('answered_by = auth.uid()');
    expect(answer).toContain('answered_at = now()');
    expect(answer).toContain('answer_body = clean');
  });

  it('refuses an empty or oversized answer', () => {
    const answer = sql.match(/create or replace function public\.answer_question[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(answer).toContain("if clean = '' then raise exception 'empty answer'");
    expect(answer).toContain('char_length(clean) > 4000');
  });

  it('will not reopen a closed question', () => {
    expect(sql).toMatch(/where id = p_question_id and status <> 'closed'/);
    expect(sql).toContain("raise exception 'question not open'");
  });

  it('is callable by authenticated but not by anon', () => {
    expect(sql).toContain('grant execute on function public.answer_question(uuid, text) to authenticated');
    expect(sql).toContain('grant execute on function public.close_question(uuid) to authenticated');
    expect(sql).toContain('revoke execute on function public.answer_question(uuid, text) from anon');
    expect(sql).toContain('revoke execute on function public.close_question(uuid) from anon');
  });
});

describe('questions rls check script', () => {
  it('warns against running on production', () => {
    expect(rlsChecks).toContain('운영 DB에서 실행 금지');
  });

  it('wraps everything in a rolled back transaction', () => {
    const statements = executableChecks.trim();
    expect(statements.startsWith('begin;')).toBe(true);
    expect(statements.endsWith('rollback;')).toBe(true);
    expect(executableChecks).not.toContain('commit;');
  });

  it('covers each boundary the migration promises', () => {
    for (const scenario of [
      '자기 질문 insert',
      'student_id 위조 거부',
      'assignment not owned 거부',
      '빈 질문 거부',
      'category allowlist 동작',
      '질문 교차 접근 차단',
      '관리자 answer_question 동작',
      '미답변 10건 상한 동작',
      'anon 조회',
    ]) {
      expect(rlsChecks).toContain(scenario);
    }
  });
});
