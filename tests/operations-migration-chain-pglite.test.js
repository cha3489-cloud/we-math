import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createOpsDb, asActor, issueTestCode, testVerifier, CHAIN, OPS_MIGRATIONS } from './helpers/ops-db.js';

// Whole-chain catalog invariants for the kiosk / messaging / learning-plan / makeup migrations,
// applied the way production will receive them: on top of an existing database that already
// holds the base attendance + registry chain, legacy rows, and the supabase_realtime publication,
// with Supabase's default privileges granting every new public object to anon, authenticated
// and service_role. Fresh installs run the same files in the same order (see the other
// *-pglite tests, which start from an empty database).
const migrationsDir = new URL('../supabase/migrations/', import.meta.url);

// Objects created by the test harness itself, not by any migration under test.
const STUB_TABLES = new Set(['profiles', 'user_roles']);
const STUB_FUNCTIONS = new Set(['is_admin()']);
const ANON_RPC = ['kiosk_mask_name(text)', 'learning_device_today_plan(text)', 'makeup_offer_select(text,uuid)', 'makeup_offer_view(text)'];
// Pre-existing column-level admin edit grants from 20261028000000; everything else is RPC-only.
const AUTHENTICATED_WRITABLE = ['attendance_records', 'makeup_plans'];

let db;
let legacy;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

beforeAll(async () => {
  db = await createOpsDb([], { supabaseDefaultPrivileges: true });
  await asActor(db);
  await db.exec(`create publication supabase_realtime`);
  const student = (await one(`select public.admin_create_student('기존학생', '중2', '', 'active', true, '보호자', '010-0000-0000') as id`)).id;
  const done = (await one(`
    insert into public.attendance_records (student_id, scheduled_at, status, checked_in_at, checked_out_at, created_by, updated_by)
    values ($1, '2026-11-02T07:00:00Z', 'present', '2026-11-02T06:58:00Z', '2026-11-02T08:31:00Z', auth.uid(), auth.uid()) returning id`, [student])).id;
  const absent = (await one(`
    insert into public.attendance_records (student_id, scheduled_at, status, absence_reason, created_by, updated_by)
    values ($1, '2026-11-04T07:00:00Z', 'absent', '감기', auth.uid(), auth.uid()) returning id`, [student])).id;
  legacy = { student, done, absent };
  for (const file of OPS_MIGRATIONS) await db.exec(await readFile(new URL(file, migrationsDir), 'utf8'));
  await asActor(db);
}, 120_000);

afterAll(async () => { if (db) await db.close(); });

