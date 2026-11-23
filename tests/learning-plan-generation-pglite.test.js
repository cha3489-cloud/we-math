import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOpsDb, seedClass, asActor, issueTestCode, testVerifier, OPS_MIGRATIONS, ADMIN, STUDENT_PROFILE } from './helpers/ops-db.js';

const MIGRATION = '20261115060000_learning_plan_autogeneration.sql';
// Explicit prefix of the chain ending at this migration; later migrations build on it.
const MIGRATIONS = OPS_MIGRATIONS.slice(0, OPS_MIGRATIONS.indexOf(MIGRATION) + 1);
const migrationSql = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');

// Mon 2026-11-16 16:00–17:30 KST. A past session so manual arrival times are valid.
const START = '2026-11-16T07:00:00Z';
const END = '2026-11-16T08:30:00Z';
const DAY = '2026-11-16';

let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

async function setup({ linked = true } = {}) {
  if (db) await db.close();
  db = await createOpsDb(MIGRATIONS);
  const s = await seedClass(db);
  if (linked) await db.query(`update public.students set account_profile_id=$1 where id=$2`, [STUDENT_PROFILE, s.student]);
  const session = (await one(`select public.admin_create_class_session($1, $2, $3, 8) as id`, [s.group, START, END])).id;
  const attendance = (await one(`select id from public.attendance_records where class_session_id=$1`, [session])).id;
  return { ...s, session, attendance };
}
const arrive = (attendance, at = '2026-11-16T07:05:00Z') => db.query(`select public.admin_record_manual_arrival($1, $2::timestamptz, '태블릿 장애')`, [attendance, at]);
const plansOf = (student) => all(`select id, plan_date::text as plan_date, source_revision, status, created_by, created_via from public.daily_learning_plans where student_id=$1 order by plan_date, source_revision`, [student]);
const itemsOf = (plan) => all(`select item_type, title, body, source_id, sort_order, progress_sequence from public.daily_learning_plan_items where plan_id=$1 order by sort_order`, [plan]);
const enqueue = async (student, title, body = '') => one(`select public.admin_enqueue_progress_target($1, $2, $3) as r`, [student, title, body]).then((r) => r.r);
const targetOf = (id) => one(`select status, consumed_by_plan_id, sequence from public.student_progress_targets where id=$1`, [id]);
const regenerate = async (attendance, expected = null) => (await one(`select public.admin_regenerate_learning_plan($1, $2) as r`, [attendance, expected])).r;
const publish = (plan, revision) => db.query(`select public.admin_publish_learning_plan($1, $2)`, [plan, revision]);

// Source fixtures, seeded as the owner exactly like portal rows already in production.
const assignment = async (title, dueAt, profile = STUDENT_PROFILE) => (await one(
  `insert into public.assignments (student_id, created_by, title, due_at) values ($1, $2, $3, $4::timestamptz) returning id`, [profile, ADMIN, title, dueAt],
)).id;
const submission = async (assignmentId, attempt, status) => (await one(
  `insert into public.submissions (assignment_id, student_id, attempt_no, status, body) values ($1, $2, $3, $4::public.submission_status, '풀이') returning id`,
  [assignmentId, STUDENT_PROFILE, attempt, status],
)).id;
const feedback = async (submissionId, items) => {
  const f = (await one(`insert into public.feedback (submission_id, author_id, body) values ($1, $2, '피드백') returning id`, [submissionId, ADMIN])).id;
  const ids = [];
  for (const [n, item] of items.entries()) {
    ids.push((await one(
      `insert into public.feedback_items (feedback_id, problem_ref, review_tag, comment, redo_required, created_at) values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) returning id`,
      [f, item.problem_ref, item.review_tag ?? '계산·부호 확인', item.comment ?? '', item.redo_required, n],
    )).id);
  }
  return ids;
};
async function publishedPriorPlan(student, date, items) {
  const plan = (await one(`select public.admin_save_learning_plan_draft($1, $2::date, null, $3::jsonb) as id`, [student, date, JSON.stringify(items)])).id;
  await publish(plan, 1);
  return plan;
}

