import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateInternalNote } from '../src/portal/admin-internal-notes.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const normalizeLocalModulePath = (fromPath, specifier) => {
  const [withoutQuery] = specifier.split('?');
  const normalized = resolve(root, fromPath, '..', withoutQuery);
  if (!normalized.startsWith(root)) return null;
  // path.resolve 는 Windows 에서 백슬래시를 쓴다 — 아래 곳곳의 'src/portal/...' 같은
  // 슬래시 리터럴과 비교하려면 항상 슬래시로 통일해야 한다(안 그러면 이 파일의
  // 모든 그래프 비교가 Windows 에서만 통과 못 한다).
  return normalized.slice(root.length + 1).split('\\').join('/');
};
const localImportsFrom = (path) => {
  const source = read(path);
  const imports = [...source.matchAll(/import\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g)];
  return imports
    .map(([, specifier]) => specifier)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => normalizeLocalModulePath(path, specifier))
    .filter(Boolean);
};
const collectImportGraph = (entryPath) => {
  const pending = [entryPath];
  const seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!path.endsWith('.js')) continue;
    for (const importedPath of localImportsFrom(path)) pending.push(importedPath);
  }
  return [...seen].sort();
};
const NON_ADMIN_SURFACE_ENTRIES = [
  'src/portal/student.js',
  'src/tablet/main.js',
  'src/main.js',
  'src/analytics.js',
];
const INTERNAL_NOTE_MARKERS = /review_internal_notes|upsert_review_internal_note|internal_note|internalNote/i;
const expectNoInternalNoteMarkersInImportGraph = (entryPath) => {
  const graph = collectImportGraph(entryPath);
  expect(graph).not.toContain('src/portal/admin-internal-notes.js');
  for (const path of graph) {
    expect(read(path), `${entryPath} imports ${path}`).not.toMatch(INTERNAL_NOTE_MARKERS);
  }
};

const MIGRATION = 'supabase/migrations/20260829000000_review_internal_notes.sql';
const migration = read(MIGRATION);
const stripComments = (source) => source
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
const executable = stripComments(migration);

const admin = read('src/portal/admin.js');
const student = read('src/portal/student.js');
const adminCss = read('src/portal/portal.css');
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

  it('keeps admin-only internal note vocabulary out of the student source graph', () => {
    // student.js 가 직접 import 하는 공유 모듈에도 원장 전용 메모 용어를 싣지 않는다.
    for (const path of ['src/portal/student.js', 'src/portal/domain.js', 'src/portal/client.js', 'src/auth.js']) {
      expect(read(path), path).not.toMatch(/review_internal_notes|upsert_review_internal_note|internal_note|internalNote|내부 메모|원장 전용/i);
    }
  });

  it('covers every non-admin browser entry in the internal-note source graph guard', () => {
    expect(NON_ADMIN_SURFACE_ENTRIES).toEqual(expect.arrayContaining([
      'src/portal/student.js',
      'src/tablet/main.js',
      'src/main.js',
      'src/analytics.js',
    ]));
  });

  it('keeps every non-admin import graph away from admin-only modules and database names', () => {
    for (const entryPath of NON_ADMIN_SURFACE_ENTRIES) {
      expectNoInternalNoteMarkersInImportGraph(entryPath);
    }
  });

  it('marks the internal-note module itself as admin-only', () => {
    expect(read('src/portal/admin-internal-notes.js')).toMatch(/ADMIN-ONLY/);
    expect(collectImportGraph('src/portal/admin.js')).toContain('src/portal/admin-internal-notes.js');
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

  it('shows saved internal notes again in the admin history, not only while review is pending', () => {
    expect(admin).toMatch(/review_internal_notes\(note,updated_at\)/);
    const card = admin.slice(admin.indexOf('function workflowCard('), admin.indexOf('const OPERATIONS_SUMMARY_SELECT'));
    expect(card).toContain('internal-note-history');
    expect(card).toContain('원장 내부 메모');
    expect(card).toMatch(/normalizeRelation\(attempt\.review_internal_notes\)/);
  });

  it('keeps old attempts folded by default so current work stays separate from history', () => {
    const card = admin.slice(admin.indexOf('function workflowCard('), admin.indexOf('const OPERATIONS_SUMMARY_SELECT'));
    expect(card).toMatch(/document\.createElement\('details'\)/);
    expect(card).toMatch(/document\.createElement\('summary'\)/);
    expect(card).not.toMatch(/details\.open\s*=\s*true/);
    expect(adminHtml).toMatch(/지난 기록은 접어서 보관/);
    expect(adminCss).toContain('.internal-note-history');
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
