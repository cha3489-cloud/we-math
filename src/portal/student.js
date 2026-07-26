// 적용 경로: src/portal/student.js (전체 교체)
import './portal.css';
import { invokeAuthenticated, isMissingFeedbackSourceColumn, supabase } from './client.js';
import {
  validatePin, validateLoginInput, validateSubmissionInput, assignmentStatus,
  latestAttempt, canSubmitAttempt, normalizeRelation, groupAssignments,
  redoProblems, allFeedbackItems, isAutoComposedFeedback, assessImageQuality, STATUS_META,
  authErrorMessage,
} from './domain.js';
import { signIn, signOut } from '../auth.js';

const byId = (id) => document.getElementById(id);
const showError = (el, message) => { el.textContent = message || ''; };

async function requireStudent(user) {
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', user.id).single();
  if (error || data?.role !== 'student') { await signOut(); throw new Error('학생 계정으로 로그인하세요.'); }
}
async function cleanup(paths) { if (paths.length) await supabase.storage.from('submission-files').remove(paths); }

// ── 인라인 파일 뷰어 (다운로드 대신 화면에서 확인) ───────────────────────
let viewerRequest = 0;
let viewerReturnFocus = null;
async function openViewer(path) {
  const request = ++viewerRequest;
  const overlay = byId('viewerOverlay');
  const image = byId('viewerImage');
  const frame = byId('viewerFrame');
  viewerReturnFocus = document.activeElement;
  image.src = ''; frame.src = '';
  showError(byId('viewerError'), '');
  overlay.hidden = false; overlay.focus();
  const { data, error } = await supabase.storage.from('submission-files').createSignedUrl(path, 60);
  if (request !== viewerRequest) return;
  if (error) { showError(byId('viewerError'), '제출 파일을 불러오지 못했습니다. 다시 시도해 주세요.'); return; }
  const pdf = /[.]pdf$/i.test(path);
  image.hidden = pdf; frame.hidden = !pdf;
  if (pdf) frame.src = data.signedUrl;
  else image.src = data.signedUrl;
}
function closeViewer() {
  viewerRequest += 1;
  byId('viewerOverlay').hidden = true;
  byId('viewerImage').src = '';
  byId('viewerFrame').src = '';
  if (viewerReturnFocus instanceof HTMLElement) viewerReturnFocus.focus();
}
byId('viewerClose').addEventListener('click', closeViewer);
byId('viewerOverlay').addEventListener('keydown', (event) => { if (event.key === 'Escape') closeViewer(); });

// ── 업로드 전 품질 분석: 실패해도 제출은 막지 않음 ───────────────────────
async function analyzeImage(file) {
  try {
    if (!file.type.startsWith('image/')) return null;
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, 512 / Math.max(width, height));
    const cw = Math.max(2, Math.round(width * scale));
    const ch = Math.max(2, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, cw, ch);
    const gray = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - cw] - gray[i + cw];
      sum += v; sumSq += v * v; n++;
    }
    const mean = sum / n;
    return { width, height, blurScore: sumSq / n - mean * mean };
  } catch { return null; }
}

// ── 대시보드 ────────────────────────────────────────────────────────────
const ASSIGNMENTS_SELECT = 'id,title,description,due_at,attachment_paths,submissions(id,attempt_no,status,body,file_paths,submitted_at,reviewed_at,feedback(body,auto_composed,created_at,feedback_items(problem_ref,review_tag,comment,redo_required)))';
const LEGACY_FEEDBACK_SELECT = 'id,title,description,due_at,attachment_paths,submissions(id,attempt_no,status,body,file_paths,submitted_at,reviewed_at,feedback(body,created_at,feedback_items(problem_ref,review_tag,comment,redo_required)))';
function assignmentsQuery(select, userId) {
  return supabase.from('assignments').select(select).eq('student_id', userId).order('due_at');
}
async function loadDashboard(user) {
  await requireStudent(user);
  const { data: profile, error: profileError } = await supabase.from('profiles').select('name,must_change_pin').eq('id', user.id).single();
  if (profileError) throw profileError;
  if (profile.must_change_pin) {
    byId('login').hidden = true; byId('logout').hidden = false;
    byId('dashboard').hidden = true; byId('pinChange').hidden = false; return;
  }
  let result = await assignmentsQuery(ASSIGNMENTS_SELECT, user.id);
  if (isMissingFeedbackSourceColumn(result.error)) {
    result = await assignmentsQuery(LEGACY_FEEDBACK_SELECT, user.id);
  }
  if (result.error) throw result.error;
  byId('studentName').textContent = profile.name;
  renderGroups(result.data || [], user.id);
  byId('dashboard').hidden = false;
  byId('login').hidden = true; byId('logout').hidden = false;
  byId('pinChange').hidden = true;
}

