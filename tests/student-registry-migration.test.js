import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const migrationPath = resolve(root, 'supabase/migrations/20261031010000_student_registry.sql');
const source = () => existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const executable = () => source().split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');

describe('persistent student registry migration', () => {
  it('creates a student operations ledger separate from login profiles without production seed rows', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = executable();
    for (const table of ['students', 'guardians', 'courses', 'class_groups', 'enrollments', 'student_registry_audit']) {
      expect(sql).toMatch(new RegExp(`create table public[.]${table}\\b`, 'i'));
    }
    expect(sql).toMatch(/students[\s\S]*account_profile_id uuid[\s\S]*references public[.]profiles[(]id[)] on delete set null/i);
    expect(sql).not.toMatch(/create table public[.]students[\s\S]{0,200}id uuid[^,]*references public[.]profiles/i);
    const ddlOnly = sql.slice(0, sql.indexOf('create function public.admin_create_student'));
    expect(ddlOnly).not.toMatch(/insert into public[.](students|guardians|courses|class_groups|enrollments)\b/i);
  });

  it('enforces admin-only row visibility and RPC-only writes', () => {
    const sql = executable();
    for (const table of ['students', 'guardians', 'courses', 'class_groups', 'enrollments', 'student_registry_audit']) {
      expect(sql).toMatch(new RegExp(`alter table public[.]${table} enable row level security`, 'i'));
      expect(sql).toMatch(new RegExp(`revoke all on table public[.]${table} from public, anon, authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`create policy [^;]+ on public[.]${table}[\\s\\S]{0,180}for select to authenticated[\\s\\S]{0,120}public[.]is_admin[(][)]`, 'i'));
    }
    for (const table of ['students', 'guardians', 'courses', 'class_groups', 'enrollments']) {
      expect(sql).toMatch(new RegExp(`grant select on table public[.]${table} to authenticated`, 'i'));
      expect(sql).not.toMatch(new RegExp(`grant (insert|update|delete|all)[^;]*public[.]${table}[^;]*to authenticated`, 'i'));
    }
  });

  it('lets the database control actor columns and records immutable audit rows', () => {
    const sql = executable();
    expect(sql).toMatch(/create function public[.]prepare_student_registry_row[(][)]/i);
    expect(sql).toMatch(/new[.]created_by := auth[.]uid[(][)]/i);
    expect(sql).toMatch(/new[.]updated_by := auth[.]uid[(][)]/i);
    expect(sql).toMatch(/create function public[.]audit_student_registry_row[(][)]/i);
    expect(sql).toMatch(/insert into public[.]student_registry_audit/i);
    expect(sql).toMatch(/raise exception 'audit rows are immutable'/i);
    expect(sql).toMatch(/on delete restrict/i);
  });

  it('exposes narrow admin create and update RPCs but no delete path', () => {
    const sql = executable();
    for (const fn of ['admin_create_student', 'admin_update_student']) {
      expect(sql).toMatch(new RegExp(`create function public[.]${fn}[(]`, 'i'));
      expect(sql).toMatch(new RegExp(`${fn}[\\s\\S]*security definer[\\s\\S]*public[.]is_admin[(][)]`, 'i'));
      expect(sql).toMatch(new RegExp(`revoke all on function public[.]${fn}[^;]+from public, anon`, 'i'));
      expect(sql).toMatch(new RegExp(`grant execute on function public[.]${fn}[^;]+to authenticated`, 'i'));
    }
    expect(sql).not.toMatch(/create function public[.]admin_delete_student/i);
    expect(sql).not.toMatch(/delete from public[.](students|guardians|enrollments)/i);
  });

  it('keeps class groups consistent with their course and retains business history', () => {
    const sql = executable();
    expect(sql).toMatch(/unique [(]id, course_id[)]/i);
    expect(sql).toMatch(/foreign key [(]class_group_id, course_id[)][\s\S]{0,100}references public[.]class_groups [(]id, course_id[)] on delete restrict/i);
    expect(sql).toMatch(/check [(]ended_on is null or ended_on >= enrolled_on[)]/i);
  });

  it('rejects clearing an existing primary guardian before mutating the student', () => {
    const sql = executable();
    const updateRpc = sql.slice(
      sql.indexOf('create function public.admin_update_student'),
      sql.indexOf('revoke all on function public.admin_create_student'),
    );
    expect(updateRpc).toMatch(/v_guardian_name = '' and v_guardian_phone = ''[\s\S]*exists[\s\S]*from public[.]guardians[\s\S]*is_primary[\s\S]*raise exception 'primary guardian cannot be cleared'/i);
    expect(updateRpc.indexOf("raise exception 'primary guardian cannot be cleared'")).toBeLessThan(updateRpc.indexOf('update public.students'));
  });
});
