// 적용 경로: src/portal/admin.js (전체 교체)
import './portal.css';
import { invokeAuthenticated, isMissingFeedbackSourceColumn, isMissingExplicitFeedbackRpc, supabase } from './client.js';
import {
  validatePin, validateLoginInput, validateAccountInput, normalizeRelation,
  waitingLabel, REVIEW_TAGS, validateProblemRef,
  validateFeedbackItems, checkItemsForStatus, composeFeedbackBody, isAutoComposedFeedback,
  authErrorMessage, adminWorkflowMeta, summarizeAdminWorkflows, summarizeStudentOperations,
  studentOperationStatusCopy,
  isActiveStudentAssignment, isActiveProfile, collectKeysetPages, createLatestRequestGate,
  reviewQueue, reconcileQueueSelection, filteredAdminListCopy, adminActionFilterCopy,
} from './domain.js';
import { currentUserOrNull, signIn, signOut } from '../auth.js';
import {
  acceptAnswerImages, answerImagesPreviewModel, extractPastedImageFiles,
  buildAnswerFilePath, isAnswerFilePathValid, canSubmitAnswer, answerErrorMessage,
} from './answer-attachments.js';
import { validateInternalNote } from './admin-internal-notes.js';

const byId = (id) => document.getElementById(id);
const showError = (el, message) => { el.textContent = message || ''; };
let currentAdmin;

async function ensureAdmin(user) {
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', user.id).single();
  if (error || data?.role !== 'admin') { await signOut(); throw new Error('관리자 권한이 필요합니다.'); }
}
async function callAdmin(payload) { return invokeAuthenticated('admin-users', payload); }
function safeName(name) { return name.replace(/[^a-zA-Z0-9._-]/g, '_'); }
async function cleanup(bucket, paths) { if (paths.length) await supabase.storage.from(bucket).remove(paths); }

