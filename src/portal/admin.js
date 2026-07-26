// 적용 경로: src/portal/admin.js (전체 교체)
import './portal.css';
import { invokeAuthenticated, isMissingFeedbackSourceColumn, isMissingExplicitFeedbackRpc, supabase } from './client.js';
import {
  validatePin, validateLoginInput, validateAccountInput, normalizeRelation,
  waitingLabel, REVIEW_TAGS, validateProblemRef,
  validateFeedbackItems, checkItemsForStatus, composeFeedbackBody, isAutoComposedFeedback,
} from './domain.js';
import { signIn, signOut } from '../auth.js';

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
async function switchTab(tab) {
  const review = tab === 'review';
  byId('reviewSection').hidden = !review;
  byId('noSelection').hidden = !review || Boolean(current);
  byId('manageSection').hidden = review;
  byId('tabReview').setAttribute('aria-pressed', String(review));
  byId('tabManage').setAttribute('aria-pressed', String(!review));
  if (!review) await Promise.all([loadUsers(), loadWorkflows()]);
}
byId('tabReview').addEventListener('click', () => switchTab('review').catch((error) => showError(byId('adminError'), error.message)));
byId('tabManage').addEventListener('click', () => switchTab('manage').catch((error) => showError(byId('adminError'), error.message)));

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

async function loadQueue() {
  const { data, error } = await supabase.from('submissions')
    .select('id,attempt_no,status,body,file_paths,submitted_at,assignments!inner(id,title,due_at,profiles!assignments_student_id_fkey(name))')
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  queue = normalizeRelation(data).map((attempt) => ({
    assignment: normalizeRelation(attempt.assignments)[0],
    attempt,
  })).filter((entry) => entry.assignment);
  byId('queueCount').textContent = String(queue.length);
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
  renderTagChips(); renderItems();

  const student = normalizeRelation(entry.assignment.profiles)[0]?.name || '학생';
  byId('reviewHead').textContent = student + ' · ' + entry.assignment.title + ' · ' + entry.attempt.attempt_no + '차 제출 · ' + waitingLabel(entry.attempt.submitted_at);
  byId('attemptBody').textContent = entry.attempt.body ? '제출 내용: ' + entry.attempt.body : '';
  await showImage(0);
  await loadQueue(); // active 표시 갱신

  // 검토 시작 이벤트 (실패해도 검토는 진행)
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
    processing = true; buttons.forEach((b) => { b.disabled = true; });
    let result = await supabase.rpc('review_submission_v2', {
      p_submission_id: current.attempt.id, p_body: body, p_status: status,
      p_items: validItems, p_auto_composed: autoComposed,
    });
    if (isMissingExplicitFeedbackRpc(result.error)) {
      result = await supabase.rpc('review_submission_v2', {
        p_submission_id: current.attempt.id, p_body: body, p_status: status,
        p_items: validItems,
      });
    }
    if (result.error) throw result.error;
    const decidedId = current.attempt.id;
    current = null;
    byId('reviewDetail').hidden = true;
    await loadQueue();
    const next = queue.findIndex((entry) => entry.attempt.id !== decidedId);
    if (next >= 0) await openReview(next);
    else byId('noSelection').hidden = false;
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

// ── 계정·과제 관리 (기존 동작 유지, 관계 정규화 적용) ─────────────────────
async function loadUsers() {
  const [profilesResult, rolesResult] = await Promise.all([
    supabase.from('profiles').select('id,name,phone,suspended_at').order('name'),
    supabase.from('user_roles').select('user_id,role'),
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (rolesResult.error) throw rolesResult.error;
  const roles = new Map(normalizeRelation(rolesResult.data).map((row) => [row.user_id, row.role]));
  const students = normalizeRelation(profilesResult.data).filter((user) => roles.get(user.id) === 'student');
  byId('assignmentStudent').replaceChildren(...students.map((student) => {
    const option = document.createElement('option'); option.value = student.id; option.textContent = student.name; return option;
  }));
  const cards = normalizeRelation(profilesResult.data).map((user) => {
    const card = document.createElement('article'); card.className = 'card';
    const name = document.createElement('h3'); name.textContent = user.name;
    const role = roles.get(user.id) ?? '역할 없음';
    const meta = document.createElement('p'); meta.textContent = user.phone + ' · ' + role; card.append(name, meta);
    const actions = [[user.suspended_at ? 'reactivate' : 'suspend', user.suspended_at ? '재활성화' : '정지']];
    if (role === 'student') actions.unshift(['reset', 'PIN 재설정']);
    for (const [action, label] of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', async () => {
        if (action === 'reset' && !confirm(user.name + ' 학생 PIN을 123456으로 초기화할까요? 학생은 로그인 후 새 PIN을 설정해야 합니다.')) return;
        button.disabled = true;
        try { await callAdmin({ action, userId: user.id }); await loadUsers(); }
        catch (error) { showError(byId('adminError'), error.message); }
        finally { button.disabled = false; }
      });
      card.append(button);
    }
    return card;
  });
  byId('users').replaceChildren(...cards);
}

async function download(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
  if (error) throw error;
  location.assign(data.signedUrl);
}

function workflowCard(item) {
  const card = document.createElement('article'); card.className = 'card';
  const title = document.createElement('h3'); title.textContent = item.title;
  const student = normalizeRelation(item.profiles)[0]?.name || '학생';
  const meta = document.createElement('p'); meta.className = 'meta';
  meta.textContent = student + (item.due_at ? ' · 마감 ' + new Date(item.due_at).toLocaleString('ko-KR') : '');
  card.append(title, meta);
  if (item.description) { const description = document.createElement('p'); description.textContent = item.description; card.append(description); }

  const attempts = normalizeRelation(item.submissions).sort((a, b) => a.attempt_no - b.attempt_no);
  if (!attempts.length) { const empty = document.createElement('p'); empty.textContent = '아직 제출하지 않았습니다.'; card.append(empty); }
  for (const attempt of attempts) {
    const section = document.createElement('section'); section.className = 'attempt';
    const heading = document.createElement('h4');
    heading.textContent = attempt.attempt_no + '차 제출 · ' + ({ submitted: '검토 대기', needs_revision: '수정 필요', completed: '완료' }[attempt.status] || attempt.status);
    section.append(heading);
    if (attempt.body) { const body = document.createElement('p'); body.textContent = attempt.body; section.append(body); }
    for (const path of attempt.file_paths || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary small'; button.textContent = '제출 파일 열기';
      button.addEventListener('click', async () => { button.disabled = true; try { await download('submission-files', path); } catch (error) { showError(byId('adminError'), error.message); button.disabled = false; } });
      section.append(button);
    }
    for (const note of normalizeRelation(attempt.feedback)) {
      const structured = normalizeRelation(note.feedback_items);
      for (const item of structured) {
        const text = document.createElement('p'); text.className = 'feedback';
        text.textContent = item.problem_ref + ' · ' + item.review_tag + (item.redo_required ? ' · 다시 풀기' : '') + (item.comment ? ' — ' + item.comment : '');
        section.append(text);
      }
      const autoComposed = isAutoComposedFeedback(note, structured);
      if (note.body && !autoComposed) { const text = document.createElement('p'); text.className = 'feedback'; text.textContent = '총평: ' + note.body; section.append(text); }
    }
    if (attempt.status === 'submitted') { const pending = document.createElement('p'); pending.className = 'meta'; pending.textContent = '과제 검토 탭에서 처리할 수 있습니다.'; section.append(pending); }
    card.append(section);
  }
  return card;
}

const WORKFLOW_PAGE_SIZE = 50;
const WORKFLOW_SELECT = 'id,title,description,due_at,profiles!assignments_student_id_fkey(name),submissions(id,attempt_no,status,body,file_paths,submitted_at,feedback(body,auto_composed,created_at,feedback_items(problem_ref,review_tag,comment,redo_required)))';
const LEGACY_FEEDBACK_SELECT = 'id,title,description,due_at,profiles!assignments_student_id_fkey(name),submissions(id,attempt_no,status,body,file_paths,submitted_at,feedback(body,created_at,feedback_items(problem_ref,review_tag,comment,redo_required)))';
let workflowPage = 0;

function workflowQuery(select, from, to) {
  return supabase.from('assignments').select(select, { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to);
}
async function loadWorkflows() {
  byId('workflowPrev').disabled = true;
  byId('workflowNext').disabled = true;
  const from = workflowPage * WORKFLOW_PAGE_SIZE;
  const to = from + WORKFLOW_PAGE_SIZE - 1;
  let result = await workflowQuery(WORKFLOW_SELECT, from, to);
  if (isMissingFeedbackSourceColumn(result.error)) {
    result = await workflowQuery(LEGACY_FEEDBACK_SELECT, from, to);
  }
  if (result.error) throw result.error;
  const { data, count } = result;
  const rows = normalizeRelation(data);
  byId('workflows').replaceChildren(...rows.map(workflowCard));
  const total = count || 0;
  const last = Math.min(from + rows.length, total);
  byId('workflowPageStatus').textContent = total ? (from + 1) + '–' + last + ' / ' + total : '과제 없음';
  byId('workflowPrev').disabled = workflowPage === 0;
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
    output.textContent = '계정을 발급했습니다.'; form.reset(); await loadUsers();
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
    if (error) throw error; inserted = true;
    workflowPage = 0; output.textContent = '과제를 등록했습니다.'; form.reset(); await Promise.all([loadQueue(), loadWorkflows()]);
  } catch (error) { if (!inserted) await cleanup('assignment-files', paths); output.textContent = error.message; }
  finally { button.disabled = false; }
});

