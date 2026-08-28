import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const FIX = 'supabase/migrations/20260825010000_answer_file_paths_valid_search_path.sql';
const APPLIED = 'supabase/migrations/20260825000000_question_answer_attachments.sql';
const fix = read(FIX);
const applied = read(APPLIED);

const stripComments = (source) => source
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
const executable = stripComments(fix);

// 고친 문제: 20260825000000 에서 answer_file_paths_valid 에 search_path 를 빠뜨려
// Supabase advisor 가 function_search_path_mutable 로 잡았다(docs/34).

describe('search_path fix — migration ordering', () => {
  it('sorts after the migration it corrects', () => {
    // 상대 순서만 본다. "마지막 파일"로 고정하면 이후 모든 신규 마이그레이션이 이 테스트를 깬다.
    const files = readdirSync(resolve(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    const corrected = files.indexOf('20260825000000_question_answer_attachments.sql');
    expect(corrected).toBeGreaterThanOrEqual(0);
    expect(files[corrected + 1]).toBe('20260825010000_answer_file_paths_valid_search_path.sql');
  });

  it('leaves the already-applied migration untouched', () => {
    // 20260825000000 은 이미 운영에 적용됐다. 고치면 저장소와 DB 이력이 어긋난다.
    expect(applied).toContain('create or replace function public.answer_file_paths_valid');
    expect(applied).not.toContain("set search_path = ''");
    // 원본에는 search_path 절이 없는 상태 그대로여야 한다
    const originalFn = applied.match(/create or replace function public\.answer_file_paths_valid[\s\S]*?\$fn\$;/)?.[0] ?? '';
    expect(originalFn).not.toContain('search_path');
  });
});

describe('search_path fix — the fix itself', () => {
  it('sets an explicit search_path on the validator', () => {
    expect(executable).toContain('create or replace function public.answer_file_paths_valid(p_question_id uuid, p_paths text[])');
    expect(executable).toContain("set search_path = ''");
  });

  it('uses the empty search_path, since the function touches nothing in public', () => {
    // 본문은 unnest·bool_and·coalesce·연산자만 쓴다. 전부 pg_catalog 이라
    // pg_catalog 가 항상 먼저 검색되는 성질만으로 충분하다.
    const fn = executable.match(/create or replace function public\.answer_file_paths_valid[\s\S]*?\$fn\$;/)?.[0] ?? '';
    expect(fn).toContain("set search_path = ''");
    expect(fn).not.toContain('set search_path = public');
    // 선언부에는 public.answer_file_paths_valid 라는 이름이 당연히 들어간다.
    // 확인해야 할 것은 본문이 public 의 무언가를 부르지 않는다는 점이다.
    const body = executable.match(/answer_file_paths_valid[\s\S]*?\$fn\$([\s\S]*?)\$fn\$;/)?.[1] ?? '';
    expect(body.trim()).not.toBe('');
    expect(body).not.toContain('public.');
  });

  it('keeps the function immutable so the check constraint still accepts it', () => {
    const fn = executable.match(/create or replace function public\.answer_file_paths_valid[\s\S]*?\$fn\$;/)?.[0] ?? '';
    expect(fn).toContain('immutable');
    expect(fn).toContain('language sql');
  });

  it('stays security invoker — it is not a privilege boundary', () => {
    expect(executable).not.toContain('security definer');
  });
});

describe('search_path fix — behaviour is unchanged', () => {
  it('keeps the body byte-for-byte identical to the applied version', () => {
    const bodyOf = (source) => {
      const fn = source.match(/create or replace function public\.answer_file_paths_valid[\s\S]*?\$fn\$([\s\S]*?)\$fn\$;/);
      return (fn?.[1] ?? '').trim();
    };
    const before = bodyOf(applied);
    const after = bodyOf(fix);
    expect(before).not.toBe('');
    expect(after).toBe(before);
  });

  it('keeps the same signature so the check constraint keeps resolving', () => {
    expect(executable).toContain('answer_file_paths_valid(p_question_id uuid, p_paths text[])');
    expect(executable).toContain('returns boolean');
  });

  it('uses create or replace, never drop — dropping would break the check constraint', () => {
    expect(executable).toContain('create or replace function');
    expect(executable).not.toMatch(/drop function[^;]*answer_file_paths_valid/);
  });
});

describe('search_path fix — grants and blast radius', () => {
  it('revokes from public and anon before granting', () => {
    const revoke = executable.indexOf('revoke all on function public.answer_file_paths_valid(uuid, text[]) from public, anon');
    const grant = executable.indexOf('grant execute on function public.answer_file_paths_valid(uuid, text[]) to authenticated');
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
  });

  it('keeps the validator callable by students, since inserts evaluate it', () => {
    expect(executable).toContain('grant execute on function public.answer_file_paths_valid(uuid, text[]) to authenticated');
  });

  it('changes nothing else at all', () => {
    const lower = executable.toLowerCase();
    for (const forbidden of [
      'answer_question', 'close_question', 'prepare_question',
      'alter table', 'create policy', 'drop policy',
      'storage.buckets', 'storage.objects',
      'public.submissions', 'public.assignments', 'public.profiles',
      'create table', 'create type', 'delete from', 'truncate',
    ]) {
      expect(lower).not.toContain(forbidden);
    }
  });
});
