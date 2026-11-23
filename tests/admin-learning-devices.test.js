import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { bindTodayOperations } from '../src/portal/kiosk-operations.js';

const root = resolve(import.meta.dirname, '..');
const adminHtml = readFileSync(resolve(root, 'admin/index.html'), 'utf8');
const NOW = new Date('2099-11-16T07:30:00.000Z');
const TOKEN = 'b2'.repeat(32);
// Every mocked RPC resolves in microtasks; two macrotask turns drain mutate → refresh → reload chains.
const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

const base = { grade: '중2', class_name: '반A', starts_at: '2099-11-16T07:00:00.000Z', ends_at: '2099-11-16T08:30:00.000Z', session_status: 'scheduled', open_followups: [], exception: null, plan_status: 'published', messages: [] };
const snapshot = () => ({
  sessions: [
    { ...base, attendance_id: 'r1', student_id: 's1', student_name: '가나다', status: 'present', checked_in_at: '2099-11-16T06:55:00.000Z', account_linked: false, learning_device: null },
    { ...base, attendance_id: 'r2', student_id: 's2', student_name: '라마바', status: 'late', checked_in_at: '2099-11-16T07:05:00.000Z', account_linked: true, learning_device: null },
    { ...base, attendance_id: 'r3', student_id: 's3', student_name: '사아자', status: 'present', checked_in_at: '2099-11-16T06:50:00.000Z', account_linked: false,
      learning_device: { session_id: 'ls1', revision: 3, device_id: 'd2', device_name: '<b>학습 2</b>', expires_at: '2099-11-16T12:30:00.000Z' } },
    { ...base, attendance_id: 'r4', student_id: 's4', student_name: '차카타', status: 'scheduled', starts_at: '2099-11-16T09:00:00.000Z', ends_at: '2099-11-16T10:30:00.000Z', account_linked: false, learning_device: null },
    { ...base, attendance_id: 'r5', student_id: 's5', student_name: '파하가', status: 'present', checked_in_at: '2099-11-16T06:50:00.000Z', checked_out_at: '2099-11-16T08:35:00.000Z', account_linked: false, learning_device: null },
  ],
  failed_messages: [],
  makeup_drafts: [],
});
const devices = () => ([
  { id: 'k1', device_name: '입구 태블릿', device_kind: 'kiosk', status: 'active', last_seen_at: '2099-11-16T07:00:00.000Z', assignment: null },
  { id: 'd1', device_name: '학습 1', device_kind: 'learning_plan', status: 'active', last_seen_at: null, assignment: null },
  { id: 'd2', device_name: '학습 2', device_kind: 'learning_plan', status: 'active', last_seen_at: '2099-11-16T07:29:00.000Z', assignment: { session_id: 'ls1', revision: 3, attendance_id: 'r3', student_name: '사아자', expires_at: '2099-11-16T12:30:00.000Z' } },
  { id: 'd3', device_name: '학습 3', device_kind: 'learning_plan', status: 'revoked', last_seen_at: null, assignment: null },
]);

function setup({ rpc = {} } = {}) {
  const dom = new JSDOM(adminHtml, { pretendToBeVisual: true });
  const { document } = dom.window;
  const calls = [];
  const responses = {
    admin_run_attendance_followups: { data: {}, error: null },
    admin_today_operations: { data: snapshot(), error: null },
    admin_list_devices: { data: devices(), error: null },
    ...rpc,
  };
  const client = {
    rpc: vi.fn(async (name, args) => {
      calls.push([name, args]);
      const r = responses[name];
      return typeof r === 'function' ? r(args) : (r ?? { data: null, error: null });
    }),
    from: vi.fn(() => {
      const builder = { select: () => builder, eq: () => builder, order: () => builder, then: (resolveFn) => resolveFn({ data: [], error: null }) };
      return builder;
    }),
  };
  const ops = bindTodayOperations(document, { client, isCurrent: () => true, now: () => NOW });
  return { document, calls, ops, window: dom.window };
}
const $ = (d, id) => d.getElementById(id);
const card = (d, name) => [...d.querySelectorAll('#todayOpsList article')].find((a) => a.querySelector('h4').textContent === name);
const buttonIn = (node, label) => [...node.querySelectorAll('button')].find((b) => b.textContent === label);
const showPresent = (d) => d.querySelector('[data-bucket="present"]').click();