// ── 로그인 / PIN / 부팅 ──────────────────────────────────────────────────
async function showAdmin(user) {
  currentAdmin = user; await ensureAdmin(user);
  const { data: profile, error } = await supabase.from('profiles').select('name,must_change_pin').eq('id', user.id).single();
  if (error) throw error;
  byId('login').hidden = true; byId('logout').hidden = false;
  if (profile.must_change_pin) { byId('admin').hidden = true; byId('pinChange').hidden = false; return; }
  byId('pinChange').hidden = true; byId('admin').hidden = false;
  await switchTab('review');
  await loadQueue();
}
byId('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const output = byId('loginError'); showError(output, '');
  try {
    const input = validateLoginInput(byId('phone').value, byId('pin').value);
    const result = await signIn(input.phone, input.pin);
    await showAdmin(result.user);
  } catch (error) { showError(output, error.message); }
});
byId('pinChangeForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const output = byId('pinChangeError'); const button = form.querySelector('button'); showError(output, '');
  try {
    const pin = validatePin(byId('newPin').value);
    if (pin !== byId('confirmPin').value) throw new Error('새 PIN이 일치하지 않습니다.');
    button.disabled = true;
    const { data: { user: currentUser }, error: userError } = await supabase.auth.getUser();
    if (userError || !currentUser?.email) throw new Error('다시 로그인하세요.');
    await invokeAuthenticated('change-pin', { pin });
    const result = await signIn(currentUser.email.split('@')[0], pin);
    form.reset(); await showAdmin(result.user);
  } catch (error) { showError(output, error.message); } finally { button.disabled = false; }
});
byId('logout').addEventListener('click', async () => { await signOut(); location.reload(); });

const { data: { user } } = await supabase.auth.getUser();
if (user) showAdmin(user).catch((error) => showError(byId('loginError'), error.message));
