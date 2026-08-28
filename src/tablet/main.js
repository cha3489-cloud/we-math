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
  isUploadable, resizedTooLargeError,
} from './submission.js';
import {
  MAX_NOTE_LENGTH, composeSubmissionBody, difficultyPickerModel, toggleTag,
} from './difficulty.js';
import {
  MAX_QUESTION_BODY_LENGTH, canSubmitQuestion, questionFormModel,
  questionInsertPayload, questionErrorMessage, recentQuestionsModel,
  REFERENCE_URL_TTL_SECONDS, ownReferencePaths, referenceModel, referencePhotoErrorMessage,
  viewerModel, nextViewerIndex, ownAnswerFilePaths,
} from './question.js';
const ANSWER_IMAGE_LABEL = '선생님이 보낸 이미지';
const REFERENCE_PHOTO_LABEL = '내가 낸 사진';

const byId = (id) => document.getElementById(id);
const showError = (el, message) => { el.textContent = message || ''; };
const PIN_MAX = 6;

// 과제 첨부(assignments.attachment_paths)는 여전히 다루지 않는다.
// 제출 사진 경로(submissions.file_paths)만 가져온다. 학생이 질문을 쓰기 전에
// 자기가 낸 사진을 다시 보기 위한 것이고, Storage 정책상 본인 파일만 열린다.
const FEEDBACK_SELECT = 'feedback(body,auto_composed,created_at,feedback_items(problem_ref,review_tag,comment,redo_required))';
const LEGACY_FEEDBACK_SELECT = 'feedback(body,created_at,feedback_items(problem_ref,review_tag,comment,redo_required))';
const assignmentsSelect = (feedbackSelect) =>
  'id,title,description,due_at,submissions(id,attempt_no,status,body,file_paths,submitted_at,' + feedbackSelect + ')';
const todayGate = createLatestRequestGate();

let currentAssignments = [];
let currentUserId = null;
let currentDetailId = null;
let selectedPhotos = [];   // { file, url, warnings }
let selectedTags = [];
let submitting = false;
const questionsGate = createLatestRequestGate();
let currentQuestions = [];
const answerImagesGate = createLatestRequestGate();
let answerImageUrls = new Map(); // question id -> [{ url }] 서명 URL
let selectedQuestionCategory = null;
let questionSubmitting = false;

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
// id 부분은 [^/]+ 로 한 구간만 받는다. 뒤에 /question 이 붙으면 상세로 이동한
// 뒤 질문하기 영역으로 스크롤·포커스한다(오늘 카드의 질문하기 바로가기용).
const routeOf = () => {
  const match = String(location.hash || '').match(/^#\/assignment\/([^/]+)(\/question)?$/);
  return match
    ? { name: 'detail', id: decodeURIComponent(match[1]), focusQuestion: Boolean(match[2]) }
    : { name: 'today' };
};
const goToday = () => { location.hash = '#/today'; };
const goDetail = (id, focusQuestion = false) => {
  location.hash = '#/assignment/' + encodeURIComponent(id) + (focusQuestion ? '/question' : '');
};

// 상세 화면 안에서도, 오늘 카드에서 바로 와도 같은 동작을 쓴다.
function focusQuestionArea() {
  byId('questionBlock').scrollIntoView({ behavior: 'smooth', block: 'start' });
  byId('questionCategoryOptions').querySelector('button')?.focus();
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
// 카드 전체를 누르면 상세로, 별도의 작은 버튼으로는 질문하기로 바로 간다.
// 버튼 안에 버튼을 넣을 수 없어 감싸는 요소(wrap)를 하나 둔다.
function assignmentCard(assignment, now) {
  const status = assignmentStatus(assignment, now);
  const meta = STATUS_META[status] ?? { icon: '•', label: status };
  const wrap = document.createElement('div');
  wrap.className = 'assignment-card-wrap';

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

  // 사진 제출 여부·과제 상태(completed 포함)와 무관하게 항상 누를 수 있다.
  const questionButton = document.createElement('button');
  questionButton.type = 'button';
  questionButton.className = 'assignment-card-question';
  questionButton.textContent = '❓ 질문하기';
  questionButton.setAttribute('aria-label', assignment.title + ' 질문하기로 바로가기');
  questionButton.addEventListener('click', () => goDetail(assignment.id, true));

  wrap.append(card, questionButton);
  return wrap;
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
  selectedTags = [];
  byId('difficultyNote').value = '';
  showError(byId('photoError'), '');
  byId('photoStatus').textContent = '';
  renderPhotoPreview();
  renderDifficulty();
}

// ── 어디서 막혔나요? ─────────────────────────────────────────────────────
function renderDifficulty() {
  const model = difficultyPickerModel(selectedTags, byId('difficultyNote').value);
  byId('difficultyOptions').replaceChildren(...model.options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = option.selected ? 'difficulty-tag difficulty-tag-on' : 'difficulty-tag';
    button.textContent = option.tag;
    button.dataset.tag = option.tag;
    button.setAttribute('aria-pressed', String(option.selected));
    button.disabled = submitting;
    button.addEventListener('click', () => {
      selectedTags = toggleTag(selectedTags, option.tag);
      renderDifficulty();
    });
    return button;
  }));
  byId('difficultyNote').disabled = submitting;
  byId('difficultyCount').textContent = model.noteLength
    ? model.noteLength + ' / ' + MAX_NOTE_LENGTH + '자'
    : '';
}

