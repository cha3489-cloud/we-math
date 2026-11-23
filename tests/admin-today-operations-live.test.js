import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { bindTodayOperations } from '../src/portal/kiosk-operations.js';

const root = resolve(import.meta.dirname, '..');
const adminHtml = readFileSync(resolve(root, 'admin/index.html'), 'utf8');
const adminJs = readFileSync(resolve(root, 'src/portal/admin.js'), 'utf8');
const kioskOpsJs = readFileSync(resolve(root, 'src/portal/kiosk-operations.js'), 'utf8');
const NOW = new Date('2099-11-16T07:30:00.000Z');
const flush = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); };

const snapshot = () => ({
  sessions: [],
  unresolved_sessions: [],
  failed_messages: [{ id: 'm1', student_name: '가', message_type: 'absent', failure_code: 'x', manual_followup_at: null }],
  makeup_drafts: [],
  queues: {
    unresolved_sessions: { total: 0, missing: 0, checkout_needed: 0, has_more: false, next_cursor: null },
    failed_messages: { total: 3, has_more: true, next_cursor: 'cursor-1' },
    makeup_drafts: { total: 0, planned_absence_drafts: 0, makeup_followup: 0, has_more: false, next_cursor: null },
  },
  page_size: 50,
});

const scheduleList = () => ({
  groups: [{ id: 'g1', name: '중2 A반', is_active: true, schedules: [
    { id: 'sc1', iso_weekday: 1, local_start_time: '16:00', duration_minutes: 90, capacity: 8, late_after_minutes: 10, missing_after_minutes: 15, effective_from: '2099-11-01', effective_to: null, active: true, revision: 3 },
  ] }],
});

