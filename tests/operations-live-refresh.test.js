import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPS_REALTIME_TABLES, createLiveRefresh, buildOperationsBuckets, mergeQueuePage,
} from '../src/portal/operations-dashboard.js';

const SECRET_TABLES = [
  'student_attendance_codes', 'academy_devices', 'parent_message_recipients', 'kiosk_attempt_buckets', 'operations_audit',
  'attendance_records', 'attendance_followups', 'parent_messages', 'makeup_offer_batches', 'daily_learning_plans', 'class_sessions',
  'learning_device_sessions',
];

function fakeClient() {
  const channels = [];
  return {
    channels,
    channel: vi.fn((name) => {
      const ch = {
        name, bindings: [], statusCb: null,
        on: vi.fn((type, filter, cb) => { ch.bindings.push({ type, filter, cb }); return ch; }),
        subscribe: vi.fn((cb) => { ch.statusCb = cb; return ch; }),
        emit(table) { for (const b of ch.bindings) if (b.filter.table === table) b.cb({ table, eventType: 'UPDATE' }); },
      };
      channels.push(ch);
      return ch;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  };
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('live refresh', () => {
  it('subscribes only to the public operations tables', () => {
    expect(OPS_REALTIME_TABLES).toEqual(['operations_refresh_events']);
    const client = fakeClient();
    const live = createLiveRefresh({ client, refresh: vi.fn(async () => {}) });
    live.start();
    expect(client.channel).toHaveBeenCalledTimes(1);
    const tables = client.channels[0].bindings.map((b) => b.filter.table).sort();
    expect(tables).toEqual([...OPS_REALTIME_TABLES].sort());
    for (const b of client.channels[0].bindings) {
      expect(b.type).toBe('postgres_changes');
      expect(b.filter).toEqual({ event: '*', schema: 'public', table: b.filter.table });
    }
    for (const secret of SECRET_TABLES) expect(tables).not.toContain(secret);
    live.stop();
  });

  it('coalesces a burst of realtime events into one refresh', async () => {
    const client = fakeClient();
    const refresh = vi.fn(async () => {});
    const live = createLiveRefresh({ client, refresh, debounceMs: 400 });
    live.start();
    const ch = client.channels[0];
    for (let i = 0; i < 5; i += 1) ch.emit('operations_refresh_events');
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(refresh).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it('never overlaps refreshes and queues at most one follow-up', async () => {
    const client = fakeClient();
    let release;
    let active = 0;
    let maxActive = 0;
    const refresh = vi.fn(() => { active += 1; maxActive = Math.max(maxActive, active); return new Promise((r) => { release = () => { active -= 1; r(); }; }); });
    const live = createLiveRefresh({ client, refresh, debounceMs: 10, pollMs: 30_000 });
    live.start();
    const first = live.request();
    live.request();
    live.request();
    client.channels[0].emit('parent_messages');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await first;
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    release();
    await flush();
    expect(maxActive).toBe(1);
    live.stop();
  });

  it('polls every 30 seconds as a fallback even after SUBSCRIBED and skips while inactive', async () => {
    const client = fakeClient();
    const refresh = vi.fn(async () => {});
    let active = true;
    const live = createLiveRefresh({ client, refresh, isActive: () => active });
    live.start();
    client.channels[0].statusCb('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    active = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    live.stop();
  });

  it('removes channels, intervals and pending debounces on stop', async () => {
    const client = fakeClient();
    const refresh = vi.fn(async () => {});
    const live = createLiveRefresh({ client, refresh, debounceMs: 400 });
    live.start();
    live.start(); // idempotent
    expect(client.channel).toHaveBeenCalledTimes(1);
    const ch = client.channels[0];
    ch.emit('operations_refresh_events');
    live.stop();
    expect(client.removeChannel).toHaveBeenCalledWith(ch);
    await vi.advanceTimersByTimeAsync(120_000);
    ch.emit('operations_refresh_events');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to polling only when the client has no realtime channel API', async () => {
    const refresh = vi.fn(async () => {});
    const live = createLiveRefresh({ client: {}, refresh });
    live.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    live.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('paged queue model', () => {
  const NOW = '2099-11-16T09:10:00.000Z';
  it('uses full-queue aggregates for counts and appends pages without duplicates', () => {
    const older = (id, patch = {}) => ({ attendance_id: id, status: 'scheduled', session_status: 'scheduled', starts_at: '2099-11-10T07:00:00.000Z', ends_at: '2099-11-10T08:00:00.000Z', open_followups: ['missing'], ...patch });
    const snap = {
      sessions: [],
      unresolved_sessions: [older('o1'), older('o2', { status: 'present', checked_in_at: '2099-11-10T06:55:00.000Z', open_followups: ['checkout_needed'] })],
      failed_messages: [{ id: 'm1', manual_followup_at: null }],
      makeup_drafts: [{ batch_id: 'k1', origin: 'planned_absence', status: 'draft' }],
      queues: {
        unresolved_sessions: { total: 80, missing: 70, planned_exceptions: 0, present: 8, late: 2, absent: 0, checkout_needed: 10, plan_missing: 9, has_more: true, next_cursor: 'c' },
        failed_messages: { total: 120, has_more: true, next_cursor: 'f' },
        makeup_drafts: { total: 60, planned_absence_drafts: 55, makeup_followup: 5, has_more: true, next_cursor: 'k' },
      },
    };
    const { counts, lists } = buildOperationsBuckets(snap, NOW);
    expect(counts.missing).toBe(70);
    expect(counts.checkout_needed).toBe(10);
    expect(counts.message_failed).toBe(120);
    expect(counts.planned_absence_drafts).toBe(55);
    expect(counts.makeup_followup).toBe(5);
    // Older rows keep the same bucket rules as before; counts come from the full queue.
    expect(counts.present).toBe(8);
    expect(counts.plan_missing).toBe(9);
    expect(lists.present.map((r) => r.attendance_id)).toEqual(['o2']);
    expect(lists.missing.map((r) => r.attendance_id)).toEqual(['o1']);
    // Today's rows are added on top of the older-queue aggregate.
    const withToday = buildOperationsBuckets({ ...snap, sessions: [{ attendance_id: 't1', status: 'scheduled', session_status: 'scheduled', starts_at: '2099-11-16T07:00:00.000Z', ends_at: '2099-11-16T08:00:00.000Z', open_followups: ['missing'] }] }, NOW);
    expect(withToday.counts.missing).toBe(71);
    expect(withToday.lists.missing.map((r) => r.attendance_id)).toEqual(['t1', 'o1']);

    const merged = mergeQueuePage(snap, 'failed_messages', { items: [{ id: 'm1' }, { id: 'm2' }], has_more: false, next_cursor: null });
    expect(merged.failed_messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(merged.queues.failed_messages).toMatchObject({ total: 120, has_more: false, next_cursor: null });
    const mergedSessions = mergeQueuePage(snap, 'unresolved_sessions', { items: [older('o2'), older('o3')], has_more: true, next_cursor: 'c2' });
    expect(mergedSessions.unresolved_sessions.map((r) => r.attendance_id)).toEqual(['o1', 'o2', 'o3']);
    expect(mergedSessions.queues.unresolved_sessions.next_cursor).toBe('c2');
    expect(() => mergeQueuePage(snap, 'student_attendance_codes', { items: [] })).toThrow(/invalid queue/);
  });

  it('never reports a count smaller than the rows already shown', () => {
    const snap = { failed_messages: [{ id: 'a' }, { id: 'b' }], queues: { failed_messages: { total: 1, has_more: false, next_cursor: null } } };
    expect(buildOperationsBuckets(snap, NOW).counts.message_failed).toBe(2);
  });
});
