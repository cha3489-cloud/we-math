import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOpsDb, seedClass, asActor, STUDENT_PROFILE, OPS_MIGRATIONS as SCHEDULER_MIGRATIONS } from './helpers/ops-db.js';
const SCHEDULER_MIGRATION = '20261115050000_recurring_schedules_operations_tick.sql';
const migrationSql = readFileSync(resolve(import.meta.dirname, '../supabase/migrations', SCHEDULER_MIGRATION), 'utf8');

// 2099-11-16 10:00 KST. KST today = 2099-11-16, tomorrow = 2099-11-17.
const NOW = '2099-11-16T01:00:00Z';
let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const isodow = async (day) => (await db.query(`select extract(isodow from $1::date)::int as d`, [day])).rows[0].d;
const create = (group, weekday, start, extra = {}) => db.query(
  `select public.admin_create_class_schedule($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date) as id`,
  [group, weekday, start, extra.duration ?? 90, extra.capacity ?? 8, extra.late ?? 10, extra.missing ?? 20, extra.from ?? '2099-11-01', extra.to ?? null],
).then((r) => r.rows[0].id);

describe('recurring class schedules', () => {
  it('validates input, prevents overlapping active slots, and updates/deactivates only with CAS', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    const s = await seedClass(db);
    const id = await create(s.group, 1, '16:00');
    await expect(create(s.group, 8, '16:00')).rejects.toThrow(/invalid schedule/);
    await expect(create(s.group, 1, '25:00')).rejects.toThrow(/invalid schedule/);
    await expect(create(s.group, 1, '16:00:30')).rejects.toThrow(/invalid schedule/);
    await expect(create(s.group, 1, '23:30', { duration: 60 })).rejects.toThrow(/invalid schedule/);
    await expect(create(s.group, 1, '10:00', { duration: 5 })).rejects.toThrow(/invalid schedule/);
    await expect(create(s.group, 1, '10:00', { capacity: 0 })).rejects.toThrow(/invalid schedule/);
    await expect(create(s.group, 1, '10:00', { from: '2099-11-10', to: '2099-11-09' })).rejects.toThrow(/invalid schedule/);
    await expect(create(s.group, 1, '10:00', { late: 30, missing: 10 })).rejects.toThrow(/invalid schedule/);
    // Same group, same weekday, overlapping time window and date range.
    await expect(create(s.group, 1, '17:00')).rejects.toThrow(/overlapping schedule/);
    // A different weekday or a later non-overlapping time is allowed.
    await create(s.group, 2, '16:00');
    await create(s.group, 1, '18:00');

    const listed = (await db.query(`select public.admin_list_class_schedules() as l`)).rows[0].l;
    const group = listed.groups.find((g) => g.id === s.group);
    expect(group.name).toBe('반A');
    expect(group.schedules.map((r) => [r.iso_weekday, r.local_start_time])).toEqual([[1, '16:00'], [1, '18:00'], [2, '16:00']]);
    expect(group.schedules[0]).toMatchObject({ id, duration_minutes: 90, capacity: 8, late_after_minutes: 10, missing_after_minutes: 20, active: true, revision: 1 });

    const rev = (await db.query(`select public.admin_update_class_schedule($1, 1, 1, '15:00', 60, 6, 5, 15, '2099-11-01'::date, null::date) as r`, [id])).rows[0].r;
    expect(rev).toBe(2);
    await expect(db.query(`select public.admin_update_class_schedule($1, 1, 1, '15:00', 60, 6, 5, 15, '2099-11-01'::date, null::date)`, [id])).rejects.toMatchObject({ code: '40001' });
    await expect(db.query(`select public.admin_deactivate_class_schedule($1, 1)`, [id])).rejects.toMatchObject({ code: '40001' });
    await db.query(`select public.admin_deactivate_class_schedule($1, 2)`, [id]);
    // Once inactive, the slot no longer blocks a new schedule.
    await create(s.group, 1, '15:30');
    const audit = (await db.query(`select action, actor_kind from public.operations_audit where entity = 'class_schedules' and entity_id = $1 order by id`, [id])).rows;
    expect(audit).toEqual([{ action: 'INSERT', actor_kind: 'admin' }, { action: 'UPDATE', actor_kind: 'admin' }, { action: 'UPDATE', actor_kind: 'admin' }]);

    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    await expect(create(s.group, 3, '16:00')).rejects.toThrow(/admin required/);
    await expect(db.query(`select public.admin_list_class_schedules()`)).rejects.toThrow(/admin required/);
    await asActor(db);
  }, 30_000);

  it('moves future untouched generated sessions when a schedule changes but preserves started attendance', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    const s = await seedClass(db);
    const today = await isodow('2099-11-16');
    const schedule = await create(s.group, today, '16:00', { duration: 60 });
    await db.query(`select private.run_operations_tick($1::timestamptz, 'service')`, [NOW]);
    await db.exec(`reset all`);
    await db.query(`select set_config('sequence.trusted_actor', '', false), set_config('sequence.trusted_device', '', false)`);
    await asActor(db);

    await db.query(`select public.admin_update_class_schedule($1, 1, $2, '17:00', 60, 8, 10, 20, '2099-11-01'::date, null::date)`, [schedule, today]);
    let row = (await db.query(`select s.starts_at, s.ends_at, r.scheduled_at, r.id as attendance_id from public.class_sessions s join public.attendance_records r on r.class_session_id=s.id where s.schedule_id=$1`, [schedule])).rows[0];
    expect(row.starts_at.toISOString()).toBe('2099-11-16T08:00:00.000Z');
    expect(row.ends_at.toISOString()).toBe('2099-11-16T09:00:00.000Z');
    expect(row.scheduled_at.toISOString()).toBe('2099-11-16T08:00:00.000Z');

    await db.exec(`select private.begin_trusted('kiosk'); update public.attendance_records set status='present', checked_in_at='2099-11-16T08:05:00Z', check_in_source='kiosk' where id='${row.attendance_id}'; select private.end_trusted()`);
    await db.exec(`reset all`);
    await db.query(`select set_config('sequence.trusted_actor', '', false), set_config('sequence.trusted_device', '', false)`);
    await asActor(db);
    await db.query(`select public.admin_update_class_schedule($1, 2, $2, '18:00', 60, 8, 10, 20, '2099-11-01'::date, null::date)`, [schedule, today]);
    row = (await db.query(`select starts_at from public.class_sessions where schedule_id=$1`, [schedule])).rows[0];
    expect(row.starts_at.toISOString()).toBe('2099-11-16T08:00:00.000Z');
  }, 30_000);

  it('blocks direct browser writes to schedules', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    const s = await seedClass(db);
    const priv = async (role, p) => (await db.query(`select has_table_privilege($1, 'public.class_schedules', $2) as ok`, [role, p])).rows[0].ok;
    expect(await priv('authenticated', 'select')).toBe(true);
    for (const p of ['insert', 'update', 'delete']) expect(await priv('authenticated', p)).toBe(false);
    expect(await priv('anon', 'select')).toBe(false);
    await db.exec(`set role authenticated`);
    await expect(db.query(`insert into public.class_schedules (class_group_id, iso_weekday, local_start_time, duration_minutes, effective_from) values ($1, 1, '16:00', 60, '2099-11-01')`, [s.group])).rejects.toThrow(/permission denied/);
    await db.exec(`reset role`);
  }, 30_000);
});

