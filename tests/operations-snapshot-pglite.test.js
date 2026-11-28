import { afterEach, describe, expect, it } from 'vitest';
import { createOpsDb, seedClass, issueTestCode, testVerifier } from './helpers/ops-db.js';
import { buildOperationsBuckets } from '../src/portal/operations-dashboard.js';

const MIGRATIONS = [
  '20261115000000_kiosk_attendance_core.sql',
  '20261115010000_parent_message_outbox.sql',
  '20261115020000_daily_learning_plans.sql',
  '20261115030000_makeup_offers.sql',
  '20261115040000_admin_operations_snapshot.sql',
];
let db;
afterEach(async () => { if (db) await db.close(); db = null; });

describe('admin operations snapshot', () => {
  it('returns today plus older unresolved work from one population without secrets', async () => {
    db = await createOpsDb(MIGRATIONS);
    const s = await seedClass(db);
    const token = (await db.query(`select public.admin_register_kiosk_device('입구') as t`)).rows[0].t;
    const code = await issueTestCode(db, s.student, '482913');
    const verifier = await testVerifier(code);
    const yesterday = (await db.query(`select public.admin_create_class_session($1, '2099-11-15T07:00:00Z', '2099-11-15T08:00:00Z', 8) as id`, [s.group])).rows[0].id;
    const today = (await db.query(`select public.admin_create_class_session($1, '2099-11-16T07:00:00Z', '2099-11-16T08:00:00Z', 8) as id`, [s.group])).rows[0].id;
    await db.query(`select private.kiosk_attendance_at($1, 'check_in', $2, '2099-11-15T06:50:00Z', '')`, [token, verifier]);
    await db.query(`select private.run_attendance_followups('2099-11-16T06:00:00Z')`);
    const todayRecord = (await db.query(`select id from public.attendance_records where class_session_id=$1`, [today])).rows[0].id;
    await db.query(`select public.admin_set_attendance_exception($1, 'planned_absence', null, 'medical', '내부 메모')`, [todayRecord]);

    const snap = (await db.query(`select private.admin_operations_snapshot_for('2099-11-16'::date) as s`)).rows[0].s;
    expect(snap.sessions.map((r) => r.attendance_id).sort()).toEqual(
      (await db.query(`select id from public.attendance_records order by id`)).rows.map((r) => r.id).sort(),
    );
    const old = snap.sessions.find((r) => r.class_session_id === yesterday);
    expect(old.open_followups).toEqual(['checkout_needed']);
    expect(old.student_name).toBe('가나다');
    const planned = snap.sessions.find((r) => r.class_session_id === today);
    expect(planned.exception).toMatchObject({ type: 'planned_absence', status: 'active' });
    expect(snap.failed_messages).toEqual([]);
    expect(snap.makeup_drafts.map((b) => [b.origin, b.status, b.manual_reason])).toEqual([['planned_absence', 'manual_followup', 'insufficient_capacity']]);
    const json = JSON.stringify(snap);
    expect(json).not.toContain(code);
    expect(json).not.toContain(verifier);
    expect(json).not.toContain('code_verifier');
    expect(json).not.toContain('010-0000-0000');

    const { counts } = buildOperationsBuckets(snap, '2099-11-16T06:30:00Z');
    expect(counts.checkout_needed).toBe(1);
    expect(counts.planned_exceptions).toBe(1);
    expect(counts.plan_missing).toBe(1);
    expect(counts.makeup_followup).toBe(1);

    await db.exec(`select set_config('test.admin', 'off', false)`);
    await expect(db.query(`select public.admin_today_operations()`)).rejects.toThrow(/admin required/);
  }, 30_000);
});
