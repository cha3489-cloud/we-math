// 적용 경로: src/tablet/main.js (태블릿 학생 화면 — 로그인 / PIN 변경 / 오늘의 수학)
// 사진 제출과 과제 상세는 다음 단계에서 추가한다.
import './tablet.css';
import { invokeAuthenticated, supabase } from '../portal/client.js';
import { validateLoginInput, validatePin, authErrorMessage, createLatestRequestGate, STATUS_META, assignmentStatus } from '../portal/domain.js';
import { currentUserOrNull, signIn, signOut } from '../auth.js';
import { todaySections, todaySummary, totalAssignmentCount, dueLabel, applyKeypadInput, maskPin, greeting } from './view-model.js';

const byId = (id) => document.getElementById(id);
const showError = (el, message) => { el.textContent = message || ''; };
const PIN_MAX = 6;

// 오늘 화면은 과제 목록만 읽는다. 제출 본문과 피드백은 다음 단계에서 붙인다.
const TODAY_SELECT = 'id,title,due_at,submissions(id,attempt_no,status,submitted_at)';
const todayGate = createLatestRequestGate();

async function requireStudent(user) {
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', user.id).single();
  if (error || data?.role !== 'student') { await signOut(); throw new Error('학생 계정으로 로그인하세요.'); }
}

function showPanel(name) {
  for (const id of ['login', 'pinChange', 'today']) byId(id).hidden = id !== name;
  byId('logout').hidden = name === 'login';
}

// ── 대형 숫자 키패드 ─────────────────────────────────────────────────────
function buildKeypad(container, onKey) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
  const labels = { clear: '지우기', back: '←' };
  container.replaceChildren(...keys.map((key) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = labels[key] ? 'keypad-key keypad-key-action' : 'keypad-key';
    button.dataset.key = key;
    button.textContent = labels[key] ?? key;
    if (key === 'back') button.setAttribute('aria-label', '한 글자 지우기');
    button.addEventListener('click', () => onKey(key));
    return button;
  }));
}

const pins = { login: '', newPin: '', confirmPin: '' };
const displayOf = { login: 'pinDisplay', newPin: 'newPinDisplay', confirmPin: 'confirmPinDisplay' };
let pinChangeTarget = 'newPin';

function renderPin(field) {
  byId(displayOf[field]).textContent = maskPin(pins[field], PIN_MAX);
}

function focusPinField(field) {
  pinChangeTarget = field;
  byId('newPinDisplay').classList.toggle('pin-display-active', field === 'newPin');
  byId('confirmPinDisplay').classList.toggle('pin-display-active', field === 'confirmPin');
}

// ── 오늘의 수학 ──────────────────────────────────────────────────────────
function assignmentCard(assignment, now) {
  const status = assignmentStatus(assignment, now);
  const meta = STATUS_META[status] ?? { icon: '•', label: status };
  const card = document.createElement('article');
  card.className = 'assignment-card';

  const heading = document.createElement('h3');
  heading.textContent = assignment.title;

  const line = document.createElement('p');
  line.className = 'assignment-meta';
  const statusEl = document.createElement('span');
  statusEl.className = 'assignment-status';
  statusEl.textContent = meta.icon + ' ' + meta.label;
  line.append(statusEl);

  const due = dueLabel(assignment.due_at, now);
  if (due) {
    const dueEl = document.createElement('span');
    dueEl.className = 'assignment-due';
    dueEl.textContent = due;
    line.append(dueEl);
  }

  card.append(heading, line);
  return card;
}

function groupBlock(section, now) {
  const block = document.createElement('section');
  block.className = 'today-group today-group-' + section.key;

  const head = document.createElement('div');
  head.className = 'today-group-head';

  const icon = document.createElement('span');
  icon.className = 'today-group-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = section.icon;

  const text = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = section.title;
  const hint = document.createElement('p');
  hint.textContent = section.hint;
  text.append(title, hint);

  const count = document.createElement('span');
  count.className = 'today-group-count';
  count.textContent = section.count + '건';

  head.append(icon, text, count);

  const cards = document.createElement('div');
  cards.className = 'today-cards';
  cards.append(...section.items.map((item) => assignmentCard(item, now)));

  block.append(head, cards);
  return block;
}