describe('internal operations tick', () => {
  it('idempotently generates KST today/tomorrow sessions and attendance rows from schedules without fake auth', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    const s = await seedClass(db);
    const paused = (await db.query(`select public.admin_create_student('휴원생', '중2', '', 'paused', true, '보호자', '010-0000-0001') as id`)).rows[0].id;
    await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [paused, s.course, s.group]);
    // Legacy free-text schedule must be ignored.
    await db.query(`update public.class_groups set schedule = '월수금 16:00' where id = $1`, [s.group]);
    const today = await isodow('2099-11-16');
    const tomorrow = await isodow('2099-11-17');
    const other = ((tomorrow % 7) + 1);
    const a = await create(s.group, today, '16:00', { duration: 90, capacity: 6, late: 10, missing: 20 });
    const b = await create(s.group, tomorrow, '09:30', { duration: 60 });
    await create(s.group, other, '16:00');
    await create(s.group, today, '19:00', { from: '2099-11-20' }); // not yet effective

    await db.exec(`select set_config('test.uid', '', false), set_config('test.admin', 'off', false)`);
    const first = (await db.query(`select private.run_operations_tick($1::timestamptz, 'service') as r`, [NOW])).rows[0].r;
    expect(first.generation).toMatchObject({ sessions_created: 2, records_created: 2 });
    expect(first.followups).toBeTruthy();
    const second = (await db.query(`select private.run_operations_tick($1::timestamptz, 'service') as r`, [NOW])).rows[0].r;
    expect(second.generation).toMatchObject({ sessions_created: 0, records_created: 0 });
    await asActor(db);

    const sessions = (await db.query(`
      select schedule_id, session_date::text as d, starts_at, ends_at, capacity, late_after_minutes, missing_after_minutes, created_by, created_via
      from public.class_sessions order by starts_at`)).rows;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ schedule_id: a, d: '2099-11-16', capacity: 6, late_after_minutes: 10, missing_after_minutes: 20, created_by: null, created_via: 'system' });
    expect(sessions[0].starts_at.toISOString()).toBe('2099-11-16T07:00:00.000Z');
    expect(sessions[0].ends_at.toISOString()).toBe('2099-11-16T08:30:00.000Z');
    expect(sessions[1]).toMatchObject({ schedule_id: b, d: '2099-11-17' });
    expect(sessions[1].starts_at.toISOString()).toBe('2099-11-17T00:30:00.000Z');
    const records = (await db.query(`select student_id, status, created_by, created_via, updated_via from public.attendance_records order by scheduled_at`)).rows;
    expect(records).toEqual([
      { student_id: s.student, status: 'scheduled', created_by: null, created_via: 'system', updated_via: 'system' },
      { student_id: s.student, status: 'scheduled', created_by: null, created_via: 'system', updated_via: 'system' },
    ]);
    const audit = (await db.query(`select distinct actor_kind, actor_id from public.operations_audit where entity = 'class_sessions'`)).rows;
    expect(audit).toEqual([{ actor_kind: 'system', actor_id: null }]);
    const runs = (await db.query(`select trigger_kind, triggered_by from public.operations_tick_runs order by started_at, id`)).rows;
    expect(runs).toEqual([{ trigger_kind: 'service', triggered_by: null }]);
    const signalColumns = (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='operations_refresh_events' order by ordinal_position`)).rows.map((r) => r.column_name);
    expect(signalColumns).toEqual(['id', 'entity', 'entity_id', 'occurred_at']);
    const signalEntities = (await db.query(`select distinct entity from public.operations_refresh_events order by entity`)).rows.map((r) => r.entity);
    expect(signalEntities).toEqual(expect.arrayContaining(['attendance_records', 'class_sessions']));
    expect(JSON.stringify((await db.query(`select * from public.operations_refresh_events`)).rows)).not.toMatch(/token|phone|student_name|rendered_body/);

    await db.exec(`reset all`);
    await db.query(`select set_config('sequence.trusted_actor', '', false), set_config('sequence.trusted_device', '', false)`);
    await asActor(db);
    expect((await db.query(`select private.trusted_actor() as actor`)).rows[0].actor).toBeNull();
    // Admins cannot hand-craft a schedule-sourced session.
    await expect(db.query(`insert into public.class_sessions (class_group_id, starts_at, ends_at, schedule_id, session_date) values ($1, '2099-11-18T09:00:00Z', '2099-11-18T10:00:00Z', $2, '2099-11-18')`, [s.group, a])).rejects.toThrow(/generated by the system/);
    // Durable source key: a second insert for the same schedule/date is rejected by the database itself.
    await expect(db.exec(`select private.begin_trusted('system'); insert into public.class_sessions (class_group_id, starts_at, ends_at, schedule_id, session_date) values ('${s.group}', '2099-11-16T09:00:00Z', '2099-11-16T10:00:00Z', '${a}', '2099-11-16')`)).rejects.toThrow(/duplicate key|unique/);
  }, 30_000);

  it('runs follow-ups in the same tick and exposes it to service_role only, with an audited admin recovery RPC', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    const s = await seedClass(db);
    await create(s.group, await isodow('2099-11-16'), '09:00', { duration: 60, late: 5, missing: 10 });
    // 09:30 KST: generated session started at 09:00 with missing threshold 10 minutes.
    const r = (await db.query(`select private.run_operations_tick('2099-11-16T00:30:00Z'::timestamptz, 'service') as r`)).rows[0].r;
    expect(r.generation.sessions_created).toBe(1);
    expect(r.followups.missing_opened).toBe(1);

    const canExec = async (role, sig) => (await db.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, sig])).rows[0].ok;
    expect(await canExec('service_role', 'public.service_operations_tick()')).toBe(true);
    for (const role of ['anon', 'authenticated', 'public']) expect(await canExec(role, 'public.service_operations_tick()')).toBe(false);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await canExec(role, 'private.run_operations_tick(timestamp with time zone, text)')).toBe(false);
      expect(await canExec(role, 'private.generate_scheduled_sessions(timestamp with time zone)')).toBe(false);
    }
    expect(await canExec('anon', 'public.admin_run_operations_tick()')).toBe(false);
    expect(await canExec('authenticated', 'public.admin_run_operations_tick()')).toBe(true);

    await db.exec(`set role service_role`);
    const viaService = (await db.query(`select public.service_operations_tick() as r`)).rows[0].r;
    await db.exec(`reset role`);
    expect(viaService.generation).toBeTruthy();

    await asActor(db);
    await db.query(`select public.admin_run_operations_tick()`);
    const adminRun = (await db.query(`select trigger_kind, triggered_by from public.operations_tick_runs where trigger_kind = 'admin'`)).rows;
    expect(adminRun).toEqual([{ trigger_kind: 'admin', triggered_by: '00000000-0000-0000-0000-0000000000a1' }]);
    await asActor(db, { uid: STUDENT_PROFILE, admin: false });
    await expect(db.query(`select public.admin_run_operations_tick()`)).rejects.toThrow(/admin required/);
    await asActor(db);
  }, 30_000);

  it('cancels future untouched generated sessions when a schedule is deactivated', async () => {
    db = await createOpsDb(SCHEDULER_MIGRATIONS);
    const s = await seedClass(db);
    const id = await create(s.group, await isodow('2099-11-17'), '16:00');
    await db.query(`select private.run_operations_tick($1::timestamptz, 'service')`, [NOW]);
    await db.query(`select private.admin_deactivate_class_schedule_at($1, 1, $2::timestamptz)`, [id, NOW]);
    expect((await db.query(`select status from public.class_sessions`)).rows).toEqual([{ status: 'cancelled' }]);
  }, 30_000);
});

describe('pg_cron and realtime migration contract', () => {
  it('installs pg_cron conditionally through dynamic SQL and replaces a stable 5-minute job', () => {
    const cronBlock = migrationSql.slice(migrationSql.indexOf('-- ── pg_cron'));
    expect(cronBlock).toMatch(/pg_available_extensions[\s\S]*name = 'pg_cron'/);
    expect(cronBlock).toMatch(/execute 'create extension if not exists pg_cron with schema pg_catalog'/);
    expect(cronBlock).toMatch(/cron\.unschedule/);
    expect(cronBlock).toMatch(/cron\.schedule\(\s*''sequence-operations-tick'',\s*''\*\/5 \* \* \* \*'',\s*''select public\.service_operations_tick\(\)''\s*\)/);
    expect(cronBlock).toContain("sequence-cron-history-cleanup");
    expect(cronBlock).toContain("delete from cron.job_run_details where end_time < now() - interval ''''7 days''''");
    // No static reference to the cron schema outside dynamic SQL strings.
    const staticSql = cronBlock.replace(/'(?:[^']|'')*'/g, "''");
    expect(staticSql).not.toMatch(/\bcron\./);
  });

  it('adds only the secret-free refresh signal to supabase_realtime idempotently', () => {
    const block = migrationSql.slice(migrationSql.indexOf('-- ── realtime'), migrationSql.indexOf('-- ── pg_cron'));
    expect(block).toMatch(/pg_publication where pubname = 'supabase_realtime'/);
    expect(block).toMatch(/pg_publication_tables/);
    expect(block).toContain("add table public.operations_refresh_events");
    for (const t of ['attendance_records', 'attendance_followups', 'parent_messages', 'makeup_offer_batches', 'daily_learning_plans', 'class_sessions']) {
      expect(block).not.toContain(`add table public.${t}`);
    }
    for (const t of ['student_attendance_codes', 'academy_devices', 'parent_message_recipients', 'kiosk_attempt_buckets']) expect(block).not.toContain(t);
    expect(block).not.toMatch(/selection_token_hash/);
  });

  it('executes the realtime block against an existing publication without duplicating members', async () => {
    const schedulerIndex = SCHEDULER_MIGRATIONS.indexOf(SCHEDULER_MIGRATION);
    db = await createOpsDb(SCHEDULER_MIGRATIONS.slice(0, schedulerIndex));
    await db.exec(`create publication supabase_realtime`);
    const sql = readFileSync(resolve(import.meta.dirname, '../supabase/migrations', SCHEDULER_MIGRATION), 'utf8');
    await db.exec(sql);
    const realtimeStart = sql.indexOf('-- ── realtime');
    const block = sql.slice(sql.indexOf('do $$', realtimeStart), sql.indexOf('-- ── pg_cron'));
    await db.exec(block);
    const tables = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`)).rows.map((r) => r.tablename);
    expect(tables).toEqual(['operations_refresh_events']);
  }, 30_000);
});
