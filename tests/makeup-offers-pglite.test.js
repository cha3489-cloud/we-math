import { afterEach, describe, expect, it } from 'vitest';
import { createOpsDb, seedClass, issueTestCode, testVerifier } from './helpers/ops-db.js';

const MIGRATIONS = [
  '20261115000000_kiosk_attendance_core.sql',
  '20261115010000_parent_message_outbox.sql',
  '20261115030000_makeup_offers.sql',
];
let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const day = (n, hour = 7) => `2099-11-${String(16 + n).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

async function setup({ capacities = [8, 8, 8, 8] } = {}) {
  db = await createOpsDb(MIGRATIONS);
  const s = await seedClass(db);
  await db.query(`select public.admin_approve_message_template(template_code) from public.message_templates`);
  const session = (await db.query(`select public.admin_create_class_session($1, $2, $3, 8) as id`, [s.group, day(0), day(0, 8)])).rows[0].id;
  const record = (await db.query(`select id from public.attendance_records where class_session_id=$1`, [session])).rows[0].id;
  const otherGroup = (await db.query(`insert into public.class_groups (course_id, name, is_test_data) values ($1, '반B', true) returning id`, [s.course])).rows[0].id;
  const options = [];
  for (const [i, capacity] of capacities.entries()) {
    options.push((await db.query(`select public.admin_create_class_session($1, $2, $3, $4) as id`, [otherGroup, day(i + 1), day(i + 1, 8), capacity])).rows[0].id);
  }
  return { ...s, session, record, otherGroup, options };
}
const batches = async () => (await db.query(`select id, status, delivery_mode, requires_manual_send, offered_at, expires_at, selection_token_hash from public.makeup_offer_batches`)).rows;
const optionRows = async (batch) => (await db.query(`select class_session_id, sort_order, status from public.makeup_offer_options where offer_batch_id=$1 order by sort_order`, [batch])).rows;
const plannedDraft = async (s) => {
  await db.query(`select public.admin_set_attendance_exception($1, 'planned_absence', null, 'family', '')`, [s.record]);
  return (await batches())[0];
};
const offerAt = async (batch, at) => {
  await db.query(`select private.offer_makeup_batch($1, $2::timestamptz, null)`, [batch, at]);
  const row = (await db.query(`select offered_at from public.makeup_offer_batches where id=$1`, [batch])).rows[0];
  return (await db.query(`select private.makeup_token($1, $2) as t`, [batch, row.offered_at])).rows[0].t;
};

describe('makeup offers', () => {
  it('creates a manual draft with exactly three capacity-valid options for a planned absence and sends nothing', async () => {
    const s = await setup();
    await db.query(`select public.admin_set_attendance_exception($1, 'planned_absence', null, 'family', '')`, [s.record]);
    const [batch] = await batches();
    expect(batch).toMatchObject({ status: 'draft', delivery_mode: 'manual', requires_manual_send: true, offered_at: null, expires_at: null, selection_token_hash: null });
    const opts = await optionRows(batch.id);
    expect(opts.map((o) => o.class_session_id)).toEqual(s.options.slice(0, 3));
    expect(opts.map((o) => o.sort_order)).toEqual([1, 2, 3]);
    expect((await db.query(`select count(*)::int as n from public.parent_messages`)).rows[0].n).toBe(0);
  }, 30_000);

  it('skips full sessions and falls back to manual follow-up when fewer than three options remain', async () => {
    const s = await setup({ capacities: [1, 8, 8, 8] });
    const filler = (await db.query(`select public.admin_create_student('채움', '중2') as id`)).rows[0].id;
    await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [filler, s.course, s.otherGroup]);
    await db.query(`insert into public.attendance_records (student_id, scheduled_at, class_session_id, created_by, updated_by) values ($1, $2, $3, $4, $4)`, [filler, day(1), s.options[0], '00000000-0000-0000-0000-0000000000a1']);
    const batch = await plannedDraft(s);
    expect((await optionRows(batch.id)).map((o) => o.class_session_id)).toEqual(s.options.slice(1, 4));

    await db.close();
    const t = await setup({ capacities: [8, 8] });
    await db.query(`select public.admin_set_attendance_exception($1, 'planned_absence')`, [t.record]);
    const [short] = await batches();
    expect(short.status).toBe('manual_followup');
    expect(await optionRows(short.id)).toEqual([]);
    await expect(db.query(`select private.offer_makeup_batch($1, now(), null)`, [short.id])).rejects.toThrow(/state changed/);
    expect((await db.query(`select private.cancel_unfinalized_makeup_offers($1, 'student_arrived') as n`, [t.record])).rows[0].n).toBe(1);
    expect((await db.query(`select status from public.makeup_offer_batches where id=$1`, [short.id])).rows[0].status).toBe('cancelled');
  }, 60_000);

  it('owner send fixes the selection deadline at the end of the KST send date and queues one message without storing the token', async () => {
    const s = await setup();
    const batch = await plannedDraft(s);
    const token = await offerAt(batch.id, '2099-11-16T14:30:00Z'); // 23:30 KST
    const row = (await batches())[0];
    expect(row.status).toBe('offered');
    expect(new Date(row.expires_at).toISOString()).toBe('2099-11-16T14:59:59.999Z');
    const msgs = (await db.query(`select message_type, status, idempotency_key, rendered_body from public.parent_messages`)).rows;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ message_type: 'makeup_offer', status: 'queued', idempotency_key: `makeup_offer:${batch.id}` });
    expect(msgs[0].rendered_body).toContain('#{선택링크}');
    expect(msgs[0].rendered_body).toContain('가나다 학생의 보강 일정');
    const everything = JSON.stringify((await db.query(`select * from public.operations_audit`)).rows) + JSON.stringify(msgs) + JSON.stringify((await db.query(`select * from public.makeup_offer_batches`)).rows);
    expect(everything).not.toContain(token);
    await expect(db.query(`select private.offer_makeup_batch($1, now(), null)`, [batch.id])).rejects.toThrow(/state changed/);
    const claim = (await db.query(`select public.service_claim_parent_messages('dry_run', 5) as c`)).rows[0].c;
    expect(claim[0].body).toContain(`https://sequencemath.co.kr/makeup/#t=${token}`);
  }, 30_000);

  it('refuses owner send until the makeup notification template is approved', async () => {
    const s = await setup();
    const batch = await plannedDraft(s);
    await db.query(`update public.message_templates set approved=false, approved_by=null, approved_at=null where message_type='makeup_offer'`);
    await expect(db.query(`select public.admin_send_makeup_offer($1)`, [batch.id])).rejects.toThrow(/approved makeup template required/);
    expect((await batches())[0]).toMatchObject({ status: 'draft', offered_at: null, expires_at: null });
    expect((await db.query(`select count(*)::int as n from public.parent_messages where message_type='makeup_offer'`)).rows[0].n).toBe(0);
  }, 30_000);

  it('does not retroactively send existing drafts when planned absences switch to automatic delivery', async () => {
    const s = await setup();
    const draft = await plannedDraft(s);
    await db.query(`select public.admin_set_planned_absence_delivery_mode('automatic')`);
    expect((await db.query(`select status from public.makeup_offer_batches where id=$1`, [draft.id])).rows[0].status).toBe('draft');
    const other = (await db.query(`select public.admin_create_student('나중학생', '중2', '', 'active', true, '보호자', '010-2222-3333') as id`)).rows[0].id;
    await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [other, s.course, s.group]);
    const session2 = (await db.query(`select public.admin_create_class_session($1, '2099-11-16T09:00:00Z', '2099-11-16T10:00:00Z', 8) as id`, [s.group])).rows[0].id;
    const rec2 = (await db.query(`select id from public.attendance_records where student_id=$1 and class_session_id=$2`, [other, session2])).rows[0].id;
    await db.query(`select public.admin_set_attendance_exception($1, 'planned_absence')`, [rec2]);
    const fresh = (await db.query(`select status, delivery_mode, requires_manual_send from public.makeup_offer_batches where attendance_id=$1`, [rec2])).rows[0];
    expect(fresh).toEqual({ status: 'offered', delivery_mode: 'automatic', requires_manual_send: false });
    expect((await db.query(`select status from public.makeup_offer_batches where id=$1`, [draft.id])).rows[0].status).toBe('draft');
  }, 30_000);

  it('lets the guardian select one option once, rechecking capacity atomically, and creates the makeup plan', async () => {
    const s = await setup({ capacities: [1, 8, 8] });
    const batch = await plannedDraft(s);
    const token = await offerAt(batch.id, '2099-11-16T01:00:00Z');
    const view = (await db.query(`select private.makeup_offer_view_at($1, '2099-11-16T02:00:00Z') as v`, [token])).rows[0].v;
    expect(view.result).toBe('open');
    expect(view.student_label).toBe('가○○');
    expect(view.options).toHaveLength(3);
    const optionIds = (await db.query(`select id from public.makeup_offer_options where offer_batch_id=$1 order by sort_order`, [batch.id])).rows.map((r) => r.id);
    // someone else fills the single seat after the offer was sent
    const filler = (await db.query(`select public.admin_create_student('채움', '중2') as id`)).rows[0].id;
    await db.query(`insert into public.attendance_records (student_id, scheduled_at, class_session_id, created_by, updated_by) values ($1, $2, $3, $4, $4)`, [filler, day(1), s.options[0], '00000000-0000-0000-0000-0000000000a1']);
    const full = (await db.query(`select private.makeup_offer_select_at($1, $2, '2099-11-16T02:00:00Z') as r`, [token, optionIds[0]])).rows[0].r;
    expect(full.result).toBe('full');
    expect(full.options.find((o) => o.id === optionIds[0]).available).toBe(false);
    const ok = (await db.query(`select private.makeup_offer_select_at($1, $2, '2099-11-16T02:01:00Z') as r`, [token, optionIds[1]])).rows[0].r;
    expect(ok.result).toBe('selected');
    expect((await db.query(`select private.makeup_offer_select_at($1, $2, '2099-11-16T02:02:00Z') as r`, [token, optionIds[1]])).rows[0].r.result).toBe('already_selected');
    expect((await db.query(`select private.makeup_offer_select_at($1, $2, '2099-11-16T02:02:00Z') as r`, [token, optionIds[2]])).rows[0].r.result).toBe('closed');
    // Selection is only a reservation while attendance is still scheduled.
    expect((await db.query(`select count(*)::int as n from public.makeup_plans`)).rows[0].n).toBe(0);
    expect((await db.query(`select status, guardian_contact_status from public.attendance_records where id=$1`, [s.record])).rows[0])
      .toEqual({ status: 'scheduled', guardian_contact_status: null });
    await db.query(`update public.attendance_records set status='excused' where id=$1`, [s.record]);
    const plan = (await db.query(`select status, class_session_id, created_via, created_by from public.makeup_plans`)).rows;
    expect(plan).toEqual([{ status: 'planned', class_session_id: s.options[1], created_via: 'makeup_selection', created_by: null }]);
    const eventText = JSON.stringify((await db.query(`select details from public.attendance_events where makeup_plan_id is not null`)).rows);
    expect(eventText).not.toContain('보강 선택 페이지에서 보호자 선택');
    const attendance = (await db.query(`select status, guardian_contact_status from public.attendance_records where id=$1`, [s.record])).rows[0];
    expect(attendance).toEqual({ status: 'excused', guardian_contact_status: 'contacted' });
    expect((await db.query(`select count(*)::int as n from public.parent_messages where message_type='absent'`)).rows[0].n).toBe(0);
  }, 30_000);

  it('rejects selection after the KST send date ends and keeps the batch expired', async () => {
    const s = await setup();
    const batch = await plannedDraft(s);
    const token = await offerAt(batch.id, '2099-11-16T14:30:00Z');
    const optionId = (await db.query(`select id from public.makeup_offer_options where offer_batch_id=$1 and sort_order=1`, [batch.id])).rows[0].id;
    expect((await db.query(`select private.makeup_offer_select_at($1, $2, '2099-11-16T15:00:00Z') as r`, [token, optionId])).rows[0].r.result).toBe('expired');
    expect((await batches())[0].status).toBe('expired');
    expect((await db.query(`select private.makeup_offer_view_at($1, '2099-11-16T15:00:01Z') as v`, [token])).rows[0].v.result).toBe('expired');
    expect((await db.query(`select count(*)::int as n from public.makeup_plans`)).rows[0].n).toBe(0);
    expect((await db.query(`select private.makeup_offer_view_at($1, now()) as v`, ['f'.repeat(64)])).rows[0].v.result).toBe('not_found');
    expect((await db.query(`select private.makeup_offer_view_at($1, now()) as v`, ['bad'])).rows[0].v.result).toBe('not_found');
  }, 30_000);

  it('drafts are not linkable before the owner sends them and anon cannot read offers directly', async () => {
    const s = await setup();
    const batch = await plannedDraft(s);
    const optionId = (await db.query(`select id from public.makeup_offer_options where offer_batch_id=$1 and sort_order=1`, [batch.id])).rows[0].id;
    const guessed = (await db.query(`select private.makeup_token($1, now()) as t`, [batch.id])).rows[0].t;
    await db.exec(`set role anon`);
    expect((await db.query(`select public.makeup_offer_select($1, $2) as r`, [guessed, optionId])).rows[0].r.result).toBe('not_found');
    await expect(db.query(`select * from public.makeup_offer_batches`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from public.makeup_offer_options`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.admin_send_makeup_offer($1)`, [batch.id])).rejects.toThrow(/permission denied/);
    await db.exec(`reset role; set role authenticated`);
    await expect(db.query(`select selection_token_hash from public.makeup_offer_batches`)).rejects.toThrow(/permission denied/);
    await db.exec(`reset role`);
  }, 30_000);

  it('prepares the automatic path for an ordinary absence once the makeup template is approved', async () => {
    const s = await setup();
    await db.query(`update public.attendance_records set status='absent' where id=$1`, [s.record]);
    const [batch] = await batches();
    expect(batch).toMatchObject({ status: 'offered', delivery_mode: 'automatic', requires_manual_send: false });
    const types = (await db.query(`select message_type from public.parent_messages order by message_type`)).rows.map((r) => r.message_type);
    expect(types).toEqual(['absent', 'makeup_offer']);
  }, 30_000);
});

