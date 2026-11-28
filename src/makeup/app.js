// Public guardian makeup selection. The signed token is read from the URL fragment only,
// removed from the address bar, and sent to narrow server functions. No free-text schedule entry.
import { kstTimeText } from '../kiosk/rules.js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export function readTokenFromHash(hash) {
  const match = /^#t=([0-9a-f]{64})$/.exec(typeof hash === 'string' ? hash : '');
  return match ? match[1] : null;
}
export function kstDateText(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const kst = new Date(ms + KST_OFFSET_MS);
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`;
}
const slotText = (option) => `${kstDateText(option.starts_at)} ${kstTimeText(option.starts_at)}`;

const STATUS = {
  expired: '선택기한이 종료되었습니다. 학원으로 연락해 주세요.',
  not_found: '유효하지 않은 링크입니다.',
  closed: '이 보강 안내는 더 이상 선택할 수 없습니다. 학원으로 연락해 주세요.',
  full: '방금 선택한 시간은 마감되었습니다. 다른 시간을 선택해 주세요.',
  error: '연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.',
};

export function mountMakeupSelection(document, { hash, replaceState, api }) {
  const byId = (id) => document.getElementById(id);
  const token = readTokenFromHash(hash);
  let busy = false;
  if (typeof replaceState === 'function') replaceState();

  function setStatus(text) { byId('makeupStatus').textContent = text; }
  function closeForm(text) {
    byId('makeupOptions').replaceChildren();
    byId('makeupForm').hidden = true;
    setStatus(text);
  }
  function renderOptions(options) {
    const list = Array.isArray(options) ? options.filter((o) => o && typeof o.id === 'string').slice(0, 3) : [];
    byId('makeupOptions').replaceChildren(...list.map((option) => {
      const label = document.createElement('label');
      label.className = 'makeup-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'option';
      input.value = option.id;
      input.disabled = option.available !== true;
      const text = document.createElement('span');
      text.textContent = slotText(option) + (option.available === true ? '' : ' · 마감');
      label.append(input, text);
      return label;
    }));
    byId('makeupForm').hidden = list.length === 0;
  }
  function renderSelected(slot, finalized = false) {
    closeForm(finalized
      ? `${slotText(slot)} 보강으로 확정되었습니다.`
      : `${slotText(slot)} 선택이 접수되었습니다. 결석 확인 후 보강 일정이 확정됩니다.`);
  }

  async function load() {
    if (!token) { closeForm(STATUS.not_found); return; }
    let view;
    try { view = await api.view(token); } catch { closeForm(STATUS.error); return; }
    if (view?.result === 'selected' && view.selected) { renderSelected(view.selected, view.finalized === true); return; }
    if (view?.result !== 'open') { closeForm(STATUS[view?.result] ?? STATUS.not_found); return; }
    byId('makeupStudent').textContent = typeof view.student_label === 'string' ? `${view.student_label} 학생` : '';
    byId('makeupDeadline').textContent = `선택 기한: ${kstDateText(view.expires_at)} ${kstTimeText(view.expires_at)}까지`;
    renderOptions(view.options);
    setStatus('');
  }

  byId('makeupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const chosen = byId('makeupOptions').querySelector('input[name=option]:checked');
    if (!chosen) { setStatus('보강 시간을 하나 선택해 주세요.'); return; }
    busy = true;
    byId('makeupSubmit').disabled = true;
    try {
      const result = await api.select(token, chosen.value);
      if (result?.result === 'selected') renderSelected(result, result.finalized === true);
      else if (result?.result === 'full') { renderOptions(result.options); setStatus(STATUS.full); }
      else if (result?.result === 'already_selected') setStatus('이미 선택이 완료되었습니다.');
      else closeForm(STATUS[result?.result] ?? STATUS.closed);
    } catch {
      setStatus(STATUS.error);
    } finally {
      busy = false;
      byId('makeupSubmit').disabled = false;
    }
  });

  return load();
}
