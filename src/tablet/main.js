// 적용 경로: src/tablet/main.js (태블릿 학생 화면 — 로그인 / PIN 변경 / 오늘의 수학)
// 사진 제출과 과제 상세는 다음 단계에서 추가한다.
import './tablet.css';
import { invokeAuthenticated, isMissingFeedbackSourceColumn, supabase } from '../portal/client.js';
import { validateLoginInput, validatePin, authErrorMessage, createLatestRequestGate, STATUS_META, assignmentStatus, assessImageQuality } from '../portal/domain.js';
import { currentUserOrNull, signIn, signOut } from '../auth.js';
import {
  todaySections, todaySummary, totalAssignmentCount, dueLabel, applyKeypadInput, maskPin, greeting,
  assignmentDetail, submissionSummaryLabel, findAssignment,
} from './view-model.js';
import {
  MAX_FILES, ALLOWED_TYPES, JPEG_QUALITY, acceptFiles, buildSubmissionPath,
  isSubmissionPathValid, resizePlan, submissionErrorMessage, previewModel,
} from './submission.js';

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
let currentUserId = null;
let currentDetailId = null;
let selectedPhotos = [];   // { file, url, warnings }
let submitting = false;

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

// ── 사진 선택 · 리사이즈 ─────────────────────────────────────────────────
// 해상도와 흐림 정도를 재서 assessImageQuality 가 쓸 지표를 만든다.
// 축소본으로 계산하므로 큰 사진에서도 부담이 적다.
function measureBlur(bitmap) {
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(2, Math.round(bitmap.width * scale));
    const h = Math.max(2, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, w, h);
    const { data } = context.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    let sum = 0; let sumSq = 0; let n = 0;
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += v; sumSq += v * v; n += 1;
      }
    }
    const mean = sum / n;
    return sumSq / n - mean * mean;
  } catch { return undefined; }
}

async function readImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    return { bitmap, width: bitmap.width, height: bitmap.height, size: file.size, blurScore: measureBlur(bitmap) };
  } catch { return null; }
}

// 태블릿 원본은 버킷 제한(10MB)을 넘기 쉬우므로 업로드 전에 줄인다.
// 실패하면 원본을 그대로 쓰되, 크기 검사는 이미 acceptFiles 에서 끝났다.
async function shrinkForUpload(file, metrics) {
  if (!metrics?.bitmap) return file;
  const plan = resizePlan({ width: metrics.width, height: metrics.height, size: metrics.size });
  if (!plan.resize) { metrics.bitmap.close(); return file; }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    canvas.getContext('2d').drawImage(metrics.bitmap, 0, 0, plan.width, plan.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    metrics.bitmap.close();
  }
}

