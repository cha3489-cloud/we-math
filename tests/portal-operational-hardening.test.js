import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migrationPath = resolve(root, 'supabase/migrations/20260726010000_portal_operational_hardening.sql');
const readMigration = () => existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

describe('portal operational hardening', () => {
  it('makes assignment ownership columns immutable to browser users', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readMigration();
    expect(migration).toMatch(/revoke update on table public[.]assignments from authenticated/i);
    expect(migration).toMatch(/grant update [(]title, description, due_at, attachment_paths, updated_at[)]\s+on table public[.]assignments to authenticated/i);
    expect(migration).not.toMatch(/grant update [(][^)]*(student_id|created_by)/i);
  });

  it('covers immutable assignment ownership in database role checks', () => {
    const rls = readFileSync(resolve(root, 'supabase/tests/rls_checks.sql'), 'utf8');
    expect(rls).toContain("has_column_privilege(current_user, 'public.assignments', 'student_id', 'UPDATE')");
    expect(rls).toContain("has_column_privilege(current_user, 'public.assignments', 'created_by', 'UPDATE')");
    expect(rls).toContain("has_column_privilege(current_user, 'public.assignments', 'title', 'UPDATE')");
    expect(rls).toMatch(/update public[.]assignments set title = title where student_id = auth[.]uid[(][)]/i);
    expect(rls).toContain("FAIL(8c): 학생이 assignment를 수정함");
  });

  it('records whether new feedback bodies were composed automatically', () => {
    const migration = readMigration();
    const admin = readFileSync(resolve(root, 'src/portal/admin.js'), 'utf8');
    const student = readFileSync(resolve(root, 'src/portal/student.js'), 'utf8');

    expect(migration).toMatch(/alter table public[.]feedback add column auto_composed boolean/i);
    expect(migration).toMatch(/review_submission_v2[(][\s\S]*p_auto_composed boolean/i);
    expect(migration).toMatch(/if p_auto_composed is null then raise exception 'auto_composed required'/i);
    expect(migration).toMatch(/insert into public[.]feedback [(]submission_id, author_id, body, auto_composed[)]/i);
    expect(migration).toMatch(/review_submission_v2[(][\s\S]*p_items jsonb default[\s\S]*perform public[.]review_submission_v2[^;]+false[)][\s\S]*update public[.]feedback[\s\S]*set auto_composed = null/i);
    expect(admin).toContain('p_auto_composed: autoComposed');
    expect(admin).toContain('feedback(body,auto_composed,created_at,feedback_items');
    expect(student).toContain('feedback(body,auto_composed,created_at,feedback_items');
    expect(admin).toContain('isMissingFeedbackSourceColumn(result.error)');
    expect(student).toContain('isMissingFeedbackSourceColumn(result.error)');
    expect(admin).toContain('isMissingExplicitFeedbackRpc(result.error)');
    expect(admin).toContain('LEGACY_FEEDBACK_SELECT');
    expect(student).toContain('LEGACY_FEEDBACK_SELECT');
  });
});