// ── 탭 ──────────────────────────────────────────────────────────────────
let actionFilter = 'all';
let operationsSummary = { counts: { principal_check: 0, submitted: 0, needs_revision: 0, overdue: 0 }, actionItems: [], studentItems: [] };
async function switchTab(tab) {
  const review = tab === 'review';
  const manage = tab === 'manage';
  const questions = tab === 'questions';
  byId('reviewSection').hidden = !review;
  byId('noSelection').hidden = !review || Boolean(current);
  byId('manageSection').hidden = !manage;
  byId('questionsSection').hidden = !questions;
  byId('tabReview').setAttribute('aria-pressed', String(review));
  byId('tabManage').setAttribute('aria-pressed', String(manage));
  byId('tabQuestions').setAttribute('aria-pressed', String(questions));
  if (manage) await Promise.all([loadUsers(), loadWorkflows(), loadOperationsSummary()]);
  if (questions) await loadQuestionInbox();
}
async function openActionFilter(filter) {
  actionFilter = filter;
  await switchTab('manage');
  renderActionItems();
  byId('actionSection').focus({ preventScroll: true });
  byId('actionSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
byId('tabReview').addEventListener('click', () => switchTab('review').catch((error) => showError(byId('adminError'), error.message)));
byId('tabManage').addEventListener('click', () => { actionFilter = 'all'; switchTab('manage').catch((error) => showError(byId('adminError'), error.message)); });
byId('tabQuestions').addEventListener('click', () => switchTab('questions').catch((error) => showError(byId('adminError'), error.message)));
byId('statPrincipalCheck').addEventListener('click', () => openActionFilter('principal_check').catch((error) => showError(byId('adminError'), error.message)));
byId('statSubmitted').addEventListener('click', () => switchTab('review').then(() => byId('queue').scrollIntoView({ behavior: 'smooth', block: 'start' })).catch((error) => showError(byId('adminError'), error.message)));
byId('statRevision').addEventListener('click', () => openActionFilter('needs_revision').catch((error) => showError(byId('adminError'), error.message)));
byId('statOverdue').addEventListener('click', () => openActionFilter('overdue').catch((error) => showError(byId('adminError'), error.message)));
byId('statQuestions').addEventListener('click', () => setQuestionStudentFilter(''));
byId('actionShowAll').addEventListener('click', () => { actionFilter = 'all'; renderActionItems(); });

// ── 검토 대기열 상태 ─────────────────────────────────────────────────────
let queue = [];          // [{ assignment, attempt }]
let current = null;      // 현재 검토 중 entry
let items = [];          // 작성 중 feedback_items
let selectedTag = null;
let images = [];         // 현재 제출의 file_paths
let imageIndex = 0;
let zoom = 1;
let rotation = 0;
let imageRequest = 0;
let processing = false;
const REMOTE_PAGE_SIZE = 1000;
const queueRequestGate = createLatestRequestGate();
const QUEUE_SELECT = 'id,title,due_at,profiles!assignments_student_id_fkey(name,suspended_at),submissions(id,attempt_no,status,body,file_paths,submitted_at)';

async function fetchQueuePage(cursor, pageSize) {
  let query = supabase.from('assignments').select(QUEUE_SELECT)
    .order('id').limit(pageSize);
  if (cursor !== null) query = query.gt('id', cursor);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
async function loadQueue() {
  const request = queueRequestGate.begin();
  let assignments;
  try {
    assignments = await collectKeysetPages(fetchQueuePage, REMOTE_PAGE_SIZE);
  } catch (error) {
    if (queueRequestGate.isLatest(request)) throw error;
    return;
  }
  if (!queueRequestGate.isLatest(request)) return;
  const activeAssignments = assignments.filter(isActiveStudentAssignment);
  const nextQueue = reviewQueue(activeAssignments);
  const selected = reconcileQueueSelection(current, nextQueue);
  if (current && !selected) {
    current = null;
    items = [];
    selectedTag = null;
    images = [];
    imageRequest += 1;
    byId('adminImage').src = '';
    byId('adminFrame').src = '';
    byId('reviewDetail').hidden = true;
  } else {
    current = selected;
  }
  queue = nextQueue;
  byId('noSelection').hidden = byId('reviewSection').hidden || Boolean(current);
  byId('queueEmpty').hidden = Boolean(queue.length);
  byId('queue').replaceChildren(...queue.map((entry, index) => queueRow(entry, index)));
}

function queueRow(entry, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'queue-row' + (current && current.attempt.id === entry.attempt.id ? ' active' : '');
  const student = normalizeRelation(entry.assignment.profiles)[0]?.name || '학생';
  button.replaceChildren();
  const name = document.createElement('strong'); name.textContent = student;
  const title = document.createElement('span'); title.textContent = entry.assignment.title;
  const meta = document.createElement('span'); meta.className = 'meta';
  meta.textContent = entry.attempt.attempt_no + '차 제출 · ' + waitingLabel(entry.attempt.submitted_at);
  button.append(name, title, meta);
  button.addEventListener('click', () => openReview(index));
  return button;
}

async function openReview(index) {
  const entry = queue[index];
  if (!entry) return;
  current = entry;
  items = []; selectedTag = null; zoom = 1; rotation = 0; imageIndex = 0;
  images = [...(entry.attempt.file_paths || [])];
  byId('noSelection').hidden = true;
  byId('reviewDetail').hidden = false;
  showError(byId('reviewError'), ''); showError(byId('viewerError'), '');
  byId('overallComment').value = ''; byId('problemRef').value = ''; byId('itemComment').value = ''; byId('redoRequired').checked = true;
  byId('internalNote').value = ''; showError(byId('internalNoteStatus'), '');
  renderTagChips(); renderItems();

  const student = normalizeRelation(entry.assignment.profiles)[0]?.name || '학생';
  byId('reviewHead').textContent = student + ' · ' + entry.assignment.title + ' · ' + entry.attempt.attempt_no + '차 제출 · ' + waitingLabel(entry.attempt.submitted_at);
  byId('attemptBody').textContent = entry.attempt.body ? '제출 내용: ' + entry.attempt.body : '';
  await showImage(0);
  await loadQueue(); // active 표시 갱신

  // 검토 시작 이벤트 (실패해도 검토는 진행)
  await loadInternalNote(entry.attempt.id);

  const { error } = await supabase.from('review_events').insert({ submission_id: entry.attempt.id, event_type: 'review_opened', actor_id: currentAdmin.id });
  if (error) console.warn('review_opened 기록 실패:', error.message);
}

async function showImage(index) {
  const img = byId('adminImage');
  const frame = byId('adminFrame');
  showError(byId('viewerError'), '');
  if (!images.length) { imageRequest += 1; img.hidden = true; frame.hidden = true; frame.src = ''; byId('noImage').hidden = false; byId('imgIndex').textContent = ''; return; }
  byId('noImage').hidden = true;
  imageIndex = (index + images.length) % images.length;
  const path = images[imageIndex];
  const request = ++imageRequest;
  byId('imgIndex').textContent = (imageIndex + 1) + ' / ' + images.length;
  const { data, error } = await supabase.storage.from('submission-files').createSignedUrl(path, 60);
  if (request !== imageRequest || images[imageIndex] !== path) return;
  if (error) { showError(byId('viewerError'), '제출 파일을 불러오지 못했습니다. 다시 시도해 주세요.'); img.hidden = true; frame.hidden = true; return; }
  const pdf = /[.]pdf$/i.test(path);
  img.hidden = pdf; frame.hidden = !pdf;
  if (pdf) { frame.src = data.signedUrl; img.src = ''; }
  else { img.src = data.signedUrl; frame.src = ''; }
  applyTransform();
}
function applyTransform() {
  byId('adminImage').style.transform = 'scale(' + zoom + ') rotate(' + rotation + 'deg)';
}
byId('imgPrev').addEventListener('click', () => showImage(imageIndex - 1));
byId('imgNext').addEventListener('click', () => showImage(imageIndex + 1));
byId('zoomIn').addEventListener('click', () => { zoom = Math.min(3, zoom + 0.25); applyTransform(); });
byId('zoomOut').addEventListener('click', () => { zoom = Math.max(0.5, zoom - 0.25); applyTransform(); });
byId('rotate').addEventListener('click', () => { rotation = (rotation + 90) % 360; applyTransform(); });

// ── 확인 항목 작성 ───────────────────────────────────────────────────────
function renderTagChips() {
  const group = byId('tagChips');
  group.replaceChildren(...REVIEW_TAGS.map((tag, index) => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'chip'; chip.textContent = tag;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(selectedTag === tag));
    chip.tabIndex = selectedTag ? (selectedTag === tag ? 0 : -1) : (index === 0 ? 0 : -1);
    const select = (target) => {
      selectedTag = REVIEW_TAGS[target]; renderTagChips();
      group.children[target]?.focus();
    };
    chip.addEventListener('click', () => select(index));
    chip.addEventListener('keydown', (event) => {
      let target = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = (index + 1) % REVIEW_TAGS.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = (index - 1 + REVIEW_TAGS.length) % REVIEW_TAGS.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = REVIEW_TAGS.length - 1;
      if (target !== null) { event.preventDefault(); select(target); }
    });
    return chip;
  }));
}
function renderItems() {
  byId('itemList').replaceChildren(...items.map((item, index) => {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = item.problem_ref + ' · ' + item.review_tag + (item.redo_required ? ' · 다시 풀기' : '') + (item.comment ? ' — ' + item.comment : '');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'thumb-remove'; remove.setAttribute('aria-label', '항목 삭제'); remove.textContent = '✕';
    remove.addEventListener('click', () => { items.splice(index, 1); renderItems(); });
    li.append(text, remove);
    return li;
  }));
}
byId('addItem').addEventListener('click', () => {
  showError(byId('reviewError'), '');
  try {
    if (!selectedTag) throw new Error('확인 태그를 선택하세요.');
    const item = {
      problem_ref: validateProblemRef(byId('problemRef').value),
      review_tag: selectedTag,
      comment: byId('itemComment').value.trim(),
      redo_required: byId('redoRequired').checked,
    };
    items = validateFeedbackItems([...items, item]);
    byId('problemRef').value = ''; byId('itemComment').value = '';
    renderItems();
  } catch (error) { showError(byId('reviewError'), error.message); }
});


// ── 내부 메모(원장 전용) ────────────────────────────────────────────────
// review_internal_notes 는 admin-only RLS 라 학생 세션에서는 0행이 온다.
// 학생 화면(student.js)은 이 테이블도 이 RPC 도 절대 호출하지 않는다.
async function loadInternalNote(submissionId) {
  const { data, error } = await supabase.from('review_internal_notes')
    .select('note').eq('submission_id', submissionId).maybeSingle();
  if (error) { console.warn('내부 메모 조회 실패:', error.message); return; }
  if (current?.attempt.id === submissionId) byId('internalNote').value = data?.note || '';
}

function isMissingInternalNotesFeature(error) {
  const message = String(error?.message || '') + ' ' + String(error?.details || '');
  return (error?.code === 'PGRST202' && message.includes('upsert_review_internal_note'))
    || (error?.code === '42P01' && message.includes('review_internal_notes'))
    || (error?.code === 'PGRST205' && message.includes('review_internal_notes'));
}

async function saveInternalNote(submissionId) {
  const note = validateInternalNote(byId('internalNote').value);
  const { error } = await supabase.rpc('upsert_review_internal_note', {
    p_submission_id: submissionId, p_note: note,
  });
  if (error) {
    if (isMissingInternalNotesFeature(error)) {
      console.warn('내부 메모 기능이 아직 DB에 적용되지 않았습니다:', error.message);
      return { note, skipped: true };
    }
    throw error;
  }
  return { note, skipped: false };
}

byId('saveInternalNote').addEventListener('click', async () => {
  if (!current) return;
  const button = byId('saveInternalNote');
  button.disabled = true;
  showError(byId('internalNoteStatus'), '');
  showError(byId('reviewError'), '');
  try {
    const { note, skipped } = await saveInternalNote(current.attempt.id);
    if (skipped) showError(byId('reviewError'), '운영 DB 적용 전이라 내부 메모는 아직 저장되지 않았습니다. 검토 확정은 계속 진행할 수 있습니다.');
    else showError(byId('internalNoteStatus'), note ? '메모를 저장했습니다.' : '메모를 비웠습니다.');
  } catch (error) { showError(byId('reviewError'), error.message); }
  finally { button.disabled = false; }
});

// ── 확정: 중복 클릭 방지 + 트랜잭션 RPC + 다음 대기 건으로 이동 ──────────
async function decide(status) {
  if (processing || !current) return;
  showError(byId('reviewError'), '');
  const buttons = [byId('decideRevision'), byId('decideComplete')];
  try {
    const validItems = validateFeedbackItems(items);
    checkItemsForStatus(status, validItems);
    const overallComment = byId('overallComment').value;
    const autoComposed = !String(overallComment).trim();
    const body = composeFeedbackBody(validItems, overallComment);
    const decidedId = current.attempt.id;
    processing = true; buttons.forEach((b) => { b.disabled = true; });
    // 내부 메모를 먼저 저장한다. 확정이 검증에서 막혀도 입력한 메모는 남는다.
    await saveInternalNote(decidedId);
    let result = await supabase.rpc('review_submission_v2', {
      p_submission_id: decidedId, p_body: body, p_status: status,
      p_items: validItems, p_auto_composed: autoComposed,
    });
    if (isMissingExplicitFeedbackRpc(result.error)) {
      result = await supabase.rpc('review_submission_v2', {
        p_submission_id: decidedId, p_body: body, p_status: status,
        p_items: validItems,
      });
    }
    if (result.error) throw result.error;
    if (current?.attempt.id === decidedId) {
      current = null;
      byId('reviewDetail').hidden = true;
    }
    try {
      await Promise.all([loadQueue(), loadOperationsSummary()]);
      if (!current) {
        const next = queue.findIndex((entry) => entry.attempt.id !== decidedId);
        if (next >= 0) await openReview(next);
        else byId('noSelection').hidden = false;
      }
    } catch (error) {
      console.warn('검토 처리 후 새로고침 실패:', error.message);
      showError(byId('adminError'), '처리는 완료됐지만 화면 새로고침에 실패했습니다. 페이지를 새로고침해 주세요.');
    }
  } catch (error) {
    // 이미 다른 곳에서 검토됐다면 대기열을 새로고침해 중복 검토를 방지
    if (String(error.message || '').includes('not reviewable')) {
      showError(byId('reviewError'), '이미 처리된 제출입니다. 대기열을 새로고침했습니다.');
      current = null; byId('reviewDetail').hidden = true; await loadQueue();
    } else {
      showError(byId('reviewError'), error.message || '처리에 실패했습니다.');
    }
  } finally {
    processing = false; buttons.forEach((b) => { b.disabled = false; });
  }
}
byId('decideRevision').addEventListener('click', () => decide('needs_revision'));
byId('decideComplete').addEventListener('click', () => decide('completed'));

// ── 학생 질문 (사진 제출과 별개, questions 테이블) ────────────────────────
// 상태 변경은 answer_question / close_question RPC 로만 한다. 직접 UPDATE 는
// questions 에 update 권한 자체가 없어 서버가 거부한다(문서 22/23).
// student_id 로 profiles 를 두 번 참조하는 FK(student_id, answered_by)가 있어
// 어느 쪽인지 명시해야 한다. assignment_id 는 questions 에서 하나뿐이라 그대로 둔다.
const QUESTIONS_SELECT = 'id,category,body,created_at,profiles!questions_student_id_fkey(name),assignments(title)';
// 오래된 질문부터 보이게 하고(review queue 와 같은 방향), 목록이 한없이 길어지지
// 않도록 개수를 제한한다. 100건을 넘게 밀리는 상황이면 운영상 이미 다른 조치가 필요하다.
const QUESTIONS_LIMIT = 100;
const questionsRequestGate = createLatestRequestGate();
let questionInbox = [];
let questionStudentFilter = '';
let questionProcessingId = null;
const questionErrors = new Map();
const questionDrafts = new Map();
const questionAnswerFiles = new Map(); // questionId -> [{ file, url }]

function clearAnswerAttachments(questionId) {
  const list = questionAnswerFiles.get(questionId) || [];
  for (const entry of list) if (entry.url) URL.revokeObjectURL(entry.url);
  questionAnswerFiles.delete(questionId);
}

function questionStudentName(entry) {
  return normalizeRelation(entry.profiles)[0]?.name || '학생';
}
function questionAssignmentTitle(entry) {
  return normalizeRelation(entry.assignments)[0]?.title || '';
}
async function loadQuestionCount() {
  const { count, error } = await supabase
    .from('questions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open');
  if (error) { console.warn('질문 개수 조회 실패:', error.message); return; }
  byId('questionCount').textContent = String(count || 0);
}

async function loadQuestionInbox() {
  const request = questionsRequestGate.begin();
  let query = supabase
    .from('questions')
    .select(questionStudentFilter ? QUESTIONS_SELECT.replace('profiles!questions_student_id_fkey(', 'profiles!questions_student_id_fkey!inner(') : QUESTIONS_SELECT)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(QUESTIONS_LIMIT);
  if (questionStudentFilter) query = query.eq('profiles.name', questionStudentFilter);
  const { data, error } = await query;
  if (!questionsRequestGate.isLatest(request)) return;
  if (error) { showError(byId('questionsError'), error.message || '질문 목록을 불러오지 못했습니다.'); return; }
  showError(byId('questionsError'), '');
  questionInbox = data || [];
  if (!questionStudentFilter) byId('questionCount').textContent = String(questionInbox.length);
  renderQuestionInbox();
}

function questionCard(entry) {
  const card = document.createElement('article');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = questionStudentName(entry) + ' · ' + entry.category;
  card.append(heading);

  const assignmentTitle = questionAssignmentTitle(entry);
  if (assignmentTitle) {
    const titleEl = document.createElement('p');
    titleEl.className = 'workflow-title';
    titleEl.textContent = assignmentTitle;
    card.append(titleEl);
  }

  const metaLine = document.createElement('p');
  metaLine.className = 'meta';
  metaLine.textContent = new Date(entry.created_at).toLocaleString('ko-KR');
  card.append(metaLine);

  const body = document.createElement('p');
  body.textContent = entry.body;
  card.append(body);

  const answerLabel = document.createElement('label');
  answerLabel.append('답변');
  const answerInput = document.createElement('textarea');
  answerInput.maxLength = 4000;
  answerInput.placeholder = '학생에게 보여줄 답변을 적어주세요.';
  answerInput.value = questionDrafts.get(entry.id) || '';
  answerLabel.append(answerInput);
  card.append(answerLabel);

  const busy = Boolean(questionProcessingId);

  // ── 답변 이미지 첨부 ─────────────────────────────────────────────────
  // student.js 의 제출 파일 미리보기와 같은 마크업·클래스(.thumbs/.thumb/.thumb-remove)를
  // 그대로 쓴다. 새 CSS 를 추가하지 않기 위해서다.
  const attachmentsBlock = document.createElement('div');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/jpeg,image/png,image/webp';
  fileInput.multiple = true;
  fileInput.hidden = true;
  const pickButton = document.createElement('button');
  pickButton.type = 'button';
  pickButton.className = 'secondary small';
  const thumbs = document.createElement('div');
  thumbs.className = 'thumbs';
  const attachmentError = document.createElement('p');
  attachmentError.className = 'error';
  attachmentError.setAttribute('role', 'alert');

  const renderAttachments = () => {
    const selected = questionAnswerFiles.get(entry.id) || [];
    const model = answerImagesPreviewModel(selected);
    pickButton.textContent = model.pickLabel;
    pickButton.disabled = busy || !model.canAddMore;
    thumbs.replaceChildren(...model.items.map((item) => {
      const figure = document.createElement('figure');
      figure.className = 'thumb';
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.label;
      figure.append(img);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'thumb-remove';
      remove.setAttribute('aria-label', item.label + ' 빼기');
      remove.textContent = '✕';
      remove.disabled = busy;
      remove.addEventListener('click', () => {
        const list = questionAnswerFiles.get(entry.id) || [];
        const target = list[item.index];
        if (target?.url) URL.revokeObjectURL(target.url);
        questionAnswerFiles.set(entry.id, list.filter((_, i) => i !== item.index));
        renderAttachments();
      });
      figure.append(remove);
      return figure;
    }));
  };
  renderAttachments();

  // 파일 선택과 붙여넣기(Ctrl+V) 둘 다 이 함수 하나로 첨부한다 — 매번
  // questionAnswerFiles 에서 현재 개수를 다시 읽으므로, 파일 선택 몇 장 +
  // 붙여넣기 몇 장을 섞어도 acceptAnswerImages 가 합쳐서 최대 3장으로 막는다.
  const addAnswerFiles = (files) => {
    const current = questionAnswerFiles.get(entry.id) || [];
    const { accepted, rejected } = acceptAnswerImages(current.length, files);
    if (accepted.length) {
      questionAnswerFiles.set(entry.id, [
        ...current,
        ...accepted.map((file) => ({ file, url: URL.createObjectURL(file) })),
      ]);
    }
    attachmentError.textContent = rejected.length ? rejected[0].message : '';
    renderAttachments();
  };

  pickButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const chosen = [...fileInput.files];
    fileInput.value = '';
    addAnswerFiles(chosen);
  });

  const attachmentGuide = document.createElement('p');
  attachmentGuide.className = 'meta';
  attachmentGuide.textContent = '답변 칸에서 캡처 후 붙여넣기(Ctrl+V)로도 첨부할 수 있어요.';

  // 캡처 이미지를 답변 textarea 에 바로 붙여넣을 수 있게 한다. 클립보드에
  // 이미지가 없으면(순수 텍스트 붙여넣기 등) 아무것도 하지 않고 기존
  // textarea 기본 동작(텍스트 삽입)에 그대로 맡긴다 — 이미지가 있을 때만
  // preventDefault 해서 이미지 텍스트 표현이 답변 칸에 섞여 들어가지 않게 한다.
  answerInput.addEventListener('paste', (event) => {
    const pastedImages = extractPastedImageFiles(event.clipboardData?.items);
    if (!pastedImages.length) return;
    event.preventDefault();
    addAnswerFiles(pastedImages);
  });

  attachmentsBlock.append(fileInput, pickButton, attachmentGuide, thumbs, attachmentError);
  card.append(attachmentsBlock);

  const errorEl = document.createElement('p');
  errorEl.className = 'error';
  errorEl.setAttribute('role', 'alert');
  errorEl.textContent = questionErrors.get(entry.id) || '';
  card.append(errorEl);

  const actions = document.createElement('div');
  actions.className = 'decide';
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.className = 'secondary'; closeButton.textContent = '닫기';
  closeButton.disabled = busy;
  closeButton.addEventListener('click', () => closeQuestionEntry(entry.id));
  const answerButton = document.createElement('button');
  answerButton.type = 'button'; answerButton.textContent = '답변 보내기';
  // 답변 본문은 항상 필수다(첨부만으로는 답변할 수 없다). 입력할 때마다 다시 본다.
  answerButton.disabled = busy || !canSubmitAnswer(answerInput.value);
  answerInput.addEventListener('input', () => {
    questionDrafts.set(entry.id, answerInput.value);
    answerButton.disabled = Boolean(questionProcessingId) || !canSubmitAnswer(answerInput.value);
  });
  answerButton.addEventListener('click', () => answerQuestion(entry.id, answerInput.value, questionAnswerFiles.get(entry.id) || []));
  actions.append(closeButton, answerButton);
  card.append(actions);

  return card;
}

