import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const FIX = 'supabase/migrations/20260828010000_review_v2_provenance_fail_closed.sql';
const APPLIED = 'supabase/migrations/20260726010000_portal_operational_hardening.sql';
const fix = read(FIX);
const applied = read(APPLIED);

const stripComments = (source) => source
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
const executable = stripComments(fix);

// 고친 문제: 20260726010000 의 4인자 review_submission_v2 가 5인자에 위임한 뒤
// auto_composed 를 null 로 덮어써, 새로 쓴 피드백이 legacy unknown 으로 기록됐다.
// 2026-08-28 운영 조회 기준 feedback 8건 중 NULL 0건 — 이 경로는 실행된 적이 없다.

describe('review provenance fix — migration ordering', () => {
  it('sorts after the migration it corrects', () => {
    const files = readdirSync(resolve(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.indexOf(FIX.split('/').pop())).toBeGreaterThan(files.indexOf(APPLIED.split('/').pop()));
  });

  it('leaves the already-applied migration untouched', () => {
    // 20260726010000 은 이미 운영에 적용됐다. 고치면 저장소와 DB 이력이 어긋난다.
    expect(applied).toContain('set auto_composed = null');
    expect(applied).toMatch(/p_items jsonb default '\[\]'::jsonb/);
  });
});

describe('review provenance fix — closes the NULL-producing path', () => {
  it('stops writing NULL provenance on new feedback', () => {
    // 4인자 경로가 다시 feedback 을 건드리면 안 된다.
    expect(executable).not.toMatch(/update public[.]feedback/i);
    expect(executable).not.toMatch(/auto_composed\s*=\s*null/i);
  });

  it('fails closed instead of inventing a provenance value', () => {
    // false 로 위임하면 "원장이 직접 씀" 이라는 값을 지어내게 된다.
    expect(executable).toMatch(/create or replace function public[.]review_submission_v2[(][^)]*p_items jsonb default/i);
    expect(executable).toMatch(/raise exception using/i);
    expect(executable).toMatch(/message = '구버전 화면입니다[.] 새로고침 후 다시 확정해 주세요[.]'/);
    expect(executable).not.toMatch(/perform public[.]review_submission_v2/i);
  });

  it('keeps the retired overload callable so the message reaches the browser', () => {
    // drop 하면 구버전 클라이언트는 PGRST202 만 받는다. revoke 하면 permission denied 가 나간다.
    expect(executable).not.toMatch(/drop function[^;]*review_submission_v2/i);
    expect(executable).toMatch(
      /grant execute on function public[.]review_submission_v2[(]uuid, text, public[.]submission_status, jsonb[)]\s*to authenticated/i);
  });

  it('never touches the five-argument path or the legacy three-argument RPC', () => {
    expect(executable).not.toMatch(/review_submission_v2[(][^)]*boolean[)]\s*(returns|language)/i);
    expect(executable).not.toMatch(/create or replace function public[.]review_submission[(]/i);
    // 5인자가 없으면 검토가 전면 중단되므로 선행 조건으로 확인한다.
    expect(executable).toMatch(/to_regprocedure[\s\S]{0,120}jsonb, boolean[\s\S]{0,200}raise exception/i);
  });
});

describe('review provenance fix — protects existing rows', () => {
  it('never rewrites historical NULL rows', () => {
    // 과거 NULL 은 "컬럼이 생기기 전"이라는 의미다. 일괄 false 변환은 기록 위조다.
    expect(executable).not.toMatch(/set auto_composed\s*=\s*(true|false)/i);
    expect(executable).not.toMatch(/\bupdate\b[\s\S]{0,80}\bfeedback\b/i);
  });

  it('enforces provenance in the schema, exempting rows written before the column existed', () => {
    expect(executable).toMatch(/add constraint feedback_auto_composed_known/i);
    expect(executable).toMatch(/check [(]auto_composed is not null[)] not valid/i);
    // validate 하면 과거 NULL 행이 있을 때 마이그레이션이 실패한다.
    expect(executable).not.toMatch(/validate constraint/i);
  });

  it('adds the constraint only when it is missing, so the migration re-runs cleanly', () => {
    expect(executable).toMatch(/if not exists [\s\S]{0,200}feedback_auto_composed_known[\s\S]{0,200}then/i);
    expect(executable).not.toMatch(/\b(drop table|drop constraint|delete from|truncate table)\b/i);
  });
});
