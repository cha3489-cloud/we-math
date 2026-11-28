import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOpsDb, seedClass, asActor, issueTestCode, testVerifier, OPS_MIGRATIONS, ADMIN, STUDENT_PROFILE } from './helpers/ops-db.js';

// Dedicated learning-plan devices + device-bound read-only learning sessions.
// Attendance numbers are never a learning credential: the plan device authenticates with its own
// admin-issued token and only ever sees the published plan of the attendance row it was assigned.
const MIGRATION = '20261115070000_learning_device_sessions.sql';
const MIGRATIONS = OPS_MIGRATIONS.slice(0, OPS_MIGRATIONS.indexOf(MIGRATION) + 1);
const migrationSql = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
const kioskCoreSql = readFileSync(new URL('../supabase/migrations/20261115000000_kiosk_attendance_core.sql', import.meta.url), 'utf8');

// Mon 2099-11-16 16:00–17:30 KST.
const START = '2099-11-16T07:00:00Z';
const END = '2099-11-16T08:30:00Z';
const ARRIVE = '2099-11-16T06:55:00Z';
const DURING = '2099-11-16T07:30:00Z';
const DAY = '2099-11-16';
const NO_SESSION = { state: 'no_session' };

let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

async function addStudent(name, { start = START, end = END } = {}) {
  const s = await seedClass(db, { name });
  const session = (await one(`select public.admin_create_class_session($1, $2, $3, 8) as id`, [s.group, start, end])).id;
  const attendance = (await one(`select id from public.attendance_records where class_session_id=$1`, [session])).id;
  const code = await issueTestCode(db, s.student);
  return { ...s, session, attendance, code };
}

async function setup({ linked = false, start = START, end = END } = {}) {
  if (db) await db.close();
  db = await createOpsDb(MIGRATIONS);
  const s = await addStudent('가나다', { start, end });
  if (linked) await db.query(`update public.students set account_profile_id=$1 where id=$2`, [STUDENT_PROFILE, s.student]);
  const kioskToken = (await one(`select public.admin_register_kiosk_device('입구 태블릿') as t`)).t;
  const planToken = (await one(`select public.admin_register_learning_plan_device('학습 태블릿 1') as t`)).t;
  const kioskDevice = (await one(`select id from public.academy_devices where device_kind='kiosk'`)).id;
  const planDevice = (await one(`select id from public.academy_devices where device_kind='learning_plan'`)).id;
  return { ...s, kioskToken, planToken, kioskDevice, planDevice };
}

const kiosk = async (token, action, code, at, ip = '198.51.100.7') => (
  await one(`select private.kiosk_attendance_at($1, $2, $3, $4::timestamptz, $5) as r`, [token, action, await testVerifier(code), at, ip])
).r;
const assignAt = async (device, attendance, at = DURING) => (await one(`select private.assign_learning_device_at($1, $2, $3::timestamptz) as r`, [device, attendance, at])).r;
const readAt = async (token, at = DURING) => (await one(`select private.learning_device_today_plan_at($1, $2::timestamptz) as r`, [token, at])).r;
const sessionRow = (id) => one(`select status, revision, revoke_reason, revoked_by, expires_at from public.learning_device_sessions where id=$1`, [id]);
const activeFor = (device) => all(`select id, student_id, attendance_id from public.learning_device_sessions where device_id=$1 and status='active'`, [device]);

async function publishCustomPlan(s) {
  const items = [
    { item_type: 'note', title: '오늘 확인', body: '연산 10문제', internal_note: 'SECRET-INTERNAL-NOTE', source_id: 'assignment:SECRET-SOURCE' },
    { item_type: 'homework', title: '숙제 p.30', body: '', internal_note: 'SECRET-INTERNAL-NOTE' },
  ];
  const plan = (await one(`select public.admin_save_learning_plan_draft($1, $2::date, $3, $4::jsonb) as id`, [s.student, DAY, s.session, JSON.stringify(items)])).id;
  const revision = (await one(`select source_revision from public.daily_learning_plans where id=$1`, [plan])).source_revision;
  await db.query(`select public.admin_publish_learning_plan($1, $2)`, [plan, revision]);
  return { plan, revision };
}