function setup({ rpc = {} } = {}) {
  const dom = new JSDOM(adminHtml, { pretendToBeVisual: true });
  const { document } = dom.window;
  const calls = [];
  const fromTables = [];
  const channels = [];
  const responses = {
    admin_run_attendance_followups: { data: {}, error: null },
    admin_today_operations: { data: snapshot(), error: null },
    admin_list_class_schedules: { data: scheduleList(), error: null },
    ...rpc,
  };
  const client = {
    rpc: vi.fn(async (name, args) => {
      calls.push([name, args]);
      const r = responses[name];
      return typeof r === 'function' ? r(args) : (r ?? { data: null, error: null });
    }),
    from: vi.fn((table) => {
      fromTables.push(table);
      const builder = { select: () => builder, eq: () => builder, order: () => builder, then: (resolveFn) => resolveFn({ data: [], error: null }) };
      return builder;
    }),
    channel: vi.fn(() => {
      const ch = { tables: [], handlers: [], on(type, filter, cb) { ch.tables.push(filter.table); ch.handlers.push(cb); return ch; }, subscribe() { return ch; } };
      channels.push(ch);
      return ch;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  };
  const ops = bindTodayOperations(document, { client, isCurrent: () => true, now: () => NOW });
  return { document, client, calls, ops, fromTables, channels, responses };
}
const $ = (d, id) => d.getElementById(id);
const countOf = (d, key) => d.querySelector(`[data-bucket="${key}"] .today-ops-count`).textContent;

afterEach(() => { vi.useRealTimers(); });

describe('today operations realtime + polling wiring', () => {
  it('subscribes after a successful mount, polls snapshot-only, and cleans up on destroy', async () => {
    vi.useFakeTimers();
    const { calls, client, channels, ops } = setup();
    expect(channels).toHaveLength(0);
    await ops.ready;
    await flush();
    expect(channels).toHaveLength(1);
    expect(channels[0].tables).not.toContain('student_attendance_codes');
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.slice(before).map((c) => c[0])).toEqual(['admin_today_operations']);
    channels[0].handlers.forEach((h) => h({}));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.slice(before).map((c) => c[0])).toEqual(['admin_today_operations', 'admin_today_operations']);
    expect(typeof ops.destroy).toBe('function');
    ops.destroy();
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    const afterDestroy = calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.length).toBe(afterDestroy);
  });

  it('does not subscribe when the operations backend is missing', async () => {
    const { channels, ops } = setup({ rpc: { admin_run_attendance_followups: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_run_attendance_followups without parameters' } } } });
    await ops.ready;
    await flush();
    expect(channels).toHaveLength(0);
    ops.destroy();
  });

  it('wires cleanup into the admin lifecycle', () => {
    expect(adminJs).toMatch(/todayOperations\?\.destroy\(\)/);
    expect(kioskOpsJs).not.toMatch(/student_attendance_codes|academy_devices/);
  });
});

describe('paged queues in the dashboard', () => {
  it('shows the aggregate count and appends the next keyset page without duplicates', async () => {
    const { document, calls, ops } = setup({ rpc: {
      admin_operations_queue_page: { data: { items: [
        { id: 'm1', student_name: '가', message_type: 'absent', failure_code: 'x', manual_followup_at: null },
        { id: 'm2', student_name: '나', message_type: 'absent', failure_code: 'x', manual_followup_at: null },
      ], has_more: false, next_cursor: null }, error: null },
    } });
    await ops.ready;
    await flush();
    expect(countOf(document, 'message_failed')).toBe('3');
    document.querySelector('[data-bucket="message_failed"]').click();
    expect(document.querySelectorAll('#todayOpsList article')).toHaveLength(1);
    const more = $(document, 'todayOpsMore');
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe('더 보기');
    more.click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_operations_queue_page')[1]).toEqual({ p_queue: 'failed_messages', p_cursor: 'cursor-1' });
    expect([...document.querySelectorAll('#todayOpsList article h4')].map((h) => h.textContent)).toEqual(['가', '나']);
    expect($(document, 'todayOpsMore').hidden).toBe(true);
    ops.destroy();
  });

  it('hides 더 보기 for buckets without more pages', async () => {
    const { document, ops } = setup();
    await ops.ready;
    await flush();
    document.querySelector('[data-bucket="scheduled"]').click();
    expect($(document, 'todayOpsMore').hidden).toBe(true);
    ops.destroy();
  });
});

describe('recurring schedule editor', () => {
  it('lists, creates, edits, deactivates schedules and runs a recovery tick through RPC only', async () => {
    const { document, calls, ops, fromTables } = setup({ rpc: {
      admin_create_class_schedule: { data: 'sc2', error: null },
      admin_update_class_schedule: { data: 4, error: null },
      admin_deactivate_class_schedule: { data: null, error: null },
      admin_run_operations_tick: { data: { generation: { sessions_created: 2, records_created: 5 } }, error: null },
    } });
    await ops.ready;
    await flush();
    $(document, 'todayOpsSchedules').open = true;
    $(document, 'todayOpsSchedules').dispatchEvent(new document.defaultView.Event('toggle'));
    await flush();
    expect(calls.some((c) => c[0] === 'admin_list_class_schedules')).toBe(true);
    expect(fromTables).not.toContain('class_schedules');
    const rows = document.querySelectorAll('#todayOpsScheduleList li');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('월');
    expect(rows[0].textContent).toContain('16:00');
    expect(rows[0].textContent).toContain('90분');
    expect([...$(document, 'todayOpsScheduleGroup').options].map((o) => [o.value, o.textContent])).toEqual([['g1', '중2 A반']]);

    $(document, 'todayOpsScheduleWeekday').value = '3';
    $(document, 'todayOpsScheduleStart').value = '';
    $(document, 'todayOpsScheduleForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect($(document, 'todayOpsResult').textContent).toBe('요일·시작 시각·수업 시간·적용 시작일을 확인해 주세요.');
    expect(calls.some((c) => c[0] === 'admin_create_class_schedule')).toBe(false);

    $(document, 'todayOpsScheduleStart').value = '17:30';
    $(document, 'todayOpsScheduleDuration').value = '80';
    $(document, 'todayOpsScheduleCapacity').value = '6';
    $(document, 'todayOpsScheduleFrom').value = '2099-11-20';
    $(document, 'todayOpsScheduleTo').value = '';
    $(document, 'todayOpsScheduleForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect(calls.find((c) => c[0] === 'admin_create_class_schedule')[1]).toEqual({
      p_class_group_id: 'g1', p_iso_weekday: 3, p_local_start_time: '17:30', p_duration_minutes: 80, p_capacity: 6,
      p_late_after_minutes: 10, p_missing_after_minutes: 15, p_effective_from: '2099-11-20', p_effective_to: null,
    });

    [...document.querySelectorAll('#todayOpsScheduleList button')].find((b) => b.textContent === '수정').click();
    expect($(document, 'todayOpsScheduleStart').value).toBe('16:00');
    $(document, 'todayOpsScheduleCapacity').value = '7';
    $(document, 'todayOpsScheduleForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect(calls.find((c) => c[0] === 'admin_update_class_schedule')[1]).toMatchObject({ p_schedule_id: 'sc1', p_expected_revision: 3, p_capacity: 7, p_local_start_time: '16:00', p_iso_weekday: 1 });

    [...document.querySelectorAll('#todayOpsScheduleList button')].find((b) => b.textContent === '중지').click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_deactivate_class_schedule')[1]).toEqual({ p_schedule_id: 'sc1', p_expected_revision: 3 });

    $(document, 'todayOpsRunTick').click();
    await flush();
    expect(calls.some((c) => c[0] === 'admin_run_operations_tick')).toBe(true);
    expect($(document, 'todayOpsResult').textContent).toContain('수업 2개');
    ops.destroy();
  });
});
