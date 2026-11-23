// Entrance kiosk UI. The only server call is the injected callKiosk (attendance-code Edge Function).
// Nothing about students, codes, or results is cached on the device.
import { applyKeypadKey, KIOSK_CODE_LENGTH, kioskResultCopy } from './rules.js';

export const DEVICE_TOKEN_KEY = 'sequence.kiosk.deviceToken';
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
const LABELS = { clear: '지우기', back: '←' };
const MODE_COPY = { check_in: '등원', check_out: '하원' };
const NETWORK_COPY = { tone: 'error', title: '연결이 원활하지 않습니다', detail: '선생님께 말하면 직접 출결을 처리해 드립니다.', hint: '' };

export function mountKiosk(document, { callKiosk, storage, resetMs = 12_000 }) {
  const byId = (id) => document.getElementById(id);
  const panels = ['kioskSetup', 'kioskChoice', 'kioskKeypadPanel', 'kioskResult'];
  const state = { action: null, code: '', busy: false, resetTimer: null, lastChoice: null, request: 0 };

  function show(panel) {
    for (const id of panels) byId(id).hidden = id !== panel;
  }
  function token() {
    const value = storage.getItem(DEVICE_TOKEN_KEY);
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
  }
  function renderCode() {
    byId('kioskCodeDisplay').textContent = '●'.repeat(state.code.length) + '○'.repeat(KIOSK_CODE_LENGTH - state.code.length);
    byId('kioskCodeDisplay').setAttribute('aria-label', `${KIOSK_CODE_LENGTH}자리 중 ${state.code.length}자리 입력`);
    byId('kioskSubmit').disabled = state.busy || state.code.length !== KIOSK_CODE_LENGTH;
  }
  function home() {
    state.request += 1; // invalidate any in-flight submission so its late response cannot render
    clearTimeout(state.resetTimer);
    state.resetTimer = null;
    state.action = null;
    state.code = '';
    state.busy = false;
    renderCode();
    if (!token()) {
      show('kioskSetup');
      byId('kioskSetupToken').focus();
      return;
    }
    show('kioskChoice');
    (state.lastChoice ?? byId('kioskCheckIn')).focus();
  }
  function choose(button) {
    state.lastChoice = button;
    state.action = button.dataset.action;
    state.code = '';
    renderCode();
    byId('kioskModeTitle').textContent = `${MODE_COPY[state.action]} · 6자리 번호를 눌러주세요`;
    show('kioskKeypadPanel');
    byId('kioskCodeDisplay').focus();
  }
  function key(value) {
    if (byId('kioskKeypadPanel').hidden || state.busy) return;
    state.code = applyKeypadKey(state.code, value);
    renderCode();
  }
  function showResult(copy) {
    byId('kioskResultTitle').textContent = copy.title;
    byId('kioskResultDetail').textContent = copy.detail;
    byId('kioskResultHint').textContent = copy.hint;
    byId('kioskResult').dataset.tone = copy.tone;
    show('kioskResult');
    byId('kioskResultDone').focus();
    clearTimeout(state.resetTimer);
    state.resetTimer = setTimeout(home, resetMs);
  }
  async function submit() {
    if (state.busy || state.code.length !== KIOSK_CODE_LENGTH || !state.action) return;
    const deviceToken = token();
    if (!deviceToken) { home(); return; }
    const action = state.action;
    const code = state.code;
    const request = ++state.request;
    state.busy = true;
    state.code = '';
    renderCode();
    let copy;
    try {
      const response = await callKiosk(deviceToken, action, code);
      if (request !== state.request) return;
      if (response?.result === 'device_not_registered') storage.removeItem(DEVICE_TOKEN_KEY);
      copy = kioskResultCopy(response, action);
    } catch {
      if (request !== state.request) return;
      copy = NETWORK_COPY;
    }
    state.busy = false;
    showResult(copy);
  }

  byId('kioskKeypad').replaceChildren(...KEYS.map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = LABELS[value] ? 'kiosk-key kiosk-key-action' : 'kiosk-key';
    button.dataset.key = value;
    button.textContent = LABELS[value] ?? value;
    if (value === 'back') button.setAttribute('aria-label', '한 글자 지우기');
    button.addEventListener('click', () => key(value));
    return button;
  }));
  byId('kioskCheckIn').addEventListener('click', (event) => choose(event.currentTarget));
  byId('kioskCheckOut').addEventListener('click', (event) => choose(event.currentTarget));
  byId('kioskSubmit').addEventListener('click', submit);
  byId('kioskBack').addEventListener('click', home);
  byId('kioskResultDone').addEventListener('click', home);
  byId('kioskSetupForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = byId('kioskSetupToken').value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) {
      byId('kioskSetupError').textContent = '등록 코드를 다시 확인해 주세요.';
      return;
    }
    storage.setItem(DEVICE_TOKEN_KEY, value);
    byId('kioskSetupToken').value = '';
    byId('kioskSetupError').textContent = '';
    home();
  });
  document.addEventListener('keydown', (event) => {
    if (byId('kioskKeypadPanel').hidden) return;
    if (/^\d$/.test(event.key) || event.key === 'Backspace') { event.preventDefault(); key(event.key); }
    else if (event.key === 'Escape') { event.preventDefault(); home(); }
    else if (event.key === 'Enter') { event.preventDefault(); submit(); }
  });

  home();
  return { home };
}
