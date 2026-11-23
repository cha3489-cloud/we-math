import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { bindTodayOperations, parsePlanLines } from '../src/portal/kiosk-operations.js';

const root = resolve(import.meta.dirname, '..');
const adminHtml = readFileSync(resolve(root, 'admin/index.html'), 'utf8');
const kioskOperationsJs = readFileSync(resolve(root, 'src/portal/kiosk-operations.js'), 'utf8');
const NOW = new Date('2099-11-16T07:30:00.000Z');
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

const snapshot = () => ({
  sessions: [
    { attendance_id: 'r1', student_id: 's1', student_name: '<i>가나다</i>', grade: '중2', class_name: '반A', starts_at: '2099-11-16T07:00:00.000Z', ends_at: '2099-11-16T08:30:00.000Z', session_status: 'scheduled', status: 'scheduled', open_followups: ['missing'], exception: null, plan_status: null, messages: [] },
    { attendance_id: 'r2', student_id: 's2', student_name: '라마바', grade: '중1', class_name: '반A', starts_at: '2099-11-16T07:00:00.000Z', ends_at: '2099-11-16T08:30:00.000Z', session_status: 'scheduled', status: 'late', checked_in_at: '2099-11-16T07:05:00.000Z', open_followups: [], exception: null, plan_status: 'published', messages: [{ type: 'late', status: 'sent', dry_run: true }] },
    { attendance_id: 'r3', student_id: 's3', student_name: '사아자', grade: '중3', class_name: '반A', starts_at: '2099-11-16T07:00:00.000Z', ends_at: '2099-11-16T08:30:00.000Z', session_status: 'scheduled', status: 'scheduled', open_followups: [], exception: { id: 'e1', type: 'planned_absence', status: 'active' }, plan_status: null, messages: [] },
  ],
  failed_messages: [{ id: 'm1', student_name: '차카타', message_type: 'absent', failure_code: 'retry_exhausted', manual_followup_at: null }],
  makeup_drafts: [{ batch_id: 'b1', student_name: '사아자', origin: 'planned_absence', status: 'draft', options: [1, 2, 3].map((n) => ({ id: 'o' + n, starts_at: `2099-11-1${6 + n}T07:00:00.000Z`, ends_at: `2099-11-1${6 + n}T08:00:00.000Z`, sort_order: n })) }],
});