// ── 질문 전에 확인하는 관련 자료 ─────────────────────────────────────────
// 새 데이터를 만들지 않는다. 이미 이 학생 것인 과제 정보와 제출 사진만 다시 보여준다.
const referenceGate = createLatestRequestGate();
let referenceUrls = [];

function renderReference(detail) {
  const model = referenceModel(detail);
  byId('questionReference').hidden = !model.visible;
  byId('questionReferenceTitle').textContent = model.title;
  byId('questionReferenceMathflat').textContent = model.mathflatNote;
  byId('questionReferenceMathflat').hidden = !model.mathflatNote;

  byId('questionReferencePhotos').replaceChildren(...referenceUrls.map((entry, index) => {
    // 썸네일만으로는 문항을 알아보기 어렵다. 눌러서 크게 볼 수 있어야 하므로 button 으로 둔다.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'question-reference-thumb';
    button.setAttribute('aria-label', '내가 낸 사진 ' + (index + 1) + ' 크게 보기');
    const image = document.createElement('img');
    image.src = entry.url;
    image.alt = '내가 낸 사진 ' + (index + 1);
    image.loading = 'lazy';
    // 서명 URL 이 만료되면 이미지가 깨진다. 그때는 다시 받을 수 있게 안내한다.
    image.addEventListener('error', () => {
      byId('questionReferenceStatus').textContent = '사진 주소가 만료됐어요.';
      byId('questionReferenceRetry').hidden = false;
    });
    button.append(image);
    button.addEventListener('click', () => openViewer(referenceUrls, index, REFERENCE_PHOTO_LABEL));
    return button;
  }));
}

// ── 사진 크게 보기 ────────────────────────────────────────────────────────
// PR #31 에서 "내가 낸 사진"용으로 만든 뷰어를 그대로 쓴다. 사진마다 별도
// 다이얼로그를 두지 않고, 지금 어느 목록을 보는 중인지만 바꿔 끼운다 — 한 번에
// 하나만 열리므로(학생이 자기 사진과 선생님 이미지를 동시에 보는 상황이 없다)
// 이렇게 하는 편이 다이얼로그를 두 개 두는 것보다 단순하다.
// 어느 쪽이든 이미 받아둔 서명 URL 을 그대로 쓴다. 뷰어를 열거나 넘길 때
// Storage 를 다시 부르지 않는다.
let viewerUrls = [];
let viewerLabelPrefix = REFERENCE_PHOTO_LABEL;
let viewerIndex = 0;

function renderViewer() {
  const model = viewerModel(viewerUrls, viewerIndex, viewerLabelPrefix);
  viewerIndex = model.index;
  byId('referenceViewerImage').src = model.url;
  byId('referenceViewerImage').alt = model.label;
  byId('referenceViewerCounter').textContent = model.counter;
  byId('referenceViewerPrev').hidden = !model.showNav;
  byId('referenceViewerNext').hidden = !model.showNav;
}

function openViewer(urls, index, labelPrefix) {
  const dialog = byId('referenceViewer');
  if (!viewerModel(urls, index, labelPrefix).canOpen) return;
  viewerUrls = urls;
  viewerLabelPrefix = labelPrefix;
  viewerIndex = index;
  renderViewer();
  if (!dialog.open) dialog.showModal();
}

function closeViewer() {
  const dialog = byId('referenceViewer');
  if (dialog.open) dialog.close();
  // 닫은 뒤에도 이미지가 남아 있으면 다음 학생이 볼 수 있다. 주소를 비운다.
  byId('referenceViewerImage').removeAttribute('src');
}