describe('learning-plan device registration', () => {
  it('registers kiosk and learning-plan devices with server-controlled kinds and one-time tokens stored only as hashes', async () => {
    const s = await setup();
    expect(s.planToken).toMatch(/^[0-9a-f]{64}$/);
    expect(s.kioskToken).toMatch(/^[0-9a-f]{64}$/);
    expect(s.planToken).not.toBe(s.kioskToken);
    const rows = await all(`select device_kind, token_hash from public.academy_devices order by device_kind`);
    expect(rows.map((r) => r.device_kind)).toEqual(['kiosk', 'learning_plan']);
    for (const row of rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect([s.planToken, s.kioskToken]).not.toContain(row.token_hash);
    }
    const audits = JSON.stringify(await all(`select before_data, after_data from public.operations_audit where entity='academy_devices'`));
    expect(audits).toContain('learning_plan');
    expect(audits).not.toContain(s.planToken);
    expect(audits).not.toContain(s.kioskToken);
    expect(audits).not.toContain('token_hash');
    // Existing rows default to kiosk; the kind is immutable once registered.
    expect((await one(`select column_default from information_schema.columns where table_name='academy_devices' and column_name='device_kind'`)).column_default).toContain('kiosk');
    await expect(db.query(`update public.academy_devices set device_kind='kiosk' where id=$1`, [s.planDevice])).rejects.toThrow(/immutable/);
    await expect(db.query(`update public.academy_devices set token_hash=repeat('0', 64) where id=$1`, [s.planDevice])).rejects.toThrow(/immutable/);
  }, 60_000);

  it('requires an admin for registration and keeps token hashes out of the admin device list', async () => {
    const s = await setup();
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    await expect(db.query(`select public.admin_register_learning_plan_device('x')`)).rejects.toThrow(/admin required/);
    await expect(db.query(`select public.admin_list_devices()`)).rejects.toThrow(/admin required/);
    await asActor(db);
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    await assignAt(s.planDevice, s.attendance);
    const list = (await one(`select public.admin_list_devices() as r`)).r;
    expect(list).toHaveLength(2);
    for (const device of list) {
      expect(Object.keys(device).sort()).toEqual(['assignment', 'device_kind', 'device_name', 'id', 'last_seen_at', 'status']);
    }
    const plan = list.find((d) => d.device_kind === 'learning_plan');
    expect(Object.keys(plan.assignment).sort()).toEqual(['attendance_id', 'expires_at', 'revision', 'session_id', 'student_name']);
    expect(plan.assignment).toMatchObject({ attendance_id: s.attendance, student_name: '가나다', revision: 1 });
    expect(list.find((d) => d.device_kind === 'kiosk').assignment).toBeNull();
    const text = JSON.stringify(list);
    for (const secret of ['token_hash', s.planToken, s.kioskToken, '010-0000-0000', '보호자']) expect(text).not.toContain(secret);
  }, 60_000);
});

describe('kiosk and learning-plan devices cannot be cross-used', () => {
  it('rejects a learning-plan token at the kiosk and a kiosk token at the plan reader with generic responses', async () => {
    const s = await setup();
    expect(await kiosk(s.planToken, 'check_in', s.code, ARRIVE)).toEqual({ result: 'device_not_registered' });
    expect(await kiosk('f'.repeat(64), 'check_in', s.code, ARRIVE)).toEqual({ result: 'device_not_registered' });
    expect((await one(`select status from public.attendance_records where id=$1`, [s.attendance])).status).toBe('scheduled');
    expect((await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE)).result).toBe('checked_in');
    await assignAt(s.planDevice, s.attendance);
    // A kiosk token, unknown, malformed, or empty token all look identical to "no session".
    for (const token of [s.kioskToken, 'f'.repeat(64), 'short', '', null]) {
      expect(await readAt(token)).toEqual(NO_SESSION);
    }
    // A kiosk device can never carry a learning session.
    await expect(assignAt(s.kioskDevice, s.attendance)).rejects.toThrow(/learning device not available/);
    await expect(db.query(`select public.admin_revoke_learning_plan_device($1)`, [s.kioskDevice])).rejects.toThrow(/device state changed/);
    await expect(db.query(`select public.admin_revoke_kiosk_device($1)`, [s.planDevice])).rejects.toThrow(/device state changed/);
  }, 60_000);
});

