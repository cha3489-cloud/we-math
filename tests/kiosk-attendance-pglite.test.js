import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOpsDb, seedClass, asActor, issueTestCode, testVerifier, STUDENT_PROFILE } from './helpers/ops-db.js';

const CORE = ['20261115000000_kiosk_attendance_core.sql'];
let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const START = '2099-11-16T07:00:00Z';
const END = '2099-11-16T08:30:00Z';

async function setup({ start = START, end = END } = {}) {
  db = await createOpsDb(CORE);
  const seeded = await seedClass(db);
  const session = (await db.query(`select public.admin_create_class_session($1, $2, $3, 8) as id`, [seeded.group, start, end])).rows[0].id;
  const code = await issueTestCode(db, seeded.student, '482913');
  const token = (await db.query(`select public.admin_register_kiosk_device('입구 태블릿') as token`)).rows[0].token;
  return { ...seeded, session, code, token };
}
// The database only ever receives the Edge-Function-computed verifier, never the six digits.
const kiosk = async (token, action, code, at, ip = '198.51.100.7') => (
  await db.query(`select private.kiosk_attendance_at($1, $2, $3, $4::timestamptz, $5) as r`, [token, action, await testVerifier(code), at, ip])
).rows[0].r;
const coreSql = readFileSync(new URL('../supabase/migrations/20261115000000_kiosk_attendance_core.sql', import.meta.url), 'utf8');