function renderQuestionInbox() {
  const copy = filteredAdminListCopy('questions', questionStudentFilter);
  byId('questionsSection').classList.toggle('question-section-filtered', Boolean(questionStudentFilter));
  byId('questionFilterStatus').textContent = copy.status;
  byId('questionFilterClear').textContent = copy.resetLabel;
  byId('questionFilterClear').setAttribute('aria-label', copy.resetAriaLabel);
  byId('questionFilterClear').hidden = copy.clearHidden;
  byId('questionsEmpty').querySelector('h3').textContent = copy.emptyTitle;
  byId('questionsEmpty').querySelector('p').textContent = copy.emptyBody;
  byId('questionsEmpty').hidden = Boolean(questionInbox.length);
  byId('questionsList').replaceChildren(...questionInbox.map(questionCard));
}
function setQuestionStudentFilter(studentName) {
  questionStudentFilter = studentName || '';
  switchTab('questions')
    .then(() => byId('questionsList').scrollIntoView({ behavior: 'smooth', block: 'start' }))
    .catch((error) => showError(byId('adminError'), error.message));
}
byId('questionFilterClear').addEventListener('click', () => setQuestionStudentFilter(''));

async function answerQuestion(questionId, answerBody, attachments = []) {
  if (questionProcessingId) return;
  const clean = String(answerBody ?? '').trim();
  // 답변 본문은 항상 필수다. 첨부 이미지가 있어도 이 검사를 건너뛰지 않는다
  // (questions_answer_files_answered_check 가 서버에서도 같은 규칙을 강제한다).
  if (!clean) { questionErrors.set(questionId, '답변 내용을 입력하세요.'); renderQuestionInbox(); return; }
  questionErrors.delete(questionId);
  questionProcessingId = questionId;
  renderQuestionInbox();

  const uploaded = [];
  try {
    for (const attachment of attachments) {
      // 경로 만들기 전에 질문 id 형식부터 확인한다. buildAnswerFilePath 가 던지면
      // 아래 catch 로 빠져 업로드를 하나도 하지 않는다.
      const path = buildAnswerFilePath(questionId, attachment.file.name, crypto.randomUUID());
      // 서버 정규식과 같은 조건을 한 번 더 확인한다. 어긋나면 업로드 자체를 하지 않는다.
      if (!isAnswerFilePathValid(path, questionId)) throw new Error('invalid answer file');
      const { error } = await supabase.storage.from('answer-files')
        .upload(path, attachment.file, { contentType: attachment.file.type });
      if (error) throw error;
      uploaded.push(path);
    }

    // 기존 2인자 호출과 같은 모양을 유지하되, 파일이 없을 때도 빈 배열을 명시해서 보낸다.
    // RPC 의 세 번째 인자는 기본값이 '{}' 라 생략해도 동작하지만, 값을 명시하는 편이
    // "이번 호출이 무엇을 보냈는지"를 코드에서 바로 알 수 있어 더 낫다.
    const { error } = await supabase.rpc('answer_question', {
      p_question_id: questionId,
      p_answer_body: clean,
      p_file_paths: uploaded,
    });
    if (error) throw error;

    questionDrafts.delete(questionId);
    clearAnswerAttachments(questionId);
    questionProcessingId = null;
    await loadQuestionInbox(); // status 가 open 이 아니게 되어 목록에서 빠진다
  } catch (error) {
    console.error(error);
    // DB 호출이 실패했으면 방금 올린 파일만 정리한다. 이전에 이미 답변된 첨부는 건드리지 않는다.
    let message = answerErrorMessage(error);
    if (uploaded.length) {
      const { error: cleanupError } = await supabase.storage.from('answer-files').remove(uploaded);
      if (cleanupError) {
        console.error('정리하지 못한 답변 이미지:', uploaded, cleanupError);
        message += ' 첨부 이미지 일부가 남아있을 수 있어요. 화면을 새로고침한 뒤 다시 시도해 주세요.';
      }
    }
    questionProcessingId = null;
    // 답변 본문과 첨부 선택은 지우지 않는다 — 실패해도 다시 입력할 필요가 없게 한다.
    questionErrors.set(questionId, message);
    renderQuestionInbox();
  }
}