function moveViewer(delta) {
  viewerIndex = nextViewerIndex(viewerIndex, viewerUrls.length, delta);
  renderViewer();
}

byId('referenceViewerClose').addEventListener('click', closeViewer);
byId('referenceViewerPrev').addEventListener('click', () => moveViewer(-1));
byId('referenceViewerNext').addEventListener('click', () => moveViewer(1));
// 배경을 누르면 닫는다. 배경 클릭은 dialog 자신이 target 이 된다.
byId('referenceViewer').addEventListener('click', (event) => {
  if (event.target === byId('referenceViewer')) closeViewer();
});
// Escape 는 원래 dialog 가 스스로 닫아 준다. 다만 그 기본 동작이 실제로 도는지
// 자동화 환경에서 확인하지 못했고 기기·브라우저에 따라 다를 수 있어, 명시적으로도 닫는다.
// 기본 동작과 겹쳐 두 번 닫혀도 close() 는 이미 닫힌 dialog 에서 아무 일도 하지 않는다.
byId('referenceViewer').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeViewer();
});
// 어떤 경로로 닫히든 뒷정리는 한곳에서 한다.
byId('referenceViewer').addEventListener('close', () => {
  byId('referenceViewerImage').removeAttribute('src');
});

async function loadReferencePhotos(detail) {
  const status = byId('questionReferenceStatus');
  const retry = byId('questionReferenceRetry');
  retry.hidden = true;
  // 과제를 옮기면 앞 과제의 사진이 뷰어에 남아 있으면 안 된다.
  closeViewer();
  referenceUrls = [];
  // 경로가 이 학생·이 과제 것인지 화면에서도 한 번 더 확인한다.
  const paths = ownReferencePaths(
    detail?.myFilePaths,
    (path) => isSubmissionPathValid(path, currentUserId, currentDetailId),
  );
  if (!paths.length) { status.textContent = ''; renderReference(detail); return; }

  const request = referenceGate.begin();
  status.textContent = '내가 낸 사진을 불러오는 중이에요…';
  renderReference(detail);
  try {
    const signed = await Promise.all(paths.map((path) =>
      supabase.storage.from('submission-files').createSignedUrl(path, REFERENCE_URL_TTL_SECONDS)));
    if (!referenceGate.isLatest(request)) return;
    const failed = signed.find((result) => result.error);
    if (failed) throw failed.error;
    referenceUrls = signed.map((result) => ({ url: result.data.signedUrl }));
    status.textContent = '';
  } catch (error) {
    if (!referenceGate.isLatest(request)) return;
    console.error(error);
    referenceUrls = [];
    status.textContent = referencePhotoErrorMessage(error);
    retry.hidden = false;
  }
  renderReference(detail);
}

byId('questionReferenceRetry').addEventListener('click', () => {
  const assignment = findAssignment(currentAssignments, currentDetailId);
  if (assignment) loadReferencePhotos(assignmentDetail(assignment));
});

// ── 질문하기 (사진 없이) ─────────────────────────────────────────────────
function renderQuestionForm() {
  const model = questionFormModel(selectedQuestionCategory, byId('questionBody').value);
  byId('questionCategoryOptions').replaceChildren(...model.categories.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = option.selected ? 'question-category-tag question-category-tag-on' : 'question-category-tag';
    button.textContent = option.tag;
    button.dataset.category = option.tag;
    button.setAttribute('aria-pressed', String(option.selected));
    button.disabled = questionSubmitting;
    button.addEventListener('click', () => {
      selectedQuestionCategory = option.tag;
      renderQuestionForm();
    });
    return button;
  }));
  byId('questionBody').disabled = questionSubmitting;
  byId('questionCount').textContent = model.bodyLength
    ? model.bodyLength + ' / ' + MAX_QUESTION_BODY_LENGTH + '자'
    : '';
  byId('questionSubmit').disabled = !model.canSubmit || questionSubmitting;
}

function clearQuestionForm() {
  selectedQuestionCategory = null;
  byId('questionBody').value = '';
  showError(byId('questionError'), '');
  byId('questionStatus').textContent = '';
  renderQuestionForm();
}

