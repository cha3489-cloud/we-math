import { afterEach, describe, expect, it } from 'vitest';
import { createOpsDb, seedClass, asActor, STUDENT_PROFILE, OPS_MIGRATIONS as SCHEDULER_MIGRATIONS } from './helpers/ops-db.js';
import { buildOperationsBuckets } from '../src/portal/operations-dashboard.js';

let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const snapshotFor = async (day) => (await db.query(`select private.admin_operations_snapshot_for($1::date) as s`, [day])).rows[0].s;
const page = async (queue, cursor, day = '2099-11-16', limit = 50) =>
  (await db.query(`select private.operations_queue_page($1, $2::date, $3, $4) as p`, [queue, day, cursor, limit])).rows[0].p;

describe('unresolved queue keyset pagination', () => {
  it('caps older unresolved sessions at 50 with aggregate counts and pages without duplicates', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    const s = await seedClass(db);
    // 60 stale scheduled rows on earlier days (one per day, two share the exact same start across groups).
    for (let i = 0; i < 60; i += 1) {
      const start = new Date(Date.UTC(2099, 8, 1 + i, 7, 0));
      await db.query(`select public.admin_create_class_session($1, $2, $3, 8)`, [s.group, start.toISOString(), new Date(start.getTime() + 3600_000).toISOString()]);
    }
    const s2 = await seedClass(db, { name: '라마바' });
    await db.query(`select public.admin_create_class_session($1, '2099-09-01T07:00:00Z', '2099-09-01T08:00:00Z', 8)`, [s2.group]);
    // Today's session stays complete in the initial snapshot.
    await db.query(`select public.admin_create_class_session($1, '2099-11-16T07:00:00Z', '2099-11-16T08:00:00Z', 8)`, [s.group]);

    const snap = await snapshotFor('2099-11-16');
    expect(snap.page_size).toBe(50);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.unresolved_sessions).toHaveLength(50);
    expect(snap.queues.unresolved_sessions).toMatchObject({ total: 61, missing: 61, checkout_needed: 0, has_more: true });
    expect(typeof snap.queues.unresolved_sessions.next_cursor).toBe('string');

    const next = await page('unresolved_sessions', snap.queues.unresolved_sessions.next_cursor);
    expect(next.items).toHaveLength(11);
    expect(next.has_more).toBe(false);
    expect(next.next_cursor).toBeNull();
    const ids = [...snap.unresolved_sessions, ...next.items].map((r) => r.attendance_id);
    expect(new Set(ids).size).toBe(61);
    const all = (await db.query(`select r.id from public.attendance_records r join public.class_sessions cs on cs.id = r.class_session_id where cs.starts_at < '2099-11-15T15:00:00Z' order by cs.starts_at, r.id`)).rows.map((r) => r.id);
    expect(ids).toEqual(all);

    // Card counts use the full aggregate, never just the loaded page.
    const { counts } = buildOperationsBuckets(snap, '2099-11-16T06:00:00Z');
    expect(counts.missing).toBe(61);

    // Smaller pages prove exact boundaries.
    const p1 = await page('unresolved_sessions', null, '2099-11-16', 25);
    const p2 = await page('unresolved_sessions', p1.next_cursor, '2099-11-16', 25);
    const p3 = await page('unresolved_sessions', p2.next_cursor, '2099-11-16', 25);
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([25, 25, 11]);
    expect([p1.has_more, p2.has_more, p3.has_more]).toEqual([true, true, false]);
    expect([...p1.items, ...p2.items, ...p3.items].map((r) => r.attendance_id)).toEqual(all);
  }, 60_000);

  it('pages failed messages and makeup drafts by stable keys and keeps payloads secret-safe', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    const s = await seedClass(db);
    for (const name of ['일', '이', '삼']) {
      const lone = (await db.query(`select public.admin_create_student($1, '중2') as id`, [name])).rows[0].id;
      await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [lone, s.course, s.group]);
    }
    const session = (await db.query(`select public.admin_create_class_session($1, '2099-11-16T07:00:00Z', '2099-11-16T08:00:00Z', 8) as id`, [s.group])).rows[0].id;
    await db.query(`update public.attendance_records set status='absent' where class_session_id=$1 and student_id <> $2`, [session, s.student]);
    const failedIds = (await db.query(`select id from public.parent_messages where status='failed' order by failed_at desc, id desc`)).rows.map((r) => r.id);
    expect(failedIds).toHaveLength(3);

    const p1 = await page('failed_messages', null, '2099-11-16', 2);
    const p2 = await page('failed_messages', p1.next_cursor, '2099-11-16', 2);
    expect(p1.has_more).toBe(true);
    expect(p2.has_more).toBe(false);
    expect([...p1.items, ...p2.items].map((m) => m.id)).toEqual(failedIds);
    expect(JSON.stringify([p1, p2])).not.toMatch(/rendered_body|recipient_phone|010-/);

    const snap = await snapshotFor('2099-11-16');
    expect(snap.queues.failed_messages).toMatchObject({ total: 3, has_more: false, next_cursor: null });
    expect(snap.queues.makeup_drafts).toMatchObject({ has_more: false });
    expect(snap.queues.makeup_drafts.total).toBe(snap.makeup_drafts.length);
    const drafts = await page('makeup_drafts', null, '2099-11-16', 1);
    expect(JSON.stringify(drafts)).not.toMatch(/selection_token/);
  }, 60_000);

  it('fails closed on malformed cursors, unknown queues, and non-admin callers', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    await seedClass(db);
    for (const bad of ['', 'x', '2099-11-16T00:00:00.000000Z', '2099-13-16T00:00:00.000000Z~00000000-0000-0000-0000-000000000000', "2099-11-16T00:00:00.000000Z~nope';--"]) {
      await expect(db.query(`select public.admin_operations_queue_page('failed_messages', $1)`, [bad])).rejects.toThrow(/invalid cursor/);
    }
    await expect(db.query(`select public.admin_operations_queue_page('student_attendance_codes', null)`)).rejects.toThrow(/invalid queue/);
    const ok = (await db.query(`select public.admin_operations_queue_page('failed_messages', null) as p`)).rows[0].p;
    expect(ok).toMatchObject({ items: [], has_more: false, next_cursor: null });
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    await expect(db.query(`select public.admin_operations_queue_page('failed_messages', null)`)).rejects.toThrow(/admin required/);
    await asActor(db);
  }, 30_000);
});
