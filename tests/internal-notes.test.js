import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateInternalNote } from '../src/portal/domain.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const MIGRATION = 'supabase/migrations/20260829000000_review_internal_notes.sql';
const migration = read(MIGRATION);
const stripComments = (source) => source
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
const executable = stripComments(migration);

const admin = read('src/portal/admin.js');
const student = read('src/portal/student.js');
const adminHtml = read('admin/index.html');
const studentHtml = read('student/index.html');

// 고친 문제: feedback.body 와 feedback_items.comment 는 학생이 그대로 읽는다.
// 원장이 내부 판단을 적을 자리가 없어 학생 노출 필드에 쓸 수밖에 없었다.
// 브라우저에서 학생과 관리자는 같은 authenticated 롤이므로 컬럼 권한으로
// 나눌 수 없다. 학생이 읽는 테이블에 내부 컬럼을 두지 않는 것이 유일한 방법이다.

describe('internal notes — never reach the student surface', () => {
  it('keeps the note out of every student-side query and render path', () => {
    // 학생 화면은 테이블도 RPC 도 이름조차 몰라야 한다.
    expect(student).not.toMatch(/review_internal_notes|upsert_review_internal_note|internal_note|internalNote/i);
    expect(studentHtml).not.toMatch(/review_internal_notes|internal_note|internalNote/i);
  });

  it('leaves the student select strings byte-for-byte unchanged', () => {
    // 임베드 한 번이면 RLS 뒤의 방어선이 의미를 잃는다.
    const selects = student.match(/^const \w*SELECT = '.*';$/gm) || [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const line of selects) expect(line).not.toMatch(/internal/i);
  });

  it('does not put the note on a table students can read', () => {
    // feedback / feedback_items 에 컬럼을 붙이면 학생 SELECT 에 딸려 나간다.
    expect(executable).not.toMatch(/alter table public[.]feedback\b[^;]*add column/i);
    expect(executable).not.toMatch(/alter table public[.]feedback_items\b[^;]*add column/i);
    expect(executable).toMatch(/create table if not exists public[.]review_internal_notes/i);
  });
});

describe('internal notes — database boundary', () => {
  it('is admin-only at the row level, like review_events', () => {
    expect(executable).toMatch(/alter table public[.]review_internal_notes enable row level security/i);
    expect(executable).toMatch(
      /create policy "admins read internal notes" on public[.]review_internal_notes\s*for select to authenticated using [(]public[.]is_admin[(][)][)]/i);
  });

  it('allows no direct writes, so every write goes through the RPC', () => {
    expect(executable).not.toMatch(/on public[.]review_internal_notes\s*for (insert|update|delete)/i);
    expect(executable).toMatch(/revoke all on table public[.]review_internal_notes from public, anon, authenticated/i);
    expect(executable).toMatch(/grant select on table public[.]review_internal_notes to authenticated/i);
    expect(executable).not.toMatch(/grant[^;]*(insert|update|delete)[^;]*on table public[.]review_internal_notes/i);
  });

  it('re-checks is_admin inside the security definer RPC', () => {
    expect(executable).toMatch(/create or replace function public[.]upsert_review_internal_note/i);
    expect(executable).toMatch(/security definer set search_path = ''/i);
    expect(executable).toMatch(/if not public[.]is_admin[(][)] then raise exception 'admin required'/i);
    expect(executable).toMatch(/revoke all on function public[.]upsert_review_internal_note[(]uuid, text[)] from public, anon/i);
  });

  it('treats an empty note as "no note" instead of storing a blank row', () => {
    expect(executable).toMatch(/trim[(]coalesce[(]p_note, ''[)][)]/i);
    expect(executable).toMatch(/if v_note = ''[\s\S]{0,160}delete from public[.]review_internal_notes/i);
    expect(executable).toMatch(/check [(]char_length[(]note[)] between 1 and 2000[)]/i);
  });

  it('supports typo fixes without a second row', () => {
    expect(executable).toMatch(/on conflict [(]submission_id[)] do update/i);
    expect(executable).toMatch(/updated_at = now[(][)]/i);
  });

  it('never rewrites existing feedback', () => {
    expect(executable).not.toMatch(/\b(update|delete from)\s+public[.]feedback/i);
    expect(executable).not.toMatch(/\b(drop table|truncate table|truncate public[.])/i);
  });

  it('documents that the existing fields are student-visible', () => {
    expect(migration).toMatch(/comment on column public[.]feedback[.]body is[\s\S]{0,40}STUDENT-VISIBLE/i);
    expect(migration).toMatch(/comment on column public[.]feedback_items[.]comment is[\s\S]{0,40}STUDENT-VISIBLE/i);
    expect(migration).toMatch(/comment on table public[.]review_internal_notes is[\s\S]{0,40}ADMIN-ONLY/i);
  });

  it('keeps parent-facing features out of Supabase but documents the boundary', () => {
    // 학부모 문안·발송 승인은 Notion 소관이다. 이 경계가 흐려지면 승인 게이트가 둘이 된다.
    // 기능(테이블·컬럼·함수)은 금지하고, 경계를 적어둔 코멘트는 오히려 남긴다.
    expect(executable).not.toMatch(/(table|column|function|policy)[^;\n]*\b(parent|guardian|approval|sent_at|notify)\b/i);
    expect(migration).toMatch(/학부모용 문안은 여기가 아니라 Notion 소관/);
  });

  it('does not touch review_submission_v2', () => {
    expect(executable).not.toMatch(/review_submission/i);
  });
});

describe('internal notes — admin surface', () => {
  it('reads and writes the note only from the admin portal', () => {
    expect(admin).toContain("supabase.from('review_internal_notes')");
    expect(admin).toContain("supabase.rpc('upsert_review_internal_note'");
    expect(adminHtml).toContain('id=internalNote');
    expect(adminHtml).toMatch(/학생에게 보이지 않습니다/);
  });

  it('saves the note before the decision so a rejected review keeps it', () => {
    const decide = admin.slice(admin.indexOf('async function decide('), admin.indexOf("rpc('review_submission_v2'"));
    expect(decide).toContain('await saveInternalNote(decidedId)');
  });

  it('does not block review decisions while the internal-note migration is pending', () => {
    // GitHub Pages can deploy the new frontend before Supabase db push applies the new RPC.
    // In that mixed-version window, review_submission_v2 must still run.
    const save = admin.slice(admin.indexOf('async function saveInternalNote('), admin.indexOf("byId('saveInternalNote').addEventListener"));
    expect(save).toMatch(/isMissingInternalNotesFeature[(]error[)]/);
    expect(save).toMatch(/return \{ note, skipped: true \}/);
    const decide = admin.slice(admin.indexOf('async function decide('), admin.indexOf("rpc('review_submission_v2'"));
    expect(decide).toContain('await saveInternalNote(decidedId)');
  });
});

describe('validateInternalNote', () => {
  it('trims and treats blank input as no note', () => {
    expect(validateInternalNote('  난이도 하향 검토  ')).toBe('난이도 하향 검토');
    expect(validateInternalNote('   ')).toBe('');
    expect(validateInternalNote(null)).toBe('');
    expect(validateInternalNote(undefined)).toBe('');
  });

  it('matches the database length bound', () => {
    expect(validateInternalNote('가'.repeat(2000))).toHaveLength(2000);
    expect(() => validateInternalNote('가'.repeat(2001))).toThrow(/2000/);
  });
});