// 이 과제에 대해 최근 남긴 질문만 보여준다. 과도한 이력 노출을 피하려고
// recentQuestionsModel 이 개수를 제한한다.
function renderQuestionRecent() {
  const items = recentQuestionsModel(currentQuestions);
  const container = byId('questionRecent');
  container.hidden = !items.length;
  container.replaceChildren(...items.map((item) => {
    const wrap = document.createElement('div');
    wrap.className = 'question-recent-item';

    const head = document.createElement('p');
    head.className = 'question-recent-head';
    const category = document.createElement('span');
    category.textContent = item.category;
    const status = document.createElement('span');
    status.className = item.answerBody
      ? 'question-recent-status question-recent-status-answered'
      : 'question-recent-status';
    status.textContent = item.statusLabel;
    head.append(category, status);

    const body = document.createElement('p');
    body.className = 'question-recent-body';
    body.textContent = item.body;
    wrap.append(head, body);

    if (item.answerBody) {
      const answer = document.createElement('p');
      answer.className = 'question-recent-answer';
      answer.textContent = item.answerBody;
      wrap.append(answer);

      // 서명 URL 은 loadAnswerImages 가 따로 받아온다. 아직 안 왔거나 실패했으면
      // 그냥 아무것도 안 보여준다 — 답변 텍스트만으로도 이미 온전한 화면이다.
      const urls = answerImageUrls.get(item.id) || [];
      if (urls.length) {
        // 기존 참고 사진과 같은 격자·버튼 스타일을 그대로 쓴다(question-reference-*).
        const photos = document.createElement('div');
        photos.className = 'question-reference-photos';
        photos.append(...urls.map((entry, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'question-reference-thumb';
          button.setAttribute('aria-label', ANSWER_IMAGE_LABEL + ' ' + (index + 1) + ' 크게 보기');
          const image = document.createElement('img');
          image.src = entry.url;
          image.alt = ANSWER_IMAGE_LABEL + ' ' + (index + 1);
          image.loading = 'lazy';
          button.append(image);
          button.addEventListener('click', () => openViewer(urls, index, ANSWER_IMAGE_LABEL));
          return button;
        }));
        wrap.append(photos);
      }
    }
    return wrap;
  }));
}

// 답변에 붙은 이미지의 서명 URL을 받아온다. 질문 목록을 먼저 그린 뒤 이어서
// 부르므로, 텍스트는 바로 보이고 이미지만 조금 늦게 채워진다.
async function loadAnswerImages(questions) {
  // recentQuestionsModel 이 화면에 답변을 보여주는 조건(answered)과 맞춘다.
  // 답변 후 닫힌 질문처럼 answer_file_paths 가 남아 있어도 화면엔 안 보이므로 요청하지 않는다.
  const jobs = questions
    .filter((question) => question.status === 'answered')
    .map((question) => ({ id: question.id, paths: ownAnswerFilePaths(question) }))
    .filter((job) => job.paths.length);
  if (!jobs.length) {
    if (answerImageUrls.size) { answerImageUrls = new Map(); renderQuestionRecent(); }
    return;
  }
  const request = answerImagesGate.begin();
  const entries = await Promise.all(jobs.map(async (job) => {
    // 본인 질문에 붙은 파일만 요청한다 — ownAnswerFilePaths 가 이미 이 질문 id로
    // 시작하는 경로만 골라 넘겨준다. Storage 정책이 최종 방어선이므로, 여기서
    // 걸러도 서명 자체는 RLS 가 다시 확인한다.
    const signed = await Promise.all(job.paths.map((path) =>
      supabase.storage.from('answer-files').createSignedUrl(path, REFERENCE_URL_TTL_SECONDS)));
    const urls = signed.filter((result) => !result.error).map((result) => ({ url: result.data.signedUrl }));
    return [job.id, urls];
  }));
  if (!answerImagesGate.isLatest(request)) return;
  answerImageUrls = new Map(entries.filter(([, urls]) => urls.length));
  renderQuestionRecent();
}