describe('admin learning-plan device assignment', () => {
  it('offers “학습 태블릿 배정” only for present/late, not checked-out, account-unlinked rows', async () => {
    const { document } = setup();
    await flush();
    showPresent(document);
    expect(buttonIn(card(document, '가나다'), '학습 태블릿 배정')).toBeTruthy();
    expect(buttonIn(card(document, '파하가'), '학습 태블릿 배정')).toBeFalsy(); // checked out
    document.querySelector('[data-bucket="late"]').click();
    const linked = card(document, '라마바');
    expect(buttonIn(linked, '학습 태블릿 배정')).toBeFalsy();
    expect(linked.textContent).toContain('학생 계정 로그인(전화번호+PIN)');
    document.querySelector('[data-bucket="scheduled"]').click();
    expect(buttonIn(card(document, '차카타'), '학습 태블릿 배정')).toBeFalsy();
  });

  it('assigns an active learning device chosen from the narrow device list, never a kiosk or revoked device', async () => {
    const { document, calls } = setup({ rpc: { admin_assign_learning_device: { data: { session_id: 'ls9', revision: 1 }, error: null } } });
    await flush();
    showPresent(document);
    const trigger = buttonIn(card(document, '가나다'), '학습 태블릿 배정');
    trigger.click();
    await flush();
    expect($(document, 'todayOpsDeviceAssign').hidden).toBe(false);
    expect($(document, 'todayOpsDeviceAssignTitle').textContent).toBe('가나다 · 학습 태블릿 배정');
    const options = [...$(document, 'todayOpsDeviceAssignSelect').options];
    expect(options.map((o) => o.value)).toEqual(['d1', 'd2']);
    expect(options[1].textContent).toBe('학습 2 (사용 중: 사아자 · 배정하면 해제됨)');
    expect(document.activeElement).toBe($(document, 'todayOpsDeviceAssignSelect'));
    $(document, 'todayOpsDeviceAssignSelect').value = 'd1';
    $(document, 'todayOpsDeviceAssign').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect(calls.find((c) => c[0] === 'admin_assign_learning_device')[1]).toEqual({ p_device_id: 'd1', p_attendance_id: 'r1' });
    expect($(document, 'todayOpsResult').textContent).toBe('학습 태블릿을 배정했습니다. 하원하면 자동으로 해제됩니다.');
    expect($(document, 'todayOpsDeviceAssign').hidden).toBe(true);
  });

  it('shows the current assignment with revoke (CAS) and reassign controls', async () => {
    const { document, calls } = setup({ rpc: { admin_revoke_learning_device_session: { data: null, error: null } } });
    await flush();
    showPresent(document);
    const assigned = card(document, '사아자');
    expect(assigned.textContent).toContain('학습 태블릿: <b>학습 2</b>');
    expect(assigned.querySelector('b')).toBeNull();
    expect(buttonIn(assigned, '학습 태블릿 배정')).toBeFalsy();
    expect(buttonIn(assigned, '다른 태블릿으로 변경')).toBeTruthy();
    buttonIn(assigned, '배정 해제').click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_revoke_learning_device_session')[1]).toEqual({ p_session_id: 'ls1', p_expected_revision: 3 });
    expect($(document, 'todayOpsResult').textContent).toBe('학습 태블릿 배정을 해제했습니다.');
  });

  it('reports a stale assignment conflict truthfully', async () => {
    const { document } = setup({ rpc: { admin_revoke_learning_device_session: { data: null, error: { code: '40001', message: 'learning device session changed' } } } });
    await flush();
    showPresent(document);
    buttonIn(card(document, '사아자'), '배정 해제').click();
    await flush();
    expect($(document, 'todayOpsResult').textContent).toBe('다른 사용자가 먼저 변경했습니다. 최신 상태를 확인해 주세요.');
  });
});

describe('admin device management', () => {
  it('lists kiosk and learning-plan devices separately with name/kind/status/last seen only', async () => {
    const { document } = setup();
    await flush();
    $(document, 'todayOpsSetup').open = true;
    $(document, 'todayOpsSetup').dispatchEvent(new document.defaultView.Event('toggle'));
    await flush();
    const rows = [...document.querySelectorAll('#todayOpsDeviceList li')].map((li) => li.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('입구 출석');
    expect(rows[1]).toContain('학습계획');
    expect(rows[2]).toContain('사아자 배정 중');
    expect(rows[3]).toContain('해지됨');
    expect(document.querySelector('#todayOpsDeviceList').textContent).not.toMatch(/token|hash/i);
  });

  it('registers a learning-plan device and shows its one-time token only in the setup output until the panel closes', async () => {
    const { document, calls } = setup({ rpc: { admin_register_learning_plan_device: { data: TOKEN, error: null } } });
    await flush();
    $(document, 'todayOpsSetup').open = true;
    $(document, 'todayOpsSetup').dispatchEvent(new document.defaultView.Event('toggle'));
    await flush();
    $(document, 'todayOpsLearningDeviceName').value = '학습 4';
    $(document, 'todayOpsLearningDeviceForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect(calls.find((c) => c[0] === 'admin_register_learning_plan_device')[1]).toEqual({ p_device_name: '학습 4' });
    expect($(document, 'todayOpsLearningDeviceToken').textContent).toContain(TOKEN);
    expect($(document, 'todayOpsLearningDeviceToken').textContent).toContain('/plan/');
    expect($(document, 'todayOpsResult').textContent).not.toContain(TOKEN);
    expect(document.body.textContent.split(TOKEN)).toHaveLength(2); // exactly one place
    $(document, 'todayOpsSetup').open = false;
    $(document, 'todayOpsSetup').dispatchEvent(new document.defaultView.Event('toggle'));
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('revokes a learning-plan device through its kind-specific RPC', async () => {
    const { document, calls } = setup({ rpc: { admin_revoke_learning_plan_device: { data: null, error: null }, admin_revoke_kiosk_device: { data: null, error: null } } });
    await flush();
    $(document, 'todayOpsSetup').open = true;
    $(document, 'todayOpsSetup').dispatchEvent(new document.defaultView.Event('toggle'));
    await flush();
    const items = [...document.querySelectorAll('#todayOpsDeviceList li')];
    buttonIn(items[1], '기기 해지').click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_revoke_learning_plan_device')[1]).toEqual({ p_device_id: 'd1' });
    buttonIn(items[0], '기기 해지').click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_revoke_kiosk_device')[1]).toEqual({ p_device_id: 'k1' });
    expect(buttonIn(items[3], '기기 해지')).toBeFalsy();
  });
});