function setup({ rpc = {}, issueAttendanceCode } = {}) {
  const dom = new JSDOM(adminHtml, { pretendToBeVisual: true });
  const { document } = dom.window;
  const calls = [];
  const responses = {
    admin_run_attendance_followups: { data: {}, error: null },
    admin_today_operations: { data: snapshot(), error: null },
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
  const ops = bindTodayOperations(document, { client, issueAttendanceCode, isCurrent: () => true, now: () => NOW });
  return { document, client, calls, ops, responses };
}
const $ = (d, id) => d.getElementById(id);
const countOf = (d, key) => d.querySelector(`[data-bucket="${key}"] .today-ops-count`).textContent;

describe('admin today operations', () => {
  it('runs the follow-up scan and renders counts that match their lists', async () => {
    const { document, calls } = setup();
    await flush();
    expect(calls.map((c) => c[0]).slice(0, 2)).toEqual(['admin_run_attendance_followups', 'admin_today_operations']);
    expect(countOf(document, 'missing')).toBe('1');
    expect(countOf(document, 'late')).toBe('1');
    expect(countOf(document, 'planned_exceptions')).toBe('1');
    expect(countOf(document, 'message_failed')).toBe('1');
    expect(countOf(document, 'planned_absence_drafts')).toBe('1');
    document.querySelector('[data-bucket="missing"]').click();
    expect(document.querySelector('[data-bucket="missing"]').getAttribute('aria-pressed')).toBe('true');
    const cards = document.querySelectorAll('#todayOpsList article');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('h4').textContent).toBe('<i>가나다</i>');
    expect(document.querySelector('#todayOpsList i')).toBeNull();
    document.querySelector('[data-bucket="planned_exceptions"]').click();
    expect(document.querySelector('#todayOpsList article').textContent).toContain('사전 결석');
    expect(document.querySelector('#todayOpsList article').textContent).toContain('자동 알림 제외');
  });

  it('records manual arrival with actual time and reason, then refreshes', async () => {
    const { document, calls } = setup({ rpc: { admin_record_manual_arrival: { data: { status: 'late' }, error: null } } });
    await flush();
    document.querySelector('[data-bucket="missing"]').click();
    const trigger = [...document.querySelectorAll('#todayOpsList button')].find((b) => b.textContent === '수동 등원');
    trigger.click();
    expect($(document, 'todayOpsActionForm').hidden).toBe(false);
    expect(document.activeElement).toBe($(document, 'todayOpsTime'));
    $(document, 'todayOpsTime').value = '2099-11-16T16:20';
    $(document, 'todayOpsReason').value = '';
    $(document, 'todayOpsActionForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect($(document, 'todayOpsResult').textContent).toBe('사유를 입력해 주세요.');
    $(document, 'todayOpsReason').value = '태블릿 네트워크 장애';
    $(document, 'todayOpsActionForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    const call = calls.find((c) => c[0] === 'admin_record_manual_arrival');
    expect(call[1]).toEqual({ p_attendance_id: 'r1', p_arrived_at: new Date('2099-11-16T16:20').toISOString(), p_reason: '태블릿 네트워크 장애' });
    expect(calls.filter((c) => c[0] === 'admin_today_operations')).toHaveLength(2);
    expect($(document, 'todayOpsResult').textContent).toBe('수동 등원을 기록했습니다.');
    expect($(document, 'todayOpsActionForm').hidden).toBe(true);
  });

  it('restores focus to the trigger when the action form is cancelled with Escape', async () => {
    const { document } = setup();
    await flush();
    document.querySelector('[data-bucket="missing"]').click();
    const trigger = [...document.querySelectorAll('#todayOpsList button')].find((b) => b.textContent === '사전 지각');
    trigger.click();
    $(document, 'todayOpsActionForm').dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($(document, 'todayOpsActionForm').hidden).toBe(true);
    expect(document.activeElement.textContent).toBe('사전 지각');
  });

  it('reports a CAS conflict truthfully and distinguishes refresh failure after a committed mutation', async () => {
    let loads = 0;
    const { document } = setup({ rpc: {
      admin_cancel_attendance_exception: { data: null, error: { code: '40001', message: 'attendance exception state changed' } },
      admin_record_message_manual_followup: { data: null, error: null },
      admin_today_operations: () => { loads += 1; return loads > 1 ? { data: null, error: { code: '08006', message: 'network' } } : { data: snapshot(), error: null }; },
    } });
    await flush();
    document.querySelector('[data-bucket="planned_exceptions"]').click();
    [...document.querySelectorAll('#todayOpsList button')].find((b) => b.textContent === '예외 취소').click();
    await flush();
    expect($(document, 'todayOpsResult').textContent).toBe('다른 사용자가 먼저 변경했습니다. 최신 상태를 확인해 주세요.');
    document.querySelector('[data-bucket="message_failed"]').click();
    [...document.querySelectorAll('#todayOpsList button')].find((b) => b.textContent === '수동 연락 완료').click();
    await flush();
    expect($(document, 'todayOpsResult').textContent).toBe('처리는 완료됐지만 화면 새로고침에 실패했습니다.');
  });

  it('lets the owner review exactly three draft options and send manually', async () => {
    const { document, calls } = setup({ rpc: { admin_send_makeup_offer: { data: { status: 'offered' }, error: null } } });
    await flush();
    document.querySelector('[data-bucket="planned_absence_drafts"]').click();
    const card = document.querySelector('#todayOpsList article');
    expect(card.querySelectorAll('li')).toHaveLength(3);
    [...card.querySelectorAll('button')].find((b) => b.textContent === '보강 안내 발송').click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_send_makeup_offer')[1]).toEqual({ p_batch_id: 'b1' });
  });

  it('reissues through the authenticated Edge Function, shows the number once outside the roster, and clears it on refresh', async () => {
    const issueAttendanceCode = vi.fn(async () => ({ code: '482913', issue_kind: 'rotated' }));
    const { document, ops, calls } = setup({ issueAttendanceCode });
    await flush();
    document.querySelector('[data-bucket="late"]').click();
    [...document.querySelectorAll('#todayOpsList button')].find((b) => b.textContent === '출석번호 재발급').click();
    await flush();
    expect(issueAttendanceCode).toHaveBeenCalledWith('s2');
    expect(calls.map((c) => c[0])).not.toContain('admin_issue_attendance_code');
    expect($(document, 'todayOpsSecret').textContent).toContain('482913');
    expect($(document, 'todayOpsResult').textContent).toContain('이전 번호는 즉시 폐기');
    expect($(document, 'todayOpsList').textContent).not.toContain('482913');
    await ops.refresh();
    expect($(document, 'todayOpsSecret').textContent).toBe('');
  });

  describe('attendance secret navigation boundary', () => {
    const issueOn = async (document) => {
      document.querySelector('[data-bucket="late"]').click();
      [...document.querySelectorAll('#todayOpsList button')].find((b) => b.textContent === '출석번호 재발급').click();
      await flush();
    };
    const noRawCode = (document, code) => {
      for (const id of ['todayOpsResult', 'todayOpsError', 'todayOpsList', 'todayOpsCounts', 'adminError']) {
        expect(($(document, id)?.textContent) ?? '').not.toContain(code);
      }
    };

    it('clears the number immediately on navigation and keeps it cleared while the return refresh is pending', async () => {
      const issueAttendanceCode = vi.fn(async () => ({ code: '482913', issue_kind: 'rotated' }));
      let hold = false;
      let release;
      const { document, ops } = setup({ issueAttendanceCode, rpc: {
        admin_today_operations: () => (hold ? new Promise((r) => { release = () => r({ data: snapshot(), error: null }); }) : { data: snapshot(), error: null }),
      } });
      await flush();
      await issueOn(document);
      expect($(document, 'todayOpsSecret').textContent).toContain('482913');
      ops.clearSecret(); // admin switchTab to any other tab
      expect($(document, 'todayOpsSecret').textContent).toBe('');
      hold = true; // back to the dashboard: refresh stays pending
      const pending = ops.refresh();
      await flush();
      expect($(document, 'todayOpsSecret').textContent).toBe('');
      noRawCode(document, '482913');
      release();
      await pending;
      expect($(document, 'todayOpsSecret').textContent).toBe('');
    });

    it('drops a late reissue success or failure that lands after navigation, even after returning', async () => {
      for (const outcome of ['success', 'failure']) {
        let settle;
        const issueAttendanceCode = vi.fn(() => new Promise((resolveFn, rejectFn) => {
          settle = () => (outcome === 'success' ? resolveFn({ code: '771204', issue_kind: 'rotated' }) : rejectFn(new Error('late failure')));
        }));
        const { document, ops } = setup({ issueAttendanceCode });
        await flush();
        await issueOn(document);
        ops.clearSecret(); // navigate away …
        await ops.refresh(); // … and come back before the old request settles
        $(document, 'todayOpsResult').textContent = '';
        settle();
        await flush();
        expect($(document, 'todayOpsSecret').textContent).toBe('');
        expect($(document, 'todayOpsResult').textContent).toBe('');
        noRawCode(document, '771204');
        // The controller is usable again for a fresh, current request.
        issueAttendanceCode.mockImplementationOnce(async () => ({ code: '339120', issue_kind: 'rotated' }));
        await issueOn(document);
        expect($(document, 'todayOpsSecret').textContent).toContain('339120');
        noRawCode(document, '339120');
      }
    });

    it('clears the number on destroy (logout / pagehide teardown)', async () => {
      const issueAttendanceCode = vi.fn(async () => ({ code: '482913', issue_kind: 'rotated' }));
      const { document, ops } = setup({ issueAttendanceCode });
      await flush();
      await issueOn(document);
      expect($(document, 'todayOpsSecret').textContent).toContain('482913');
      ops.destroy();
      expect($(document, 'todayOpsSecret').textContent).toBe('');
    });

    it('wires admin navigation, logout and every pagehide to clear both attendance secrets before any await', () => {
      const adminJs = readFileSync(resolve(root, 'src/portal/admin.js'), 'utf8');
      expect(adminJs).toMatch(/async function switchTab\([^)]*\) \{\s*studentRegistry[.]clearSecret\(\);\s*todayOperations\?[.]clearSecret\(\);\s*const navigation = adminNavigationGate[.]begin\(\);/);
      expect(adminJs).toMatch(/function clearAttendanceSecrets\(\) \{\s*studentRegistry[.]clearSecret\(\);\s*todayOperations\?[.]clearSecret\(\);\s*\}/);
      expect(adminJs).toMatch(/window[.]addEventListener\('pagehide', \(event\) => \{\s*clearAttendanceSecrets\(\);/);
      expect(adminJs).toMatch(/byId\('logout'\)[.]addEventListener\('click', async \(\) => \{\s*clearAttendanceSecrets\(\);\s*teardownTodayOperations\(\);/);
    });
  });

  it('reports a failed reissue without showing any number', async () => {
    const issueAttendanceCode = vi.fn(async () => { throw new Error('forbidden'); });
    const { document } = setup({ issueAttendanceCode });
    await flush();
    document.querySelector('[data-bucket="late"]').click();
    [...document.querySelectorAll('#todayOpsList button')].find((b) => b.textContent === '출석번호 재발급').click();
    await flush();
    expect($(document, 'todayOpsSecret').textContent).toBe('');
    expect($(document, 'todayOpsResult').textContent).toContain('출석번호를 발급하지 못했습니다');
  });

  it('never calls a raw-code attendance RPC from the admin bundle', () => {
    expect(kioskOperationsJs).not.toContain('admin_issue_attendance_code');
    const adminJs = readFileSync(resolve(root, 'src/portal/admin.js'), 'utf8');
    expect(adminJs).not.toContain('admin_issue_attendance_code');
    expect(adminJs).toContain('createAttendanceCodeIssuer(invokeAuthenticated)');
    expect(adminJs).toMatch(/bindStudentRegistry\(document, undefined, \{[^}]*issueAttendanceCode/s);
    expect(adminJs).toMatch(/bindTodayOperations\(document, \{[^}]*issueAttendanceCode/s);
    for (const id of ['studentRegistryAttendanceCode', 'studentRegistryIssueCode', 'studentRegistryCodeSecret']) expect(adminHtml).toContain(`id=${id}`);
  });

  it('falls back only for the exact missing-function rollout error and surfaces permission errors', async () => {
    const missing = setup({ rpc: { admin_run_attendance_followups: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_run_attendance_followups without parameters' } } } });
    await flush();
    expect($(missing.document, 'todayOpsNotice').hidden).toBe(false);
    expect($(missing.document, 'todayOpsError').textContent).toBe('');
    const denied = setup({ rpc: { admin_today_operations: { data: null, error: { code: '42501', message: 'admin required' } } } });
    await flush();
    expect($(denied.document, 'todayOpsNotice').hidden).toBe(true);
    expect($(denied.document, 'todayOpsError').textContent).toBe('admin required');
  });

  it('parses owner plan lines into typed items without inventing types', () => {
    expect(parsePlanLines('숙제: p.30\n재풀이: 3번\n이월: 연립방정식\n진도: 일차함수\n매쓰플랫: 20문항\n메모: 개념 복습\n\n그냥 줄')).toEqual([
      { item_type: 'homework', title: 'p.30' },
      { item_type: 'redo', title: '3번' },
      { item_type: 'carryover', title: '연립방정식' },
      { item_type: 'auto_progress', title: '일차함수' },
      { item_type: 'mathflat', title: '20문항' },
      { item_type: 'note', title: '개념 복습' },
      { item_type: 'note', title: '그냥 줄' },
    ]);
    expect(parsePlanLines('')).toEqual([]);
  });

  it('shows teacher confirmation only after the student has submitted completion', () => {
    expect(kioskOperationsJs).toContain("item.student_status === 'submitted' && item.teacher_status !== 'confirmed'");
  });

  describe('learning plan panel: generated drafts and next-progress queue', () => {
    const PLANS = [
      { id: 'p1', status: 'published', source_revision: 1, new_progress_approved_at: null, daily_learning_plan_items: [
        { id: 'i1', item_type: 'homework', title: '숙제 p.30', student_status: 'pending', teacher_status: 'pending', sort_order: 1 },
      ] },
      { id: 'p2', status: 'draft', source_revision: 2, created_via: 'admin', daily_learning_plan_items: [
        { id: 'i4', item_type: 'auto_progress', title: '<b>일차함수</b>', student_status: 'pending', teacher_status: 'pending', sort_order: 3 },
        { id: 'i2', item_type: 'homework', title: '숙제 p.30', student_status: 'pending', teacher_status: 'pending', sort_order: 1 },
        { id: 'i3', item_type: 'redo', title: '단원평가 · 3번', student_status: 'pending', teacher_status: 'pending', sort_order: 2 },
      ] },
    ];
    const TARGETS = [
      { id: 't1', sequence: 4, title: '일차함수 개념', status: 'queued' },
      { id: 't2', sequence: 5, title: '일차함수 그래프', status: 'queued' },
    ];
    function planSetup({ plans = PLANS, targets = TARGETS, rpc = {} } = {}) {
      const ctx = setup({ rpc });
      const reads = [];
      ctx.client.from = vi.fn((table) => {
        const query = { table, filters: [] };
        reads.push(query);
        const rows = table === 'daily_learning_plans' ? plans : table === 'student_progress_targets' ? targets : [];
        const builder = {
          select: (cols) => { query.select = cols; return builder; },
          eq: (col, val) => { query.filters.push([col, val]); return builder; },
          order: () => builder,
          then: (resolveFn) => resolveFn({ data: rows, error: null }),
        };
        return builder;
      });
      return { ...ctx, reads };
    }
    async function openPanel(document) {
      await flush();
      document.querySelector('[data-bucket="late"]').click();
      [...document.querySelectorAll('#todayOpsList button')].find((b) => b.textContent === '학습계획').click();
      await flush();
    }

    it('shows generated draft item types and titles in rank order, not only the revision number', async () => {
      const { document } = planSetup();
      await openPanel(document);
      const draft = $(document, 'todayOpsPlanDraft');
      expect(draft.textContent).toContain('미발행 초안 r2');
      expect([...draft.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['숙제 · 숙제 p.30', '재풀이 · 단원평가 · 3번', '진도 · <b>일차함수</b>']);
      expect(draft.querySelector('b')).toBeNull();
      expect($(document, 'todayOpsPlanCurrent').textContent).toContain('숙제 · 숙제 p.30');
    });

    it('shows the current next-progress target first, folds the rest, and enqueues or cancels only through RPCs', async () => {
      const { document, calls, reads, client } = planSetup({ rpc: {
        admin_enqueue_progress_target: { data: { id: 't3', sequence: 6 }, error: null },
        admin_cancel_progress_target: { data: null, error: null },
      } });
      await openPanel(document);
      const targetRead = reads.find((r) => r.table === 'student_progress_targets');
      expect(targetRead.filters).toEqual([['student_id', 's2'], ['status', 'queued']]);
      expect($(document, 'todayOpsProgressCurrent').textContent).toContain('일차함수 개념');
      expect($(document, 'todayOpsProgressMore').open).toBe(false);
      expect($(document, 'todayOpsProgressList').textContent).toContain('일차함수 그래프');
      expect($(document, 'todayOpsPlanManual').tagName).toBe('DETAILS');
      expect($(document, 'todayOpsPlanManual').open).toBe(false);

      $(document, 'todayOpsProgressInput').value = '   ';
      $(document, 'todayOpsProgressForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
      await flush();
      expect(calls.some((c) => c[0] === 'admin_enqueue_progress_target')).toBe(false);
      $(document, 'todayOpsProgressInput').value = ' 연립방정식 활용 ';
      $(document, 'todayOpsProgressForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
      await flush();
      expect(calls.find((c) => c[0] === 'admin_enqueue_progress_target')[1]).toEqual({ p_student_id: 's2', p_title: '연립방정식 활용', p_body: '' });
      expect($(document, 'todayOpsProgressInput').value).toBe('');

      [...$(document, 'todayOpsProgressCurrent').querySelectorAll('button')].find((b) => b.textContent === '취소').click();
      await flush();
      expect(calls.find((c) => c[0] === 'admin_cancel_progress_target')[1]).toEqual({ p_target_id: 't1' });
      const writes = client.from.mock.results.map((r) => r.value).filter((b) => b.insert || b.update || b.upsert || b.delete);
      expect(writes).toHaveLength(0);
    });

    it('explains the empty queue without inventing a progress entry', async () => {
      const { document } = planSetup({ targets: [] });
      await openPanel(document);
      expect($(document, 'todayOpsProgressCurrent').textContent).toContain('다음 진도를 입력');
      expect($(document, 'todayOpsProgressList').children).toHaveLength(0);
    });

    it('regenerates a new automatic draft with a revision CAS and reports conflicts truthfully', async () => {
      let mode = 'ok';
      const { document, calls } = planSetup({ rpc: {
        admin_regenerate_learning_plan: () => (mode === 'ok'
          ? { data: { plan_id: 'p3', revision: 3 }, error: null }
          : { data: null, error: { code: '40001', message: 'learning plan revision changed' } }),
      } });
      await openPanel(document);
      $(document, 'todayOpsPlanRegenerate').click();
      await flush();
      expect(calls.find((c) => c[0] === 'admin_regenerate_learning_plan')[1]).toEqual({ p_attendance_id: 'r2', p_expected_revision: 2 });
      expect($(document, 'todayOpsResult').textContent).toContain('새 초안');
      mode = 'conflict';
      $(document, 'todayOpsPlanRegenerate').click();
      await flush();
      expect($(document, 'todayOpsResult').textContent).toBe('다른 사용자가 먼저 변경했습니다. 최신 상태를 확인해 주세요.');
    });
  });

  it('lets the owner review and approve message templates before any automatic outbox is queued', async () => {
    const { document, client, calls } = setup({ rpc: { admin_approve_message_template: { data: null, error: null } } });
    client.from = vi.fn((table) => {
      const rows = table === 'message_templates'
        ? [{ template_code: 'attendance_late', message_type: 'late', body: '<b>#{학생명}</b> 지각', approved: false }, { template_code: 'attendance_present', message_type: 'present', body: '출석', approved: true }]
        : [];
      const builder = { select: () => builder, eq: () => builder, order: () => builder, then: (resolveFn) => resolveFn({ data: rows, error: null }) };
      return builder;
    });
    await flush();
    $(document, 'todayOpsSetup').open = true;
    $(document, 'todayOpsSetup').dispatchEvent(new document.defaultView.Event('toggle'));
    await flush();
    const items = document.querySelectorAll('#todayOpsTemplates li');
    expect(items).toHaveLength(2);
    expect(document.querySelector('#todayOpsTemplates b')).toBeNull();
    expect(items[0].textContent).toContain('<b>#{학생명}</b> 지각');
    expect(items[1].textContent).toContain('승인됨');
    expect(items[1].querySelector('button')).toBeNull();
    items[0].querySelector('button').click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_approve_message_template')[1]).toEqual({ p_template_code: 'attendance_late' });
  });
});

describe('admin today operations · draft parent messages', () => {
  const draftSnapshot = (drafts, total = drafts.length, extra = {}) => ({
    ...snapshot(),
    draft_messages: drafts,
    queues: { draft_messages: { total, has_more: total > drafts.length, next_cursor: total > drafts.length ? 'draft-cursor-1' : null } },
    ...extra,
  });
  const d1 = { id: 'dm1', attendance_id: 'old-r1', student_name: '<b>하나</b>', message_type: 'present', status: 'draft', created_at: '2099-11-15T06:55:00.000Z', recipient_label: '보호자', template_approved: true };
  const d2 = { id: 'dm2', attendance_id: 'old-r1', student_name: '하나', message_type: 'checkout', status: 'draft', created_at: '2099-11-15T08:05:00.000Z', recipient_label: '보호자', template_approved: false };

  it('shows draft messages as their own bucket with the full-queue aggregate count', async () => {
    const { document } = setup({ rpc: { admin_today_operations: { data: draftSnapshot([d1, d2], 3), error: null } } });
    await flush();
    expect(countOf(document, 'message_draft')).toBe('3');
    document.querySelector('[data-bucket="message_draft"]').click();
    const cards = [...document.querySelectorAll('#todayOpsList article')];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('h4').textContent).toBe('<b>하나</b>');
    expect(cards[0].querySelector('b')).toBeNull();
    expect(cards[0].textContent).toContain('출석 알림 승인 대기');
    expect(cards[1].textContent).toContain('템플릿 승인 필요');
    expect($(document, 'todayOpsMore').hidden).toBe(false);
  });

  it('approves one draft through admin_approve_parent_message and refreshes every count and list', async () => {
    let loads = 0;
    const { document, calls } = setup({ rpc: {
      admin_approve_parent_message: { data: null, error: null },
      admin_today_operations: () => { loads += 1; return { data: loads > 1 ? draftSnapshot([d2], 1) : draftSnapshot([d1, d2]), error: null }; },
    } });
    await flush();
    document.querySelector('[data-bucket="message_draft"]').click();
    const approve = [...document.querySelectorAll('#todayOpsList article')][0];
    [...approve.querySelectorAll('button')].find((b) => b.textContent === '승인 후 발송').click();
    await flush();
    expect(calls.filter((c) => c[0] === 'admin_approve_parent_message')).toEqual([['admin_approve_parent_message', { p_message_id: 'dm1' }]]);
    expect(loads).toBe(2);
    expect(countOf(document, 'message_draft')).toBe('1');
    expect([...document.querySelectorAll('#todayOpsList article')]).toHaveLength(1);
    expect($(document, 'todayOpsResult').textContent).toBe('알림을 승인해 발송 대기열에 넣었습니다.');
  });

  it('cancels a stale draft and reports template/state failures truthfully', async () => {
    const { document, calls } = setup({ rpc: {
      admin_today_operations: { data: draftSnapshot([d1, d2]), error: null },
      admin_cancel_parent_message: { data: null, error: null },
      admin_approve_parent_message: { data: null, error: { code: '40001', message: 'parent message state changed' } },
    } });
    await flush();
    document.querySelector('[data-bucket="message_draft"]').click();
    [...document.querySelectorAll('#todayOpsList article')[0].querySelectorAll('button')].find((b) => b.textContent === '승인 후 발송').click();
    await flush();
    expect($(document, 'todayOpsResult').textContent).toBe('다른 사용자가 먼저 변경했습니다. 최신 상태를 확인해 주세요.');
    [...document.querySelectorAll('#todayOpsList article')[1].querySelectorAll('button')].find((b) => b.textContent === '발송 안 함').click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_cancel_parent_message')[1]).toEqual({ p_message_id: 'dm2', p_expected_status: 'draft' });
    expect($(document, 'todayOpsResult').textContent).toBe('알림을 발송하지 않도록 취소했습니다.');
  });

  it('sends the displayed status as the cancel CAS and never reports a conflicting cancel as success or refreshes for it', async () => {
    let loads = 0;
    const approved = { ...d1, id: 'dm3', status: 'approved' };
    const { document, calls } = setup({ rpc: {
      admin_today_operations: () => { loads += 1; return { data: draftSnapshot([approved, d2]), error: null }; },
      admin_cancel_parent_message: (args) => (args.p_message_id === 'dm3'
        ? { data: null, error: { code: '40001', message: 'parent message state changed' } }
        : { data: null, error: null }),
    } });
    await flush();
    document.querySelector('[data-bucket="message_draft"]').click();
    const loadsBefore = loads;
    [...document.querySelectorAll('#todayOpsList article')[0].querySelectorAll('button')].find((b) => b.textContent === '발송 안 함').click();
    await flush();
    expect(calls.filter((c) => c[0] === 'admin_cancel_parent_message').map((c) => c[1])).toEqual([{ p_message_id: 'dm3', p_expected_status: 'approved' }]);
    expect($(document, 'todayOpsResult').textContent).toBe('다른 사용자가 먼저 변경했습니다. 최신 상태를 확인해 주세요.');
    expect(loads).toBe(loadsBefore);
    [...document.querySelectorAll('#todayOpsList article')[1].querySelectorAll('button')].find((b) => b.textContent === '발송 안 함').click();
    await flush();
    expect($(document, 'todayOpsResult').textContent).toBe('알림을 발송하지 않도록 취소했습니다.');
    expect(loads).toBe(loadsBefore + 1);
  });

  it('pages the draft queue through the keyset RPC', async () => {
    const { document, calls } = setup({ rpc: {
      admin_today_operations: { data: draftSnapshot([d1], 2), error: null },
      admin_operations_queue_page: { data: { items: [d2], has_more: false, next_cursor: null }, error: null },
    } });
    await flush();
    document.querySelector('[data-bucket="message_draft"]').click();
    $(document, 'todayOpsMore').click();
    await flush();
    expect(calls.find((c) => c[0] === 'admin_operations_queue_page')[1]).toEqual({ p_queue: 'draft_messages', p_cursor: 'draft-cursor-1' });
    expect([...document.querySelectorAll('#todayOpsList article')]).toHaveLength(2);
    expect(countOf(document, 'message_draft')).toBe('2');
    expect($(document, 'todayOpsMore').hidden).toBe(true);
  });
});