// 남에게 보일 이유가 없으므로 student_id 로도 한 번 더 좁힌다. RLS 가 최종
// 방어선이지만 화면도 같은 조건을 쓴다.
async function loadQuestions(assignmentId) {
  const request = questionsGate.begin();
  const { data, error } = await supabase
    .from('questions')
    .select('id,category,body,status,answer_body,answer_file_paths,created_at')
    .eq('assignment_id', assignmentId)
    .eq('student_id', currentUserId)
    .order('created_at', { ascending: false })
    .limit(3);
  if (!questionsGate.isLatest(request)) return;
  if (error) { console.error(error); currentQuestions = []; answerImageUrls = new Map(); renderQuestionRecent(); return; }
  currentQuestions = data || [];
  renderQuestionRecent();
  loadAnswerImages(currentQuestions);
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

  // 학생이 지난 제출에 무엇을 적어 보냈는지만 되짚어 준다. 그 이상은 보여주지 않는다.
  byId('detailMineTags').textContent = detail.myTags.length ? '막힌 지점 · ' + detail.myTags.join(', ') : '';
  byId('detailMineTags').hidden = !detail.myTags.length;
  byId('detailMineNote').textContent = detail.myNote;
  byId('detailMineNote').hidden = !detail.myNote;
  byId('detailMineBlock').hidden = !detail.myTags.length && !detail.myNote;

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
  const detail = assignmentDetail(assignment);
  if (currentDetailId !== assignment.id) {
    currentDetailId = assignment.id;
    clearPhotos();
    clearQuestionForm();
    currentQuestions = [];
    answerImageUrls = new Map();
    renderQuestionRecent();
    loadQuestions(assignment.id);
    loadReferencePhotos(detail);
  }
  renderDetail(detail);
  renderPhotoPreview();
  showPanel('detail');
  // 질문하기로 바로가기(오늘 카드의 ❓ 버튼, 상세 화면의 점프 버튼)로 들어왔을 때는
  // 맨 위로 스크롤하지 않고 곧바로 질문하기 영역으로 이동한다.
  if (route.focusQuestion) {
    focusQuestionArea();
  } else {
    window.scrollTo(0, 0);
  }
}

// 상세 화면 안에서 이미 보이는 점프 버튼 — 사진 제출 영역이 닫혀 있어도 스크롤 없이
// 바로 눌러서 질문하기 영역으로 이동할 수 있다.
byId('jumpToQuestion').addEventListener('click', focusQuestionArea);

// ── 사진 제출 ────────────────────────────────────────────────────────────
byId('photoPick').addEventListener('click', () => byId('photoInput').click());
byId('difficultyNote').addEventListener('input', renderDifficulty);
renderDifficulty();
byId('questionBody').addEventListener('input', renderQuestionForm);
renderQuestionForm();

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
  renderDifficulty();

  const uploaded = [];
  let stage = 'upload';
  try {
    byId('photoStatus').textContent = '사진을 올리는 중이에요…';
    for (const [index, entry] of selectedPhotos.entries()) {
      byId('photoStatus').textContent = '사진 ' + (index + 1) + '/' + selectedPhotos.length + '장 올리는 중이에요…';
      const upload = await shrinkForUpload(entry.file, entry.metrics);
      // 축소를 거친 뒤에도 버킷 한계를 넘으면 여기서 멈춘다. 서버가 413으로
      // 거절하기 전에 학생에게 무엇을 다시 해야 하는지 먼저 알려준다.
      if (!isUploadable(upload.size)) throw resizedTooLargeError();
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
    // 막힌 지점과 메모는 기존 body 컬럼에 규약 텍스트로 담는다. 둘 다 없으면 빈 문자열이다.
    const { error } = await supabase.from('submissions').insert({
      assignment_id: currentDetailId,
      student_id: currentUserId,
      body: composeSubmissionBody(selectedTags, byId('difficultyNote').value),
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
    renderDifficulty();
  }
});

byId('questionSubmit').addEventListener('click', async () => {
  if (questionSubmitting || !currentUserId || !currentDetailId) return;
  if (!canSubmitQuestion(selectedQuestionCategory, byId('questionBody').value)) return;
  questionSubmitting = true;
  showError(byId('questionError'), '');
  renderQuestionForm();

  try {
    // status / answered_at 등 서버가 정하는 값은 보내지 않는다.
    const payload = questionInsertPayload({
      studentId: currentUserId,
      assignmentId: currentDetailId,
      category: selectedQuestionCategory,
      body: byId('questionBody').value,
    });
    const { error } = await supabase.from('questions').insert(payload);
    if (error) throw error;

    clearQuestionForm();
    byId('questionStatus').textContent = '질문을 남겼어요. 선생님이 확인할게요.';
    await loadQuestions(currentDetailId);
  } catch (error) {
    console.error(error);
    showError(byId('questionError'), questionErrorMessage(error));
  } finally {
    questionSubmitting = false;
    renderQuestionForm();
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
  currentQuestions = [];
  clearQuestionForm();
  // 다음 사람이 앞 학생의 사진을 보지 못하게 뷰어를 닫고 서명 URL 도 함께 버린다.
  closeViewer();
  referenceUrls = [];
  answerImageUrls = new Map();
  byId('questionReferencePhotos').replaceChildren();
  byId('questionReference').hidden = true;
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