describe('device-bound read-only plan', () => {
  it('moves from no_session to preparing to ready and returns only published, secret-free plan content', async () => {
    const s = await setup();
    expect(await readAt(s.planToken)).toEqual(NO_SESSION);
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    const assigned = await assignAt(s.planDevice, s.attendance);
    expect(assigned).toMatchObject({ revision: 1 });
    expect(new Date(assigned.expires_at).toISOString()).toBe('2099-11-16T12:30:00.000Z'); // ends_at + 4h
    // The arrival-generated draft is never visible.
    expect((await one(`select count(*)::int as n from public.daily_learning_plans where student_id=$1 and status='draft'`, [s.student])).n).toBe(1);
    expect(await readAt(s.planToken)).toEqual({ state: 'preparing', plan_date: DAY });

    const { plan, revision } = await publishCustomPlan(s);
    const view = await readAt(s.planToken);
    expect(view).toEqual({
      state: 'ready',
      plan_date: DAY,
      source_revision: revision,
      items: [
        { item_type: 'homework', title: '숙제 p.30', body: '', teacher_status: 'pending' },
        { item_type: 'note', title: '오늘 확인', body: '연산 10문제', teacher_status: 'pending' },
      ],
    });
    const text = JSON.stringify(view);
    for (const secret of [s.student, s.attendance, s.session, plan, '가나다', '보호자', '010-0000-0000', 'SECRET-INTERNAL-NOTE', 'SECRET-SOURCE', s.planToken, STUDENT_PROFILE, ADMIN]) {
      expect(text).not.toContain(secret);
    }
    const seen = (await one(`select last_seen_at from public.academy_devices where id=$1`, [s.planDevice])).last_seen_at;
    expect(new Date(seen).toISOString()).toBe(new Date(DURING).toISOString());
  }, 60_000);

  it('expires a stale session inside the read call and caps expiry at the end of the KST plan day', async () => {
    const s = await setup();
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    const assigned = await assignAt(s.planDevice, s.attendance);
    expect((await readAt(s.planToken, '2099-11-16T12:29:59Z')).state).toBe('preparing');
    expect(await readAt(s.planToken, '2099-11-16T12:30:00Z')).toEqual(NO_SESSION);
    expect(await sessionRow(assigned.session_id)).toMatchObject({ status: 'expired', revoke_reason: 'expired', revision: 2, revoked_by: null });
    const audit = await one(`select actor_kind, actor_id from public.operations_audit where entity='learning_device_sessions' and entity_id=$1 and action='UPDATE'`, [assigned.session_id]);
    expect(audit).toEqual({ actor_kind: 'system', actor_id: null });

    // 22:00–23:00 KST: ends_at + 4h would cross midnight, so the session ends at KST midnight.
    const late = await setup({ start: '2099-11-16T13:00:00Z', end: '2099-11-16T14:00:00Z' });
    await kiosk(late.kioskToken, 'check_in', late.code, '2099-11-16T12:55:00Z');
    const capped = await assignAt(late.planDevice, late.attendance, '2099-11-16T13:10:00Z');
    expect(new Date(capped.expires_at).toISOString()).toBe('2099-11-16T15:00:00.000Z');
  }, 90_000);

  it('only assigns present/late, not-checked-out, account-unlinked attendance of today (KST) to an active learning device', async () => {
    const s = await setup();
    await expect(assignAt(s.planDevice, s.attendance)).rejects.toThrow(/not eligible/); // still scheduled
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    await expect(assignAt(s.planDevice, s.attendance, '2099-11-17T07:30:00Z')).rejects.toThrow(/not eligible/); // not today
    await expect(assignAt(s.planDevice, s.attendance, '2099-11-16T12:31:00Z')).rejects.toThrow(/already be expired/);
    await expect(assignAt(s.planDevice, '00000000-0000-0000-0000-00000000dead')).rejects.toThrow(/not eligible/);

    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    await expect(db.query(`select public.admin_assign_learning_device($1, $2)`, [s.planDevice, s.attendance])).rejects.toThrow(/admin required/);
    await expect(assignAt(s.planDevice, s.attendance)).rejects.toThrow(/admin required/);
    await asActor(db);

    await db.query(`select public.admin_revoke_learning_plan_device($1)`, [s.planDevice]);
    await expect(assignAt(s.planDevice, s.attendance)).rejects.toThrow(/learning device not available/);

    const linked = await setup({ linked: true });
    await kiosk(linked.kioskToken, 'check_in', linked.code, ARRIVE);
    await expect(assignAt(linked.planDevice, linked.attendance)).rejects.toThrow(/account-linked/);

    const out = await setup();
    await kiosk(out.kioskToken, 'check_in', out.code, ARRIVE);
    await kiosk(out.kioskToken, 'check_out', out.code, '2099-11-16T08:35:00Z');
    await expect(assignAt(out.planDevice, out.attendance, '2099-11-16T08:40:00Z')).rejects.toThrow(/not eligible/);
    expect((await one(`select count(*)::int as n from public.learning_device_sessions`)).n).toBe(0);
  }, 120_000);
});