function renderGroups(assignments, userId) {
  const groups = groupAssignments(assignments);
  const summary = [];
  if (groups.redo.length) summary.push('✏️ 다시 낼 과제 ' + groups.redo.length + '건');
  if (groups.open.length) summary.push('📝 제출할 과제 ' + groups.open.length + '건');
  if (!summary.length && groups.review.length) summary.push('⏳ 선생님이 확인하고 있어요');
  if (!summary.length && !groups.review.length) summary.push('오늘 할 일을 모두 마쳤어요 ✅');
  byId('summary').textContent = '오늘 할 일: ' + summary.join(' · ');
  byId('empty').hidden = Boolean(assignments.length);
  document.querySelector('.mobile-action-bar').hidden = !assignments.length;
  const sections = [['groupRedo', groups.redo], ['groupOpen', groups.open], ['groupReview', groups.review], ['groupDone', groups.done]];
  for (const [sectionId, list] of sections) {
    const section = byId(sectionId);
    section.hidden = !list.length;
    section.querySelector('.cards').replaceChildren(...list.map((item) => assignmentCard(item, userId)));
  }
}

function statusBadge(status) {
  const meta = STATUS_META[status] || { icon: '', label: status };
  const badge = document.createElement('span');
  badge.className = 'badge badge-' + status;
  badge.textContent = meta.icon + ' ' + meta.label;
  return badge;
}

function assignmentCard(item, userId) {
  const card = document.createElement('article'); card.className = 'card';
  const attempts = normalizeRelation(item.submissions).sort((a, b) => a.attempt_no - b.attempt_no);
  const latest = latestAttempt(attempts);
  const status = assignmentStatus(item);

  const title = document.createElement('h3'); title.textContent = item.title;
  const meta = document.createElement('p'); meta.className = 'meta';
  meta.textContent = item.due_at ? '마감 ' + new Date(item.due_at).toLocaleString('ko-KR') : '';
  card.append(title, statusBadge(status), meta);
  if (item.description) { const desc = document.createElement('p'); desc.textContent = item.description; card.append(desc); }

  for (const path of item.attachment_paths || []) {
    const link = document.createElement('button'); link.type = 'button'; link.className = 'secondary'; link.textContent = '📄 과제 파일 받기';
    link.addEventListener('click', async () => {
      const { data, error } = await supabase.storage.from('assignment-files').createSignedUrl(path, 60);
      if (error) showError(byId('globalError'), '파일을 불러오지 못했습니다. 다시 시도해 주세요.');
      else location.assign(data.signedUrl);
    });
    card.append(link);
  }

  // 최신 피드백: 다시 확인할 부분과 다음 행동 중심
  if (latest && (latest.status === 'needs_revision' || latest.status === 'completed')) {
    card.append(feedbackBlock(latest));
  }

  // 제출 이력 (간결)
  for (const attempt of attempts) {
    const line = document.createElement('p'); line.className = 'meta';
    line.textContent = attempt.attempt_no + '차 제출 · ' + new Date(attempt.submitted_at).toLocaleDateString('ko-KR');
    card.append(line);
    for (const path of attempt.file_paths || []) {
      const view = document.createElement('button'); view.type = 'button'; view.className = 'secondary small'; view.textContent = '📎 내 제출 파일 보기';
      view.addEventListener('click', () => openViewer(path));
      card.append(view);
    }
  }

  if (canSubmitAttempt(attempts)) card.append(submissionForm(item, userId, latest ? '수정해서 다시 제출' : '과제 제출'));
  return card;
}

function feedbackBlock(attempt) {
  const box = document.createElement('div'); box.className = 'feedback';
  const items = allFeedbackItems(attempt.feedback);
  const redo = redoProblems(attempt.feedback);
  const heading = document.createElement('p'); heading.className = 'feedback-title';
  heading.textContent = attempt.status === 'completed' ? '✅ 이번 과제는 완료됐어요' : '✏️ 다시 확인할 부분';
  box.append(heading);
  if (redo.length) {
    const redoLine = document.createElement('p'); redoLine.className = 'redo';
    redoLine.textContent = '다시 풀 문제: ' + redo.join(', ');
    box.append(redoLine);
  }
  for (const item of items) {
    const line = document.createElement('p');
    line.textContent = item.problem_ref + ' · ' + item.review_tag + (item.comment ? ' — ' + item.comment : '');
    box.append(line);
  }
  for (const note of normalizeRelation(attempt.feedback)) {
    const bodyText = String(note?.body || '');
    const autoComposed = isAutoComposedFeedback(note, items);
    if (bodyText && !autoComposed) {
      const body = document.createElement('p'); body.className = 'meta'; body.textContent = bodyText; box.append(body);
    }
  }
  const next = document.createElement('p'); next.className = 'next-action';
  next.textContent = attempt.status === 'completed'
    ? '다음 행동: 다음 과제로 넘어가면 돼요.'
    : '다음 행동: 표시된 문제를 다시 풀어 사진이나 PDF로 제출해 주세요.';
  box.append(next);
  return box;
}