function renderToday(profile, assignments, now = new Date()) {
  const sections = todaySections(assignments, now);
  byId('greeting').textContent = greeting(profile.name);
  byId('todaySummary').textContent = todaySummary(sections);
  byId('emptyState').hidden = totalAssignmentCount(sections) > 0;
  byId('sections').replaceChildren(
    ...sections.filter((section) => section.count).map((section) => groupBlock(section, now)),
  );
}

async function loadToday(user) {
  await requireStudent(user);
  const { data: profile, error: profileError } = await supabase.from('profiles').select('name,must_change_pin').eq('id', user.id).single();
  if (profileError) throw profileError;
  if (profile.must_change_pin) { showPanel('pinChange'); return; }

  // 빠르게 여러 번 조작해도 오래된 응답이 최신 화면을 덮어쓰지 않게 한다.
  const request = todayGate.begin();
  const result = await supabase.from('assignments').select(TODAY_SELECT).eq('student_id', user.id).order('due_at');
  if (!todayGate.isLatest(request)) return;
  if (result.error) throw result.error;
  renderToday(profile, result.data || []);
  showPanel('today');
}

// ── 로그인 ───────────────────────────────────────────────────────────────
buildKeypad(byId('loginKeypad'), (key) => {
  pins.login = applyKeypadInput(pins.login, key, PIN_MAX);
  renderPin('login');
});
renderPin('login');

byId('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = byId('loginSubmit');
  showError(byId('loginError'), '');
  try {
    const input = validateLoginInput(byId('phone').value, pins.login);
    button.disabled = true;
    const result = await signIn(input.phone, input.pin);
    pins.login = '';
    renderPin('login');
    await loadToday(result.user);
  } catch (error) {
    showError(byId('loginError'), authErrorMessage(error));
  } finally {
    button.disabled = false;
  }
});

// ── 첫 로그인 PIN 변경 ───────────────────────────────────────────────────
for (const field of ['newPin', 'confirmPin']) {
  byId(displayOf[field]).addEventListener('click', () => focusPinField(field));
  renderPin(field);
}
focusPinField('newPin');

buildKeypad(byId('pinKeypad'), (key) => {
  pins[pinChangeTarget] = applyKeypadInput(pins[pinChangeTarget], key, PIN_MAX);
  renderPin(pinChangeTarget);
  // 새 PIN을 다 채우면 확인 칸으로 넘어간다.
  if (pinChangeTarget === 'newPin' && pins.newPin.length === PIN_MAX) focusPinField('confirmPin');
});

byId('pinChangeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = byId('pinChangeSubmit');
  showError(byId('pinChangeError'), '');
  try {
    const pin = validatePin(pins.newPin);
    if (pin !== pins.confirmPin) throw new Error('새 PIN이 서로 달라요. 다시 입력해 주세요.');
    button.disabled = true;
    const { data: { user: currentUser }, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    if (!currentUser?.email) throw new Error('다시 로그인하세요.');
    await invokeAuthenticated('change-pin', { pin });
    const result = await signIn(currentUser.email.split('@')[0], pin);
    pins.newPin = '';
    pins.confirmPin = '';
    renderPin('newPin');
    renderPin('confirmPin');
    focusPinField('newPin');
    await loadToday(result.user);
  } catch (error) {
    showError(byId('pinChangeError'), authErrorMessage(error));
  } finally {
    button.disabled = false;
  }
});

// ── 로그아웃 / 세션 복구 ─────────────────────────────────────────────────
byId('logout').addEventListener('click', async () => { await signOut(); location.reload(); });

try {
  const currentUser = await currentUserOrNull();
  if (currentUser) await loadToday(currentUser); else showPanel('login');
} catch (error) {
  showPanel('login');
  showError(byId('loginError'), authErrorMessage(error));
}