describe('automatic daily learning-plan drafts', () => {
  it('maps all four sources in fixed rank order with stable source ids and never publishes', async () => {
    const s = await setup();
    const hw1 = await assignment('숙제 p.30', '2026-11-15T10:00:00Z');
    const hw2 = await assignment('숙제 p.32', '2026-11-16T14:59:00Z'); // 23:59 KST on the plan date
    await assignment('다음 주 숙제', '2026-11-16T15:30:00Z'); // 00:30 KST next day: not yet due
    await assignment('기한 없음', null);
    const pending = await assignment('검토 대기', '2026-11-14T10:00:00Z');
    await submission(pending, 1, 'submitted'); // pending review is not missed homework
    const revise = await assignment('단원평가', '2026-11-13T10:00:00Z');
    const reviseSub = await submission(revise, 1, 'needs_revision');
    const [fi3, , fi7] = await feedback(reviseSub, [
      { problem_ref: '3번', review_tag: '계산·부호 확인', comment: '부호 다시', redo_required: true },
      { problem_ref: '5번', redo_required: false },
      { problem_ref: '7번', review_tag: '개념 연결 보완', redo_required: true },
    ]);
    const resubmitted = await assignment('재제출함', '2026-11-12T10:00:00Z');
    const old = await submission(resubmitted, 1, 'needs_revision');
    await feedback(old, [{ problem_ref: '1번', redo_required: true }]);
    await submission(resubmitted, 2, 'submitted'); // latest attempt is not needs_revision

    const prior = await publishedPriorPlan(s.student, '2026-11-13', [
      { item_type: 'homework', title: '지난 숙제(확인됨)' },
      { item_type: 'carryover', title: '연립방정식 마무리', body: '예제 2개' },
      { item_type: 'auto_progress', title: '일차방정식 활용', progress_sequence: 4 },
      { item_type: 'note', title: '메모는 이월하지 않음' },
    ]);
    const priorItems = await all(`select id, item_type from public.daily_learning_plan_items where plan_id=$1 order by sort_order`, [prior]);
    await db.query(`update public.daily_learning_plan_items set student_status='submitted', submitted_at=now(), teacher_status='confirmed', confirmed_by=$2, confirmed_at=now() where id=$1`, [priorItems[0].id, ADMIN]);

    const t1 = await enqueue(s.student, '일차함수 개념', '교재 p.40-43');
    await enqueue(s.student, '일차함수 그래프');

    await arrive(s.attendance);
    const plans = await plansOf(s.student);
    const today = plans.filter((p) => p.plan_date === DAY);
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({ source_revision: 1, status: 'draft', created_by: null, created_via: 'system' });
    const items = await itemsOf(today[0].id);
    expect(items.map((i) => i.item_type)).toEqual(['homework', 'homework', 'redo', 'redo', 'carryover', 'carryover', 'auto_progress']);
    expect(items.map((i) => i.sort_order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(items.slice(0, 2).map((i) => [i.title, i.source_id])).toEqual([['숙제 p.30', `assignment:${hw1}`], ['숙제 p.32', `assignment:${hw2}`]]);
    expect(items[2]).toMatchObject({ title: '단원평가 · 3번', source_id: `feedback_item:${fi3}` });
    expect(items[2].body).toContain('계산·부호 확인');
    expect(items[2].body).toContain('부호 다시');
    expect(items[3]).toMatchObject({ title: '단원평가 · 7번', source_id: `feedback_item:${fi7}` });
    expect(items[4]).toMatchObject({ title: '연립방정식 마무리', body: '예제 2개', source_id: `plan_item:${priorItems[1].id}` });
    expect(items[5]).toMatchObject({ title: '일차방정식 활용', source_id: `plan_item:${priorItems[2].id}` });
    expect(items[6]).toMatchObject({ title: '일차함수 개념', body: '교재 p.40-43', source_id: `progress_target:${t1.id}`, progress_sequence: 1 });
    expect(new Set(items.map((i) => i.source_id)).size).toBe(items.length);

    const audit = await one(`select actor_kind, actor_id from public.operations_audit where entity='daily_learning_plans' and entity_id=$1 and action='INSERT'`, [today[0].id]);
    expect(audit).toEqual({ actor_kind: 'system', actor_id: null });
    // The manual-arrival event is still attributed to the admin who recorded it.
    const events = await all(`select actor_kind, actor_id from public.attendance_events where attendance_id=$1 and event_type='attendance_updated'`, [s.attendance]);
    expect(events).toEqual([{ actor_kind: 'admin', actor_id: ADMIN }]);
    expect((await targetOf(t1.id)).status).toBe('queued');
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    expect((await one(`select public.student_today_learning_plan() as v`)).v.status).toBe('preparing');
    await asActor(db);
  }, 60_000);

  it('skips homework and redo without an account profile and never invents progress', async () => {
    const s = await setup({ linked: false });
    await assignment('다른 계정 숙제', '2026-11-15T10:00:00Z');
    await arrive(s.attendance);
    const [plan] = await plansOf(s.student);
    const items = await itemsOf(plan.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ item_type: 'note', source_id: 'next_progress_required', progress_sequence: null });
    expect(items[0].title).toContain('다음 진도');
    expect(await all(`select 1 from public.daily_learning_plan_items where item_type='auto_progress'`)).toHaveLength(0);
  }, 60_000);

  it('caps a generated draft at 30 items and keeps the final progress slot', async () => {
    const s = await setup();
    for (let n = 1; n <= 35; n += 1) await assignment(`숙제 ${String(n).padStart(2, '0')}`, `2026-11-1${n % 2 ? 4 : 5}T0${n % 10}:00:00Z`);
    await enqueue(s.student, '다음 단원');
    await arrive(s.attendance);
    const [plan] = await plansOf(s.student);
    const items = await itemsOf(plan.id);
    expect(items).toHaveLength(30);
    expect(items.slice(0, 29).every((i) => i.item_type === 'homework')).toBe(true);
    expect(items[29]).toMatchObject({ item_type: 'auto_progress', title: '다음 단원' });
  }, 60_000);

  it('generates only on an actual arrival transition and is idempotent per student and session date', async () => {
    const s = await setup();
    await db.query(`update public.attendance_records set status='absent', absence_reason='병결' where id=$1`, [s.attendance]);
    expect(await plansOf(s.student)).toHaveLength(0);

    const again = await setup();
    await arrive(again.attendance);
    await expect(arrive(again.attendance)).rejects.toThrow(/attendance state changed/);
    const [plan] = await plansOf(again.student);
    expect((await one(`select private.generate_learning_plan_for_attendance($1) as id`, [again.attendance])).id).toBe(plan.id);
    expect(await plansOf(again.student)).toHaveLength(1);

    // An owner draft saved before arrival is returned instead of adding a system revision.
    const third = await setup();
    const owner = (await one(`select public.admin_save_learning_plan_draft($1, $2::date, null, '[{"item_type":"note","title":"미리 작성"}]'::jsonb) as id`, [third.student, DAY])).id;
    await arrive(third.attendance);
    const plans = await plansOf(third.student);
    expect(plans.map((p) => [p.id, p.created_via])).toEqual([[owner, 'admin']]);
  }, 90_000);

  it('keeps kiosk attribution for the arrival while the draft is attributed to the system', async () => {
    const s = await setup();
    const code = await issueTestCode(db, s.student, '482913');
    const token = (await one(`select public.admin_register_kiosk_device('입구 태블릿') as token`)).token;
    const result = (await one(`select private.kiosk_attendance_at($1, 'check_in', $2, '2026-11-16T07:03:00Z'::timestamptz, '198.51.100.7') as r`, [token, await testVerifier(code)])).r;
    expect(result.result).toBe('checked_in');
    const [plan] = await plansOf(s.student);
    expect(plan).toMatchObject({ status: 'draft', created_via: 'system' });
    expect((await one(`select actor_kind from public.operations_audit where entity='daily_learning_plans' and entity_id=$1`, [plan.id])).actor_kind).toBe('system');
    const kinds = (await all(`select actor_kind from public.attendance_events where attendance_id=$1 and event_type='attendance_updated'`, [s.attendance])).map((r) => r.actor_kind);
    expect(kinds).toEqual(['kiosk']);
    const recordAudit = await all(`select actor_kind from public.operations_audit where entity='attendance_records' and entity_id=$1 and action='UPDATE'`, [s.attendance]);
    expect(recordAudit.every((r) => r.actor_kind === 'kiosk')).toBe(true);
  }, 60_000);

  it('reflects source changes only after an explicit admin regeneration and never mutates the published revision', async () => {
    const s = await setup();
    await assignment('숙제 A', '2026-11-15T10:00:00Z');
    const t1 = await enqueue(s.student, '진도 1');
    const t2 = await enqueue(s.student, '진도 2');
    await arrive(s.attendance);
    const [r1] = await plansOf(s.student);
    await publish(r1.id, 1);
    expect(await targetOf(t1.id)).toMatchObject({ status: 'consumed', consumed_by_plan_id: r1.id });
    const r1Items = await itemsOf(r1.id);

    await assignment('숙제 B', '2026-11-16T09:00:00Z');
    expect(await itemsOf(r1.id)).toEqual(r1Items);
    await expect(regenerate(s.attendance, 0)).rejects.toThrow(/revision changed/);
    const regen = await regenerate(s.attendance, 1);
    expect(regen.revision).toBe(2);
    const plans = await plansOf(s.student);
    expect(plans.map((p) => [p.source_revision, p.status, p.created_via])).toEqual([[1, 'published', 'system'], [2, 'draft', 'admin']]);
    expect((await one(`select actor_kind, actor_id from public.operations_audit where entity='daily_learning_plans' and entity_id=$1 and action='INSERT'`, [regen.plan_id]))).toEqual({ actor_kind: 'admin', actor_id: ADMIN });
    const r2Items = await itemsOf(regen.plan_id);
    expect(r2Items.map((i) => i.title)).toEqual(['숙제 A', '숙제 B', '진도 1']);
    expect(r2Items.at(-1).source_id).toBe(`progress_target:${t1.id}`); // same day keeps the consumed target
    expect(await itemsOf(r1.id)).toEqual(r1Items);

    await publish(regen.plan_id, 2);
    expect(await targetOf(t1.id)).toMatchObject({ status: 'consumed', consumed_by_plan_id: r1.id });
    expect((await targetOf(t2.id)).status).toBe('queued');
    expect((await one(`select status from public.daily_learning_plans where id=$1`, [r1.id])).status).toBe('superseded');
  }, 60_000);

  it('consumes a referenced target exactly once on publish and conflicts when it changed elsewhere', async () => {
    const s = await setup();
    const t1 = await enqueue(s.student, '진도 1');
    const t2 = await enqueue(s.student, '진도 2');
    await arrive(s.attendance);
    const [r1] = await plansOf(s.student);
    expect((await targetOf(t1.id)).status).toBe('queued');

    await db.query(`select public.admin_cancel_progress_target($1)`, [t1.id]);
    await expect(db.query(`select public.admin_cancel_progress_target($1)`, [t1.id])).rejects.toThrow(/progress target state changed/);
    await expect(publish(r1.id, 1)).rejects.toThrow(/progress target changed/);
    expect((await one(`select status from public.daily_learning_plans where id=$1`, [r1.id])).status).toBe('draft');
    expect((await targetOf(t1.id)).status).toBe('cancelled');

    const r2 = await regenerate(s.attendance, 1);
    expect((await itemsOf(r2.plan_id)).at(-1).source_id).toBe(`progress_target:${t2.id}`);
    // Another day publishes the same target first: today's draft must not double-consume it.
    const other = (await one(`select public.admin_save_learning_plan_draft($1, '2026-11-17'::date, null, $2::jsonb) as id`, [s.student, JSON.stringify([{ item_type: 'auto_progress', title: '진도 2', source_id: `progress_target:${t2.id}` }])])).id;
    await publish(other, 1);
    expect(await targetOf(t2.id)).toMatchObject({ status: 'consumed', consumed_by_plan_id: other });
    await expect(publish(r2.plan_id, 2)).rejects.toThrow(/progress target changed/);
    await expect(db.query(`select public.admin_cancel_progress_target($1)`, [t2.id])).rejects.toThrow(/progress target state changed/);
    const consumedAudits = await all(`select 1 from public.operations_audit where entity='student_progress_targets' and entity_id=$1 and action='UPDATE'`, [t2.id]);
    expect(consumedAudits).toHaveLength(1);

    // A reference to another student's target or a malformed reference is rejected.
    const otherStudent = (await one(`select public.admin_create_student('다른학생', '중2') as id`)).id;
    const foreign = await enqueue(otherStudent, '남의 진도');
    const bad = (await one(`select public.admin_save_learning_plan_draft($1, '2026-11-18'::date, null, $2::jsonb) as id`, [s.student, JSON.stringify([{ item_type: 'auto_progress', title: 'x', source_id: `progress_target:${foreign.id}` }])])).id;
    await expect(publish(bad, 1)).rejects.toThrow(/progress target changed/);
    const malformed = (await one(`select public.admin_save_learning_plan_draft($1, '2026-11-19'::date, null, $2::jsonb) as id`, [s.student, JSON.stringify([{ item_type: 'auto_progress', title: 'x', source_id: 'progress_target:abc' }])])).id;
    await expect(publish(malformed, 1)).rejects.toThrow(/invalid progress target reference/);
    expect((await targetOf(foreign.id)).status).toBe('queued');
  }, 60_000);

  it('keeps a stable unique per-student queue order that never reuses sequences', async () => {
    const s = await setup();
    const a = await enqueue(s.student, '1단원');
    const b = await enqueue(s.student, '2단원');
    await db.query(`select public.admin_cancel_progress_target($1)`, [b.id]);
    const c = await enqueue(s.student, '3단원');
    expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 3]);
    await expect(enqueue(s.student, '   ')).rejects.toThrow(/progress title required/);
    await expect(db.query(`insert into public.student_progress_targets (student_id, sequence, title, created_by) values ($1, 1, 'dup', $2)`, [s.student, ADMIN])).rejects.toThrow(/duplicate key|unique/);
    await expect(db.query(`update public.student_progress_targets set title='바꿈' where id=$1`, [a.id])).rejects.toThrow(/immutable/);
    const signals = await all(`select entity from public.operations_refresh_events where entity='student_progress_targets'`);
    expect(signals.length).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('denies non-admins, students and anonymous callers every target and generation path', async () => {
    const s = await setup();
    const t = await enqueue(s.student, '진도 1');
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    await expect(enqueue(s.student, 'x')).rejects.toThrow(/admin required/);
    await expect(db.query(`select public.admin_cancel_progress_target($1)`, [t.id])).rejects.toThrow(/admin required/);
    await expect(regenerate(s.attendance)).rejects.toThrow(/admin required/);
    await asActor(db);

    await db.exec(`set role authenticated`);
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    expect(await all(`select id from public.student_progress_targets`)).toHaveLength(0);
    await expect(db.query(`insert into public.student_progress_targets (student_id, sequence, title, created_by) values ($1, 9, 'x', $2)`, [s.student, STUDENT_PROFILE])).rejects.toThrow(/permission denied/);
    await expect(db.query(`update public.student_progress_targets set status='cancelled'`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select private.generate_learning_plan_for_attendance($1)`, [s.attendance])).rejects.toThrow(/permission denied/);
    await asActor(db);
    expect((await all(`select id from public.student_progress_targets`)).length).toBe(1); // admin RLS read
    await db.exec(`reset role; set role anon`);
    await expect(db.query(`select public.admin_enqueue_progress_target($1, 'x', '')`, [s.student])).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.admin_regenerate_learning_plan($1, null)`, [s.attendance])).rejects.toThrow(/permission denied/);
    await db.exec(`reset role`);
  }, 60_000);

  it('publishes only the refresh signal table to Realtime, never the target table', () => {
    expect(migrationSql).toMatch(/create trigger refresh_signal_student_progress_targets/);
    expect(migrationSql).not.toMatch(/alter publication[^;]*student_progress_targets/i);
    expect(migrationSql).not.toMatch(/alter publication[^;]*daily_learning_plan/i);
  });
});