// ── reservation vs. finalization state machine ──────────────────────────────
const KIOSK_IP = '198.51.100.9';
async function withKiosk(s) {
  const code = await issueTestCode(db, s.student, '582913');
  const token = (await db.query(`select public.admin_register_kiosk_device('입구') as token`)).rows[0].token;
  return { ...s, code, token };
}
const kioskCheckIn = async (s, at) => (await db.query(
  `select private.kiosk_attendance_at($1, 'check_in', $2, $3::timestamptz, $4) as r`,
  [s.token, await testVerifier(s.code), at, KIOSK_IP],
)).rows[0].r;
const occupancy = async (session) => (await db.query(`select private.session_occupancy($1) as n`, [session])).rows[0].n;
const batchRow = async (id) => (await db.query(`select status, selected_option_id, makeup_plan_id, selected_at from public.makeup_offer_batches where id=$1`, [id])).rows[0];
const optionIdsOf = async (batch) => (await db.query(`select id from public.makeup_offer_options where offer_batch_id=$1 order by sort_order`, [batch])).rows.map((r) => r.id);
const selectAt = async (token, option, at = '2099-11-16T02:00:00Z') => (await db.query(`select private.makeup_offer_select_at($1, $2, $3::timestamptz) as r`, [token, option, at])).rows[0].r;
const offerMessages = async () => (await db.query(`select status from public.parent_messages where message_type='makeup_offer'`)).rows.map((r) => r.status);
const SEND_AT = '2099-11-16T01:00:00Z';