describe('session lifecycle', () => {
  it('reassignment atomically revokes the previous device and student sessions', async () => {
    const s = await setup();
    const other = await addStudent('라마바');
    const second = (await one(`select public.admin_register_learning_plan_device('학습 태블릿 2') as t`)).t;
    const secondDevice = (await one(`select id from public.academy_devices where device_name='학습 태블릿 2'`)).id;
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    await kiosk(s.kioskToken, 'check_in', other.code, ARRIVE);

    const first = await assignAt(s.planDevice, s.attendance);
    const moved = await assignAt(s.planDevice, other.attendance); // same device, another student
    expect(await sessionRow(first.session_id)).toMatchObject({ status: 'revoked', revoke_reason: 'reassigned', revoked_by: ADMIN });
    expect(await activeFor(s.planDevice)).toEqual([{ id: moved.session_id, student_id: other.student, attendance_id: other.attendance }]);

    const swapped = await assignAt(secondDevice, other.attendance); // same student, another device
    expect(await sessionRow(moved.session_id)).toMatchObject({ status: 'revoked', revoke_reason: 'reassigned' });
    expect(await activeFor(s.planDevice)).toEqual([]);
    expect((await activeFor(secondDevice)).map((r) => r.id)).toEqual([swapped.session_id]);
    expect(await readAt(s.planToken)).toEqual(NO_SESSION);
    expect((await readAt(second)).state).toBe('preparing');
    expect((await one(`select count(*)::int as n from public.learning_device_sessions where status='active'`)).n).toBe(1);
  }, 90_000);

  it('revokes with compare-and-set on the session revision and audits before/after without secrets', async () => {
    const s = await setup();
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    const assigned = await assignAt(s.planDevice, s.attendance);
    await expect(db.query(`select public.admin_revoke_learning_device_session($1, 2)`, [assigned.session_id])).rejects.toThrow(/learning device session changed/);
    await db.query(`select public.admin_revoke_learning_device_session($1, 1)`, [assigned.session_id]);
    expect(await sessionRow(assigned.session_id)).toMatchObject({ status: 'revoked', revoke_reason: 'admin_revoked', revision: 2, revoked_by: ADMIN });
    await expect(db.query(`select public.admin_revoke_learning_device_session($1, 2)`, [assigned.session_id])).rejects.toThrow(/learning device session changed/);
    expect(await readAt(s.planToken)).toEqual(NO_SESSION);

    const audits = await all(`select action, before_data, after_data, actor_kind, actor_id from public.operations_audit where entity='learning_device_sessions' and entity_id=$1 order by id`, [assigned.session_id]);
    expect(audits.map((a) => a.action)).toEqual(['INSERT', 'UPDATE']);
    expect(audits[1].before_data.status).toBe('active');
    expect(audits[1].after_data.status).toBe('revoked');
    expect(audits[1]).toMatchObject({ actor_kind: 'admin', actor_id: ADMIN });
    const text = JSON.stringify(audits);
    expect(text).not.toContain(s.planToken);
    expect(text).not.toContain('token_hash');
  }, 60_000);

  it('keeps identity immutable and only lets a session end once, through server functions', async () => {
    const s = await setup();
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    const assigned = await assignAt(s.planDevice, s.attendance);
    await expect(db.query(`update public.learning_device_sessions set status='revoked', revoke_reason='admin_revoked' where id=$1`, [assigned.session_id])).rejects.toThrow(/server functions/);
    await expect(db.query(`insert into public.learning_device_sessions (device_id, student_id, attendance_id, expires_at, assigned_by) values ($1, $2, $3, $4, $5)`, [s.planDevice, s.student, s.attendance, '2099-11-16T12:00:00Z', ADMIN])).rejects.toThrow(/server functions/);
    await db.exec(`select set_config('sequence.learning_session_write', 'on', false)`);
    try {
      await expect(db.query(`update public.learning_device_sessions set updated_at=now() where id=$1`, [assigned.session_id])).rejects.toThrow(/can only end/);
      await expect(db.query(`update public.learning_device_sessions set expires_at='2099-11-17T00:00:00Z' where id=$1`, [assigned.session_id])).rejects.toThrow(/immutable/);
      await expect(db.query(`insert into public.learning_device_sessions (device_id, student_id, attendance_id, expires_at, assigned_by) values ($1, $2, $3, $4, $5)`, [s.planDevice, s.student, s.attendance, '2099-11-16T12:00:00Z', ADMIN])).rejects.toThrow(/unique|duplicate/);
      await db.query(`update public.learning_device_sessions set status='revoked', revoke_reason='admin_revoked' where id=$1`, [assigned.session_id]);
      await expect(db.query(`update public.learning_device_sessions set status='active', revoke_reason=null, revoked_at=null where id=$1`, [assigned.session_id])).rejects.toThrow(/immutable/);
    } finally {
      await db.exec(`select set_config('sequence.learning_session_write', '', false)`);
    }
  }, 60_000);
});

