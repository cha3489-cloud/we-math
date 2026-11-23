import { afterEach, describe, expect, it } from 'vitest';
import { createOpsDb, seedClass, asActor, ADMIN, STUDENT_PROFILE, OTHER_PROFILE } from './helpers/ops-db.js';

const MIGRATIONS = [
  '20261115000000_kiosk_attendance_core.sql',
  '20261115010000_parent_message_outbox.sql',
  '20261115020000_daily_learning_plans.sql',
];
let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const ITEMS = [
  { item_type: 'auto_progress', title: '일차방정식 활용', progress_sequence: 12, internal_note: '원장 판단: 속도 조절' },
  { item_type: 'mathflat', title: '매쓰플랫 20문항' },
  { item_type: 'redo', title: '지난 오답 3번 재풀이' },
  { item_type: 'carryover', title: '지난 수업 미완료: 연립방정식', progress_sequence: 11 },
  { item_type: 'homework', title: '미제출 숙제 p.30' },
];

async function setup() {
  db = await createOpsDb(MIGRATIONS);
  const s = await seedClass(db);
  await db.query(`update public.students set account_profile_id=$1 where id=$2`, [STUDENT_PROFILE, s.student]);
  const today = (await db.query(`select (now() at time zone 'Asia/Seoul')::date::text as d`)).rows[0].d;
  const plan = (await db.query(`select public.admin_save_learning_plan_draft($1, $2::date, null, $3::jsonb, '학부모 문안 초안') as id`, [s.student, today, JSON.stringify(ITEMS)])).rows[0].id;
  return { ...s, today, plan };
}
const studentView = async () => {
  await asActor(db, { uid: STUDENT_PROFILE, admin: false });
  const r = (await db.query(`select public.student_today_learning_plan() as v`)).rows[0].v;
  await asActor(db);
  return r;
};

