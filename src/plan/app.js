// Dedicated learning-plan device (academy-owned tablet). Read-only.
// Authorization is an admin-issued device token checked server-side; the six-digit attendance
// number is never accepted here. The server returns only the published plan for the attendance the
// device is currently assigned to — no student name or identifiers — and this page never submits,
// completes, or changes anything. Remote text is rendered with textContent only.

export const PLAN_DEVICE_TOKEN_KEY = 'sequence.learningPlan.deviceToken';
export const PLAN_POLL_MS = 30_000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const ITEM_TYPES = new Set(['homework', 'redo', 'carryover', 'auto_progress', 'mathflat', 'note']);
const TYPE_COPY = {
  homework: '숙제', redo: '다시 풀기', carryover: '지난 수업 이어하기',
  auto_progress: '오늘 진도', mathflat: '매쓰플랫', note: '오늘 확인',
};
const STATE_COPY = {
  no_session: { title: '아직 연결된 학습이 없어요', detail: '선생님이 이 태블릿을 배정하면 오늘 계획이 여기에 나타나요.' },
  preparing: { title: '오늘 계획을 준비하고 있어요', detail: '준비가 끝나면 자동으로 보여 드릴게요. 잠시만 기다려 주세요.' },
  error: { title: '잠시 연결이 원활하지 않아요', detail: '자동으로 다시 확인하고 있어요. 계속되면 선생님께 알려 주세요.' },
};
const STALE_NOTE = '연결을 다시 확인하고 있어요. 화면의 계획은 마지막으로 받은 내용이에요.';

function planDateText(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  return match ? `${Number(match[2])}월 ${Number(match[3])}일 학습 계획` : '오늘 학습 계획';
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object' && ITEM_TYPES.has(item.item_type) && typeof item.title === 'string')
    .slice(0, 30);
}

export function mountPlanDevice(document, {
  readPlan,
  storage,
  setInterval: startTimer = (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: stopTimer = (id) => globalThis.clearInterval(id),
  confirm = (message) => (typeof document.defaultView?.confirm === 'function' ? document.defaultView.confirm(message) : true),
  pollMs = PLAN_POLL_MS,
}) {
  const byId = (id) => document.getElementById(id);
  const state = { seq: 0, timer: null, hasPlan: false };

  function token() {
    const value = storage.getItem(PLAN_DEVICE_TOKEN_KEY);
    return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
  }
  function stopPolling() {
    if (state.timer !== null) stopTimer(state.timer);
    state.timer = null;
  }
  function clearPlan() {
    state.hasPlan = false;
    byId('planItems').replaceChildren();
    byId('planNote').textContent = '';
    byId('planDate').textContent = '';
  }
  function showSetup() {
    stopPolling();
    state.seq += 1; // invalidate anything still in flight
    clearPlan();
    byId('planView').hidden = true;
    byId('planSetup').hidden = false;
    byId('planSetupToken').focus();
  }
  function showStatus(kind) {
    const copy = STATE_COPY[kind];
    byId('planStatus').hidden = false;
    byId('planStatus').dataset.state = kind;
    byId('planStatusTitle').textContent = copy.title;
    byId('planStatusDetail').textContent = copy.detail;
  }
  function renderItems(items) {
    byId('planItems').replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      li.className = 'plan-item';
      li.dataset.itemType = item.item_type;
      const kind = document.createElement('span');
      kind.className = 'plan-item-kind';
      kind.textContent = TYPE_COPY[item.item_type];
      const title = document.createElement('strong');
      title.className = 'plan-item-title';
      title.textContent = item.title;
      li.append(kind, title);
      if (typeof item.body === 'string' && item.body) {
        const body = document.createElement('p');
        body.className = 'plan-item-body';
        body.textContent = item.body;
        li.append(body);
      }
      if (item.teacher_status === 'confirmed') {
        const done = document.createElement('span');
        done.className = 'plan-item-state';
        done.textContent = '확인 완료';
        li.append(done);
      }
      return li;
    }));
  }
  function apply(view) {
    byId('planNote').textContent = '';
    if (view?.state === 'ready') {
      const items = cleanItems(view.items);
      byId('planDate').textContent = planDateText(view.plan_date);
      byId('planStatus').hidden = true;
      if (!items.length) { state.hasPlan = false; byId('planItems').replaceChildren(); showStatus('preparing'); return; }
      state.hasPlan = true;
      renderItems(items);
      return;
    }
    clearPlan();
    if (view?.state === 'preparing') {
      byId('planDate').textContent = planDateText(view.plan_date);
      showStatus('preparing');
      return;
    }
    showStatus('no_session');
  }
  function applyFailure() {
    if (state.hasPlan) {
      byId('planNote').textContent = STALE_NOTE;
      return;
    }
    clearPlan();
    showStatus('error');
  }

  async function poll() {
    const deviceToken = token();
    if (!deviceToken) { showSetup(); return; }
    state.seq += 1;
    const seq = state.seq;
    let view;
    try {
      view = await readPlan(deviceToken);
    } catch {
      if (seq === state.seq) applyFailure();
      return;
    }
    // Latest request only: an older response (success or failure) never overwrites a newer one.
    if (seq === state.seq) apply(view);
  }

  function showView({ focus = false } = {}) {
    byId('planSetup').hidden = true;
    byId('planView').hidden = false;
    stopPolling();
    state.timer = startTimer(poll, pollMs);
    poll();
    if (focus) byId('planHeading').focus();
  }

  byId('planSetupForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = byId('planSetupToken');
    const value = input.value.trim().toLowerCase();
    input.value = '';
    if (!TOKEN_PATTERN.test(value)) {
      byId('planSetupError').textContent = '등록 코드를 다시 확인해 주세요.';
      input.focus();
      return;
    }
    byId('planSetupError').textContent = '';
    storage.setItem(PLAN_DEVICE_TOKEN_KEY, value);
    showView({ focus: true });
  });
  byId('planClearDevice').addEventListener('click', () => {
    if (!confirm('이 태블릿의 학습계획 연결을 해제할까요? 다시 쓰려면 새 등록 코드가 필요해요.')) return;
    storage.removeItem(PLAN_DEVICE_TOKEN_KEY);
    showSetup();
  });

  if (token()) showView();
  else showSetup();

  return {
    refresh: poll,
    destroy() {
      state.seq += 1;
      stopPolling();
    },
  };
}