describe('operations migration chain', () => {
  it('covers every migration from the attendance base onward, in filename order', () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && f >= CHAIN[0]).sort();
    expect([...CHAIN, ...OPS_MIGRATIONS]).toEqual(files);
  });

  it('upgrades an existing install without touching legacy attendance rows', async () => {
    const rows = await all(`select id, status, class_session_id, updated_via, checkout_source, checked_out_at from public.attendance_records where student_id=$1 order by scheduled_at`, [legacy.student]);
    expect(rows.map((r) => [r.id, r.status, r.class_session_id, r.updated_via, r.checkout_source])).toEqual([
      [legacy.done, 'present', null, 'admin', null],
      [legacy.absent, 'absent', null, 'admin', null],
    ]);
    // Legacy checkout remains protected by the correction rule added in the kiosk core.
    await expect(db.query(`update public.attendance_records set checked_out_at = checked_out_at + interval '1 minute' where id=$1`, [legacy.done]))
      .rejects.toThrow(/admin correction/);
    // Students without a code are not resolvable at the kiosk until an admin issues one.
    expect((await one(`select count(*)::int as n from public.student_attendance_codes`)).n).toBe(0);
  });

  it('defines device_kind once, server-controlled, readable but never writable by admins', async () => {
    const col = await one(`select is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='academy_devices' and column_name='device_kind'`);
    expect(col.is_nullable).toBe('NO');
    expect(col.column_default).toContain("'kiosk'");
    const checks = (await all(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid='public.academy_devices'::regclass and contype='c'`)).map((r) => r.def);
    expect(checks.some((d) => /device_kind/.test(d) && /'kiosk'/.test(d) && /'learning_plan'/.test(d))).toBe(true);
    const colPriv = async (role, column, priv) => (await one(`select has_column_privilege($1, 'public.academy_devices', $2, $3) as ok`, [role, column, priv])).ok;
    expect(await colPriv('authenticated', 'device_kind', 'SELECT')).toBe(true);
    expect(await colPriv('authenticated', 'token_hash', 'SELECT')).toBe(false);
    for (const priv of ['INSERT', 'UPDATE']) {
      for (const column of ['device_kind', 'status', 'token_hash', 'device_name']) {
        expect(await colPriv('authenticated', column, priv)).toBe(false);
        expect(await colPriv('anon', column, priv)).toBe(false);
      }
    }
    const triggers = (await all(`select tgname from pg_trigger where tgrelid='public.academy_devices'::regclass and not tgisinternal order by 1`)).map((r) => r.tgname);
    expect(triggers).toEqual(['audit_academy_devices', 'guard_academy_devices', 'revoke_learning_sessions_on_device']);
    expect((await one(`select count(*)::int as n from pg_indexes where schemaname='public' and indexname='academy_devices_kind_idx'`)).n).toBe(1);
  });

  it('keeps kiosk and learning-plan device tokens mutually unusable after the upgrade', async () => {
    const kioskToken = (await one(`select public.admin_register_kiosk_device('입구') as t`)).t;
    const planToken = (await one(`select public.admin_register_learning_plan_device('학습') as t`)).t;
    await issueTestCode(db, legacy.student, '246810');
    const verifier = await testVerifier('246810');
    const kiosk = async (token) => (await one(`select private.kiosk_attendance_at($1, 'check_in', $2, now(), '') as r`, [token, verifier])).r.result;
    expect(await kiosk(planToken)).toBe('device_not_registered');
    expect(await kiosk(kioskToken)).not.toBe('device_not_registered');
    expect((await one(`select public.learning_device_today_plan($1) as r`, [kioskToken])).r).toEqual({ state: 'no_session' });
    const kioskId = (await one(`select id from public.academy_devices where device_kind='kiosk'`)).id;
    const planId = (await one(`select id from public.academy_devices where device_kind='learning_plan'`)).id;
    await expect(db.query(`select public.admin_revoke_kiosk_device($1)`, [planId])).rejects.toThrow(/device state changed/);
    await expect(db.query(`select public.admin_revoke_learning_plan_device($1)`, [kioskId])).rejects.toThrow(/device state changed/);
  });

  it('pins search_path on every SECURITY DEFINER function', async () => {
    const loose = await all(`
      select p.oid::regprocedure::text as sig, coalesce(array_to_string(p.proconfig, ','), '') as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef`);
    expect(loose.length).toBeGreaterThan(50);
    expect(loose.filter((f) => !/(^|,)search_path=(""|public)(,|$)/.test(f.cfg)).map((f) => f.sig)).toEqual([]);
    // Everything added from the kiosk core onward uses an empty search_path.
    expect(loose.filter((f) => /^private\./.test(f.sig) && !/search_path=""/.test(f.cfg)).map((f) => f.sig)).toEqual([]);
  });

  it('grants function execution only through the documented boundary even with Supabase default privileges', async () => {
    const fns = await all(`
      select n.nspname as schema, p.proname as name, replace(p.oid::regprocedure::text, 'public.', '') as sig,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('service_role', p.oid, 'execute') as svc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')`);
    const pub = fns.filter((f) => f.schema === 'public' && !STUB_FUNCTIONS.has(f.sig));
    expect(pub.filter((f) => f.anon).map((f) => f.sig).sort()).toEqual(ANON_RPC);
    const service = pub.filter((f) => f.name.startsWith('service_'));
    expect(service.map((f) => f.name).sort()).toEqual([
      'service_claim_parent_messages', 'service_kiosk_attendance', 'service_operations_tick',
      'service_record_delivery_receipt', 'service_record_delivery_result', 'service_run_attendance_followups',
    ]);
    for (const f of service) expect([f.sig, f.anon, f.auth, f.svc]).toEqual([f.sig, false, false, true]);
    const priv = fns.filter((f) => f.schema === 'private');
    expect(priv.length).toBeGreaterThan(30);
    expect(priv.filter((f) => f.anon || f.auth || f.svc).map((f) => f.sig)).toEqual([]);
    const schema = await one(`select has_schema_privilege('anon','private','usage') a, has_schema_privilege('authenticated','private','usage') u, has_schema_privilege('service_role','private','usage') s`);
    expect(schema).toEqual({ a: false, u: false, s: false });
  });

  it('enables RLS on every public table and grants anon nothing, authenticated no new direct writes', async () => {
    const tables = await all(`
      select c.relname, c.relrowsecurity as rls,
        has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger') as anon_any,
        has_table_privilege('authenticated', c.oid, 'insert,update,delete,truncate') as auth_write,
        exists (select 1 from information_schema.column_privileges cp where cp.table_schema='public' and cp.table_name=c.relname
                and cp.grantee='authenticated' and cp.privilege_type <> 'SELECT') as auth_col_write,
        exists (select 1 from information_schema.column_privileges cp where cp.table_schema='public' and cp.table_name=c.relname and cp.grantee='anon') as anon_col
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')`);
    const real = tables.filter((t) => !STUB_TABLES.has(t.relname));
    expect(real.length).toBeGreaterThan(25);
    expect(real.filter((t) => !t.rls).map((t) => t.relname)).toEqual([]);
    expect(real.filter((t) => t.anon_any || t.anon_col).map((t) => t.relname)).toEqual([]);
    expect(real.filter((t) => t.auth_write || t.auth_col_write).map((t) => t.relname).sort()).toEqual(AUTHENTICATED_WRITABLE);
    const privateTables = await all(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relkind in ('r', 'p', 'v', 'm')
        and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('service_role', c.oid, 'select'))`);
    expect(privateTables).toEqual([]);
  });

  it('publishes only the secret-free refresh signal table to the existing realtime publication', async () => {
    const tables = (await all(`select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename`)).map((r) => r.tablename);
    expect(tables).toEqual(['operations_refresh_events']);
  });
});
