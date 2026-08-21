// 적용 경로: src/tablet/main.js (태블릿 학생 화면 — 로그인 / PIN 변경 / 오늘의 수학)
// 사진 제출과 과제 상세는 다음 단계에서 추가한다.
import './tablet.css';
import { invokeAuthenticated, isMissingFeedbackSourceColumn, supabase } from '../portal/client.js';
import { validateLoginInput, validatePin, authErrorMessage, createLatestRequestGate, STATUS_META, assignmentStatus } from '../portal/domain.js';
import { currentUserOrNull, signIn, signOut } from '../auth.js';
import {
  todaySections, todaySummary, totalAssignmentCount, dueLabel, applyKeypadInput, maskPin, greeting,
  assignmentDetail, submissionSummaryLabel, findAssignment,
} from './view-model.js';

const byId = (id) => document.getElementById(id);
const showError = (el, message) => { el.textContent = message || ''; };
const PIN_MAX = 6;

// 첨부 파일과 제출 사진 경로는 아직 다루지 않는다.
// Storage 를 건드리지 않기 위해 select 에서 파일 경로 컬럼을 모두 제외한다.
const FEEDBACK_SELECT = 'feedback(body,auto_composed,created_at,feedback_items(problem_ref,review_tag,comment,redo_required))';
const LEGACY_FEEDBACK_SELECT = 'feedback(body,created_at,feedback_items(problem_ref,review_tag,comment,redo_required))';
const assignmentsSelect = (feedbackSelect) =>
  'id,title,description,due_at,submissions(id,attempt_no,status,submitted_at,' + feedbackSelect + ')';
const todayGate = createLatestRequestGate();

let currentAssignments = [];

async function requireStudent(user) {
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', user.id).single();
  if (error || data?.role !== 'student') { await signOut(); throw new Error('학생 계정으로 로그인하세요.'); }
}

function showPanel(name) {
  for (const id of ['login', 'pinChange', 'today', 'detail']) byId(id).hidden = id !== name;
  byId('logout').hidden = name === 'login';
}

// 화면 전환은 hash 로만 한다. History API 를 쓰면 GitHub Pages 에서
// 새로고침 시 404 가 나므로 사용하지 않는다.
const routeOf = () => {
  const match = String(location.hash || '').match(/^#\/assignment\/(.+)$/);
  return match ? { name: 'detail', id: decodeURIComponent(match[1]) } : { name: 'today' };
};
const goToday = () => { location.hash = '#/today'; };
const goDetail = (id) => { location.hash = '#/assignment/' + encodeURIComponent(id); };

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
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'assignment-card';
  card.dataset.assignmentId = assignment.id;
  card.addEventListener('click', () => goDetail(assignment.id));

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

  const chevron = document.createElement('span');
  chevron.className = 'assignment-go';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';

  card.append(heading, line, chevron);
  return card;
}

// ── 과제 상세 ────────────────────────────────────────────────────────────
function renderMathflat(mathflat) {
  const card = byId('detailMathflat');
  if (!mathflat) { card.hidden = true; return; }
  const fields = byId('detailMathflatFields');
  fields.replaceChildren(...mathflat.fields.flatMap((field) => {
    const term = document.createElement('dt');
    term.textContent = field.label;
    const value = document.createElement('dd');
    value.textContent = field.value;
    return [term, value];
  }));
  const notes = byId('detailMathflatNotes');
  const noteText = mathflat.notes.join('\n');
  notes.textContent = noteText;
  notes.hidden = !noteText;
  // 라벨도 자유 문장도 하나도 없으면 빈 카드를 띄우지 않는다.
  card.hidden = !mathflat.fields.length && !noteText;
}

function renderDetail(detail) {
  byId('detailTitle').textContent = detail.title;
  byId('detailStatus').textContent = detail.statusIcon + ' ' + detail.statusLabel;
  const dueEl = byId('detailDue');
  dueEl.textContent = detail.due;
  dueEl.hidden = !detail.due;

  renderMathflat(detail.mathflat);

  byId('detailDescription').textContent = detail.description;
  byId('detailDescriptionBlock').hidden = !detail.description;

  byId('detailSubmission').textContent = submissionSummaryLabel(detail);

  byId('detailFeedback').textContent = detail.feedbackText;
  byId('detailFeedbackBlock').hidden = !detail.feedbackText && !detail.redoProblems.length;
  byId('detailRedo').textContent = detail.redoProblems.join(', ');
  byId('detailRedoBlock').hidden = !detail.redoProblems.length;
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
  const query = (feedbackSelect) => supabase
    .from('assignments').select(assignmentsSelect(feedbackSelect))
    .eq('student_id', user.id).order('due_at');
  let result = await query(FEEDBACK_SELECT);
  // auto_composed 컬럼이 없는 배포본을 만나면 기존 포털과 같은 방식으로 물러선다.
  if (isMissingFeedbackSourceColumn(result.error)) result = await query(LEGACY_FEEDBACK_SELECT);
  if (!todayGate.isLatest(request)) return;
  if (result.error) throw result.error;
  currentAssignments = result.data || [];
  renderToday(profile, currentAssignments);
  applyRoute();
}

// 로그인된 상태에서만 hash 경로를 해석한다. 없는 과제를 가리키면 오늘 화면으로 되돌린다.
function applyRoute() {
  if (!currentAssignments.length && routeOf().name === 'detail') { showPanel('today'); goToday(); return; }
  const route = routeOf();
  if (route.name !== 'detail') { showPanel('today'); return; }
  const assignment = findAssignment(currentAssignments, route.id);
  if (!assignment) { showPanel('today'); goToday(); return; }
  renderDetail(assignmentDetail(assignment));
  showPanel('detail');
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => {
  // 로그인 전에는 hash 를 무시한다.
  if (byId('login').hidden === false || byId('pinChange').hidden === false) return;
  applyRoute();
});

byId('detailBack').addEventListener('click', goToday);

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
byId('logout').addEventListener('click', async () => {
  currentAssignments = [];
  await signOut();
  // 다음 사람이 이전 학생의 과제 경로를 열지 않도록 hash 도 비운다.
  location.replace(location.pathname);
});

try {
  const currentUser = await currentUserOrNull();
  if (currentUser) await loadToday(currentUser); else showPanel('login');
} catch (error) {
  showPanel('login');
  showError(byId('loginError'), authErrorMessage(error));
}