// ── 제출 폼: 미리보기 + 삭제 + 품질 경고 + 인라인 오류 ────────────────────
function submissionForm(item, userId, label) {
  const form = document.createElement('form'); form.className = 'submit-form';
  const body = document.createElement('textarea'); body.placeholder = '풀이 과정이나 질문을 적어주세요. (선택)';
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.pdf,image/jpeg,image/png,image/webp'; fileInput.multiple = true; fileInput.hidden = true;
  const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'secondary'; pick.textContent = '📎 파일 선택';
  const thumbs = document.createElement('div'); thumbs.className = 'thumbs';
  const errorBox = document.createElement('p'); errorBox.className = 'error'; errorBox.setAttribute('role', 'alert');
  const submit = document.createElement('button'); submit.textContent = label;
  form.append(body, pick, fileInput, thumbs, submit, errorBox);

  let selected = []; // { file, url, warnings }
  let selectingFiles = false;

  function renderThumbs() {
    thumbs.replaceChildren(...selected.map((entry, index) => {
      const wrap = document.createElement('figure'); wrap.className = 'thumb';
      if (entry.url) { const img = document.createElement('img'); img.src = entry.url; img.alt = '선택한 사진 ' + (index + 1); wrap.append(img); }
      else { const doc = document.createElement('span'); doc.className = 'thumb-doc'; doc.textContent = '📄 ' + entry.file.name; wrap.append(doc); }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'thumb-remove'; remove.setAttribute('aria-label', '이 파일 삭제'); remove.textContent = '✕';
      remove.addEventListener('click', () => {
        if (entry.url) URL.revokeObjectURL(entry.url);
        selected = selected.filter((_, i) => i !== index);
        renderThumbs();
      });
      wrap.append(remove);
      for (const warning of entry.warnings) {
        const note = document.createElement('figcaption'); note.className = 'warn';
        note.textContent = '⚠ ' + warning.message + ' 그래도 제출은 가능해요.';
        wrap.append(note);
      }
      return wrap;
    }));
    pick.textContent = selected.length ? '📎 파일 추가 (' + selected.length + '/3)' : '📎 파일 선택';
  }

  pick.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    if (selectingFiles) return;
    selectingFiles = true; pick.disabled = true; showError(errorBox, '');
    const chosen = [...fileInput.files];
    try {
      for (const file of chosen) {
        if (selected.length >= 3) { showError(errorBox, '파일은 최대 3개까지 올릴 수 있어요.'); break; }
        const metrics = await analyzeImage(file);
        selected.push({
          file,
          url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
          warnings: assessImageQuality(metrics),
        });
      }
    } finally {
      fileInput.value = ''; selectingFiles = false; pick.disabled = false; renderThumbs();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault(); showError(errorBox, ''); submit.disabled = true;
    const paths = []; let inserted = false;
    try {
      const files = selected.map((entry) => entry.file);
      const input = validateSubmissionInput(body.value, files);
      for (const upload of files) {
        const safe = upload.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = userId + '/' + item.id + '/' + crypto.randomUUID() + '-' + safe;
        const { error } = await supabase.storage.from('submission-files').upload(path, upload);
        if (error) throw error;
        paths.push(path);
      }
      const { error } = await supabase.from('submissions').insert({ assignment_id: item.id, student_id: userId, body: input.body, file_paths: paths });
      if (error) throw error;
      inserted = true;
      selected.forEach((entry) => entry.url && URL.revokeObjectURL(entry.url));
      await loadDashboard({ id: userId }); // 제출 직후 '선생님 확인 중' 상태로 갱신
    } catch (error) {
      if (!inserted) await cleanup(paths);
      showError(errorBox, error.message || '제출에 실패했습니다. 다시 시도해 주세요.');
      submit.disabled = false;
    }
  });
  return form;
}

// ── 로그인 / PIN / 로그아웃 (기존 흐름 유지) ─────────────────────────────
byId('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); showError(byId('loginError'), '');
  try {
    const input = validateLoginInput(byId('phone').value, byId('pin').value);
    const result = await signIn(input.phone, input.pin);
    await loadDashboard(result.user);
  } catch (error) { showError(byId('loginError'), authErrorMessage(error)); }
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
    form.reset(); await loadDashboard(result.user);
  } catch (error) { showError(output, authErrorMessage(error)); } finally { button.disabled = false; }
});
byId('logout').addEventListener('click', async () => { await signOut(); location.reload(); });

const { data: userData, error: userError } = await supabase.auth.getUser();
if (userError) showError(byId('loginError'), authErrorMessage(userError));
else if (userData?.user) loadDashboard(userData.user).catch((error) => showError(byId('loginError'), authErrorMessage(error)));
