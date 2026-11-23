import { afterEach, describe, expect, it } from 'vitest';
import { createOpsDb, seedClass, issueTestCode, testVerifier, OPS_MIGRATIONS, ADMIN } from './helpers/ops-db.js';

// "발송 안 함" is offered only on the draft_messages queue (status draft/approved). Cancellation must
// be an exact expected-state CAS: a stale card must never cancel a message another admin already
// approved/queued, and never a message the dispatcher has claimed (requested attempt + lease lock).
let db;
afterEach(async () => { if (db) await db.close(); db = null; });

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
const snapshotFor = async (day) => (await one(`select private.admin_operations_snapshot_for($1::date) as s`, [day])).s;

async function seedDrafts() {
  db = await createOpsDb(OPS_MIGRATIONS, { supabaseDefaultPrivileges: true });
  const s = await seedClass(db);
  const token = (await one(`select public.admin_register_kiosk_device('입구') as t`)).t;
  const verifier = await testVerifier(await issueTestCode(db, s.student, '482913'));
  await one(`select public.admin_create_class_session($1, '2099-11-15T07:00:00Z', '2099-11-15T08:00:00Z', 8) as id`, [s.group]);
  await db.query(`select private.kiosk_attendance_at($1, 'check_in', $2, '2099-11-15T06:55:00Z', '')`, [token, verifier]);
  await db.query(`select private.kiosk_attendance_at($1, 'check_out', $2, '2099-11-15T08:05:00Z', '')`, [token, verifier]);
  const present = (await one(`select id from public.parent_messages where message_type='present'`)).id;
  const checkout = (await one(`select id from public.parent_messages where message_type='checkout'`)).id;
  return { present, checkout };
}

// Full observable state of one message: row, attempts, claim, audit and realtime refresh signal.
async function stateOf(id) {
  return {
    message: await one(`select status, cancelled_at, dispatch_locked_until, queued_at from public.parent_messages where id=$1`, [id]),
    attempts: await all(`select attempt_no, status, completed_at from public.message_delivery_attempts where message_id=$1 order by attempt_no`, [id]),
    claims: (await one(`select count(*)::int as n from private.parent_message_claims where message_id=$1`, [id])).n,
    audit: (await one(`select count(*)::int as n from public.operations_audit where entity='parent_messages' and entity_id=$1`, [id])).n,
    refresh: (await one(`select count(*)::int as n from public.operations_refresh_events where entity='parent_messages' and entity_id=$1`, [id])).n,
  };
}

const cancel = (id, expected) => db.query(`select public.admin_cancel_parent_message($1, $2)`, [id, expected]);
const sqlState = async (promise) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error.code;
  }
};

