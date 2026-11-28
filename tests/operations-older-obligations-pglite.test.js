import { afterEach, describe, expect, it } from 'vitest';
import { createOpsDb, seedClass, issueTestCode, testVerifier, asActor, STUDENT_PROFILE, OPS_MIGRATIONS } from './helpers/ops-db.js';
import { buildOperationsBuckets, mergeQueuePage } from '../src/portal/operations-dashboard.js';

let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
const snapshotFor = async (day) => (await one(`select private.admin_operations_snapshot_for($1::date) as s`, [day])).s;
const page = async (queue, cursor, day, limit = 50) =>
  (await one(`select private.operations_queue_page($1, $2::date, $3, $4) as p`, [queue, day, cursor, limit])).p;

// An older, fully completed visit (checked in and out, no open follow-up) whose learning plan was
// never published and whose present/checkout parent messages are still drafts.
async function seedCompletedOlderVisit() {
  db = await createOpsDb(OPS_MIGRATIONS);
  const s = await seedClass(db);
  const token = (await one(`select public.admin_register_kiosk_device('입구') as t`)).t;
  const verifier = await testVerifier(await issueTestCode(db, s.student, '482913'));
  const session = (await one(`select public.admin_create_class_session($1, '2099-11-15T07:00:00Z', '2099-11-15T08:00:00Z', 8) as id`, [s.group])).id;
  await db.query(`select private.kiosk_attendance_at($1, 'check_in', $2, '2099-11-15T06:55:00Z', '')`, [token, verifier]);
  await db.query(`select private.kiosk_attendance_at($1, 'check_out', $2, '2099-11-15T08:05:00Z', '')`, [token, verifier]);
  await db.query(`select private.run_attendance_followups('2099-11-16T06:00:00Z')`);
  const record = (await one(`select id, status, checked_out_at from public.attendance_records where class_session_id=$1`, [session]));
  return { s, session, record };
}

describe('older unresolved operations obligations', () => {
  it('keeps an older completed visit with an unpublished plan and draft parent messages in the unresolved queue', async () => {
    const { s, record } = await seedCompletedOlderVisit();
    // Preconditions: nothing else would keep this row in the older queue.
    expect(record.status).toBe('present');
    expect(record.checked_out_at).not.toBeNull();
    expect(await all(`select kind from public.attendance_followups where attendance_id=$1 and status='open'`, [record.id])).toEqual([]);
    expect(await all(`select status from public.daily_learning_plans where student_id=$1`, [s.student])).toEqual([{ status: 'draft' }]);
    expect(await all(`select message_type, status from public.parent_messages where attendance_id=$1 order by message_type`, [record.id]))
      .toEqual([{ message_type: 'checkout', status: 'draft' }, { message_type: 'present', status: 'draft' }]);

    for (const day of ['2099-11-16', '2100-03-01']) {
      const snap = await snapshotFor(day);
      expect(snap.unresolved_sessions.map((r) => r.attendance_id)).toEqual([record.id]);
      expect(snap.queues.unresolved_sessions).toMatchObject({ total: 1, present: 1, plan_missing: 1, has_more: false });
      expect(snap.draft_messages.map((m) => m.message_type).sort()).toEqual(['checkout', 'present']);
      expect(snap.queues.draft_messages).toMatchObject({ total: 2, has_more: false, next_cursor: null });
      const { counts, lists } = buildOperationsBuckets(snap, `${day}T06:30:00Z`);
      expect(counts.plan_missing).toBe(1);
      expect(counts.message_draft).toBe(2);
      expect(lists.message_draft).toHaveLength(2);
    }
  }, 60_000);

  it('pages draft messages with the same population as the aggregate and keeps payloads secret-safe', async () => {
    const { record } = await seedCompletedOlderVisit();
    const ids = (await all(`select id from public.parent_messages where status in ('draft','approved') and message_type <> 'makeup_offer' order by created_at, id`)).map((r) => r.id);
    expect(ids).toHaveLength(2);
    const p1 = await page('draft_messages', null, '2099-11-16', 1);
    const p2 = await page('draft_messages', p1.next_cursor, '2099-11-16', 1);
    expect([p1.has_more, p2.has_more]).toEqual([true, false]);
    expect(p2.next_cursor).toBeNull();
    expect([...p1.items, ...p2.items].map((m) => m.id)).toEqual(ids);
    expect(p1.items[0]).toMatchObject({ attendance_id: record.id, status: 'draft', student_name: '가나다' });
    expect(JSON.stringify([p1, p2])).not.toMatch(/rendered_body|recipient_phone|010-|482913/);
    const snap = await snapshotFor('2099-11-16');
    const merged = mergeQueuePage({ ...snap, draft_messages: p1.items, queues: { ...snap.queues, draft_messages: { ...snap.queues.draft_messages, has_more: true } } }, 'draft_messages', p2);
    expect(merged.draft_messages.map((m) => m.id)).toEqual(ids);
    expect(merged.queues.draft_messages.has_more).toBe(false);
  }, 60_000);

  it('resolves only after every message is approved or cancelled and the plan is published', async () => {
    const { s, record } = await seedCompletedOlderVisit();
    const present = (await one(`select id from public.parent_messages where attendance_id=$1 and message_type='present'`, [record.id])).id;
    const checkout = (await one(`select id from public.parent_messages where attendance_id=$1 and message_type='checkout'`, [record.id])).id;

    await db.query(`select public.admin_approve_message_template('attendance_present')`);
    await db.query(`select public.admin_approve_parent_message($1)`, [present]);
    expect((await one(`select status from public.parent_messages where id=$1`, [present])).status).toBe('queued');
    let snap = await snapshotFor('2099-11-16');
    expect(snap.draft_messages.map((m) => m.id)).toEqual([checkout]);
    expect(snap.queues.draft_messages.total).toBe(1);
    expect(snap.queues.unresolved_sessions.total).toBe(1);

    await db.query(`select public.admin_cancel_parent_message($1, 'draft')`, [checkout]);
    snap = await snapshotFor('2099-11-16');
    expect(snap.draft_messages).toEqual([]);
    expect(snap.queues.draft_messages.total).toBe(0);
    // The unpublished plan alone still keeps the older visit open.
    expect(snap.unresolved_sessions.map((r) => r.attendance_id)).toEqual([record.id]);
    expect(snap.queues.unresolved_sessions).toMatchObject({ total: 1, plan_missing: 1 });

    const plan = await one(`select id, source_revision from public.daily_learning_plans where student_id=$1 and status='draft'`, [s.student]);
    await db.query(`select public.admin_publish_learning_plan($1, $2)`, [plan.id, plan.source_revision]);
    snap = await snapshotFor('2099-11-16');
    expect(snap.unresolved_sessions).toEqual([]);
    expect(snap.queues.unresolved_sessions.total).toBe(0);
  }, 60_000);

  it('exposes the draft queue to admins only through the public page RPC', async () => {
    await seedCompletedOlderVisit();
    const ok = (await one(`select public.admin_operations_queue_page('draft_messages', null) as p`)).p;
    expect(ok.items).toHaveLength(2);
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    await expect(db.query(`select public.admin_operations_queue_page('draft_messages', null)`)).rejects.toThrow(/admin required/);
    await asActor(db);
  }, 60_000);
});