async function closeQuestionEntry(questionId) {
  if (questionProcessingId) return;
  questionErrors.delete(questionId);
  questionProcessingId = questionId;
  renderQuestionInbox();
  try {
    const { error } = await supabase.rpc('close_question', { p_question_id: questionId });
    if (error) throw error;
    questionDrafts.delete(questionId);
    clearAnswerAttachments(questionId);
    questionProcessingId = null;
    await loadQuestionInbox();
  } catch (error) {
    questionProcessingId = null;
    questionErrors.set(questionId, error.message || '질문 닫기에 실패했습니다.');
    renderQuestionInbox();
  }
}

// ── 계정·과제 관리 (기존 동작 유지, 관계 정규화 적용) ─────────────────────
async function refreshAfterUserAction(action) {
  if (action === 'suspend' || action === 'reactivate') {
    await Promise.all([loadUsers(), loadQueue(), loadWorkflows(), loadOperationsSummary()]);
    return;
  }
  await loadUsers();
}
const usersRequestGate = createLatestRequestGate();
async function loadUsers() {
  const request = usersRequestGate.begin();
  let profilesResult;
  let rolesResult;
  try {
    [profilesResult, rolesResult] = await Promise.all([
      supabase.from('profiles').select('id,name,phone,suspended_at').order('name'),
      supabase.from('user_roles').select('user_id,role'),
    ]);
  } catch (error) {
    if (usersRequestGate.isLatest(request)) throw error;
    return;
  }
  if (!usersRequestGate.isLatest(request)) return;
  if (profilesResult.error) throw profilesResult.error;
  if (rolesResult.error) throw rolesResult.error;
  const roles = new Map(normalizeRelation(rolesResult.data).map((row) => [row.user_id, row.role]));
  const students = normalizeRelation(profilesResult.data)
    .filter((user) => roles.get(user.id) === 'student' && isActiveProfile(user));
  byId('assignmentStudent').replaceChildren(...students.map((student) => {
    const option = document.createElement('option'); option.value = student.id; option.textContent = student.name; return option;
  }));
  const cards = normalizeRelation(profilesResult.data).map((user) => {
    const role = roles.get(user.id) ?? '역할 없음';
    const roleKey = String(role || 'none').replace(/[^a-z0-9_-]/gi, '_');
    const card = document.createElement('article'); card.className = 'card admin-user-card user-role-' + roleKey;
    const name = document.createElement('h3'); name.textContent = user.name;
    const badgeLine = document.createElement('p');
    badgeLine.className = 'user-badge-line';
    const roleBadge = document.createElement('span');
    roleBadge.className = 'account-status user-role-badge role-' + roleKey;
    roleBadge.textContent = role === 'student' ? '학생' : role === 'admin' ? '관리자' : role;
    const statusBadge = document.createElement('span');
    statusBadge.className = 'account-status ' + (user.suspended_at ? 'status-suspended' : 'status-open');
    statusBadge.textContent = user.suspended_at ? '정지' : '활성';
    badgeLine.append(roleBadge, statusBadge);
    const meta = document.createElement('p'); meta.className = 'meta'; meta.textContent = user.phone; card.append(name, badgeLine, meta);
    const actions = [[user.suspended_at ? 'reactivate' : 'suspend', user.suspended_at ? '재활성화' : '정지']];
    if (role === 'student') actions.unshift(['reset', 'PIN 재설정']);
    for (const [action, label] of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', async () => {
        if (action === 'reset' && !confirm(user.name + ' 학생 PIN을 123456으로 초기화할까요? 학생은 로그인 후 새 PIN을 설정해야 합니다.')) return;
        button.disabled = true;
        try {
          await callAdmin({ action, userId: user.id });
          try {
            await refreshAfterUserAction(action);
          } catch (error) {
            console.warn('계정 작업 후 새로고침 실패:', error.message);
            showError(byId('adminError'), '계정 작업은 완료됐지만 화면 새로고침에 실패했습니다. 페이지를 새로고침해 주세요.');
          }
        } catch (error) { showError(byId('adminError'), error.message); }
        finally { button.disabled = false; }
      });
      card.append(button);
    }
    return card;
  });
  byId('users').replaceChildren(...cards);
  byId('userListSummaryCount').textContent = cards.length ? '사용자 ' + cards.length + '명' : '사용자 없음';
}

