import { afterEach, describe, expect, it } from 'vitest';
import { createOpsDb, seedClass, issueTestCode, testVerifier } from './helpers/ops-db.js';

const MIGRATIONS = ['20261115000000_kiosk_attendance_core.sql', '20261115010000_parent_message_outbox.sql'];
let db;
afterEach(async () => { if (db) await db.close(); db = null; });
const START = '2099-11-16T07:00:00Z';
const END = '2099-11-16T08:30:00Z';

async function setup() {
  db = await createOpsDb(MIGRATIONS);
  const seeded = await seedClass(db);
  const session = (await db.query(`select public.admin_create_class_session($1, $2, $3, 8) as id`, [seeded.group, START, END])).rows[0].id;
  const code = await issueTestCode(db, seeded.student, '482913');
  const token = (await db.query(`select public.admin_register_kiosk_device('입구') as token`)).rows[0].token;
  const record = (await db.query(`select id from public.attendance_records where class_session_id=$1`, [session])).rows[0].id;
  await db.query(`select public.admin_approve_message_template(template_code) from public.message_templates`);
  return { ...seeded, session, code, token, record };
}
const kiosk = async (s, action, at) => (await db.query(`select private.kiosk_attendance_at($1, $2, $3, $4::timestamptz, '198.51.100.7') as r`, [s.token, action, await testVerifier(s.code), at])).rows[0].r;
const messages = async () => (await db.query(`select message_type, status, idempotency_key, rendered_body, guardian_id from public.parent_messages order by created_at, message_type`)).rows;

