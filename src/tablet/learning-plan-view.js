// Renders the published daily learning plan snapshot for the logged-in student.
// Student completion is only "submitted"; teacher confirmation is final.
import { orderPlanItems } from '../portal/learning-plan.js';

const TYPE_COPY = {
  homework: '미제출 숙제', redo: '재풀이', carryover: '지난 수업 이어하기',
  auto_progress: '오늘 진도', mathflat: '매쓰플랫', note: '오늘 확인',
};
const FN = 'student_today_learning_plan';

export function isLearningPlanBackendMissing(error) {
  if (!error || typeof error.message !== 'string') return false;
  if (error.code === 'PGRST202') return error.message.includes('public.' + FN);
  if (error.code === '42883') return error.message.includes('public.' + FN + '(');
  return false;
}

function stateCopy(item) {
  if (item.teacher_status === 'confirmed') return '확인 완료';
  if (item.student_status === 'submitted') return '선생님 확인 중';
  if (item.locked) return '선생님 확인 후 시작';
  return '';
}

export function clearLearningPlan(document) {
  const section = document.getElementById('todayPlan');
  document.getElementById('todayPlanItems')?.replaceChildren();
  const warning = document.getElementById('todayPlanWarning');
  const status = document.getElementById('todayPlanStatus');
  if (warning) warning.textContent = '';
  if (status) status.textContent = '';
  if (section) section.hidden = true;
}

export function renderLearningPlan(document, view, { onSubmit } = {}) {
  const list = document.getElementById('todayPlanItems');
  const warning = document.getElementById('todayPlanWarning');
  const status = document.getElementById('todayPlanStatus');
  list.replaceChildren();
  warning.textContent = '';
  if (view?.status !== 'ready') {
    status.textContent = view?.status === 'unlinked'
      ? '학습계획은 원장님이 계정을 연결한 뒤 표시됩니다.'
      : '오늘 계획 준비 중 · 매쓰플랫 먼저 시작';
    return;
  }
  status.textContent = '';
  const remaining = Number.isInteger(view.remaining_priority_count) ? view.remaining_priority_count : 0;
  if (remaining > 0) {
    warning.textContent = view.new_progress_approved
      ? `먼저 확인할 숙제·재풀이가 ${remaining}건 남아 있어요. 선생님이 새 진도를 승인했어요.`
      : `먼저 확인할 숙제·재풀이가 ${remaining}건 남아 있어요. 선생님 확인 후 새 진도를 시작해요.`;
  }
  const rank = new Map((Array.isArray(view.items) ? view.items : []).map((item, index) => [item, Number.isInteger(item?.sort_order) ? item.sort_order : index]));
  const items = orderPlanItems(view.items).sort((a, b) => rank.get(a) - rank.get(b));
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.className = 'plan-item plan-item-' + item.item_type;
    li.dataset.itemType = item.item_type;
    const kind = document.createElement('span');
    kind.className = 'plan-item-kind';
    kind.textContent = TYPE_COPY[item.item_type];
    const title = document.createElement('strong');
    title.textContent = item.title;
    li.append(kind, title);
    if (typeof item.body === 'string' && item.body) {
      const body = document.createElement('p');
      body.textContent = item.body;
      li.append(body);
    }
    const state = document.createElement('span');
    state.className = 'plan-item-state';
    state.textContent = stateCopy(item);
    li.append(state);
    const canSubmit = item.item_type !== 'note' && item.student_status !== 'submitted' && item.teacher_status !== 'confirmed';
    if (canSubmit) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'plan-item-submit';
      button.textContent = '완료 제출';
      button.disabled = item.locked === true;
      button.addEventListener('click', () => {
        if (button.disabled) return;
        button.disabled = true;
        onSubmit?.(item.id);
      });
      li.append(button);
    }
    return li;
  }));
}

// Owns plan reads/submits for one signed-in student. reset() (logout/session change) bumps the
// session generation so any in-flight RPC that resolves afterwards cannot touch the DOM or reload.
export function createLearningPlanController(document, { loadPlan, submitItem, currentUser = () => null }) {
  let session = 0;
  let request = 0;
  const owner = () => ({ session, user: currentUser() });
  const isOwner = (claim) => claim.session === session && claim.user === currentUser();
  const byId = (id) => document.getElementById(id);

  async function load() {
    const claim = owner();
    const mine = ++request;
    let result;
    try { result = await loadPlan(); } catch (error) { result = { error }; }
    if (mine !== request || !isOwner(claim)) return;
    const { data, error } = result || {};
    if (error) {
      if (isLearningPlanBackendMissing(error)) { byId('todayPlan').hidden = true; return; }
      byId('todayPlan').hidden = false;
      byId('todayPlanItems').replaceChildren();
      byId('todayPlanWarning').textContent = '';
      byId('todayPlanStatus').textContent = '학습계획을 불러오지 못했습니다. 선생님께 알려 주세요.';
      return;
    }
    byId('todayPlan').hidden = false;
    renderLearningPlan(document, data, { onSubmit: submit });
  }

  async function submit(itemId) {
    const claim = owner();
    let error = null;
    try { ({ error } = await submitItem(itemId)); } catch (thrown) { error = thrown; }
    if (!isOwner(claim)) return;
    if (error) {
      byId('todayPlanStatus').textContent = String(error?.message || '').includes('priority items')
        ? '먼저 숙제·재풀이를 선생님께 확인받아요.'
        : '완료 제출에 실패했습니다. 다시 눌러 주세요.';
    }
    await load();
  }

  function reset() {
    session += 1;
    request += 1;
    clearLearningPlan(document);
  }

  return { load, submit, reset };
}
