import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migrationPath = 'supabase/migrations/20261028000000_attendance_makeup_operations.sql';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const executable = (sql) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('attendance and makeup operations', () => {
  it('creates an admin-only attendance source of truth without browser delete access', () => {
    expect(existsSync(resolve(root, migrationPath))).toBe(true);
    const sql = read(migrationPath);
    const code = executable(sql);

    expect(sql).toMatch(/create table public[.]attendance_records/i);
    expect(sql).toMatch(/student_id uuid not null references public[.]profiles[(]id[)] on delete restrict/i);
    expect(sql).toMatch(/created_by uuid not null references public[.]profiles[(]id[)] on delete restrict/i);
    expect(sql).toMatch(/updated_by uuid not null references public[.]profiles[(]id[)] on delete restrict/i);
    expect(sql).toMatch(/absence_reason is null or status in [(]'absent', 'excused'[)]/i);
    expect(sql).toMatch(/scheduled_at timestamptz not null/i);
    expect(sql).toMatch(/status text not null default 'scheduled'/i);
    expect(sql).toMatch(/unique [(]student_id, scheduled_at[)]/i);
    expect(sql).toMatch(/alter table public[.]attendance_records enable row level security/i);
    expect(sql).toMatch(/attendance records visible to admins[\s\S]*for select to authenticated\s+using [(]public[.]is_admin[(][)][)]/i);
    expect(sql).toMatch(/admins create attendance records[\s\S]*created_by = auth[.]uid[(][)][\s\S]*updated_by = auth[.]uid[(][)]/i);
    expect(sql).toMatch(/admins update attendance records[\s\S]*using [(]public[.]is_admin[(][)][)][\s\S]*with check [(]public[.]is_admin[(][)][)]/i);
    expect(sql).toMatch(/touch_attendance_record[\s\S]*new[.]student_id is distinct from old[.]student_id[\s\S]*new[.]created_by is distinct from old[.]created_by[\s\S]*new[.]updated_by := auth[.]uid[(][)]/i);
    expect(sql).toMatch(/revoke all on function public[.]touch_attendance_record[(][)] from public, anon, authenticated/i);
    expect(sql).toMatch(/check [(]status in [(]'scheduled', 'present', 'late', 'absent', 'excused'[)]/i);
    expect(sql).toMatch(/revoke all on table public[.]attendance_records from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select, insert on table public[.]attendance_records to authenticated/i);
    expect(sql).toMatch(/grant update [(][^)]*status[^)]*[)]\s*on table public[.]attendance_records to authenticated/i);
    expect(code).not.toMatch(/grant[^;]*delete[^;]*attendance_records/i);
    expect(code).not.toMatch(/attendance records[^;]*for delete/i);
  });

  it('stores one guarded makeup plan per absence and preserves an admin-only audit trail', () => {
    const sql = read(migrationPath);
    const code = executable(sql);

    expect(sql).toMatch(/create table public[.]makeup_plans/i);
    expect(sql).toMatch(/attendance_id uuid not null unique references public[.]attendance_records[(]id[)]/i);
    expect(sql).toMatch(/status text not null default 'planned'[\s\S]*check [(]status in [(]'planned', 'completed', 'cancelled'[)]/i);
    expect(sql).toMatch(/method text not null[\s\S]*in_person[\s\S]*video[\s\S]*assignment/i);
    expect(sql).toMatch(/guardian_contact_status text[\s\S]*contacted[\s\S]*unreachable/i);
    expect(sql).toMatch(/validate_makeup_plan[\s\S]*attendance_contact_status is null or attendance_contact_status not in [(]'contacted', 'unreachable'[)]/i);
    expect(sql).toMatch(/validate_makeup_plan[\s\S]*attendance_status not in [(]'absent', 'excused'[)]/i);
    expect(sql).toMatch(/old[.]status = 'completed'[\s\S]*new[.]status is distinct from old[.]status[\s\S]*new[.]scheduled_at is distinct from old[.]scheduled_at[\s\S]*new[.]completed_at is distinct from old[.]completed_at[\s\S]*new[.]method is distinct from old[.]method/i);
    expect(sql).toMatch(/old[.]status = 'cancelled'[\s\S]*new[.]status = 'completed'/i);
    expect(sql).toMatch(/validate_attendance_makeup_state[\s\S]*new[.]status not in [(]'absent', 'excused'[)][\s\S]*exists [(][\s\S]*public[.]makeup_plans/i);
    expect(sql).toMatch(/validate_attendance_makeup_state[\s\S]*new[.]guardian_contact_status is null[\s\S]*exists [(][\s\S]*public[.]makeup_plans/i);
    expect(sql).toMatch(/before update of status, guardian_contact_status, guardian_contacted_at on public[.]attendance_records/i);
    expect(sql).toMatch(/touch_makeup_plan[\s\S]*new[.]attendance_id is distinct from old[.]attendance_id[\s\S]*new[.]created_by is distinct from old[.]created_by[\s\S]*new[.]updated_by := auth[.]uid[(][)]/i);
    expect(sql).toMatch(/alter table public[.]makeup_plans enable row level security/i);
    expect(sql).toMatch(/makeup plans visible to admins[\s\S]*for select to authenticated\s+using [(]public[.]is_admin[(][)][)]/i);
    expect(sql).toMatch(/admins create makeup plans[\s\S]*created_by = auth[.]uid[(][)][\s\S]*updated_by = auth[.]uid[(][)]/i);
    expect(sql).toMatch(/revoke all on table public[.]makeup_plans from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select, insert on table public[.]makeup_plans to authenticated/i);
    expect(sql).toMatch(/grant update [(][^)]*status[^)]*[)]\s*on table public[.]makeup_plans to authenticated/i);
    expect(code).not.toMatch(/grant[^;]*delete[^;]*makeup_plans/i);
    expect(code).not.toMatch(/makeup plans[^;]*for delete/i);

    expect(sql).toMatch(/create table public[.]attendance_events/i);
    expect(sql).toMatch(/details jsonb not null default '[{][}]'::jsonb/i);
    expect(sql).toMatch(/alter table public[.]attendance_events enable row level security/i);
    expect(sql).toMatch(/attendance events visible to admins[\s\S]*for select to authenticated\s+using [(]public[.]is_admin[(][)][)]/i);
    expect(sql).toMatch(/record_attendance_event[\s\S]*jsonb_build_object/i);
    expect(sql).toMatch(/record_makeup_event[\s\S]*jsonb_build_object/i);
    expect(sql).toMatch(/revoke all on table public[.]attendance_events from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select on table public[.]attendance_events to authenticated/i);
    expect(code).not.toMatch(/grant[^;]*(insert|update|delete)[^;]*attendance_events/i);
  });

  it('adds one real attendance workspace instead of a placeholder menu', async () => {
    const admin = read('admin/index.html');
    const shell = read('src/portal/admin-shell.js');
    const adminJs = read('src/portal/admin.js');

    expect(admin).toContain('data-admin-view=attendance');
    expect(admin).toContain('id=attendanceSection');
    expect(admin).toContain('id=attendanceRecordForm');
    expect(admin).toContain('id=attendanceStudent');
    expect(admin).toContain('id=attendanceScheduledAt');
    expect(admin).toContain('id=attendanceStatus');
    expect(admin).toContain('id=attendanceAbsenceReason');
    expect(admin).toContain('오늘 출결·미처리 연락');
    expect(admin).toContain('id=attendanceList');
    expect(admin).toContain('id=makeupPlanForm');
    expect(admin).toContain('id=makeupAttendance');
    expect(admin).toContain('id=makeupScheduledAt');
    expect(admin).toContain('id=makeupMethod');
    expect(admin).toContain('id=makeupList');
    expect(admin).toContain('id=attendanceBackendNotice');
    expect(admin).not.toContain('가상 출결');

    expect(shell).toContain("'attendance'");
    expect(shell).toContain("attendance: ['수업운영', '출결·보강'");
    expect(shell).toContain("attendance: document.getElementById('attendanceSection')");
    expect(adminJs).toMatch(/from ['"]~?[.]?\/?attendance[.]js['"]|from ['"][.]\/attendance[.]js['"]/);
    expect(adminJs).toContain("supabase.from('attendance_records')");
    expect(adminJs).toContain("supabase.from('makeup_plans')");
    expect(adminJs).toContain('isAttendanceBackendMissing');
    expect(adminJs).toContain('attendanceNextAction');
    expect(adminJs).toContain('학부모 연락 완료');
    expect(adminJs).toContain('학부모 연락 안 됨');

    const { activateAdminView } = await import('../src/portal/admin-shell.js');
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(`
      <button data-admin-view="dashboard" aria-current="page"></button>
      <button data-admin-view="attendance"></button>
      <span id="adminCrumbGroup"></span><span id="adminCrumbTitle"></span>
      <h1 id="adminViewTitle"></h1><p id="adminViewDescription"></p>
      <section id="adminDashboard"></section><section id="reviewSection"></section>
      <section id="manageSection"></section><section id="questionsSection"></section>
      <section id="attendanceSection"></section>
    `);
    activateAdminView(dom.window.document, 'attendance');
    expect(dom.window.document.getElementById('attendanceSection').hidden).toBe(false);
    expect(dom.window.document.getElementById('adminDashboard').hidden).toBe(true);
    expect(dom.window.document.querySelectorAll('[data-admin-view][aria-current="page"]')).toHaveLength(1);
    expect(dom.window.document.querySelector('[data-admin-view="attendance"]').getAttribute('aria-current')).toBe('page');
    expect(dom.window.document.getElementById('adminCrumbTitle').textContent).toBe('출결·보강');
  });

  it('keeps private attendance sources out of member bundles and guards stale admin loads', () => {
    const adminJs = read('src/portal/admin.js');
    const studentSources = [
      read('src/portal/student.js'), read('src/portal/domain.js'),
      read('src/tablet/main.js'), read('src/tablet/view-model.js'), read('src/tablet/question.js'),
      read('src/tablet/submission.js'), read('src/tablet/difficulty.js'),
    ].join('\n');

    for (const marker of ['attendance_records', 'makeup_plans', 'attendance_events', 'guardian_contacted_at', 'guardian_contact_status']) {
      expect(studentSources).not.toContain(marker);
    }
    expect(adminJs).toContain('const attendanceRequestGate = createLatestRequestGate()');
    expect(adminJs).toContain('let activeAttendanceNavigation = null');
    expect(adminJs).toMatch(/refreshAttendanceAfterCommit[(]message, output, navigation[)][\s\S]*!isCurrentAdminNavigation[(]navigation[)][\s\S]*loadAttendanceOperations[(]navigation[)]/);
    expect(adminJs).not.toMatch(/refreshAttendanceAfterCommit[\s\S]{0,160}adminNavigationGate[.]begin[(][)]/);
    expect(adminJs).toMatch(/updateAttendanceRecord[\s\S]*select[(]'id'[)][\s\S]*single[(][)][\s\S]*if [(]!data[?][.]id[)]/);
    expect(adminJs).toMatch(/updateMakeupPlan[\s\S]*select[(]'id'[)][\s\S]*single[(][)][\s\S]*if [(]!data[?][.]id[)]/);
    expect(adminJs).toMatch(/const actionableRows = attendanceRows[.]filter[\s\S]*dayKey[(]row[.]scheduled_at[)] === today \|\| attendanceNextAction[(]row[)] === 'guardian_contact'/);
    expect(adminJs).toContain('collectKeysetPages(fetchAttendanceOperationsPage');
    expect(adminJs).toContain('collectKeysetPages(fetchHistoricalAttendanceFollowupPage');
    expect(adminJs).toContain('collectKeysetPages(fetchMakeupOperationsPage');
    expect(adminJs).toMatch(/new Map[(][\s\S]*recentAttendanceResult[.]data[\s\S]*historicalAttendanceResult[.]data/);
    expect(adminJs).toMatch(/loadAttendanceOperations[(]navigation = null[)][\s\S]*await Promise[.]all[\s\S]*!attendanceRequestGate[.]isLatest[(]request[)] \|\| !isCurrentAdminNavigation[(]navigation[)]/);
    expect(adminJs).toMatch(/updateAttendanceRecord[(]recordId,[\s\S]*from[(]'attendance_records'[)][.]update[(]patch[)][.]eq[(]'id', recordId[)]/);
    expect(adminJs).toMatch(/updateMakeupPlan[(]planId,[\s\S]*from[(]'makeup_plans'[)][.]update[(]patch[)][.]eq[(]'id', planId[)]/);
    expect(adminJs).toContain("'처리는 완료됐지만 화면 새로고침에 실패했습니다.'");
  });

  it('derives the next academy action without inventing attendance data', async () => {
    const modulePath = resolve(root, 'src/portal/attendance.js');
    expect(existsSync(modulePath)).toBe(true);
    const { attendanceNextAction } = await import('../src/portal/attendance.js');

    expect(attendanceNextAction({ status: 'scheduled' })).toBe('check_in');
    expect(attendanceNextAction({ status: 'absent', guardian_contact_status: null, guardian_contacted_at: null, makeup_plans: [] })).toBe('guardian_contact');
    expect(attendanceNextAction({ status: 'absent', guardian_contact_status: null, guardian_contacted_at: '2026-10-28T10:00:00Z', makeup_plans: [] })).toBe('guardian_contact');
    expect(attendanceNextAction({ status: 'absent', guardian_contact_status: 'contacted', guardian_contacted_at: '2026-10-28T10:00:00Z', makeup_plans: [] })).toBe('makeup_plan');
    expect(attendanceNextAction({ status: 'absent', guardian_contact_status: 'unreachable', guardian_contacted_at: '2026-10-28T10:00:00Z', makeup_plans: [] })).toBe('makeup_plan');
    expect(attendanceNextAction({
      status: 'absent', guardian_contact_status: 'contacted',
      guardian_contacted_at: '2026-10-28T10:00:00Z', makeup_plans: [{ status: 'planned' }],
    })).toBe('makeup_pending');
    expect(attendanceNextAction({
      status: 'absent', guardian_contact_status: 'contacted',
      guardian_contacted_at: '2026-10-28T10:00:00Z', makeup_plans: [{ status: 'completed' }],
    })).toBe(null);
    expect(attendanceNextAction({ status: 'present', checked_in_at: '2026-10-28T10:00:00Z' })).toBe(null);
  });

  it('hides only the expected missing-backend condition during a staged rollout', async () => {
    const modulePath = resolve(root, 'src/portal/attendance.js');
    expect(existsSync(modulePath)).toBe(true);
    const { isAttendanceBackendMissing, areAttendanceBackendErrorsMissing } = await import('../src/portal/attendance.js');

    const missingAttendance = { code: '42P01', message: 'relation "public.attendance_records" does not exist' };
    const missingMakeup = { code: 'PGRST205', message: "Could not find the table 'public.makeup_plans'" };
    const permissionDenied = { code: '42501', message: 'permission denied for table makeup_plans' };
    expect(isAttendanceBackendMissing(missingAttendance)).toBe(true);
    expect(isAttendanceBackendMissing({ code: 'PGRST205', message: "Could not find the table 'public.attendance_records'" })).toBe(true);
    expect(isAttendanceBackendMissing(permissionDenied)).toBe(false);
    expect(isAttendanceBackendMissing({ code: '42P01', message: 'relation "public.other_table" does not exist' })).toBe(false);
    expect(isAttendanceBackendMissing(null)).toBe(false);
    expect(areAttendanceBackendErrorsMissing([missingAttendance, missingMakeup])).toBe(true);
    expect(areAttendanceBackendErrorsMissing([missingAttendance, permissionDenied])).toBe(false);
    expect(areAttendanceBackendErrorsMissing([null, undefined])).toBe(false);
  });
});