describe('automatic revocation', () => {
  async function assigned(opts) {
    const s = await setup(opts);
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    const a = await assignAt(s.planDevice, s.attendance);
    return { ...s, sessionId: a.session_id };
  }

  it('revokes on actual kiosk checkout, attributed to the kiosk, without any guardian message', async () => {
    const s = await assigned();
    const before = (await one(`select count(*)::int as n from public.parent_messages where attendance_id=$1`, [s.attendance])).n;
    await kiosk(s.kioskToken, 'check_out', s.code, '2099-11-16T08:35:00Z');
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: 'revoked', revoke_reason: 'checked_out', revoked_by: null });
    const audit = await one(`select actor_kind, device_id from public.operations_audit where entity='learning_device_sessions' and entity_id=$1 and action='UPDATE'`, [s.sessionId]);
    expect(audit).toEqual({ actor_kind: 'kiosk', device_id: s.kioskDevice });
    expect(await readAt(s.planToken, '2099-11-16T08:36:00Z')).toEqual(NO_SESSION);
    const after = (await all(`select message_type from public.parent_messages where attendance_id=$1`, [s.attendance])).map((m) => m.message_type);
    expect(after.length - before).toBeLessThanOrEqual(1); // only the existing checkout notice, never a device notice
    expect(after).not.toContain('learning_device');
  }, 60_000);

  it('revokes when attendance is corrected away from present/late', async () => {
    const s = await assigned();
    // Final statuses are immutable today (validate_attendance_transition); this simulates any
    // future correction path so the revocation trigger never depends on that guard.
    await db.exec(`alter table public.attendance_records disable trigger validate_attendance_transition`);
    await db.query(`update public.attendance_records set status='absent', checked_in_at=null where id=$1`, [s.attendance]);
    await db.exec(`alter table public.attendance_records enable trigger validate_attendance_transition`);
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: 'revoked', revoke_reason: 'attendance_changed' });
  }, 60_000);

  it('revokes when the class session is cancelled', async () => {
    const s = await assigned();
    await db.query(`select public.admin_cancel_class_session($1)`, [s.session]);
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: 'revoked', revoke_reason: 'session_cancelled' });
  }, 60_000);

  it('revokes when the device is revoked', async () => {
    const s = await assigned();
    await db.query(`select public.admin_revoke_learning_plan_device($1)`, [s.planDevice]);
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: 'revoked', revoke_reason: 'device_revoked' });
    expect(await readAt(s.planToken)).toEqual(NO_SESSION);
  }, 60_000);

  it('revokes when the student account becomes linked (phone + PIN login takes over)', async () => {
    const s = await assigned();
    await db.query(`update public.students set account_profile_id=$1 where id=$2`, [STUDENT_PROFILE, s.student]);
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: 'revoked', revoke_reason: 'account_linked' });
  }, 60_000);
});

