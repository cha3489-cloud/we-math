import './portal.css';
import { invokeAuthenticated, supabase } from './client.js';
import { validatePin, validateLoginInput, validateAccountInput, latestAttempt } from './domain.js';
import { signIn, signOut } from '../auth.js';
const byId = (id) => document.getElementById(id);
let currentAdmin;
async function ensureAdmin(user) {
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', user.id).single();
  if (error || data?.role !== 'admin') { await signOut(); throw new Error('관리자 권한이 필요합니다.'); }
}
async function callAdmin(payload) {
  return invokeAuthenticated('admin-users', payload);
}
function safeName(name) { return name.replace(/[^a-zA-Z0-9._-]/g, '_'); }
async function cleanup(bucket, paths) { if (paths.length) await supabase.storage.from(bucket).remove(paths); }
async function loadUsers() {
  const [profilesResult, rolesResult] = await Promise.all([
    supabase.from('profiles').select('id,name,phone,suspended_at').order('name'),
    supabase.from('user_roles').select('user_id,role'),
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (rolesResult.error) throw rolesResult.error;
  const roles = new Map((rolesResult.data || []).map((row) => [row.user_id, row.role]));
  const students = (profilesResult.data || []).filter((user) => roles.get(user.id) === 'student');
  byId('assignmentStudent').replaceChildren(...students.map((student) => { const option = document.createElement('option'); option.value = student.id; option.textContent = student.name; return option; }));
  const cards = (profilesResult.data || []).map((user) => {
    const card = document.createElement('article'); card.className = 'card';
    const name = document.createElement('h2'); name.textContent = user.name;
    const meta = document.createElement('p'); meta.textContent = user.phone + ' · ' + (roles.get(user.id) || 'student'); card.append(name, meta);
    for (const [action, label] of [['reset', 'PIN 재설정'], [user.suspended_at ? 'reactivate' : 'suspend', user.suspended_at ? '재활성화' : '정지']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', async () => { const newPin = action === 'reset' ? prompt('새 숫자 6자리 PIN') : undefined; if (action === 'reset' && !newPin) return; try { if (action === 'reset') validatePin(newPin); await callAdmin({ action, userId: user.id, pin: newPin }); await loadUsers(); } catch (error) { alert(error.message); } }); card.append(button);
    }
    return card;
  });
  byId('users').replaceChildren(...cards);
}
function workflowCard(item) {
  const card = document.createElement('article'); card.className = 'card';
  const title = document.createElement('h2'); title.textContent = item.title;
  const meta = document.createElement('p'); meta.className = 'meta'; meta.textContent = (item.profiles?.name || '학생') + (item.due_at ? ' · 마감 ' + new Date(item.due_at).toLocaleString('ko-KR') : '');
  card.append(title, meta);
  const attempts = [...(item.submissions || [])].sort((a, b) => a.attempt_no - b.attempt_no);
  if (!attempts.length) { const empty = document.createElement('p'); empty.textContent = '아직 제출하지 않았습니다.'; card.append(empty); }
  for (const attempt of attempts) {
    const section = document.createElement('section'); section.className = 'attempt';
    const heading = document.createElement('h3'); heading.textContent = attempt.attempt_no + '차 제출 · ' + ({ submitted: '검토 대기', needs_revision: '수정 필요', completed: '완료' }[attempt.status] || attempt.status); section.append(heading);
    if (attempt.body) { const body = document.createElement('p'); body.textContent = attempt.body; section.append(body); }
    for (const path of attempt.file_paths || []) { const button = document.createElement('button'); button.type = 'button'; button.textContent = '제출 파일 받기'; button.addEventListener('click', () => download('submission-files', path)); section.append(button); }
    for (const note of attempt.feedback || []) { const text = document.createElement('p'); text.className = 'feedback'; text.textContent = '피드백: ' + note.body; section.append(text); }
    if (attempt === latestAttempt(attempts) && attempt.status === 'submitted') {
      const form = document.createElement('form'); const feedback = document.createElement('textarea'); feedback.required = true; feedback.maxLength = 4000; feedback.placeholder = '학생에게 전달할 피드백';
      const revise = document.createElement('button'); revise.textContent = '수정 필요'; revise.value = 'needs_revision';
      const complete = document.createElement('button'); complete.textContent = '완료'; complete.value = 'completed';
      form.append(feedback, revise, complete);
      form.addEventListener('submit', async (event) => { event.preventDefault(); const submitter = event.submitter; submitter.disabled = true; try { const { error } = await supabase.rpc('review_submission', { p_submission_id: attempt.id, p_body: feedback.value, p_status: submitter.value }); if (error) throw error; await loadWorkflows(); } catch (error) { alert(error.message); submitter.disabled = false; } }); section.append(form);
    }
    card.append(section);
  }
  return card;
}
async function download(bucket, path) { const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60); if (error) alert(error.message); else location.assign(data.signedUrl); }
async function loadWorkflows() {
  const { data, error } = await supabase.from('assignments').select('id,title,description,due_at,profiles!assignments_student_id_fkey(name),submissions(id,attempt_no,status,body,file_paths,submitted_at,feedback(body,created_at))').order('created_at', { ascending: false });
  if (error) throw error;
  byId('workflows').replaceChildren(...(data || []).map(workflowCard));
}
async function showAdmin(user) {
  currentAdmin = user; await ensureAdmin(user);
  const { data: profile, error } = await supabase.from('profiles').select('name,must_change_pin').eq('id', user.id).single(); if (error) throw error;
  byId('login').hidden = true; byId('logout').hidden = false;
  if (profile.must_change_pin) { byId('admin').hidden = true; byId('pinChange').hidden = false; return; }
  byId('pinChange').hidden = true; byId('admin').hidden = false; await Promise.all([loadUsers(), loadWorkflows()]);
}
byId('loginForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const input = validateLoginInput(byId('phone').value, byId('pin').value); const result = await signIn(input.phone, input.pin); await showAdmin(result.user); } catch (error) { byId('loginError').textContent = error.message; } });
byId('accountForm').addEventListener('submit', async (event) => { event.preventDefault(); const output = byId('accountResult'); try { const input = validateAccountInput(Object.fromEntries(new FormData(event.currentTarget))); await callAdmin({ action: 'create', ...input }); output.textContent = '계정을 발급했습니다.'; event.currentTarget.reset(); await loadUsers(); } catch (error) { output.textContent = error.message; } });
byId('assignmentForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const output = byId('assignmentResult'); const button = form.querySelector('button'); const data = new FormData(form); const file = data.get('attachment'); const paths = []; let inserted = false; button.disabled = true;
  try {
    const title = String(data.get('title') || '').trim(); if (!title || title.length > 120) throw new Error('제목은 1~120자로 입력하세요.');
    if (file?.size) { const path = currentAdmin.id + '/' + crypto.randomUUID() + '-' + safeName(file.name); const { error } = await supabase.storage.from('assignment-files').upload(path, file); if (error) throw error; paths.push(path); }
    const due = data.get('due_at'); const { error } = await supabase.from('assignments').insert({ student_id: data.get('student_id'), created_by: currentAdmin.id, title, description: String(data.get('description') || '').trim(), due_at: due ? new Date(due).toISOString() : null, attachment_paths: paths });
    if (error) throw error; inserted = true; output.textContent = '과제를 등록했습니다.'; form.reset(); await loadWorkflows();
  } catch (error) { if (!inserted) await cleanup('assignment-files', paths); output.textContent = error.message; } finally { button.disabled = false; }
});
byId('pinChangeForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const output = byId('pinChangeError'); const button = form.querySelector('button'); output.textContent = '';
  try {
    const pin = validatePin(byId('newPin').value); if (pin !== byId('confirmPin').value) throw new Error('새 PIN이 일치하지 않습니다.'); button.disabled = true;
    const { data: { user: currentUser }, error: userError } = await supabase.auth.getUser();
    if (userError || !currentUser?.email) throw new Error('다시 로그인하세요.');
    await invokeAuthenticated('change-pin', { pin });
    const result = await signIn(currentUser.email.split('@')[0], pin);
    form.reset(); await showAdmin(result.user);
  } catch (error) { output.textContent = error.message; } finally { button.disabled = false; }
});
byId('logout').addEventListener('click', async () => { await signOut(); location.reload(); });
const { data: { user } } = await supabase.auth.getUser(); if (user) showAdmin(user).catch((error) => { byId('loginError').textContent = error.message; });
