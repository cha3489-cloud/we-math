// Admin "오늘 출결 현황": today-first kiosk attendance, follow-ups, parent-message failures,
// planned exceptions, planned-absence makeup drafts, and learning-plan publication.
// Every write goes through a narrow admin RPC; remote text is rendered with textContent only.
import { kstTimeText } from '../kiosk/rules.js';
import {
  BUCKET_QUEUE, buildOperationsBuckets, createLiveRefresh, createRefreshCoordinator, mergeQueuePage, mutationErrorCopy, REFRESH_FAILED_COPY,
} from './operations-dashboard.js';

const BUCKET_COPY = {
  message_failed: '알림 발송 실패',
  message_draft: '알림 승인 대기',
  missing: '출석 미확인',
  checkout_needed: '하원 확인 필요',
  planned_absence_drafts: '보강 안내 대기',
  makeup_followup: '보강 직접 연락',
  plan_missing: '학습계획 누락',
  scheduled: '출석 예정',
  present: '출석',
  late: '지각',
  absent: '결석',
  planned_exceptions: '사전 지각·결석',
};
const BUCKET_ORDER = Object.keys(BUCKET_COPY);
const STATUS_COPY = { scheduled: '예정', present: '출석', late: '지각', absent: '결석', excused: '사유 결석' };
const MESSAGE_COPY = { present: '출석', late: '지각', missing: '출석 미확인', absent: '결석', checkout: '하원', makeup_offer: '보강 안내' };
const MESSAGE_STATUS_COPY = { draft: '승인 대기', approved: '승인됨', queued: '발송 대기', sent: '발송', delivered: '전달 완료', failed: '실패', cancelled: '취소' };
const EXCEPTION_COPY = { expected_late: '사전 지각', planned_absence: '사전 결석' };
const OPS_FUNCTIONS = ['admin_run_attendance_followups', 'admin_today_operations'];
const WEEKDAY_COPY = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const SCHEDULE_INVALID_COPY = '요일·시작 시각·수업 시간·적용 시작일을 확인해 주세요.';
const PLAN_PREFIX = { '숙제': 'homework', '재풀이': 'redo', '이월': 'carryover', '진도': 'auto_progress', '매쓰플랫': 'mathflat', '메모': 'note' };
const ITEM_TYPE_COPY = Object.fromEntries(Object.entries(PLAN_PREFIX).map(([label, type]) => [type, label]));
const DEVICE_KIND_COPY = { kiosk: '입구 출석', learning_plan: '학습계획' };
const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const isObject = (value) => Boolean(value) && typeof value === 'object';
const objectRows = (value) => (Array.isArray(value) ? value.filter(isObject) : []);
const planItems = (plan) => (Array.isArray(plan?.daily_learning_plan_items) ? plan.daily_learning_plan_items : []).slice().sort((a, b) => a.sort_order - b.sort_order);
const itemLabel = (item) => `${ITEM_TYPE_COPY[item.item_type] || '메모'} · ${item.title}`;

export function isOpsBackendMissing(error) {
  if (!error || typeof error.message !== 'string') return false;
  if (error.code === 'PGRST202') return OPS_FUNCTIONS.some((fn) => error.message.includes('public.' + fn + ' ') || error.message.endsWith('public.' + fn));
  if (error.code === '42883') return OPS_FUNCTIONS.some((fn) => error.message.includes('public.' + fn + '('));
  return false;
}

export function parsePlanLines(text) {
  if (typeof text !== 'string') return [];
  return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 30).map((line) => {
    const match = /^([^:：]{1,6})[:：]\s*(.+)$/.exec(line);
    const type = match ? PLAN_PREFIX[match[1].trim()] : null;
    return type ? { item_type: type, title: match[2].trim().slice(0, 200) } : { item_type: 'note', title: line.slice(0, 200) };
  });
}