describe('parent message outbox', () => {
  it('queues one late-arrival message per attendance with the full student name for the primary guardian', async () => {
    const s = await setup();
    await kiosk(s, 'check_in', '2099-11-16T07:05:00Z');
    await kiosk(s, 'check_in', '2099-11-16T07:06:00Z');
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0].message_type).toBe('late');
    expect(rows[0].status).toBe('queued');
    expect(rows[0].idempotency_key).toBe(`attendance:${s.record}:late`);
    expect(rows[0].rendered_body).toContain('가나다 학생이 예정 수업 16:00보다 늦은 16:05에 출석했습니다.');
    const primary = (await db.query(`select id from public.guardians where student_id=$1 and is_primary`, [s.student])).rows[0].id;
    expect(rows[0].guardian_id).toBe(primary);
  }, 30_000);

  it('withdraws a pending missing message when the student arrives and keeps arrival notification', async () => {
    const s = await setup();
    await db.query(`select private.run_attendance_followups('2099-11-16T07:16:00Z')`);
    await db.query(`select private.run_attendance_followups('2099-11-16T07:17:00Z')`);
    let rows = await messages();
    expect(rows.map((r) => [r.message_type, r.status])).toEqual([['missing', 'queued']]);
    expect(rows[0].rendered_body).toContain('가나다 학생의 16:00 수업 출석이 아직 확인되지 않았습니다.');
    await kiosk(s, 'check_in', '2099-11-16T07:25:00Z');
    rows = await messages();
    expect(Object.fromEntries(rows.map((r) => [r.message_type, r.status]))).toEqual({ missing: 'cancelled', late: 'queued' });
  }, 30_000);

  it('suppresses late wording, missing, and absence outbox for planned exceptions but still notifies real arrival and checkout', async () => {
    const s = await setup();
    await db.query(`select public.admin_set_attendance_exception($1, 'expected_late', '2099-11-16T07:30:00Z', 'medical', '병원 진료')`, [s.record]);
    await db.query(`select private.run_attendance_followups('2099-11-16T07:20:00Z')`);
    expect(await messages()).toEqual([]);
    await kiosk(s, 'check_in', '2099-11-16T07:28:00Z');
    await kiosk(s, 'check_out', '2099-11-16T08:31:00Z');
    const rows = await messages();
    expect(rows.map((r) => r.message_type).sort()).toEqual(['checkout', 'present']);
    expect(rows.every((r) => !r.rendered_body.includes('병원'))).toBe(true);
    expect((await db.query(`select status from public.attendance_exceptions`)).rows[0].status).toBe('consumed');
  }, 30_000);

  it('does not create an absence message for a planned absence and creates one for an ordinary absence', async () => {
    const s = await setup();
    await db.query(`select public.admin_set_attendance_exception($1, 'planned_absence', null, 'family', '')`, [s.record]);
    await db.query(`update public.attendance_records set status='excused' where id=$1`, [s.record]);
    expect(await messages()).toEqual([]);
    const other = (await db.query(`select public.admin_create_student('하나둘', '중2', '', 'active', true, '보호자', '010-1111-2222') as id`)).rows[0].id;
    await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [other, s.course, s.group]);
    const session2 = (await db.query(`select public.admin_create_class_session($1, '2099-11-17T07:00:00Z', '2099-11-17T08:00:00Z', 8) as id`, [s.group])).rows[0].id;
    const otherRecord = (await db.query(`select id from public.attendance_records where student_id=$1 and class_session_id=$2`, [other, session2])).rows[0].id;
    await db.query(`update public.attendance_records set status='absent' where id=$1`, [otherRecord]);
    const rows = await messages();
    expect(rows.map((r) => [r.message_type, r.idempotency_key])).toEqual([['absent', `attendance:${otherRecord}:absent`]]);
  }, 30_000);

  it('never generates a parent message for checkout-needed follow-up', async () => {
    const s = await setup();
    await kiosk(s, 'check_in', '2099-11-16T06:55:00Z');
    await db.query(`select private.run_attendance_followups('2099-11-16T09:30:00Z')`);
    expect((await db.query(`select count(*)::int as n from public.attendance_followups where kind='checkout_needed'`)).rows[0].n).toBe(1);
    expect((await messages()).map((r) => r.message_type)).toEqual(['present']);
  }, 30_000);

  it('keeps messages as drafts when the template is not approved and fails without a primary guardian phone', async () => {
    db = await createOpsDb(MIGRATIONS);
    const seeded = await seedClass(db);
    const lone = (await db.query(`select public.admin_create_student('보호자없음', '중2') as id`)).rows[0].id;
    await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [lone, seeded.course, seeded.group]);
    const session = (await db.query(`select public.admin_create_class_session($1, $2, $3, 8) as id`, [seeded.group, START, END])).rows[0].id;
    await db.query(`update public.attendance_records set status='absent' where class_session_id=$1`, [session]);
    const rows = (await db.query(`select m.status, m.failure_code, st.name from public.parent_messages m join public.students st on st.id=m.student_id order by st.name`)).rows;
    expect(rows).toEqual([
      { status: 'draft', failure_code: null, name: '가나다' },
      { status: 'failed', failure_code: 'no_primary_guardian_phone', name: '보호자없음' },
    ]);
    const draftId = (await db.query(`select id from public.parent_messages where status='draft'`)).rows[0].id;
    await expect(db.query(`select public.admin_approve_parent_message($1)`, [draftId])).rejects.toThrow(/approved current template/);
    await db.query(`select public.admin_approve_message_template('attendance_absent')`);
    await db.query(`update public.message_templates set template_version=2 where template_code='attendance_absent'`);
    await expect(db.query(`select public.admin_approve_parent_message($1)`, [draftId])).rejects.toThrow(/approved current template/);
    await db.query(`update public.message_templates set template_version=1 where template_code='attendance_absent'`);
    await db.query(`select public.admin_approve_parent_message($1)`, [draftId]);
    expect((await db.query(`select status from public.parent_messages where id=$1`, [draftId])).rows[0].status).toBe('queued');
  }, 30_000);

  it('dispatches through claim/result with bounded retries, keeps failures failed, and records manual follow-up separately', async () => {
    const s = await setup();
    await kiosk(s, 'check_in', '2099-11-16T06:55:00Z');
    let claims = (await db.query(`select public.service_claim_parent_messages('dry_run', 10) as c`)).rows[0].c;
    expect(claims).toHaveLength(1);
    expect(claims[0].recipient_phone).toBe('010-0000-0000');
    expect((await db.query(`select public.service_claim_parent_messages('dry_run', 10) as c`)).rows[0].c).toHaveLength(0);
    expect((await db.query(`select public.service_record_delivery_result($1, 1, $2, 'retryable', 'timeout') as s`, [claims[0].message_id, claims[0].claim_nonce])).rows[0].s).toBe('queued');
    for (const attempt of [2, 3]) {
      claims = (await db.query(`select public.service_claim_parent_messages('dry_run', 10) as c`)).rows[0].c;
      expect(claims[0].attempt_no).toBe(attempt);
      await db.query(`select public.service_record_delivery_result($1, $2, $3, 'retryable', 'timeout')`, [claims[0].message_id, attempt, claims[0].claim_nonce]);
    }
    const msg = (await db.query(`select id, status, failure_code from public.parent_messages`)).rows[0];
    expect(msg).toMatchObject({ status: 'failed', failure_code: 'retry_exhausted' });
    await expect(db.query(`update public.parent_messages set status='queued' where id=$1`, [msg.id])).rejects.toThrow(/invalid parent message transition/);
    await db.query(`select public.admin_record_message_manual_followup($1, '전화로 안내')`, [msg.id]);
    const after = (await db.query(`select status, manual_followup_at from public.parent_messages where id=$1`, [msg.id])).rows[0];
    expect(after.status).toBe('failed');
    expect(after.manual_followup_at).toBeTruthy();
    await expect(db.query(`select public.admin_record_message_manual_followup($1, '중복')`, [msg.id])).rejects.toThrow(/state changed/);
    const attempts = (await db.query(`select attempt_no, status from public.message_delivery_attempts order by attempt_no`)).rows;
    expect(attempts.map((a) => a.status)).toEqual(['failed', 'failed', 'failed']);
  }, 30_000);

  it('freezes the primary guardian recipient at enqueue time instead of retargeting a later phone edit', async () => {
    const s = await setup();
    await kiosk(s, 'check_in', '2099-11-16T06:55:00Z');
    await db.query(`update public.guardians set phone='010-9999-9999' where student_id=$1 and is_primary`, [s.student]);
    const claims = (await db.query(`select public.service_claim_parent_messages('dry_run', 10) as c`)).rows[0].c;
    expect(claims).toHaveLength(1);
    expect(claims[0].recipient_phone).toBe('010-0000-0000');
  }, 30_000);

  it('never copies attendance numbers, verifier material, device tokens, private notes, or rendered parent copy into operations audit', async () => {
    const s = await setup();
    await db.query(`select public.admin_set_attendance_exception($1, 'expected_late', '2099-11-16T07:30:00Z', 'medical', '민감한 병원 진료 메모')`, [s.record]);
    await kiosk(s, 'check_in', '2099-11-16T07:28:00Z');
    const audit = JSON.stringify((await db.query(`select before_data, after_data from public.operations_audit`)).rows);
    expect(audit).not.toContain(s.code);
    expect(audit).not.toContain(s.token);
    expect(audit).not.toContain(await testVerifier(s.code));
    expect(audit).not.toContain('code_verifier');
    expect(audit).not.toContain('token_hash');
    expect(audit).not.toContain('민감한 병원 진료 메모');
    expect(audit).not.toContain('오늘 학습을 시작합니다');
  }, 30_000);

  it('denies browser roles the dispatcher functions and direct outbox writes', async () => {
    const s = await setup();
    await db.exec(`set role authenticated`);
    await expect(db.query(`select public.service_claim_parent_messages('dry_run', 10)`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.service_record_delivery_result(gen_random_uuid(), 1, 'x', 'sent')`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.service_record_delivery_receipt('dry_run', 'k', 'r', 'delivered')`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from private.parent_message_claims`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`insert into public.parent_messages (student_id, message_type, template_code, template_version, rendered_body, status, idempotency_key) values ($1, 'present', 'attendance_present', 1, 'x', 'queued', 'k')`, [s.student])).rejects.toThrow(/permission denied/);
    await db.exec(`reset role; set role anon`);
    await expect(db.query(`select * from public.parent_messages`)).rejects.toThrow(/permission denied/);
    await db.exec(`reset role`);
  }, 30_000);
});

// ── dispatcher claim ownership and delivery facts ───────────────────────────
const T0 = '2099-11-16T06:56:00Z';
const plus = (iso, minutes) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
const claimAt = async (at, limit = 10) => (await db.query(`select private.claim_parent_messages_at('dry_run', $1, $2::timestamptz) as c`, [limit, at])).rows[0].c;
const recordAt = (c, at, outcome = 'sent', { nonce = c.claim_nonce, attempt = c.attempt_no, requestId = 'req-1' } = {}) =>
  db.query(`select private.record_delivery_result_at($1, $2, $3, $4, 'ok', $5, false, $6::timestamptz) as s`, [c.message_id, attempt, nonce, outcome, requestId, at]);
const receipt = (key, requestId, outcome) => db.query(`select public.service_record_delivery_receipt('dry_run', $1, $2, $3, 'ok') as s`, [key, requestId, outcome]);
const attemptRows = async () => (await db.query(`select attempt_no, status, result_code, completed_at, provider_request_id from public.message_delivery_attempts order by attempt_no`)).rows;

describe('dispatcher claim ownership', () => {
  async function claimed() {
    const s = await setup();
    await kiosk(s, 'check_in', '2099-11-16T06:55:00Z');
    const [c] = await claimAt(T0);
    return { s, c };
  }

  it('issues a high-entropy claim nonce and lease that never land in browser-readable rows or audit', async () => {
    const { c } = await claimed();
    expect(c.claim_nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(c.lease_expires_at).toISOString()).toBe(plus(T0, 5));
    const visible = JSON.stringify((await db.query(`select * from public.parent_messages`)).rows)
      + JSON.stringify((await db.query(`select * from public.message_delivery_attempts`)).rows)
      + JSON.stringify((await db.query(`select * from public.operations_audit`)).rows);
    expect(visible).not.toContain(c.claim_nonce);
    const stored = (await db.query(`select nonce_hash from private.parent_message_claims`)).rows[0].nonce_hash;
    expect(stored).not.toBe(c.claim_nonce);
  }, 30_000);

  it('rejects a wrong nonce and an expired lease with 40001', async () => {
    const { c } = await claimed();
    await expect(recordAt(c, plus(T0, 1), 'sent', { nonce: 'f'.repeat(64) })).rejects.toMatchObject({ code: '40001' });
    await expect(recordAt(c, plus(T0, 1), 'sent', { attempt: 2 })).rejects.toMatchObject({ code: '40001' });
    await expect(recordAt(c, plus(T0, 6))).rejects.toMatchObject({ code: '40001' });
    expect((await attemptRows())[0].status).toBe('requested');
    expect((await db.query(`select status from public.parent_messages`)).rows[0].status).toBe('queued');
  }, 30_000);

  it('a late worker after re-claim cannot write; the current owner can, with the same provider idempotency key', async () => {
    const { c } = await claimed();
    expect(await claimAt(plus(T0, 2))).toEqual([]); // lease still held
    const [again] = await claimAt(plus(T0, 6));
    expect(again).toMatchObject({ message_id: c.message_id, attempt_no: 2, idempotency_key: c.idempotency_key });
    expect(again.claim_nonce).not.toBe(c.claim_nonce);
    await expect(recordAt(c, plus(T0, 7))).rejects.toMatchObject({ code: '40001' });
    await expect(recordAt(c, plus(T0, 7), 'sent', { attempt: 2 })).rejects.toMatchObject({ code: '40001' });
    expect((await recordAt(again, plus(T0, 7))).rows[0].s).toBe('sent');
    const attempts = await attemptRows();
    expect(attempts.map((a) => [a.attempt_no, a.status, a.result_code])).toEqual([[1, 'failed', 'lease_expired'], [2, 'accepted', 'ok']]);
  }, 30_000);

  it('same-result retry with the same nonce is idempotent; a conflicting one is rejected', async () => {
    const { c } = await claimed();
    expect((await recordAt(c, plus(T0, 1))).rows[0].s).toBe('sent');
    expect((await recordAt(c, plus(T0, 2))).rows[0].s).toBe('sent');
    await expect(recordAt(c, plus(T0, 2), 'failed')).rejects.toMatchObject({ code: '40001' });
    await expect(recordAt(c, plus(T0, 2), 'sent', { requestId: 'req-other' })).rejects.toMatchObject({ code: '40001' });
  }, 30_000);

  it('keeps an accepted attempt open for a later delivery receipt, idempotent on duplicates, rejecting conflicts', async () => {
    const { c } = await claimed();
    await recordAt(c, plus(T0, 1));
    let [a] = await attemptRows();
    expect(a).toMatchObject({ status: 'accepted', completed_at: null, provider_request_id: 'req-1' });
    await expect(receipt(c.idempotency_key, 'req-wrong', 'delivered')).rejects.toMatchObject({ code: '40001' });
    expect((await receipt(c.idempotency_key, 'req-1', 'delivered')).rows[0].s).toBe('delivered');
    [a] = await attemptRows();
    expect(a.status).toBe('delivered');
    expect(a.completed_at).toBeTruthy();
    expect((await receipt(c.idempotency_key, 'req-1', 'delivered')).rows[0].s).toBe('delivered');
    await expect(receipt(c.idempotency_key, 'req-1', 'failed')).rejects.toMatchObject({ code: '40001' });
    const msg = (await db.query(`select status, sent_at, delivered_at from public.parent_messages`)).rows[0];
    expect(msg.status).toBe('delivered');
    expect(msg.sent_at && msg.delivered_at).toBeTruthy();
  }, 30_000);

  it('an accepted attempt can later fail via receipt', async () => {
    const { c } = await claimed();
    await recordAt(c, plus(T0, 1));
    expect((await receipt(c.idempotency_key, 'req-1', 'failed')).rows[0].s).toBe('failed');
    expect((await attemptRows())[0].status).toBe('failed');
    expect((await db.query(`select failure_code from public.parent_messages`)).rows[0].failure_code).toBe('ok');
  }, 30_000);
});