function renderPhotoPreview() {
  const model = previewModel(selectedPhotos);
  byId('photoPick').textContent = model.pickLabel;
  byId('photoPick').disabled = !model.canAddMore || submitting;
  byId('photoSubmit').disabled = !model.canSubmit || submitting;
  byId('photoPreview').replaceChildren(...model.items.map((item) => {
    const figure = document.createElement('figure');
    figure.className = 'photo-thumb';
    if (item.url) {
      const image = document.createElement('img');
      image.src = item.url;
      image.alt = item.label;
      figure.append(image);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-remove';
    remove.setAttribute('aria-label', item.label + ' 빼기');
    remove.textContent = '✕';
    remove.addEventListener('click', () => removePhoto(item.index));
    figure.append(remove);
    for (const warning of item.warnings) {
      const note = document.createElement('figcaption');
      note.className = 'photo-warn';
      note.textContent = '⚠ ' + warning + ' 그래도 제출은 할 수 있어요.';
      figure.append(note);
    }
    return figure;
  }));
}

function removePhoto(index) {
  const entry = selectedPhotos[index];
  if (entry?.url) URL.revokeObjectURL(entry.url);
  selectedPhotos = selectedPhotos.filter((_, i) => i !== index);
  showError(byId('photoError'), '');
  renderPhotoPreview();
}

function clearPhotos() {
  for (const entry of selectedPhotos) if (entry.url) URL.revokeObjectURL(entry.url);
  selectedPhotos = [];
  showError(byId('photoError'), '');
  byId('photoStatus').textContent = '';
  renderPhotoPreview();
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

  // 아직 제출 전이거나 재풀이 요청을 받은 과제만 제출 영역을 연다.
  // 실제 허용 여부는 서버 트리거가 다시 판단한다.
  const open = detail.attemptCount === 0 || detail.canResubmit;
  byId('submitBlock').hidden = !open;
  byId('submitHeading').textContent = detail.canResubmit ? '다시 풀어서 제출하기' : '사진으로 제출하기';
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
  currentUserId = user.id;
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
  if (currentDetailId !== assignment.id) { currentDetailId = assignment.id; clearPhotos(); }
  renderDetail(assignmentDetail(assignment));
  renderPhotoPreview();
  showPanel('detail');
  window.scrollTo(0, 0);
}

// ── 사진 제출 ────────────────────────────────────────────────────────────
byId('photoPick').addEventListener('click', () => byId('photoInput').click());

byId('photoInput').addEventListener('change', async () => {
  const input = byId('photoInput');
  const chosen = [...input.files];
  input.value = '';
  showError(byId('photoError'), '');
  const { accepted, rejected } = acceptFiles(selectedPhotos.length, chosen);
  for (const file of accepted) {
    const metrics = await readImage(file);
    selectedPhotos.push({
      file,
      metrics,
      url: URL.createObjectURL(file),
      warnings: assessImageQuality(metrics),
    });
  }
  if (rejected.length) showError(byId('photoError'), rejected[0].message);
  renderPhotoPreview();
});

byId('photoSubmit').addEventListener('click', async () => {
  if (submitting || !selectedPhotos.length || !currentUserId || !currentDetailId) return;
  submitting = true;
  showError(byId('photoError'), '');
  renderPhotoPreview();

  const uploaded = [];
  let stage = 'upload';
  try {
    byId('photoStatus').textContent = '사진을 올리는 중이에요…';
    for (const [index, entry] of selectedPhotos.entries()) {
      byId('photoStatus').textContent = '사진 ' + (index + 1) + '/' + selectedPhotos.length + '장 올리는 중이에요…';
      const upload = await shrinkForUpload(entry.file, entry.metrics);
      const path = buildSubmissionPath(currentUserId, currentDetailId, upload.name, crypto.randomUUID());
      // 서버 정규식과 같은 조건을 한 번 더 확인한다. 어긋나면 업로드 자체를 하지 않는다.
      if (!isSubmissionPathValid(path, currentUserId, currentDetailId)) throw new Error('invalid submission file');
      const { error } = await supabase.storage.from('submission-files').upload(path, upload, { contentType: upload.type });
      if (error) throw error;
      uploaded.push(path);
    }

    stage = 'insert';
    byId('photoStatus').textContent = '제출하는 중이에요…';
    // attempt_no / status / 소유권은 서버 트리거가 정한다. 여기서 보내지 않는다.
    const { error } = await supabase.from('submissions').insert({
      assignment_id: currentDetailId,
      student_id: currentUserId,
      file_paths: uploaded,
    });
    if (error) throw error;

    clearPhotos();
    byId('photoStatus').textContent = '제출했어요. 선생님이 확인할 거예요.';
    const user = { id: currentUserId };
    await loadToday(user);
  } catch (error) {
    console.error(error);
    // DB 제출이 실패했으면 방금 올린 파일은 남겨두지 않는다.
    if (uploaded.length) {
      const { error: cleanupError } = await supabase.storage.from('submission-files').remove(uploaded);
      if (cleanupError) console.error('정리하지 못한 업로드 파일:', uploaded, cleanupError);
    }
    byId('photoStatus').textContent = '';
    showError(byId('photoError'), submissionErrorMessage(error, stage));
  } finally {
    submitting = false;
    renderPhotoPreview();
  }
});

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
  currentUserId = null;
  currentDetailId = null;
  clearPhotos();
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