describe('daily learning plan snapshot', () => {
  it('hides drafts from the student and shows the published snapshot in fixed priority order without owner-only fields', async () => {
    const s = await setup();
    expect((await studentView()).status).toBe('preparing');
    await db.query(`select public.admin_publish_learning_plan($1, 1)`, [s.plan]);
    const view = await studentView();
    expect(view.status).toBe('ready');
    expect(view.items.map((i) => i.item_type)).toEqual(['homework', 'redo', 'carryover', 'auto_progress', 'mathflat']);
    expect(view.remaining_priority_count).toBe(3);
    expect(view.items.find((i) => i.item_type === 'auto_progress').locked).toBe(true);
    expect(view.items.find((i) => i.item_type === 'homework').locked).toBe(false);
    const json = JSON.stringify(view);
    expect(json).not.toContain('원장 판단');
    expect(json).not.toContain('학부모 문안');
    expect(json).not.toContain('internal_note');
  }, 30_000);

  const asStudent = async (fn) => { await asActor(db, { uid: STUDENT_PROFILE, admin: false }); try { return await fn(); } finally { await asActor(db); } };

  it('keeps student completion as submitted only, idempotently, until a teacher confirms it', async () => {
    const s = await setup();
    await db.query(`select public.admin_publish_learning_plan($1, 1)`, [s.plan]);
    const homework = (await studentView()).items[0];
    expect(await asStudent(async () => (await db.query(`select public.student_submit_learning_item($1) as r`, [homework.id])).rows[0].r)).toBe('submitted');
    expect(await asStudent(async () => (await db.query(`select public.student_submit_learning_item($1) as r`, [homework.id])).rows[0].r)).toBe('already_submitted');
    const events = (await db.query(`select count(*)::int as n from public.operations_audit where entity='daily_learning_plan_items' and entity_id=$1 and action='UPDATE'`, [homework.id])).rows[0].n;
    expect(events).toBe(1);
    let view = await studentView();
    expect(view.items[0]).toMatchObject({ student_status: 'submitted', teacher_status: 'pending' });
    expect(view.remaining_priority_count).toBe(3);
    await db.query(`select public.admin_confirm_learning_item($1)`, [homework.id]);
    await expect(db.query(`select public.admin_confirm_learning_item($1)`, [homework.id])).rejects.toThrow(/state changed/);
    view = await studentView();
    expect(view.remaining_priority_count).toBe(2);
  }, 30_000);

  it('does not let a teacher confirm an item before the student submits completion', async () => {
    const s = await setup();
    await db.query(`select public.admin_publish_learning_plan($1, 1)`, [s.plan]);
    const homework = (await studentView()).items[0];
    await expect(db.query(`select public.admin_confirm_learning_item($1)`, [homework.id])).rejects.toThrow(/student completion submission required/);
  }, 30_000);

  it('blocks new progress while priority work remains until a teacher explicitly approves, auditing what remained', async () => {
    const s = await setup();
    await db.query(`select public.admin_publish_learning_plan($1, 1)`, [s.plan]);
    const progress = (await studentView()).items.find((i) => i.item_type === 'auto_progress');
    await expect(asStudent(() => db.query(`select public.student_submit_learning_item($1)`, [progress.id]))).rejects.toThrow(/priority items must be checked first/);
    await db.query(`select public.admin_approve_new_progress($1)`, [s.plan]);
    const view = await studentView();
    expect(view.new_progress_approved).toBe(true);
    expect(view.remaining_priority_count).toBe(3);
    expect(view.items.find((i) => i.item_type === 'auto_progress').locked).toBe(false);
    const audit = (await db.query(`select after_data, actor_id from public.operations_audit where entity='new_progress_override' and entity_id=$1`, [s.plan])).rows[0];
    expect(audit.actor_id).toBe(ADMIN);
    expect(audit.after_data.remaining_items.map((i) => i.item_type)).toEqual(['homework', 'redo', 'carryover']);
    await expect(db.query(`select public.admin_approve_new_progress($1)`, [s.plan])).rejects.toThrow(/state changed/);
  }, 30_000);

  it('publishes only the latest revision with compare-and-set and the student sees the new revision', async () => {
    const s = await setup();
    await db.query(`select public.admin_publish_learning_plan($1, 1)`, [s.plan]);
    const second = (await db.query(`select public.admin_save_learning_plan_draft($1, $2::date, null, $3::jsonb) as id`, [s.student, s.today, JSON.stringify([{ item_type: 'note', title: '오늘은 개념 복습' }])])).rows[0].id;
    expect((await studentView()).revision).toBe(1);
    await expect(db.query(`select public.admin_publish_learning_plan($1, 1)`, [second])).rejects.toThrow(/revision changed/);
    const third = (await db.query(`select public.admin_save_learning_plan_draft($1, $2::date, null, $3::jsonb) as id`, [s.student, s.today, JSON.stringify([{ item_type: 'note', title: '수정본' }])])).rows[0].id;
    await expect(db.query(`select public.admin_publish_learning_plan($1, 2)`, [second])).rejects.toThrow(/revision changed/);
    await db.query(`select public.admin_publish_learning_plan($1, 3)`, [third]);
    const view = await studentView();
    expect(view.revision).toBe(3);
    expect(view.items.map((i) => i.title)).toEqual(['수정본']);
    expect((await db.query(`select status from public.daily_learning_plans where id=$1`, [s.plan])).rows[0].status).toBe('superseded');
  }, 30_000);

  it('isolates plans to the linked student and denies direct table access to students and anonymous users', async () => {
    const s = await setup();
    await db.query(`select public.admin_publish_learning_plan($1, 1)`, [s.plan]);
    await asActor(db, { uid: OTHER_PROFILE, admin: false });
    expect((await db.query(`select public.student_today_learning_plan() as v`)).rows[0].v).toEqual({ status: 'unlinked' });
    const itemId = (await db.query(`select id from public.daily_learning_plan_items limit 1`)).rows[0].id;
    await expect(db.query(`select public.student_submit_learning_item($1)`, [itemId])).rejects.toThrow(/student account required/);
    await asActor(db);
    await db.exec(`set role authenticated`);
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    expect((await db.query(`select count(*)::int as n from public.daily_learning_plan_items`)).rows[0].n).toBe(0);
    await expect(db.query(`update public.daily_learning_plan_items set teacher_status='confirmed'`)).rejects.toThrow(/permission denied/);
    await db.exec(`reset role; set role anon`);
    await expect(db.query(`select public.student_today_learning_plan()`)).rejects.toThrow(/permission denied/);
    await db.exec(`reset role`);
    await asActor(db);
  }, 30_000);

  it('rejects a linked account unless its DB role is student and forced PIN change is complete', async () => {
    const s = await setup();
    await db.query(`select public.admin_publish_learning_plan($1, 1)`, [s.plan]);
    const itemId = (await db.query(`select id from public.daily_learning_plan_items where plan_id=$1 limit 1`, [s.plan])).rows[0].id;

    await db.query(`update public.user_roles set role='admin' where user_id=$1`, [STUDENT_PROFILE]);
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    expect((await db.query(`select public.student_today_learning_plan() as v`)).rows[0].v).toEqual({ status: 'unlinked' });
    await expect(db.query(`select public.student_submit_learning_item($1)`, [itemId])).rejects.toThrow(/student account required/);

    await asActor(db);
    await db.query(`update public.user_roles set role='student' where user_id=$1`, [STUDENT_PROFILE]);
    await db.query(`update public.profiles set must_change_pin=true where id=$1`, [STUDENT_PROFILE]);
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    expect((await db.query(`select public.student_today_learning_plan() as v`)).rows[0].v).toEqual({ status: 'unlinked' });
    await expect(db.query(`select public.student_submit_learning_item($1)`, [itemId])).rejects.toThrow(/student account required/);
    await asActor(db);
  }, 30_000);
});