async function download(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
  if (error) throw error;
  location.assign(data.signedUrl);
}

function assignmentProfile(item) {
  return normalizeRelation(item.profiles)[0];
}
function assignmentStudent(item) {
  return assignmentProfile(item)?.name || '학생';
}
function dueText(item) {
  return item.due_at ? '마감 ' + new Date(item.due_at).toLocaleString('ko-KR') : '마감 없음';
}
function workflowCard(item) {
  const meta = adminWorkflowMeta(item);
  const card = document.createElement('article');
  card.className = 'card workflow-card workflow-' + meta.status;
  const heading = document.createElement('h3'); heading.textContent = assignmentStudent(item);
  const status = document.createElement('span'); status.className = 'workflow-status status-' + meta.status; status.textContent = meta.label;
  const title = document.createElement('p'); title.className = 'workflow-title'; title.textContent = item.title;
  const metaLine = document.createElement('p'); metaLine.className = 'meta'; metaLine.textContent = dueText(item);
  card.append(heading, status);
  if (assignmentProfile(item)?.suspended_at) {
    const accountStatus = document.createElement('span');
    accountStatus.className = 'account-status status-suspended';
    accountStatus.textContent = '정지 계정';
    card.append(accountStatus);
  }
  card.append(title, metaLine);
  if (item.description) { const description = document.createElement('p'); description.textContent = item.description; card.append(description); }

  const attempts = normalizeRelation(item.submissions).sort((a, b) => b.attempt_no - a.attempt_no);
  if (!attempts.length) { const empty = document.createElement('p'); empty.textContent = '아직 제출하지 않았습니다.'; card.append(empty); }
  for (const attempt of attempts) {
    const details = document.createElement('details'); details.className = 'attempt attempt-history';
    const summary = document.createElement('summary');
    summary.textContent = attempt.attempt_no + '차 제출 · ' + ({ submitted: '검토 대기', needs_revision: '수정 필요', completed: '완료' }[attempt.status] || attempt.status);
    details.append(summary);
    if (attempt.body) { const body = document.createElement('p'); body.textContent = attempt.body; details.append(body); }
    for (const path of attempt.file_paths || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary small'; button.textContent = '제출 파일 열기';
      button.addEventListener('click', async () => { button.disabled = true; try { await download('submission-files', path); } catch (error) { showError(byId('adminError'), error.message); button.disabled = false; } });
      details.append(button);
    }
    for (const internal of normalizeRelation(attempt.review_internal_notes)) {
      if (!internal?.note) continue;
      const box = document.createElement('p'); box.className = 'internal-note-history';
      box.textContent = '원장 내부 메모: ' + internal.note;
      details.append(box);
    }
    for (const note of normalizeRelation(attempt.feedback)) {
      const structured = normalizeRelation(note.feedback_items);
      for (const item of structured) {
        const text = document.createElement('p'); text.className = 'feedback';
        text.textContent = item.problem_ref + ' · ' + item.review_tag + (item.redo_required ? ' · 다시 풀기' : '') + (item.comment ? ' — ' + item.comment : '');
        details.append(text);
      }
      const autoComposed = isAutoComposedFeedback(note, structured);
      if (note.body && !autoComposed) { const text = document.createElement('p'); text.className = 'feedback'; text.textContent = '총평: ' + note.body; details.append(text); }
    }
    if (attempt.status === 'submitted') { const pending = document.createElement('p'); pending.className = 'meta'; pending.textContent = '과제 검토 탭에서 처리할 수 있습니다.'; details.append(pending); }
    card.append(details);
  }
  return card;
}