describe('makeup reservation does not pre-confirm absence', () => {
  it('a guardian selection on scheduled attendance reserves capacity exactly once without excusing or planning', async () => {
    const s = await setup();
    const batch = await plannedDraft(s);
    const token = await offerAt(batch.id, SEND_AT);
    const [first] = await optionIdsOf(batch.id);
    const before = await occupancy(s.options[0]);
    expect((await selectAt(token, first)).result).toBe('selected');
    expect((await db.query(`select status, guardian_contact_status from public.attendance_records where id=$1`, [s.record])).rows[0])
      .toEqual({ status: 'scheduled', guardian_contact_status: null });
    expect((await db.query(`select count(*)::int as n from public.makeup_plans`)).rows[0].n).toBe(0);
    expect(await batchRow(batch.id)).toMatchObject({ status: 'selected', selected_option_id: first, makeup_plan_id: null });
    expect(await occupancy(s.options[0])).toBe(before + 1);

    // explicit absence finalizes into exactly one plan linked to the batch, keeping session + contact fact
    await db.query(`update public.attendance_records set status='excused', absence_reason='사전 결석' where id=$1`, [s.record]);
    const plans = (await db.query(`select id, class_session_id, created_via, scheduled_at from public.makeup_plans`)).rows;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ class_session_id: s.options[0], created_via: 'makeup_selection' });
    const finalized = await batchRow(batch.id);
    expect(finalized).toMatchObject({ status: 'selected', makeup_plan_id: plans[0].id });
    const att = (await db.query(`select guardian_contact_status, guardian_contacted_at from public.attendance_records where id=$1`, [s.record])).rows[0];
    expect(att.guardian_contact_status).toBe('contacted');
    expect(new Date(att.guardian_contacted_at).toISOString()).toBe(new Date(finalized.selected_at).toISOString());
    expect(await occupancy(s.options[0])).toBe(before + 1);

    // idempotent finalization; finalized selection is immutable
    await db.query(`select private.finalize_makeup_selection($1)`, [s.record]);
    expect((await db.query(`select count(*)::int as n from public.makeup_plans`)).rows[0].n).toBe(1);
    await expect(db.query(`update public.makeup_offer_batches set status='cancelled' where id=$1`, [batch.id])).rejects.toThrow(/invalid makeup offer transition|immutable/);
    await expect(db.query(`update public.makeup_offer_batches set makeup_plan_id=null where id=$1`, [batch.id])).rejects.toThrow(/immutable/);
  }, 30_000);

  it('an unexpected arrival after selection checks in normally, cancels the reservation, link, and pending message', async () => {
    const s = await withKiosk(await setup());
    const batch = await plannedDraft(s);
    const token = await offerAt(batch.id, SEND_AT);
    const [first] = await optionIdsOf(batch.id);
    const before = await occupancy(s.options[0]);
    await selectAt(token, first);
    expect(await occupancy(s.options[0])).toBe(before + 1);
    expect(await offerMessages()).toEqual(['queued']);

    const result = await kioskCheckIn(s, '2099-11-16T06:50:00Z');
    expect(result).toMatchObject({ result: 'checked_in', status: 'present' });
    expect((await batchRow(batch.id)).status).toBe('cancelled');
    expect((await db.query(`select status from public.makeup_offer_options where id=$1`, [first])).rows[0].status).toBe('closed');
    expect(await occupancy(s.options[0])).toBe(before);
    expect((await db.query(`select count(*)::int as n from public.makeup_plans`)).rows[0].n).toBe(0);
    expect(await offerMessages()).toEqual(['cancelled']);
    expect((await db.query(`select private.makeup_offer_view_at($1, '2099-11-16T02:00:00Z') as v`, [token])).rows[0].v.result).toBe('closed');
    expect((await selectAt(token, first)).result).toBe('closed');
    expect((await db.query(`select private.makeup_selection_url($1) as u`, [batch.id])).rows[0].u).toBeNull();
  }, 30_000);

  it('arrival keeps already-sent provider history but still invalidates the link', async () => {
    const s = await withKiosk(await setup());
    const batch = await plannedDraft(s);
    const token = await offerAt(batch.id, SEND_AT);
    const [claim] = (await db.query(`select public.service_claim_parent_messages('dry_run', 5) as c`)).rows[0].c;
    await db.query(`select public.service_record_delivery_result($1, $2, $3, 'sent', 'dry_run', 'dry-run:x', true)`, [claim.message_id, claim.attempt_no, claim.claim_nonce]);
    expect(await offerMessages()).toEqual(['sent']);
    await kioskCheckIn(s, '2099-11-16T06:50:00Z');
    expect(await offerMessages()).toEqual(['sent']);
    expect((await batchRow(batch.id)).status).toBe('cancelled');
    expect((await db.query(`select private.makeup_offer_view_at($1, '2099-11-16T02:00:00Z') as v`, [token])).rows[0].v.result).toBe('closed');
  }, 30_000);

  it('draft → arrival → owner send fails the state check', async () => {
    const s = await withKiosk(await setup());
    const batch = await plannedDraft(s);
    await kioskCheckIn(s, '2099-11-16T06:50:00Z');
    expect((await batchRow(batch.id)).status).toBe('cancelled');
    await expect(db.query(`select public.admin_send_makeup_offer($1)`, [batch.id])).rejects.toThrow(/state changed/);
    expect(await offerMessages()).toEqual([]);
  }, 30_000);

  it('cancelling the planned absence cancels an offered batch, its link, and its pending message', async () => {
    const s = await setup();
    const batch = await plannedDraft(s);
    const token = await offerAt(batch.id, SEND_AT);
    const exception = (await db.query(`select id from public.attendance_exceptions`)).rows[0].id;
    await db.query(`select public.admin_cancel_attendance_exception($1)`, [exception]);
    expect((await batchRow(batch.id)).status).toBe('cancelled');
    expect(await offerMessages()).toEqual(['cancelled']);
    const [first] = await optionIdsOf(batch.id);
    expect((await selectAt(token, first)).result).toBe('closed');
  }, 30_000);

  it('cancelling the planned absence after selection releases the reservation; selection after cancellation is closed', async () => {
    const s = await setup();
    const batch = await plannedDraft(s);
    const token = await offerAt(batch.id, SEND_AT);
    const [first, second] = await optionIdsOf(batch.id);
    const before = await occupancy(s.options[0]);
    await selectAt(token, first);
    const exception = (await db.query(`select id from public.attendance_exceptions`)).rows[0].id;
    await db.query(`select public.admin_cancel_attendance_exception($1)`, [exception]);
    expect((await batchRow(batch.id)).status).toBe('cancelled');
    expect(await occupancy(s.options[0])).toBe(before);
    expect((await selectAt(token, second)).result).toBe('closed');
    // a later explicit absence does not resurrect the cancelled reservation
    await db.query(`update public.attendance_records set status='absent' where id=$1`, [s.record]);
    expect((await db.query(`select count(*)::int as n from public.makeup_plans`)).rows[0].n).toBe(0);
  }, 30_000);

  it('owner send revalidates the parent state: planned absence needs an active exception and scheduled attendance', async () => {
    const s = await setup();
    const batch = await plannedDraft(s);
    await db.query(`update public.attendance_exceptions set status='expired'`);
    await expect(db.query(`select public.admin_send_makeup_offer($1)`, [batch.id])).rejects.toThrow(/state changed/);
    expect((await batchRow(batch.id)).status).toBe('draft');
    expect(await offerMessages()).toEqual([]);
  }, 30_000);

  it('owner send for an ordinary absence requires the attendance to still be absent/excused', async () => {
    const s = await setup();
    await db.query(`update public.message_templates set approved=false, approved_by=null, approved_at=null where message_type='makeup_offer'`);
    await db.query(`update public.attendance_records set status='absent' where id=$1`, [s.record]);
    const [batch] = await batches();
    expect(batch.status).toBe('draft');
    await db.query(`select public.admin_approve_message_template('makeup_offer')`);
    // forge a stale parent: the batch claims ordinary absence while attendance is not absent
    await db.query(`alter table public.attendance_records disable trigger user`);
    await db.query(`update public.attendance_records set status='scheduled' where id=$1`, [s.record]);
    await db.query(`alter table public.attendance_records enable trigger user`);
    await expect(db.query(`select public.admin_send_makeup_offer($1)`, [batch.id])).rejects.toThrow(/state changed/);
  }, 30_000);

  it('ordinary absence selection finalizes the plan in the same transaction', async () => {
    const s = await setup();
    await db.query(`update public.attendance_records set status='absent' where id=$1`, [s.record]);
    const [batch] = await batches();
    const offered = (await db.query(`select offered_at from public.makeup_offer_batches where id=$1`, [batch.id])).rows[0].offered_at;
    const token = (await db.query(`select private.makeup_token($1, $2) as t`, [batch.id, offered])).rows[0].t;
    const [first] = await optionIdsOf(batch.id);
    const before = await occupancy(s.options[0]);
    expect((await selectAt(token, first, new Date(Date.now() + 1000).toISOString())).result).toBe('selected');
    const plans = (await db.query(`select id, class_session_id from public.makeup_plans`)).rows;
    expect(plans).toEqual([{ id: (await batchRow(batch.id)).makeup_plan_id, class_session_id: s.options[0] }]);
    expect(await occupancy(s.options[0])).toBe(before + 1);
    expect((await db.query(`select guardian_contact_status from public.attendance_records where id=$1`, [s.record])).rows[0].guardian_contact_status).toBe('contacted');
  }, 30_000);
});