describe('admin_cancel_parent_message expected-state CAS', () => {
  it('rejects a stale draft-card cancel after another admin approved and queued the message, leaving it untouched', async () => {
    const { present } = await seedDrafts();
    await db.query(`select public.admin_approve_message_template('attendance_present')`);
    await db.query(`select public.admin_approve_parent_message($1)`, [present]);
    const before = await stateOf(present);
    expect(before.message.status).toBe('queued');

    // The stale card was rendered while the message was still a draft.
    expect(await sqlState(cancel(present, 'draft'))).toBe('40001');
    expect(await sqlState(cancel(present, 'approved'))).toBe('40001');
    // The legacy unconditioned signature must not exist any more.
    expect(await sqlState(db.query(`select public.admin_cancel_parent_message($1)`, [present]))).toBe('42883');
    expect(await stateOf(present)).toEqual(before);
  }, 60_000);

  it('rejects cancel after the dispatcher claimed the message and keeps message, lease lock and requested attempt consistent', async () => {
    const { present } = await seedDrafts();
    await db.query(`select public.admin_approve_message_template('attendance_present')`);
    await db.query(`select public.admin_approve_parent_message($1)`, [present]);
    const claims = (await one(`select public.service_claim_parent_messages('dry_run', 10) as c`)).c;
    expect(claims.map((c) => c.message_id)).toEqual([present]);
    const before = await stateOf(present);
    expect(before.message.status).toBe('queued');
    expect(before.message.dispatch_locked_until).not.toBeNull();
    expect(before.attempts.map((a) => a.status)).toEqual(['requested']);
    expect(before.claims).toBe(1);

    for (const expected of ['draft', 'approved']) expect(await sqlState(cancel(present, expected))).toBe('40001');
    // queued/claimed/terminal states are never a valid cancellation precondition from the draft queue.
    for (const expected of ['queued', 'sent', 'delivered', 'failed', 'cancelled', null]) {
      expect(['22023', '40001']).toContain(await sqlState(cancel(present, expected)));
    }
    expect(await sqlState(db.query(`select public.admin_cancel_parent_message($1)`, [present]))).toBe('42883');
    expect(await stateOf(present)).toEqual(before);

    // The dispatcher still owns the claim and can complete it normally.
    const status = (await one(`select public.service_record_delivery_result($1, 1, $2, 'sent', null, 'dry-run-1', true) as s`, [present, claims[0].claim_nonce])).s;
    expect(status).toBe('sent');
    const after = await stateOf(present);
    expect(after.message.dispatch_locked_until).toBeNull();
    expect(after.attempts.map((a) => a.status)).toEqual(['accepted']);
  }, 60_000);

  it('cancels an untouched draft once, audits the admin actor, signals refresh, and removes it from the draft queue and count', async () => {
    const { present, checkout } = await seedDrafts();
    let snap = await snapshotFor('2099-11-16');
    expect(snap.draft_messages.map((m) => m.id).sort()).toEqual([present, checkout].sort());
    expect(snap.queues.draft_messages.total).toBe(2);
    const before = await stateOf(checkout);

    expect(await sqlState(cancel(checkout, 'draft'))).toBe('ok');
    const after = await stateOf(checkout);
    expect(after.message.status).toBe('cancelled');
    expect(after.message.cancelled_at).not.toBeNull();
    expect(after.attempts).toEqual([]);
    expect(after.claims).toBe(0);
    expect(after.audit).toBe(before.audit + 1);
    expect(after.refresh).toBeGreaterThan(before.refresh);
    const audit = await one(`select actor_kind, actor_id, before_data->>'status' as was, after_data->>'status' as now from public.operations_audit
      where entity='parent_messages' and entity_id=$1 order by id desc limit 1`, [checkout]);
    expect(audit).toEqual({ actor_kind: 'admin', actor_id: ADMIN, was: 'draft', now: 'cancelled' });

    snap = await snapshotFor('2099-11-16');
    expect(snap.draft_messages.map((m) => m.id)).toEqual([present]);
    expect(snap.queues.draft_messages.total).toBe(1);

    // A second (stale) click conflicts and writes nothing more.
    expect(await sqlState(cancel(checkout, 'draft'))).toBe('40001');
    expect(await stateOf(checkout)).toEqual(after);
  }, 60_000);

  it('never cancels a makeup offer through the draft-queue action', async () => {
    const { present } = await seedDrafts();
    const offer = (await one(`select private.enqueue_parent_message(student_id, 'makeup_offer', 'test:makeup', '{}'::jsonb) as id from public.parent_messages where id=$1`, [present])).id;
    expect((await one(`select status from public.parent_messages where id=$1`, [offer])).status).toBe('draft');
    expect(await sqlState(cancel(offer, 'draft'))).toBe('40001');
    expect((await one(`select status from public.parent_messages where id=$1`, [offer])).status).toBe('draft');
  }, 60_000);

  it('exposes only the expected-state signature, to authenticated admins, never anon, under Supabase default privileges', async () => {
    const { checkout } = await seedDrafts();
    const sigs = await all(`select p.oid::regprocedure::text as sig,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as auth
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='admin_cancel_parent_message'`);
    expect(sigs).toEqual([{ sig: 'admin_cancel_parent_message(uuid,text)', anon: false, auth: true }]);
    await db.exec(`select set_config('test.admin', 'off', false)`);
    expect(await sqlState(cancel(checkout, 'draft'))).toBe('42501');
    expect((await one(`select status from public.parent_messages where id=$1`, [checkout])).status).toBe('draft');
  }, 60_000);
});