describe('kiosk attendance core migration', () => {
  it('checks in a scheduled student as late exactly at 15 minutes and returns only masked minimal data', async () => {
    const s = await setup();
    expect(s.code).toMatch(/^\d{6}$/);
    const result = await kiosk(s.token, 'check_in', s.code, '2099-11-16T07:15:00Z');
    expect(result).toEqual({ result: 'checked_in', status: 'late', student_label: '가○○', at: '2099-11-16T07:15:00+00:00' });
    const row = (await db.query(`select status, checked_in_at, check_in_source from public.attendance_records where class_session_id=$1`, [s.session])).rows[0];
    expect(row.status).toBe('late');
    expect(row.check_in_source).toBe('kiosk');
  }, 30_000);

  it('records present at or before start and returns the existing result on duplicate check-in', async () => {
    const s = await setup();
    expect((await kiosk(s.token, 'check_in', s.code, START)).status).toBe('present');
    const again = await kiosk(s.token, 'check_in', s.code, '2099-11-16T07:05:00Z');
    expect(again.result).toBe('already_checked_in');
    expect(again.status).toBe('present');
    const rows = (await db.query(`select status, checked_in_at from public.attendance_records where student_id=$1`, [s.student])).rows;
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].checked_in_at).toISOString()).toBe('2099-11-16T07:00:00.000Z');
  }, 30_000);

  it('rejects checkout without a check-in and records exactly one checkout without changing present/late', async () => {
    const s = await setup();
    expect((await kiosk(s.token, 'check_out', s.code, '2099-11-16T07:30:00Z')).result).toBe('not_checked_in');
    await kiosk(s.token, 'check_in', s.code, '2099-11-16T07:10:00Z');
    const out = await kiosk(s.token, 'check_out', s.code, '2099-11-16T08:31:00Z');
    expect(out.result).toBe('checked_out');
    const dup = await kiosk(s.token, 'check_out', s.code, '2099-11-16T08:40:00Z');
    expect(dup.result).toBe('already_checked_out');
    expect(dup.at).toBe('2099-11-16T08:31:00+00:00');
    const row = (await db.query(`select status, checked_out_at, checkout_source from public.attendance_records where student_id=$1`, [s.student])).rows[0];
    expect(row.status).toBe('late');
    expect(row.checkout_source).toBe('kiosk');
  }, 30_000);

  it('rejects a sibling duplicate verifier, never reuses a revoked one, and rotation revokes the old code immediately', async () => {
    const s = await setup();
    const sibling = (await db.query(`select public.admin_create_student('가나라', '중1', '', 'active', true, '보호자', '010-0000-0000') as id`)).rows[0].id;
    await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [sibling, s.course, s.group]);
    // A colliding verifier is rejected with 23505 so the Edge Function retries with a fresh code;
    // the failed attempt must not revoke the sibling's existing code.
    await expect(issueTestCode(db, sibling, s.code)).rejects.toMatchObject({ code: '23505' });
    const siblingCode = await issueTestCode(db, sibling, '730148');
    await expect(issueTestCode(db, s.student, '730148')).rejects.toMatchObject({ code: '23505' });
    expect((await db.query(`select count(*)::int as n from public.student_attendance_codes where student_id=$1 and active`, [s.student])).rows[0].n).toBe(1);
    const verifiers = (await db.query(`select count(distinct code_verifier)::int as n, count(*)::int as total from public.student_attendance_codes where active`)).rows[0];
    expect(verifiers).toEqual({ n: 2, total: 2 });

    const rotated = (await db.query(`select public.admin_store_attendance_code_verifier($1, $2) as r`, [s.student, await testVerifier('615204')])).rows[0].r;
    expect(rotated.issue_kind).toBe('rotated');
    expect((await kiosk(s.token, 'check_in', s.code, START)).result).toBe('not_found');
    expect((await kiosk(s.token, 'check_in', '615204', START)).result).toBe('checked_in');
    // A revoked verifier is history, not free: re-issuing the old number is refused.
    await expect(issueTestCode(db, sibling, s.code)).rejects.toMatchObject({ code: '23505' });
    const siblingActive = (await db.query(`select code_verifier from public.student_attendance_codes where student_id=$1 and active`, [sibling])).rows;
    expect(siblingActive).toEqual([{ code_verifier: await testVerifier(siblingCode) }]);
    const stored = (await db.query(`select string_agg(code_verifier, ',') as h from public.student_attendance_codes`)).rows[0].h;
    for (const plain of [s.code, siblingCode, '615204']) expect(stored).not.toContain(plain);
    await expect(db.query(`select public.admin_store_attendance_code_verifier($1, '482913')`, [s.student])).rejects.toThrow(/invalid attendance code verifier/);
  }, 30_000);

  it('does not generate hidden plaintext codes for new or existing students', async () => {
    const s = await setup();
    const fresh = (await db.query(`select public.admin_create_student('신규', '중1') as id`)).rows[0].id;
    expect((await db.query(`select count(*)::int as n from public.student_attendance_codes where student_id=$1`, [fresh])).rows[0].n).toBe(0);
    expect((await db.query(`select count(*)::int as n from public.student_attendance_codes where student_id=$1`, [s.student])).rows[0].n).toBe(1);
    expect(coreSql).not.toMatch(/create trigger issue_attendance_code/i);
    expect(coreSql).not.toMatch(/random_six_digits|attendance_code_pepper|app_secrets|code_hash/);
  }, 30_000);

  it('accepts no raw code in any public function and exposes the kiosk transition to service_role only', async () => {
    const s = await setup();
    const publicFns = (await db.query(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like '%kiosk%' or p.proname like '%attendance_code%')`)).rows;
    expect(publicFns.map((f) => f.proname).sort()).toEqual([
      'admin_register_kiosk_device', 'admin_revoke_attendance_code', 'admin_revoke_kiosk_device',
      'admin_store_attendance_code_verifier', 'kiosk_mask_name', 'service_kiosk_attendance',
    ].sort());
    expect(publicFns.map((f) => f.args).join(' ')).not.toMatch(/p_code\b/);
    expect(coreSql).not.toMatch(/function public\.kiosk_attendance\(/);
    expect(coreSql).not.toMatch(/admin_issue_attendance_code/);

    const canExec = async (role, signature) => (await db.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, signature])).rows[0].ok;
    const kioskFn = 'public.service_kiosk_attendance(text, text, text, text)';
    const storeFn = 'public.admin_store_attendance_code_verifier(uuid, text)';
    expect(await canExec('service_role', kioskFn)).toBe(true);
    for (const role of ['anon', 'authenticated', 'public']) expect(await canExec(role, kioskFn)).toBe(false);
    expect(await canExec('anon', storeFn)).toBe(false);
    expect(await canExec('public', storeFn)).toBe(false);
    expect(await canExec('authenticated', storeFn)).toBe(true);

    await db.exec(`set role anon`);
    await expect(db.query(`select public.service_kiosk_attendance($1, 'check_in', $2, '')`, [s.token, await testVerifier(s.code)])).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.admin_store_attendance_code_verifier($1, $2)`, [s.student, await testVerifier('100200')])).rejects.toThrow(/permission denied/);
    await db.exec(`reset role`);
    await db.exec(`set role authenticated`);
    await expect(db.query(`select public.service_kiosk_attendance($1, 'check_in', $2, '')`, [s.token, await testVerifier(s.code)])).rejects.toThrow(/permission denied/);
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    await expect(db.query(`select public.admin_store_attendance_code_verifier($1, $2)`, [s.student, await testVerifier('100200')])).rejects.toThrow(/admin required/);
    await db.exec(`reset role`);
    await asActor(db);

    await db.exec(`set role service_role`);
    const viaService = (await db.query(`select public.service_kiosk_attendance($1, 'check_in', $2, '198.51.100.7') as r`, [s.token, await testVerifier(s.code)])).rows[0].r;
    await db.exec(`reset role`);
    expect(['checked_in', 'not_found']).toContain(viaService.result);
    expect(Object.keys(viaService).every((k) => ['result', 'status', 'student_label', 'at'].includes(k))).toBe(true);
  }, 30_000);

  it('never writes plaintext codes, code hashes, or device tokens into audit rows', async () => {
    const s = await setup();
    await kiosk(s.token, 'check_in', s.code, START);
    const audit = JSON.stringify((await db.query(`select before_data, after_data from public.operations_audit`)).rows)
      + JSON.stringify((await db.query(`select details from public.attendance_events`)).rows)
      + JSON.stringify((await db.query(`select before_data, after_data from public.student_registry_audit`)).rows.filter(Boolean).map(() => ''));
    expect(audit).not.toContain(s.code);
    expect(audit).not.toContain(s.token);
    expect(audit).not.toContain(await testVerifier(s.code));
    expect(audit).not.toContain('code_verifier');
    expect(audit).not.toContain('token_hash');
    const kioskEvent = (await db.query(`select actor_id, actor_kind, device_id from public.attendance_events where actor_kind='kiosk'`)).rows[0];
    expect(kioskEvent.actor_id).toBeNull();
    expect(kioskEvent.device_id).toBeTruthy();
    await expect(db.query(`update public.operations_audit set actor_kind='admin'`)).rejects.toThrow(/immutable/);
    await expect(db.query(`delete from public.operations_audit`)).rejects.toThrow(/immutable/);
  }, 30_000);

  it('rejects unregistered or revoked devices without letting ten distinct typos disable the whole kiosk', async () => {
    const s = await setup();
    expect((await kiosk('not-a-device', 'check_in', s.code, START, '203.0.113.9')).result).toBe('device_not_registered');
    for (let i = 0; i < 10; i += 1) {
      expect((await kiosk(s.token, 'check_in', String(100000 + i), START)).result).toBe('not_found');
    }
    expect((await kiosk(s.token, 'check_in', s.code, START)).result).toBe('checked_in');
    const device = (await db.query(`select id from public.academy_devices`)).rows[0].id;
    await db.query(`select public.admin_revoke_kiosk_device($1)`, [device]);
    expect((await kiosk(s.token, 'check_out', s.code, '2099-11-16T08:31:00Z', '192.0.2.2')).result).toBe('device_not_registered');
  }, 30_000);

  it('rate-limits the same guessed number across different registered devices and IP addresses', async () => {
    const s = await setup();
    const secondToken = (await db.query(`select public.admin_register_kiosk_device('보조 태블릿') as token`)).rows[0].token;
    for (let i = 0; i < 10; i += 1) {
      const token = i % 2 === 0 ? s.token : secondToken;
      const result = await kiosk(token, 'check_in', '555551', START, `198.51.100.${20 + i}`);
      expect(result.result).toBe('not_found');
    }
    expect((await kiosk(secondToken, 'check_in', '555551', START, '203.0.113.77')).result).toBe('rate_limited');
    expect((await kiosk(secondToken, 'check_in', s.code, START, '203.0.113.77')).result).toBe('checked_in');
  }, 30_000);

  it('denies anonymous roster reads and direct writes, exposing only the kiosk function', async () => {
    const s = await setup();
    await db.exec(`set role anon`);
    for (const table of ['students', 'attendance_records', 'student_attendance_codes', 'academy_devices', 'class_sessions', 'attendance_exceptions', 'attendance_followups', 'operations_audit']) {
      await expect(db.query(`select * from public.${table} limit 1`)).rejects.toThrow(/permission denied/);
    }
    await expect(db.query(`select public.admin_store_attendance_code_verifier($1, $2)`, [s.student, await testVerifier('000001')])).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from private.kiosk_attempt_buckets`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select private.kiosk_attendance_at($1, 'check_in', $2, now(), '')`, [s.token, await testVerifier('000001')])).rejects.toThrow(/permission denied/);
    await db.exec(`reset role`);
    await db.exec(`set role authenticated`);
    await expect(db.query(`select code_verifier from public.student_attendance_codes`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select token_hash from public.academy_devices`)).rejects.toThrow(/permission denied/);
    await db.exec(`reset role`);
  }, 30_000);

  it('opens missing work only after 15 minutes, suppresses it for planned exceptions, and expires exceptions after the session', async () => {
    const s = await setup();
    const other = (await db.query(`select public.admin_create_student('라마바', '중2', '', 'active', true, '보호자2', '010-0000-0001') as id`)).rows[0].id;
    await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [other, s.course, s.group]);
    const session2 = (await db.query(`select public.admin_create_class_session($1, '2099-11-16T09:00:00Z', '2099-11-16T10:00:00Z', 8) as id`, [s.group])).rows[0].id;
    const otherRecord = (await db.query(`select id from public.attendance_records where student_id=$1 and class_session_id=$2`, [other, session2])).rows[0].id;
    expect(otherRecord).toBeTruthy();
    const record = (await db.query(`select id from public.attendance_records where student_id=$1 and class_session_id=$2`, [s.student, s.session])).rows[0].id;
    await db.query(`select private.run_attendance_followups('2099-11-16T07:15:00Z')`);
    expect((await db.query(`select count(*)::int as n from public.attendance_followups`)).rows[0].n).toBe(0);
    await db.query(`select private.run_attendance_followups('2099-11-16T07:15:01Z')`);
    expect((await db.query(`select kind, status from public.attendance_followups where attendance_id=$1`, [record])).rows).toEqual([{ kind: 'missing', status: 'open' }]);
    // late arrival after the missing follow-up resolves it and still counts as late
    expect((await kiosk(s.token, 'check_in', s.code, '2099-11-16T07:40:00Z')).status).toBe('late');
    expect((await db.query(`select status, resolution from public.attendance_followups where attendance_id=$1`, [record])).rows[0]).toEqual({ status: 'resolved', resolution: 'arrived' });
  }, 30_000);

  it('queues checkout follow-up only after end plus 30 minutes and never for checked-out students', async () => {
    const s = await setup();
    await kiosk(s.token, 'check_in', s.code, START);
    await db.query(`select private.run_attendance_followups('2099-11-16T09:00:00Z')`);
    expect((await db.query(`select count(*)::int as n from public.attendance_followups where kind='checkout_needed'`)).rows[0].n).toBe(0);
    await db.query(`select private.run_attendance_followups('2099-11-16T09:00:01Z')`);
    expect((await db.query(`select count(*)::int as n from public.attendance_followups where kind='checkout_needed' and status='open'`)).rows[0].n).toBe(1);
    await db.query(`select private.run_attendance_followups('2099-11-16T09:10:00Z')`);
    expect((await db.query(`select count(*)::int as n from public.attendance_followups where kind='checkout_needed'`)).rows[0].n).toBe(1);
    await kiosk(s.token, 'check_out', s.code, '2099-11-16T09:20:00Z');
    expect((await db.query(`select status, resolution from public.attendance_followups where kind='checkout_needed'`)).rows[0]).toEqual({ status: 'resolved', resolution: 'checked_out' });
  }, 30_000);

  it('admin manual arrival requires a reason, classifies against the session, and loses a CAS race cleanly', async () => {
    const s = await setup({ start: '2026-01-05T07:00:00Z', end: '2026-01-05T08:30:00Z' });
    const record = (await db.query(`select id from public.attendance_records where class_session_id=$1`, [s.session])).rows[0].id;
    await expect(db.query(`select public.admin_record_manual_arrival($1, '2026-01-05T07:05:00Z', ' ')`, [record])).rejects.toThrow(/manual reason required/);
    const result = (await db.query(`select public.admin_record_manual_arrival($1, '2026-01-05T07:05:00Z', '입구 태블릿 네트워크 장애') as r`, [record])).rows[0].r;
    expect(result.status).toBe('late');
    await expect(db.query(`select public.admin_record_manual_arrival($1, '2026-01-05T07:06:00Z', '중복')`, [record])).rejects.toThrow(/attendance state changed/);
    expect((await kiosk(s.token, 'check_in', s.code, '2026-01-05T07:07:00Z')).result).toBe('already_checked_in');
    await db.query(`select public.admin_record_manual_checkout($1, '2026-01-05T08:35:00Z', '하원 확인 전화')`, [record]);
    await expect(db.query(`select public.admin_record_manual_checkout($1, '2026-01-05T08:36:00Z', '정정')`, [record])).rejects.toThrow(/attendance state changed/);
    await db.query(`select public.admin_record_manual_checkout($1, '2026-01-05T08:40:00Z', '실제 하원 시각 정정', '2026-01-05T08:35:00Z')`, [record]);
    const ev = (await db.query(`select details from public.attendance_events where attendance_id=$1 order by created_at desc limit 1`, [record])).rows[0].details;
    expect(new Date(ev.before.checked_out_at).toISOString()).toBe('2026-01-05T08:35:00.000Z');
    expect(new Date(ev.after.checked_out_at).toISOString()).toBe('2026-01-05T08:40:00.000Z');
    expect(ev.after.checkout_source).toBe('admin_correction');
    const eventText = JSON.stringify((await db.query(`select details from public.attendance_events where attendance_id=$1`, [record])).rows);
    expect(eventText).not.toContain('입구 태블릿 네트워크 장애');
    expect(eventText).not.toContain('하원 확인 전화');
    expect(eventText).not.toContain('실제 하원 시각 정정');
    await expect(db.query(`update public.attendance_records set checked_out_at='2026-01-05T09:00:00Z' where id=$1`, [record])).rejects.toThrow(/admin correction/);
    await expect(db.query(`update public.attendance_records set status='scheduled', checked_in_at=null, checked_out_at=null where id=$1`, [record])).rejects.toThrow();
  }, 30_000);

  it('scopes exceptions to one student and session, allows one active at a time, and audits changes', async () => {
    const s = await setup();
    const record = (await db.query(`select id from public.attendance_records where class_session_id=$1`, [s.session])).rows[0].id;
    const ex = (await db.query(`select public.admin_set_attendance_exception($1, 'expected_late', '2099-11-16T07:30:00Z', 'medical', '병원') as id`, [record])).rows[0].id;
    await expect(db.query(`select public.admin_set_attendance_exception($1, 'planned_absence')`, [record])).rejects.toThrow(/active exception already exists/);
    await db.query(`select private.run_attendance_followups('2099-11-16T07:40:00Z')`);
    expect((await db.query(`select count(*)::int as n from public.attendance_followups`)).rows[0].n).toBe(0);
    await db.query(`select public.admin_cancel_attendance_exception($1)`, [ex]);
    await expect(db.query(`select public.admin_cancel_attendance_exception($1)`, [ex])).rejects.toThrow(/state changed/);
    await db.query(`select private.run_attendance_followups('2099-11-16T07:41:00Z')`);
    expect((await db.query(`select count(*)::int as n from public.attendance_followups`)).rows[0].n).toBe(1);
    const ex2 = (await db.query(`select public.admin_set_attendance_exception($1, 'expected_late', '2099-11-16T07:50:00Z') as id`, [record])).rows[0].id;
    await db.query(`select private.run_attendance_followups('2099-11-16T08:31:00Z')`);
    expect((await db.query(`select status from public.attendance_exceptions where id=$1`, [ex2])).rows[0].status).toBe('expired');
    const audits = (await db.query(`select action, before_data->>'status' as before, after_data->>'status' as after, actor_kind from public.operations_audit where entity='attendance_exceptions' and entity_id=$1 order by id`, [ex])).rows;
    expect(audits).toEqual([
      { action: 'INSERT', before: null, after: 'active', actor_kind: 'admin' },
      { action: 'UPDATE', before: 'active', after: 'cancelled', actor_kind: 'admin' },
    ]);
  }, 30_000);
});