function kstDay(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function kstSlot(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${kstTimeText(value)}`;
}

export function bindTodayOperations(document, { client, issueAttendanceCode = null, isCurrent = () => true, now = () => new Date() }) {
  const byId = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const state = { snapshot: null, model: null, filter: null, action: null, trigger: null, busy: false, planStudent: null, plans: [], schedules: [], scheduleEdit: null, deviceAssign: null, deviceTrigger: null, destroyed: false, secretEpoch: 0 };
  const active = () => !state.destroyed && isCurrent();
  // The reissued six-digit number lives only in #todayOpsSecret. Clearing it (navigation, logout,
  // pagehide, destroy) also retires every in-flight reissue, so a late success or failure can
  // never repopulate the number or its status, even after the admin returns to this view.
  function clearSecret() {
    state.secretEpoch += 1;
    byId('todayOpsSecret').textContent = '';
  }

  async function load() {
    for (const fn of OPS_FUNCTIONS) {
      const { data, error } = await client.rpc(fn);
      if (error) throw error;
      if (fn === 'admin_today_operations') return data;
    }
    return null;
  }
  // Background (realtime/poll) refreshes read the snapshot only; the server tick runs follow-ups.
  async function loadSnapshot() {
    const { data, error } = await client.rpc('admin_today_operations');
    if (error) throw error;
    return data;
  }
  const coordinator = createRefreshCoordinator((data) => {
    if (!active()) return;
    state.snapshot = data;
    byId('todayOpsSecret').textContent = '';
    byId('todayOpsNotice').hidden = true;
    byId('todayOpsError').textContent = '';
    render();
    // Realtime + polling start only after the first successfully applied admin snapshot.
    live.start();
  });

  // Resolves true only when a fresh snapshot was applied.
  async function refresh(loader = load) {
    try {
      return await coordinator.refresh(loader);
    } catch (error) {
      if (!active()) return false;
      byId('todayOpsSecret').textContent = '';
      if (isOpsBackendMissing(error)) {
        byId('todayOpsNotice').hidden = false;
        byId('todayOpsError').textContent = '';
        byId('todayOpsCounts').replaceChildren();
        byId('todayOpsList').replaceChildren();
        byId('todayOpsMore').hidden = true;
        return false;
      }
      byId('todayOpsNotice').hidden = true;
      byId('todayOpsError').textContent = error?.message || '오늘 출결 현황을 불러오지 못했습니다.';
      return false;
    }
  }
  const live = createLiveRefresh({ client, refresh: () => refresh(loadSnapshot), isActive: () => active() && !state.busy });

  async function mutate(fn, args, successCopy, after) {
    return runMutation(async () => {
      const response = await client.rpc(fn, args);
      if (response.error) throw response.error;
      return response.data;
    }, successCopy, after);
  }

  async function runMutation(perform, successCopy, after, failureCopy = mutationErrorCopy, stillCurrent = () => true) {
    if (state.busy || !active()) return false;
    state.busy = true;
    byId('todayOpsResult').textContent = '';
    const current = () => active() && stillCurrent();
    let data;
    try {
      data = await perform();
    } catch (error) {
      state.busy = false;
      if (current()) byId('todayOpsResult').textContent = failureCopy(error);
      return false;
    }
    try {
      await coordinator.refresh(load);
      if (current()) byId('todayOpsResult').textContent = typeof successCopy === 'function' ? successCopy(data) : successCopy;
    } catch {
      if (current()) byId('todayOpsResult').textContent = REFRESH_FAILED_COPY;
    }
    state.busy = false;
    if (after && current()) after(data);
    return true;
  }

  function button(label, handler, className = 'secondary small') {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', () => handler(node));
    return node;
  }

  function sessionCard(row) {
    const card = el('article', 'card attendance-card attendance-' + row.status);
    card.append(el('h4', '', row.student_name || '학생'));
    card.append(el('p', 'meta', [row.grade, row.class_name, kstTimeText(row.starts_at) + ' 수업'].filter(Boolean).join(' · ')));
    const statusParts = [STATUS_COPY[row.status] || row.status];
    if (row.checked_in_at) statusParts.push(kstTimeText(row.checked_in_at) + ' 등원' + (row.check_in_source === 'admin_manual' ? '(수동)' : ''));
    if (row.checked_out_at) statusParts.push(kstTimeText(row.checked_out_at) + ' 하원' + (row.checkout_source && row.checkout_source !== 'kiosk' ? '(수동)' : ''));
    card.append(el('p', '', statusParts.join(' · ')));
    if (row.exception && row.exception.status !== 'cancelled') {
      card.append(el('p', 'attendance-status', (EXCEPTION_COPY[row.exception.type] || '사전 예외') + ' · 자동 알림 제외'));
    }
    if (Array.isArray(row.open_followups) && row.open_followups.length) {
      card.append(el('p', 'attendance-private-note', row.open_followups.map((kind) => (kind === 'missing' ? '출석 미확인' : '하원 확인 필요')).join(' · ')));
    }
    if (row.status === 'present' || row.status === 'late') {
      card.append(el('p', 'meta', row.plan_status === 'published' ? '학습계획 발행됨' : row.plan_status === 'draft' ? '학습계획 초안 · 발행 필요' : '학습계획 없음 · 작성 필요'));
    }
    // Account-unlinked students on site may view today's plan on a dedicated academy tablet.
    // Fail closed: older snapshots without account_linked never offer the device path.
    const onSite = (row.status === 'present' || row.status === 'late') && Boolean(row.checked_in_at) && !row.checked_out_at;
    const device = isObject(row.learning_device) ? row.learning_device : null;
    if (onSite && row.account_linked === true) card.append(el('p', 'meta', '학생 계정 로그인(전화번호+PIN) · 학습 태블릿 배정 대상 아님'));
    if (device) card.append(el('p', 'meta', `학습 태블릿: ${device.device_name || '기기'}${device.expires_at ? ` · ${kstTimeText(device.expires_at)}까지` : ''}`));
    const messages = Array.isArray(row.messages) ? row.messages : [];
    if (messages.length) {
      card.append(el('p', 'meta', '학부모 알림: ' + messages.map((m) => `${MESSAGE_COPY[m.type] || m.type} ${MESSAGE_STATUS_COPY[m.status] || m.status}${m.dry_run ? '(테스트·실제 미발송)' : ''}`).join(', ')));
    }
    const actions = el('div', 'attendance-actions');
    const activeException = row.exception && row.exception.status === 'active';
    if (row.status === 'scheduled') {
      if (activeException) actions.append(button('예외 취소', () => mutate('admin_cancel_attendance_exception', { p_exception_id: row.exception.id }, '사전 예외를 취소했습니다.')));
      else {
        actions.append(button('사전 지각', (b) => openAction('expected_late', row, b)));
        actions.append(button('사전 결석', (b) => openAction('planned_absence', row, b)));
      }
      actions.append(button('수동 등원', (b) => openAction('manual_arrival', row, b)));
    }
    if ((row.status === 'present' || row.status === 'late') && row.checked_in_at) {
      actions.append(button(row.checked_out_at ? '하원 시각 정정' : '수동 하원', (b) => openAction('manual_checkout', row, b)));
    }
    if (onSite && row.account_linked === false) {
      if (device) {
        actions.append(button('다른 태블릿으로 변경', (b) => openDeviceAssign(row, b)));
        actions.append(button('배정 해제', () => mutate('admin_revoke_learning_device_session', { p_session_id: device.session_id, p_expected_revision: device.revision }, '학습 태블릿 배정을 해제했습니다.')));
      } else {
        actions.append(button('학습 태블릿 배정', (b) => openDeviceAssign(row, b)));
      }
    }
    actions.append(button('학습계획', () => openPlan(row)));
    actions.append(button('출석번호 재발급', () => { const epoch = state.secretEpoch; return runMutation(async () => {
      if (!issueAttendanceCode) throw new Error('출석번호 발급 기능이 연결되지 않았습니다.');
      return issueAttendanceCode(row.student_id);
    }, '출석번호를 재발급했습니다. 이전 번호는 즉시 폐기됐습니다.', (issued) => {
      const code = issued?.code;
      if (typeof code === 'string' && /^\d{6}$/.test(code)) {
        byId('todayOpsSecret').textContent = `${row.student_name || '학생'} 새 출석번호: ${code} · 학생에게 직접 전달하세요. 화면을 새로고침하면 다시 볼 수 없습니다.`;
      }
    }, (error) => `출석번호를 발급하지 못했습니다. 새 번호는 표시되지 않았으니 다시 시도해 주세요. (${error?.message || '알 수 없는 오류'})`,
    () => state.secretEpoch === epoch); }));
    card.append(actions);
    return card;
  }

  function failedCard(message) {
    const card = el('article', 'card attendance-card');
    card.append(el('h4', '', message.student_name || '학생'));
    card.append(el('p', '', `${MESSAGE_COPY[message.message_type] || message.message_type} 알림 실패 · ${message.failure_code || ''}`));
    card.append(el('p', 'meta', '문자 대체발송은 하지 않습니다. 전화 등으로 직접 연락한 뒤 기록하세요.'));
    const actions = el('div', 'attendance-actions');
    actions.append(button('수동 연락 완료', () => mutate('admin_record_message_manual_followup', { p_message_id: message.id, p_note: null }, '수동 연락 완료를 기록했습니다. 원래 알림은 실패 상태로 보존됩니다.')));
    card.append(actions);
    return card;
  }

  // Parent messages drafted while their template was unapproved. Each is approved (queued) or
  // cancelled individually; the mutation reloads the whole snapshot so every count stays in sync.
  function messageDraftCard(message) {
    const card = el('article', 'card attendance-card');
    card.append(el('h4', '', message.student_name || '학생'));
    card.append(el('p', '', `${MESSAGE_COPY[message.message_type] || message.message_type} 알림 ${MESSAGE_STATUS_COPY[message.status] || message.status}`));
    const meta = [message.created_at ? kstSlot(message.created_at) + ' 생성' : '', message.recipient_label ? '수신: ' + message.recipient_label : ''].filter(Boolean).join(' · ');
    if (meta) card.append(el('p', 'meta', meta));
    if (message.template_approved === false) card.append(el('p', 'attendance-private-note', '템플릿 승인 필요 · 아래 알림 템플릿을 먼저 승인하세요.'));
    const actions = el('div', 'attendance-actions');
    actions.append(button('승인 후 발송', () => mutate('admin_approve_parent_message', { p_message_id: message.id }, '알림을 승인해 발송 대기열에 넣었습니다.'), 'small'));
    actions.append(button('발송 안 함', () => mutate('admin_cancel_parent_message', { p_message_id: message.id, p_expected_status: message.status }, '알림을 발송하지 않도록 취소했습니다.')));
    card.append(actions);
    return card;
  }

  function draftCard(batch) {
    const card = el('article', 'card attendance-card');
    card.append(el('h4', '', batch.student_name || '학생'));
    card.append(el('p', 'meta', batch.origin === 'planned_absence' ? '사전 결석 보강 안내 · 원장 확인 후 발송' : '결석 보강 안내'));
    const options = Array.isArray(batch.options) ? batch.options : [];
    const list = el('ol', 'today-ops-options');
    list.append(...options.map((option) => el('li', '', kstSlot(option.starts_at))));
    card.append(list);
    const actions = el('div', 'attendance-actions');
    if (batch.status === 'draft' && options.length === 3) {
      actions.append(button('보강 안내 발송', () => mutate('admin_send_makeup_offer', { p_batch_id: batch.batch_id }, '보강 안내를 발송 대기열에 넣었습니다. 선택은 오늘(한국시간) 자정까지 가능합니다.'), 'small'));
    } else {
      card.append(el('p', 'attendance-private-note', '정원 내 보강 가능시간 3개를 찾지 못했습니다 · 직접 연락 필요'));
    }
    card.append(actions);
    return card;
  }

  function render() {
    const model = buildOperationsBuckets(state.snapshot, now());
    state.model = model;
    if (!state.filter || !BUCKET_ORDER.includes(state.filter)) {
      state.filter = BUCKET_ORDER.find((key) => model.counts[key] > 0) || 'scheduled';
    }
    byId('todayOpsCounts').replaceChildren(...BUCKET_ORDER.map((key) => {
      const node = el('button', 'admin-stat today-ops-stat');
      node.type = 'button';
      node.dataset.bucket = key;
      node.setAttribute('aria-pressed', String(state.filter === key));
      node.append(el('span', 'today-ops-count', String(model.counts[key])), el('small', '', BUCKET_COPY[key]));
      node.addEventListener('click', () => { state.filter = key; render(); });
      return node;
    }));
    const rows = model.lists[state.filter] || [];
    const cards = rows.map((row) => {
      if (state.filter === 'message_failed') return failedCard(row);
      if (state.filter === 'message_draft') return messageDraftCard(row);
      if (state.filter === 'planned_absence_drafts' || state.filter === 'makeup_followup') return draftCard(row);
      return sessionCard(row);
    });
    byId('todayOpsList').replaceChildren(...cards);
    byId('todayOpsEmpty').hidden = cards.length > 0;
    const queue = BUCKET_QUEUE[state.filter];
    const meta = queue ? state.snapshot?.queues?.[queue] : null;
    byId('todayOpsMore').hidden = !(meta && meta.has_more === true && typeof meta.next_cursor === 'string');
  }

  // ── keyset "더 보기" for paged unresolved queues ─────────────────────────
  byId('todayOpsMore').addEventListener('click', async () => {
    const queue = BUCKET_QUEUE[state.filter];
    const base = state.snapshot;
    const cursor = base?.queues?.[queue]?.next_cursor;
    if (!queue || typeof cursor !== 'string' || state.busy || !active()) return;
    state.busy = true;
    byId('todayOpsMore').disabled = true;
    try {
      const { data, error } = await client.rpc('admin_operations_queue_page', { p_queue: queue, p_cursor: cursor });
      if (error) throw error;
      // A full refresh that landed meanwhile already reset the pages; drop this stale page.
      if (active() && state.snapshot === base) {
        state.snapshot = mergeQueuePage(base, queue, data);
        render();
      }
    } catch (error) {
      if (active()) byId('todayOpsResult').textContent = mutationErrorCopy(error);
    } finally {
      state.busy = false;
      byId('todayOpsMore').disabled = false;
    }
  });

  // ── action form (exceptions + manual fallback) ───────────────────────────
  const ACTIONS = {
    expected_late: { title: '사전 지각 등록', time: '예상 등원 시각', timeRequired: false, reason: '내부 메모 (선택)', reasonRequired: false, category: true },
    planned_absence: { title: '사전 결석 등록 · 보강 3개 초안 생성', time: null, reason: '내부 메모 (선택)', reasonRequired: false, category: true },
    manual_arrival: { title: '수동 등원 (실제 도착 시각)', time: '실제 도착 시각', timeRequired: true, reason: '수동 처리 사유', reasonRequired: true, category: false },
    manual_checkout: { title: '수동 하원 (실제 하원 시각)', time: '실제 하원 시각', timeRequired: true, reason: '수동 처리 사유', reasonRequired: true, category: false },
  };
  function openAction(kind, row, trigger) {
    const spec = ACTIONS[kind];
    state.action = { kind, row };
    state.trigger = trigger;
    byId('todayOpsActionTitle').textContent = `${row.student_name || '학생'} · ${spec.title}`;
    byId('todayOpsTimeLabel').hidden = !spec.time;
    if (spec.time) byId('todayOpsTimeCaption').textContent = spec.time;
    byId('todayOpsTime').value = spec.time ? localInputValue(now()) : '';
    byId('todayOpsCategoryLabel').hidden = !spec.category;
    byId('todayOpsCategory').value = '';
    byId('todayOpsReasonCaption').textContent = spec.reason;
    byId('todayOpsReason').value = '';
    byId('todayOpsActionForm').hidden = false;
    (spec.time ? byId('todayOpsTime') : byId(spec.category ? 'todayOpsCategory' : 'todayOpsReason')).focus();
  }
  function closeAction() {
    byId('todayOpsActionForm').hidden = true;
    const trigger = state.trigger;
    state.action = null;
    state.trigger = null;
    if (trigger && document.contains(trigger)) trigger.focus();
  }
  byId('todayOpsActionCancel').addEventListener('click', closeAction);
  byId('todayOpsActionForm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeAction(); }
  });
  byId('todayOpsActionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.action) return;
    const { kind, row } = state.action;
    const spec = ACTIONS[kind];
    const timeValue = byId('todayOpsTime').value;
    const time = timeValue ? new Date(timeValue) : null;
    const reason = byId('todayOpsReason').value.trim();
    if (spec.timeRequired && (!time || Number.isNaN(time.getTime()))) { byId('todayOpsResult').textContent = '시각을 입력해 주세요.'; return; }
    if (spec.reasonRequired && !reason) { byId('todayOpsResult').textContent = '사유를 입력해 주세요.'; return; }
    const category = byId('todayOpsCategory').value || null;
    const calls = {
      expected_late: ['admin_set_attendance_exception', { p_attendance_id: row.attendance_id, p_exception_type: 'expected_late', p_expected_arrival_at: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null, p_reason_category: category, p_internal_note: reason }, '사전 지각을 등록했습니다. 지각·출석 미확인 자동 알림이 제외됩니다.'],
      planned_absence: ['admin_set_attendance_exception', { p_attendance_id: row.attendance_id, p_exception_type: 'planned_absence', p_expected_arrival_at: null, p_reason_category: category, p_internal_note: reason }, '사전 결석을 등록했습니다. 보강 안내는 초안으로만 만들어졌습니다.'],
      manual_arrival: ['admin_record_manual_arrival', { p_attendance_id: row.attendance_id, p_arrived_at: time?.toISOString(), p_reason: reason }, '수동 등원을 기록했습니다.'],
      manual_checkout: ['admin_record_manual_checkout', { p_attendance_id: row.attendance_id, p_checked_out_at: time?.toISOString(), p_reason: reason, p_expected_checked_out_at: row.checked_out_at ?? null }, '하원 시각을 기록했습니다.'],
    };
    const [fn, args, copy] = calls[kind];
    const done = await mutate(fn, args, copy);
    if (done) closeAction();
  });

  // ── learning-plan device assignment (account-unlinked students only) ─────
  async function listDevices() {
    const { data, error } = await client.rpc('admin_list_devices');
    if (error) throw error;
    return objectRows(data);
  }
  async function openDeviceAssign(row, trigger) {
    state.deviceAssign = { row };
    state.deviceTrigger = trigger;
    const select = byId('todayOpsDeviceAssignSelect');
    byId('todayOpsDeviceAssignTitle').textContent = `${row.student_name || '학생'} · 학습 태블릿 배정`;
    select.replaceChildren();
    byId('todayOpsDeviceAssignEmpty').hidden = true;
    byId('todayOpsDeviceAssignSubmit').disabled = true;
    byId('todayOpsDeviceAssign').hidden = false;
    let devices;
    try {
      devices = await listDevices();
    } catch (error) {
      if (active() && state.deviceAssign?.row === row) byId('todayOpsResult').textContent = mutationErrorCopy(error);
      return;
    }
    if (!active() || state.deviceAssign?.row !== row) return;
    const usable = devices.filter((d) => d.device_kind === 'learning_plan' && d.status === 'active' && typeof d.id === 'string');
    select.replaceChildren(...usable.map((device) => {
      const assignment = isObject(device.assignment) ? device.assignment : null;
      const suffix = !assignment ? ''
        : assignment.attendance_id === row.attendance_id ? ' (현재 배정)'
          : ` (사용 중: ${assignment.student_name || '다른 학생'} · 배정하면 해제됨)`;
      const option = el('option', '', `${device.device_name || '학습 태블릿'}${suffix}`);
      option.value = device.id;
      return option;
    }));
    byId('todayOpsDeviceAssignEmpty').hidden = usable.length > 0;
    byId('todayOpsDeviceAssignSubmit').disabled = usable.length === 0;
    (usable.length ? select : byId('todayOpsDeviceAssignCancel')).focus();
  }
  function closeDeviceAssign() {
    byId('todayOpsDeviceAssign').hidden = true;
    byId('todayOpsDeviceAssignSelect').replaceChildren();
    const trigger = state.deviceTrigger;
    state.deviceAssign = null;
    state.deviceTrigger = null;
    if (trigger && document.contains(trigger)) trigger.focus();
  }
  byId('todayOpsDeviceAssignCancel').addEventListener('click', closeDeviceAssign);
  byId('todayOpsDeviceAssign').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeDeviceAssign(); }
  });
  byId('todayOpsDeviceAssign').addEventListener('submit', async (event) => {
    event.preventDefault();
    const row = state.deviceAssign?.row;
    const deviceId = byId('todayOpsDeviceAssignSelect').value;
    if (!row || !deviceId) { byId('todayOpsResult').textContent = '배정할 학습계획 태블릿을 선택해 주세요.'; return; }
    const done = await mutate('admin_assign_learning_device', { p_device_id: deviceId, p_attendance_id: row.attendance_id }, '학습 태블릿을 배정했습니다. 하원하면 자동으로 해제됩니다.');
    if (done) closeDeviceAssign();
  });

  // ── learning plan panel ──────────────────────────────────────────────────
  async function loadPlans() {
    const student = state.planStudent;
    if (!student) return;
    const { data, error } = await client.from('daily_learning_plans')
      .select('id,status,source_revision,created_via,new_progress_approved_at,daily_learning_plan_items(id,item_type,title,student_status,teacher_status,sort_order)')
      .eq('student_id', student.student_id).eq('plan_date', kstDay(now())).order('source_revision');
    if (state.planStudent !== student) return;
    if (error) { byId('todayOpsPlanCurrent').replaceChildren(el('p', 'error', error.message)); return; }
    state.plans = Array.isArray(data) ? data : [];
    const published = state.plans.find((plan) => plan.status === 'published');
    const drafts = state.plans.filter((plan) => plan.status === 'draft');
    const nodes = [];
    if (published) {
      nodes.push(el('p', 'meta', `발행본 r${published.source_revision}${published.new_progress_approved_at ? ' · 새 진도 승인됨' : ''}`));
      const list = el('ol', 'today-ops-plan-items');
      list.append(...planItems(published).map((item) => {
        const li = el('li', '', `${itemLabel(item)} · ${item.teacher_status === 'confirmed' ? '확인 완료' : item.student_status === 'submitted' ? '완료 제출' : '진행 전'}`);
        if (item.student_status === 'submitted' && item.teacher_status !== 'confirmed' && item.item_type !== 'note') {
          li.append(button('확인 완료', async () => { await mutate('admin_confirm_learning_item', { p_item_id: item.id }, '교사 확인을 기록했습니다.'); await loadPlans(); }));
        }
        return li;
      }));
      nodes.push(list);
    } else {
      nodes.push(el('p', 'meta', '발행된 학습계획이 없습니다. 학생 화면에는 “오늘 계획 준비 중”이 표시됩니다.'));
    }
    byId('todayOpsPlanCurrent').replaceChildren(...nodes);
    // Latest unpublished draft (automatic or owner-written): show what would be published.
    const draft = drafts.at(-1);
    const draftNodes = [];
    if (draft) {
      draftNodes.push(el('p', 'meta', `미발행 초안 r${draft.source_revision}${draft.created_via === 'system' ? ' · 등원 시 자동 생성' : ''} · 발행 전에는 학생에게 보이지 않습니다.`));
      const list = el('ol', 'today-ops-plan-items');
      list.append(...planItems(draft).map((item) => el('li', '', itemLabel(item))));
      draftNodes.push(list);
    }
    byId('todayOpsPlanDraft').replaceChildren(...draftNodes);
    byId('todayOpsPlanPublish').disabled = drafts.length === 0;
    byId('todayOpsPlanApprove').disabled = !published || Boolean(published.new_progress_approved_at);
    byId('todayOpsPlanRegenerate').disabled = !student.attendance_id;
  }

  // ── next-progress queue (admin RLS read; writes via RPC only) ────────────
  async function loadProgressTargets() {
    const student = state.planStudent;
    if (!student) return;
    const { data, error } = await client.from('student_progress_targets')
      .select('id,sequence,title,status')
      .eq('student_id', student.student_id).eq('status', 'queued').order('sequence');
    if (state.planStudent !== student) return;
    if (error) { byId('todayOpsProgressCurrent').replaceChildren(el('p', 'error', error.message)); return; }
    const queued = Array.isArray(data) ? data.filter((t) => t && typeof t === 'object') : [];
    const cancel = (target) => button('취소', async () => {
      const done = await mutate('admin_cancel_progress_target', { p_target_id: target.id }, '대기 진도를 취소했습니다. 이미 만든 초안은 다시 만들어야 반영됩니다.');
      if (done) await loadProgressTargets();
    });
    const [current, ...rest] = queued;
    if (current) {
      const p = el('p', '', `다음 자동 초안 진도: ${current.title}`);
      p.append(cancel(current));
      byId('todayOpsProgressCurrent').replaceChildren(p);
    } else {
      byId('todayOpsProgressCurrent').replaceChildren(el('p', 'meta', '대기 중인 다음 진도가 없습니다. 자동 초안에는 “다음 진도를 입력·확인” 메모만 들어갑니다.'));
    }
    byId('todayOpsProgressList').replaceChildren(...rest.map((target) => {
      const li = el('li', '', target.title);
      li.append(cancel(target));
      return li;
    }));
    byId('todayOpsProgressMore').hidden = rest.length === 0;
  }

  function openPlan(row) {
    state.planStudent = row;
    byId('todayOpsPlanTitle').textContent = `${row.student_name || '학생'} · 오늘 학습계획`;
    byId('todayOpsPlanLines').value = '';
    byId('todayOpsProgressInput').value = '';
    byId('todayOpsPlanManual').open = false;
    byId('todayOpsProgressMore').open = false;
    byId('todayOpsPlanPanel').hidden = false;
    byId('todayOpsPlanTitle').setAttribute('tabindex', '-1');
    byId('todayOpsPlanTitle').focus();
    loadPlans();
    loadProgressTargets();
  }
  byId('todayOpsProgressForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const student = state.planStudent;
    const title = byId('todayOpsProgressInput').value.trim();
    if (!student || !title) { byId('todayOpsResult').textContent = '다음 진도 내용을 입력해 주세요.'; return; }
    const done = await mutate('admin_enqueue_progress_target', { p_student_id: student.student_id, p_title: title.slice(0, 200), p_body: '' }, '다음 진도를 대기열에 추가했습니다. 발행할 때 한 번만 사용됩니다.');
    if (done) { byId('todayOpsProgressInput').value = ''; await loadProgressTargets(); }
  });
  byId('todayOpsPlanRegenerate').addEventListener('click', async () => {
    const student = state.planStudent;
    if (!student?.attendance_id) return;
    const latest = state.plans.reduce((max, plan) => Math.max(max, Number(plan.source_revision) || 0), 0);
    const done = await mutate('admin_regenerate_learning_plan', { p_attendance_id: student.attendance_id, p_expected_revision: latest },
      (result) => `현재 숙제·재풀이·이월·다음 진도로 새 초안${result?.revision ? ` r${result.revision}` : ''}을 만들었습니다. 발행 전에는 학생에게 보이지 않습니다.`);
    if (done) await loadPlans();
  });
  byId('todayOpsPlanClose').addEventListener('click', () => { byId('todayOpsPlanPanel').hidden = true; state.planStudent = null; });
  byId('todayOpsPlanSave').addEventListener('click', async () => {
    const student = state.planStudent;
    const items = parsePlanLines(byId('todayOpsPlanLines').value);
    if (!student || !items.length) { byId('todayOpsResult').textContent = '학습계획 항목을 한 줄 이상 입력해 주세요.'; return; }
    const done = await mutate('admin_save_learning_plan_draft', { p_student_id: student.student_id, p_plan_date: kstDay(now()), p_class_session_id: student.class_session_id ?? null, p_items: items, p_owner_note: '' }, '초안을 저장했습니다. 발행 전에는 학생에게 보이지 않습니다.');
    if (done) { byId('todayOpsPlanLines').value = ''; await loadPlans(); }
  });
  byId('todayOpsPlanPublish').addEventListener('click', async () => {
    const draft = state.plans.filter((plan) => plan.status === 'draft').at(-1);
    if (!draft) return;
    await mutate('admin_publish_learning_plan', { p_plan_id: draft.id, p_expected_revision: draft.source_revision }, '학습계획을 발행했습니다. 학생 태블릿에 최신본이 표시됩니다.');
    await loadPlans();
    await loadProgressTargets();
  });
  byId('todayOpsPlanApprove').addEventListener('click', async () => {
    const published = state.plans.find((plan) => plan.status === 'published');
    if (!published) return;
    await mutate('admin_approve_new_progress', { p_plan_id: published.id }, '남은 항목을 확인하고 새 진도 시작을 승인했습니다.');
    await loadPlans();
  });

  // ── setup: class sessions and kiosk devices ──────────────────────────────
  async function loadTemplates() {
    const { data, error } = await client.from('message_templates').select('template_code,message_type,body,approved').order('template_code');
    if (error) { byId('todayOpsResult').textContent = error.message; return; }
    byId('todayOpsTemplates').replaceChildren(...(Array.isArray(data) ? data : []).map((template) => {
      const li = el('li', '');
      li.append(el('strong', '', MESSAGE_COPY[template.message_type] || template.message_type), el('pre', 'today-ops-template-body', template.body));
      if (template.approved) li.append(el('span', 'meta', '승인됨'));
      else li.append(button('템플릿 승인', async () => { await mutate('admin_approve_message_template', { p_template_code: template.template_code }, '템플릿을 승인했습니다.'); await loadTemplates(); }));
      return li;
    }));
  }
  async function loadDevices() {
    let devices;
    try {
      devices = await listDevices();
    } catch (error) {
      if (active()) byId('todayOpsResult').textContent = mutationErrorCopy(error);
      return;
    }
    if (!active()) return;
    // Name, kind, status, last seen and current assignment only; the list RPC never returns token hashes.
    byId('todayOpsDeviceList').replaceChildren(...devices.map((device) => {
      const assignment = device.device_kind === 'learning_plan' && isObject(device.assignment) ? device.assignment : null;
      const parts = [
        device.device_name || '기기',
        DEVICE_KIND_COPY[device.device_kind] || '기기',
        device.status === 'active' ? '사용 중' : '해지됨',
        device.last_seen_at ? `마지막 연결 ${kstSlot(device.last_seen_at)}` : '연결 기록 없음',
      ];
      if (assignment) parts.push(`${assignment.student_name || '학생'} 배정 중`);
      const li = el('li', 'today-ops-device device-kind-' + (device.device_kind === 'learning_plan' ? 'learning-plan' : 'kiosk'), parts.join(' · '));
      if (device.status === 'active' && typeof device.id === 'string') {
        const fn = device.device_kind === 'learning_plan' ? 'admin_revoke_learning_plan_device' : 'admin_revoke_kiosk_device';
        li.append(button('기기 해지', () => mutate(fn, { p_device_id: device.id }, '기기를 해지했습니다. 이 기기의 등록 코드는 더 이상 쓸 수 없습니다.', () => loadDevices())));
      }
      return li;
    }));
    byId('todayOpsDeviceListEmpty').hidden = devices.length > 0;
  }
  byId('todayOpsSetup').addEventListener('toggle', async () => {
    if (!byId('todayOpsSetup').open) {
      // The one-time learning-plan device token never outlives the setup panel.
      byId('todayOpsLearningDeviceToken').textContent = '';
      return;
    }
    loadTemplates();
    loadDevices();
    const { data, error } = await client.from('class_groups').select('id,name').eq('is_active', true).order('name');
    if (error) { byId('todayOpsResult').textContent = error.message; return; }
    byId('todayOpsSessionGroup').replaceChildren(...(Array.isArray(data) ? data : []).map((group) => {
      const option = el('option', '', group.name);
      option.value = group.id;
      return option;
    }));
  });
  byId('todayOpsSessionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const start = new Date(byId('todayOpsSessionStart').value);
    const end = new Date(byId('todayOpsSessionEnd').value);
    const group = byId('todayOpsSessionGroup').value;
    if (!group || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) { byId('todayOpsResult').textContent = '반·시작·종료 시각을 확인해 주세요.'; return; }
    await mutate('admin_create_class_session', { p_class_group_id: group, p_starts_at: start.toISOString(), p_ends_at: end.toISOString(), p_capacity: Number(byId('todayOpsSessionCapacity').value) || 8 }, '수업 회차와 재원생 출결 예정을 만들었습니다.');
  });
  byId('todayOpsDeviceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = byId('todayOpsDeviceName').value.trim();
    if (!name) { byId('todayOpsResult').textContent = '기기 이름을 입력해 주세요.'; return; }
    byId('todayOpsDeviceToken').textContent = '';
    await mutate('admin_register_kiosk_device', { p_device_name: name }, '출석 기기를 등록했습니다.', (token) => {
      if (typeof token === 'string') byId('todayOpsDeviceToken').textContent = `등록 코드(한 번만 표시): ${token}`;
    });
  });
  byId('todayOpsLearningDeviceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = byId('todayOpsLearningDeviceName').value.trim();
    if (!name) { byId('todayOpsResult').textContent = '기기 이름을 입력해 주세요.'; return; }
    byId('todayOpsLearningDeviceToken').textContent = '';
    await mutate('admin_register_learning_plan_device', { p_device_name: name }, '학습계획 태블릿을 등록했습니다. 등록 코드는 지금 한 번만 표시됩니다.', (token) => {
      if (typeof token === 'string' && DEVICE_TOKEN_PATTERN.test(token)) {
        byId('todayOpsLearningDeviceToken').textContent = `등록 코드(한 번만 표시): ${token} · 학습계획 태블릿에서 /plan/ 화면을 열어 붙여 넣으세요. 이 패널을 닫으면 다시 볼 수 없습니다.`;
      }
      byId('todayOpsLearningDeviceName').value = '';
      loadDevices();
    });
  });

  // ── recurring timetable (RPC only) ───────────────────────────────────────
  const scheduleFields = ['Weekday', 'Start', 'Duration', 'Capacity', 'Late', 'Missing', 'From', 'To'].map((name) => 'todayOpsSchedule' + name);
  function resetScheduleForm() {
    state.scheduleEdit = null;
    byId('todayOpsScheduleGroup').disabled = false;
    byId('todayOpsScheduleSubmit').textContent = '시간표 추가';
    byId('todayOpsScheduleCancelEdit').hidden = true;
  }
  function scheduleText(group, row) {
    const range = `${row.effective_from}부터${row.effective_to ? ` ${row.effective_to}까지` : ''}`;
    return `${group.name} · ${WEEKDAY_COPY[row.iso_weekday] || row.iso_weekday}요일 ${row.local_start_time} · ${row.duration_minutes}분 · 정원 ${row.capacity} · ${range}`;
  }
  async function loadSchedules() {
    const { data, error } = await client.rpc('admin_list_class_schedules');
    if (!active()) return;
    if (error) { byId('todayOpsResult').textContent = error.message; return; }
    const groups = Array.isArray(data?.groups) ? data.groups.filter((g) => g && typeof g === 'object') : [];
    state.schedules = groups;
    const select = byId('todayOpsScheduleGroup');
    const selected = select.value;
    select.replaceChildren(...groups.map((group) => {
      const option = el('option', '', group.name);
      option.value = group.id;
      return option;
    }));
    if (groups.some((g) => g.id === selected)) select.value = selected;
    const items = groups.flatMap((group) => (Array.isArray(group.schedules) ? group.schedules : []).map((row) => {
      const li = el('li', '', scheduleText(group, row));
      li.append(button('수정', () => {
        state.scheduleEdit = { id: row.id, revision: row.revision };
        select.value = group.id;
        select.disabled = true;
        const values = [row.iso_weekday, row.local_start_time, row.duration_minutes, row.capacity, row.late_after_minutes, row.missing_after_minutes, row.effective_from, row.effective_to ?? ''];
        scheduleFields.forEach((id, index) => { byId(id).value = String(values[index] ?? ''); });
        byId('todayOpsScheduleSubmit').textContent = '시간표 수정 저장';
        byId('todayOpsScheduleCancelEdit').hidden = false;
        byId('todayOpsScheduleStart').focus();
      }));
      li.append(button('중지', async () => {
        const done = await mutate('admin_deactivate_class_schedule', { p_schedule_id: row.id, p_expected_revision: row.revision }, '시간표를 중지했습니다. 아직 시작하지 않은 자동 생성 수업은 취소됐습니다.');
        if (done) { if (state.scheduleEdit?.id === row.id) resetScheduleForm(); await loadSchedules(); }
      }));
      return li;
    }));
    byId('todayOpsScheduleList').replaceChildren(...items);
    byId('todayOpsScheduleEmpty').hidden = items.length > 0;
  }
  byId('todayOpsSchedules').addEventListener('toggle', () => {
    if (byId('todayOpsSchedules').open) loadSchedules();
  });
  byId('todayOpsScheduleCancelEdit').addEventListener('click', resetScheduleForm);
  byId('todayOpsScheduleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const int = (id) => (/^\d+$/.test(byId(id).value.trim()) ? Number(byId(id).value.trim()) : NaN);
    const weekday = int('todayOpsScheduleWeekday');
    const start = byId('todayOpsScheduleStart').value.trim();
    const duration = int('todayOpsScheduleDuration');
    const from = byId('todayOpsScheduleFrom').value;
    const to = byId('todayOpsScheduleTo').value || null;
    const group = byId('todayOpsScheduleGroup').value;
    if (!group || !(weekday >= 1 && weekday <= 7) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !Number.isInteger(duration) || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      byId('todayOpsResult').textContent = SCHEDULE_INVALID_COPY;
      return;
    }
    const fields = {
      p_iso_weekday: weekday, p_local_start_time: start, p_duration_minutes: duration,
      p_capacity: int('todayOpsScheduleCapacity'), p_late_after_minutes: int('todayOpsScheduleLate'), p_missing_after_minutes: int('todayOpsScheduleMissing'),
      p_effective_from: from, p_effective_to: to,
    };
    const edit = state.scheduleEdit;
    const done = edit
      ? await mutate('admin_update_class_schedule', { p_schedule_id: edit.id, p_expected_revision: edit.revision, ...fields }, '시간표를 수정했습니다. 아직 만들어지지 않은 날짜부터 적용됩니다.')
      : await mutate('admin_create_class_schedule', { p_class_group_id: group, ...fields }, '시간표를 추가했습니다. 오늘·내일 수업은 다음 자동 실행(5분 이내)에 만들어집니다.');
    if (done) { resetScheduleForm(); await loadSchedules(); }
  });
  byId('todayOpsRunTick').addEventListener('click', () => mutate('admin_run_operations_tick', {}, (result) => {
    const generation = result?.generation || {};
    return `시간표를 지금 반영했습니다. 새 수업 ${Number(generation.sessions_created) || 0}개 · 출결 예정 ${Number(generation.records_created) || 0}건.`;
  }));

  byId('todayOpsRefresh').addEventListener('click', () => refresh());
  const ready = refresh();
  function destroy() {
    state.destroyed = true;
    clearSecret();
    byId('todayOpsLearningDeviceToken').textContent = '';
    live.stop();
  }
  return { refresh: () => refresh(), ready, destroy, clearSecret };
}