const OPERATIONS_SUMMARY_SELECT = 'id,title,due_at,profiles!assignments_student_id_fkey(name,suspended_at),submissions(attempt_no,status,submitted_at,reviewed_at)';
const QUESTION_SUMMARY_SELECT = 'id,profiles!questions_student_id_fkey(name,suspended_at)';
const operationsSummaryRequestGate = createLatestRequestGate();
async function fetchOperationsSummaryPage(cursor, pageSize) {
  let query = supabase.from('assignments').select(OPERATIONS_SUMMARY_SELECT)
    .order('id').limit(pageSize);
  if (cursor !== null) query = query.gt('id', cursor);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
async function fetchQuestionSummaryPage(cursor, pageSize) {
  let query = supabase.from('questions')
    .select(QUESTION_SUMMARY_SELECT)
    .eq('status', 'open')
    .order('id').limit(pageSize);
  if (cursor !== null) query = query.gt('id', cursor);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
async function fetchQuestionSummary() {
  const rows = await collectKeysetPages(fetchQuestionSummaryPage, REMOTE_PAGE_SIZE);
  return rows.filter((question) => isActiveProfile(normalizeRelation(question.profiles)[0]));
}
async function loadOperationsSummary() {
  const request = operationsSummaryRequestGate.begin();
  let assignments;
  let questions;
  try {
    [assignments, questions] = await Promise.all([
      collectKeysetPages(fetchOperationsSummaryPage, REMOTE_PAGE_SIZE),
      fetchQuestionSummary(),
    ]);
  } catch (error) {
    if (operationsSummaryRequestGate.isLatest(request)) throw error;
    return;
  }
  const activeAssignments = assignments.filter(isActiveStudentAssignment);
  const nextSummary = summarizeAdminWorkflows(activeAssignments);
  nextSummary.studentItems = summarizeStudentOperations(activeAssignments, new Date(), questions);
  if (!operationsSummaryRequestGate.isLatest(request)) return;
  operationsSummary = nextSummary;
  byId('principalCheckCount').textContent = String(operationsSummary.counts.principal_check);
  byId('queueCount').textContent = String(operationsSummary.counts.submitted);
  byId('revisionCount').textContent = String(operationsSummary.counts.needs_revision);
  byId('overdueCount').textContent = String(operationsSummary.counts.overdue);
  renderActionItems();
  renderStudentStatusItems();
}
function actionCard(entry) {
  const { assignment, status: state, label } = entry;
  const card = document.createElement('article');
  card.className = 'card workflow-card workflow-' + state;
  const heading = document.createElement('h3'); heading.textContent = assignmentStudent(assignment);
  const status = document.createElement('span'); status.className = 'workflow-status status-' + state; status.textContent = label;
  const title = document.createElement('p'); title.className = 'workflow-title'; title.textContent = assignment.title;
  const metaLine = document.createElement('p'); metaLine.className = 'meta'; metaLine.textContent = dueText(assignment);
  card.append(heading, status, title, metaLine);
  if (entry.reason) {
    const reason = document.createElement('p');
    reason.className = 'action-reason';
    reason.textContent = '사유: ' + entry.reason;
    card.append(reason);
  }
  if (entry.nextAction) {
    const next = document.createElement('p');
    next.className = 'action-next';
    next.textContent = '다음 조치: ' + entry.nextAction;
    card.append(next);
  }
  const actions = document.createElement('div');
  actions.className = 'action-card-actions';
  const showHistory = document.createElement('button');
  showHistory.type = 'button';
  showHistory.className = 'secondary small';
  showHistory.textContent = '이 학생 기록 보기';
  showHistory.addEventListener('click', () => setWorkflowStudentFilter(assignmentStudent(assignment)));
  actions.append(showHistory);
  card.append(actions);
  return card;
}
function renderActionItems() {
  const rows = operationsSummary.actionItems.filter((entry) => actionFilter === 'all' || entry.status === actionFilter);
  const copy = adminActionFilterCopy(actionFilter);
  byId('actionFilterStatus').textContent = copy.status;
  byId('actionSection').classList.toggle('action-section-filtered', actionFilter !== 'all');
  byId('actionShowAll').textContent = copy.resetLabel;
  byId('actionShowAll').setAttribute('aria-label', copy.resetAriaLabel);
  byId('actionShowAll').hidden = copy.clearHidden;
  byId('actionEmpty').querySelector('h3').textContent = copy.emptyTitle;
  byId('actionEmpty').querySelector('p').textContent = copy.emptyBody;
  byId('actionEmpty').hidden = Boolean(rows.length);
  byId('actionItems').replaceChildren(...rows.map(actionCard));
}
async function openStudentReview(studentName) {
  await switchTab('review');
  await loadQueue();
  const index = queue.findIndex((entry) => assignmentStudent(entry.assignment) === studentName);
  if (index >= 0) await openReview(index);
  byId('queue').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openStudentQuestions(studentName) {
  setQuestionStudentFilter(studentName);
}
function studentStatusCard(entry) {
  const copy = studentOperationStatusCopy(entry);
  const card = document.createElement('article');
  const statusKey = String(entry.status || 'open').replace(/[^a-z0-9_-]/gi, '_');
  card.className = 'card student-status-card student-status-' + statusKey;
  const heading = document.createElement('h3'); heading.textContent = entry.name;
  const label = document.createElement('span'); label.className = 'workflow-status status-' + statusKey; label.textContent = entry.label;
  const counts = document.createElement('p'); counts.className = 'meta';
  counts.textContent = copy.summary;
  const itemList = document.createElement('ul');
  itemList.className = 'student-status-items-list';
  itemList.replaceChildren(...entry.visibleItems.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  if (entry.hiddenItemCount) {
    const hidden = document.createElement('li');
    hidden.className = 'student-status-more';
    hidden.textContent = '외 ' + entry.hiddenItemCount + '건은 이 학생 기록에서 확인';
    itemList.append(hidden);
  }
  const next = document.createElement('p'); next.className = 'action-next'; next.textContent = '다음 조치: ' + entry.nextAction;
  const actions = document.createElement('div');
  actions.className = 'student-status-actions';
  const showHistory = document.createElement('button');
  showHistory.type = 'button';
  showHistory.className = 'secondary small';
  showHistory.textContent = copy.historyLabel;
  showHistory.setAttribute('aria-label', entry.name + ' 학생 과제 이력 보기');
  showHistory.addEventListener('click', () => setWorkflowStudentFilter(entry.name));
  const showReview = document.createElement('button');
  showReview.type = 'button';
  showReview.className = 'secondary small';
  showReview.textContent = copy.reviewLabel;
  showReview.setAttribute('aria-label', entry.name + ' 학생 검토 대기 ' + Number(entry.counts.submitted || 0) + '건 열기');
  showReview.hidden = !entry.counts.submitted;
  showReview.addEventListener('click', () => openStudentReview(entry.name).catch((error) => showError(byId('adminError'), error.message)));
  const showQuestions = document.createElement('button');
  showQuestions.type = 'button';
  showQuestions.className = 'secondary small';
  showQuestions.textContent = copy.questionsLabel;
  showQuestions.setAttribute('aria-label', entry.name + ' 학생 질문 ' + Number(entry.counts.questions || 0) + '건 보기');
  showQuestions.hidden = !entry.counts.questions;
  showQuestions.addEventListener('click', () => openStudentQuestions(entry.name));
  actions.append(showHistory, showReview, showQuestions);
  card.append(heading, label, counts, itemList, next, actions);
  return card;
}
function renderStudentStatusItems() {
  const rows = operationsSummary.studentItems || [];
  byId('studentStatusSummaryCount').textContent = rows.length ? '조치 학생 ' + rows.length + '명' : '조치 학생 없음';
  byId('studentStatusEmpty').hidden = Boolean(rows.length);
  byId('studentStatusItems').replaceChildren(...rows.map(studentStatusCard));
}
function setWorkflowStudentFilter(studentName) {
  workflowStudentFilter = studentName || '';
  workflowPage = 0;
  const copy = filteredAdminListCopy('workflows', workflowStudentFilter);
  byId('workflowFilterStatus').textContent = copy.status;
  byId('workflowFilterClear').textContent = copy.resetLabel;
  byId('workflowFilterClear').setAttribute('aria-label', copy.resetAriaLabel);
  byId('workflowFilterClear').hidden = copy.clearHidden;
  loadWorkflows()
    .then(() => byId('workflows').scrollIntoView({ behavior: 'smooth', block: 'start' }))
    .catch((error) => showError(byId('adminError'), error.message));
}
byId('workflowFilterClear').addEventListener('click', () => setWorkflowStudentFilter(''));

const WORKFLOW_PAGE_SIZE = 50;
const WORKFLOW_SELECT = 'id,title,description,due_at,profiles!assignments_student_id_fkey(name,suspended_at),submissions(id,attempt_no,status,body,file_paths,submitted_at,review_internal_notes(note,updated_at),feedback(body,auto_composed,created_at,feedback_items(problem_ref,review_tag,comment,redo_required)))';
const LEGACY_FEEDBACK_SELECT = 'id,title,description,due_at,profiles!assignments_student_id_fkey(name,suspended_at),submissions(id,attempt_no,status,body,file_paths,submitted_at,feedback(body,created_at,feedback_items(problem_ref,review_tag,comment,redo_required)))';
let workflowPage = 0;
let workflowStudentFilter = '';
const workflowsRequestGate = createLatestRequestGate();

function workflowQuery(select, from, to) {
  const effectiveSelect = workflowStudentFilter ? select.replace('profiles!assignments_student_id_fkey(', 'profiles!assignments_student_id_fkey!inner(') : select;
  let query = supabase.from('assignments').select(effectiveSelect, { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to);
  if (workflowStudentFilter) query = filterWorkflowsByStudent(query, workflowStudentFilter);
  return query;
}
function filterWorkflowsByStudent(query, studentName) {
  return query.eq('profiles.name', studentName);
}
async function loadWorkflows() {
  const request = workflowsRequestGate.begin();
  const page = workflowPage;
  byId('workflowPrev').disabled = true;
  byId('workflowNext').disabled = true;
  const from = page * WORKFLOW_PAGE_SIZE;
  const to = from + WORKFLOW_PAGE_SIZE - 1;
  let result;
  try {
    result = await workflowQuery(WORKFLOW_SELECT, from, to);
    if (!workflowsRequestGate.isLatest(request)) return;
    if (isMissingFeedbackSourceColumn(result.error)) {
      result = await workflowQuery(LEGACY_FEEDBACK_SELECT, from, to);
    }
  } catch (error) {
    if (workflowsRequestGate.isLatest(request)) throw error;
    return;
  }
  if (!workflowsRequestGate.isLatest(request) || page !== workflowPage) return;
  if (result.error) throw result.error;
  const { data, count } = result;
  const rows = normalizeRelation(data).filter((row) => !workflowStudentFilter || assignmentStudent(row) === workflowStudentFilter);
  const copy = filteredAdminListCopy('workflows', workflowStudentFilter);
  byId('workflows').replaceChildren(...rows.map(workflowCard));
  byId('workflowFilterStatus').textContent = copy.status;
  byId('workflowFilterClear').textContent = copy.resetLabel;
  byId('workflowFilterClear').setAttribute('aria-label', copy.resetAriaLabel);
  byId('workflowFilterClear').hidden = copy.clearHidden;
  byId('workflowEmpty').querySelector('h3').textContent = copy.emptyTitle;
  byId('workflowEmpty').querySelector('p').textContent = copy.emptyBody;
  byId('workflowEmpty').hidden = Boolean(rows.length);
  const total = count || 0;
  const last = Math.min(from + rows.length, total);
  byId('workflowPageStatus').textContent = total ? (from + 1) + '–' + last + ' / ' + total : '과제 없음';
  byId('workflowHistorySummaryCount').textContent = total ? '과제 ' + total + '건' : '과제 없음';
  byId('workflowPrev').disabled = page === 0;
  byId('workflowNext').disabled = to + 1 >= total;
}
async function changeWorkflowPage(delta) {
  const previousPage = workflowPage;
  workflowPage += delta;
  try { await loadWorkflows(); }
  catch (error) {
    workflowPage = previousPage;
    byId('workflowPrev').disabled = workflowPage === 0;
    byId('workflowNext').disabled = false;
    throw error;
  }
}
byId('workflowPrev').addEventListener('click', () => {
  if (workflowPage > 0) changeWorkflowPage(-1).catch((error) => showError(byId('adminError'), error.message));
});
byId('workflowNext').addEventListener('click', () => {
  changeWorkflowPage(1).catch((error) => showError(byId('adminError'), error.message));
});

byId('accountForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const output = byId('accountResult'); const button = form.querySelector('button'); button.disabled = true;
  try {
    const input = validateAccountInput(Object.fromEntries(new FormData(form)));
    await callAdmin({ action: 'create', ...input });
    output.textContent = '계정을 발급했습니다.';
    form.reset();
    try {
      await loadUsers();
    } catch (error) {
      console.warn('계정 발급 후 새로고침 실패:', error.message);
      output.textContent = '계정 발급은 완료됐지만 화면 새로고침에 실패했습니다. 페이지를 새로고침해 주세요.';
    }
  } catch (error) { output.textContent = error.message; } finally { button.disabled = false; }
});

byId('assignmentForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const output = byId('assignmentResult'); const button = form.querySelector('button');
  const data = new FormData(form); const file = data.get('attachment'); const paths = []; let inserted = false; button.disabled = true;
  try {
    const title = String(data.get('title') || '').trim();
    if (!title || title.length > 120) throw new Error('제목은 1~120자로 입력하세요.');
    if (file?.size) {
      const path = currentAdmin.id + '/' + crypto.randomUUID() + '-' + safeName(file.name);
      const { error } = await supabase.storage.from('assignment-files').upload(path, file);
      if (error) throw error; paths.push(path);
    }
    const due = data.get('due_at');
    const { error } = await supabase.from('assignments').insert({
      student_id: data.get('student_id'), created_by: currentAdmin.id, title,
      description: String(data.get('description') || '').trim(),
      due_at: due ? new Date(due).toISOString() : null, attachment_paths: paths,
    });
    if (error) throw error;
    inserted = true;
    workflowPage = 0;
    output.textContent = '과제를 등록했습니다.';
    form.reset();
    try {
      await Promise.all([loadQueue(), loadWorkflows(), loadOperationsSummary()]);
    } catch (refreshError) {
      console.warn('과제 등록 후 새로고침 실패:', refreshError.message);
      output.textContent = '과제 등록은 완료됐지만 화면 새로고침에 실패했습니다. 페이지를 새로고침해 주세요.';
    }
  } catch (error) { if (!inserted) await cleanup('assignment-files', paths); output.textContent = error.message; }
  finally { button.disabled = false; }
});

// ── 로그인 / PIN / 부팅 ──────────────────────────────────────────────────
async function showAdmin(user) {
  currentAdmin = user; await ensureAdmin(user);
  const { data: profile, error } = await supabase.from('profiles').select('name,must_change_pin').eq('id', user.id).single();
  if (error) throw error;
  if (profile.must_change_pin) {
    byId('login').hidden = true; byId('logout').hidden = false;
    byId('admin').hidden = true; byId('pinChange').hidden = false; return;
  }
  await switchTab('review');
  await loadQueue();
  await loadOperationsSummary();
  await loadQuestionCount();
  byId('login').hidden = true; byId('logout').hidden = false;
  byId('pinChange').hidden = true; byId('admin').hidden = false;
}
byId('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const output = byId('loginError'); showError(output, '');
  try {
    const input = validateLoginInput(byId('phone').value, byId('pin').value);
    const result = await signIn(input.phone, input.pin);
    await showAdmin(result.user);
  } catch (error) { showError(output, authErrorMessage(error)); }
});
byId('pinChangeForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const output = byId('pinChangeError'); const button = form.querySelector('button'); showError(output, '');
  try {
    const pin = validatePin(byId('newPin').value);
    if (pin !== byId('confirmPin').value) throw new Error('새 PIN이 일치하지 않습니다.');
    button.disabled = true;
    const { data: { user: currentUser }, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    if (!currentUser?.email) throw new Error('다시 로그인하세요.');
    await invokeAuthenticated('change-pin', { pin });
    const result = await signIn(currentUser.email.split('@')[0], pin);
    form.reset(); await showAdmin(result.user);
  } catch (error) { showError(output, authErrorMessage(error)); } finally { button.disabled = false; }
});
byId('logout').addEventListener('click', async () => { await signOut(); location.reload(); });

try {
  const currentUser = await currentUserOrNull();
  if (currentUser) await showAdmin(currentUser);
} catch (error) {
  showError(byId('loginError'), authErrorMessage(error));
}