describe('privileges, RLS, and realtime', () => {
  it('denies raw table writes, hides sessions from non-admins, and exposes only the read RPC to anon', async () => {
    const s = await setup();
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    const a = await assignAt(s.planDevice, s.attendance);
    const canExec = async (role, sig) => (await one(`select has_function_privilege($1, $2, 'execute') as ok`, [role, sig])).ok;
    expect(await canExec('anon', 'public.learning_device_today_plan(text)')).toBe(true);
    expect(await canExec('authenticated', 'public.learning_device_today_plan(text)')).toBe(true);
    for (const sig of ['public.admin_register_learning_plan_device(text)', 'public.admin_assign_learning_device(uuid, uuid)', 'public.admin_revoke_learning_device_session(uuid, integer)', 'public.admin_revoke_learning_plan_device(uuid)', 'public.admin_list_devices()']) {
      expect(await canExec('anon', sig)).toBe(false);
      expect(await canExec('authenticated', sig)).toBe(true);
    }
    for (const sig of ['private.learning_device_today_plan_at(text, timestamptz)', 'private.assign_learning_device_at(uuid, uuid, timestamptz)']) {
      expect(await canExec('anon', sig)).toBe(false);
      expect(await canExec('authenticated', sig)).toBe(false);
    }
    // No write-capable function for the device exists.
    const fns = (await all(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'learning_device%'`)).map((r) => r.proname);
    expect(fns).toEqual(['learning_device_today_plan']);

    await db.exec(`set role authenticated`);
    try {
      await asActor(db);
      expect((await all(`select id, status from public.learning_device_sessions`))).toEqual([{ id: a.session_id, status: 'active' }]);
      expect((await all(`select id, device_kind, status from public.academy_devices order by device_kind`)).map((r) => r.device_kind)).toEqual(['kiosk', 'learning_plan']);
      await expect(db.query(`select token_hash from public.academy_devices`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`update public.learning_device_sessions set status='revoked'`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`delete from public.learning_device_sessions`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`insert into public.learning_device_sessions (device_id, student_id, attendance_id, expires_at, assigned_by) values ($1, $2, $3, now() + interval '1 hour', $4)`, [s.planDevice, s.student, s.attendance, ADMIN])).rejects.toThrow(/permission denied/);
      await asActor(db, { uid: STUDENT_PROFILE, admin: false });
      expect(await all(`select id from public.learning_device_sessions`)).toHaveLength(0);
      await db.exec(`reset role; set role anon`);
      await asActor(db, { uid: null, admin: false });
      await expect(db.query(`select id from public.learning_device_sessions`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select public.admin_assign_learning_device($1, $2)`, [s.planDevice, s.attendance])).rejects.toThrow(/permission denied/);
      expect((await one(`select public.learning_device_today_plan($1) as r`, ['0'.repeat(64)])).r).toEqual(NO_SESSION);
      // The real anonymous path (server time) still resolves the assigned 2099 attendance session.
      expect((await one(`select public.learning_device_today_plan($1) as r`, [s.planToken])).r).toEqual({ state: 'preparing', plan_date: DAY });
    } finally {
      await db.exec(`reset role`);
      await asActor(db);
    }
  }, 60_000);

  it('signals admins only through operations_refresh_events and never publishes device or session rows', async () => {
    const s = await setup();
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    const a = await assignAt(s.planDevice, s.attendance);
    const events = await all(`select entity from public.operations_refresh_events where entity_id=$1`, [a.session_id]);
    expect(events.map((e) => e.entity)).toEqual(['learning_device_sessions']);
    expect(migrationSql).toMatch(/create trigger refresh_signal_learning_device_sessions/);
    expect(migrationSql).not.toMatch(/alter publication[^;]*learning_device_sessions/i);
    expect(migrationSql).not.toMatch(/alter publication[^;]*academy_devices/i);
    // Polling last_seen_at is not a refresh signal.
    const before = (await one(`select count(*)::int as n from public.operations_refresh_events`)).n;
    await readAt(s.planToken);
    expect((await one(`select count(*)::int as n from public.operations_refresh_events`)).n).toBe(before);
  }, 60_000);

  it('adds account-link and current device assignment to the admin session row', async () => {
    const s = await setup();
    await kiosk(s.kioskToken, 'check_in', s.code, ARRIVE);
    const a = await assignAt(s.planDevice, s.attendance);
    const row = (await one(`select private.operations_session_json($1) as r`, [s.attendance])).r;
    expect(row.account_linked).toBe(false);
    expect(row.learning_device).toEqual({ session_id: a.session_id, revision: 1, device_id: s.planDevice, device_name: '학습 태블릿 1', expires_at: row.learning_device.expires_at });
    expect(row.status).toBe('present');
    await db.query(`select public.admin_revoke_learning_device_session($1, 1)`, [a.session_id]);
    expect((await one(`select private.operations_session_json($1) as r`, [s.attendance])).r.learning_device).toBeNull();
  }, 60_000);

  it('is listed in the ops migration chain after the autogeneration migration', () => {
    expect(OPS_MIGRATIONS.indexOf(MIGRATION)).toBe(OPS_MIGRATIONS.indexOf('20261115060000_learning_plan_autogeneration.sql') + 1);
    expect(kioskCoreSql).toMatch(/device_kind = 'kiosk'/);
  });
});
