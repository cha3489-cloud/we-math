import './portal.css';
import { invokeAuthenticated, supabase } from './client.js';
import { validatePin, validateLoginInput, validateSubmissionInput, assignmentStatus, latestAttempt, canSubmitAttempt } from './domain.js';
import { signIn, signOut } from '../auth.js';
const byId = (id) => document.getElementById(id);
const statusLabel = { submitted: '검토 대기', needs_revision: '수정 필요', completed: '완료', overdue: '기한 지남', open: '진행 중' };
async function requireStudent(user) {
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', user.id).single();
  if (error || data?.role !== 'student') { await signOut(); throw new Error('학생 계정으로 로그인하세요.'); }
}
async function cleanup(paths) { if (paths.length) await supabase.storage.from('submission-files').remove(paths); }
async function loadDashboard(user) {
  await requireStudent(user);
  const { data: profile, error: profileError } = await supabase.from('profiles').select('name,must_change_pin').eq('id', user.id).single();
  if (profileError) throw profileError;
  byId('login').hidden = true; byId('logout').hidden = false;
  if (profile.must_change_pin) { byId('dashboard').hidden = true; byId('pinChange').hidden = false; return; }
  byId('pinChange').hidden = true;
  const { data: assignments, error } = await supabase.from('assignments').select('id,title,description,due_at,attachment_paths,submissions(id,attempt_no,status,body,file_paths,submitted_at,reviewed_at,feedback(body,created_at))').eq('student_id', user.id).order('due_at');
  if (error) throw error;
  byId('studentName').textContent = profile.name;
  byId('assignments').replaceChildren(...(assignments || []).map((item) => assignmentCard(item, user.id)));
  byId('empty').hidden = Boolean(assignments?.length);
  byId('dashboard').hidden = false;
}
function assignmentCard(item, userId) {
  const card = document.createElement('article'); card.className = 'card';
  const attempts = [...(item.submissions || [])].sort((a, b) => a.attempt_no - b.attempt_no); const latest = latestAttempt(attempts);
  const title = document.createElement('h2'); title.textContent = item.title;
  const meta = document.createElement('p'); meta.className = 'meta'; meta.textContent = (item.due_at ? '마감 ' + new Date(item.due_at).toLocaleString('ko-KR') + ' · ' : '') + statusLabel[assignmentStatus(item)];
  const desc = document.createElement('p'); desc.textContent = item.description || ''; card.append(title, meta, desc);
  for (const path of item.attachment_paths || []) { const link = document.createElement('button'); link.type = 'button'; link.textContent = '과제 파일 받기'; link.addEventListener('click', () => download('assignment-files', path)); card.append(link); }
  for (const attempt of attempts) {
    const section = document.createElement('section'); section.className = 'attempt';
    const heading = document.createElement('h3'); heading.textContent = attempt.attempt_no + '차 제출 · ' + statusLabel[attempt.status]; section.append(heading);
    if (attempt.body) { const body = document.createElement('p'); body.textContent = attempt.body; section.append(body); }
    for (const path of attempt.file_paths || []) { const link = document.createElement('button'); link.type = 'button'; link.textContent = '내 제출 파일 받기'; link.addEventListener('click', () => download('submission-files', path)); section.append(link); }
    for (const note of attempt.feedback || []) { const feedback = document.createElement('p'); feedback.className = 'feedback'; feedback.textContent = '선생님 피드백: ' + note.body; section.append(feedback); }
    card.append(section);
  }
  if (canSubmitAttempt(attempts)) card.append(submissionForm(item, userId, latest ? '수정 제출' : '과제 제출'));
  return card;
}
function submissionForm(item, userId, label) {
  const form = document.createElement('form'); const body = document.createElement('textarea'); body.placeholder = '풀이 과정이나 질문을 적어주세요.'; const file = document.createElement('input'); file.type = 'file'; file.accept = '.pdf,image/jpeg,image/png,image/webp'; file.multiple = true; const button = document.createElement('button'); button.textContent = label; form.append(body, file, button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); button.disabled = true; const paths = []; let inserted = false;
    try {
      const files = [...file.files]; const input = validateSubmissionInput(body.value, files);
      for (const upload of files) { const safe = upload.name.replace(/[^a-zA-Z0-9._-]/g, '_'); const path = userId + '/' + item.id + '/' + crypto.randomUUID() + '-' + safe; const { error } = await supabase.storage.from('submission-files').upload(path, upload); if (error) throw error; paths.push(path); }
      const { error } = await supabase.from('submissions').insert({ assignment_id: item.id, student_id: userId, body: input.body, file_paths: paths });
      if (error) throw error; inserted = true; await loadDashboard({ id: userId });
    } catch (error) { if (!inserted) await cleanup(paths); alert(error.message); button.disabled = false; }
  }); return form;
}
async function download(bucket, path) { const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60); if (error) alert(error.message); else location.assign(data.signedUrl); }
byId('loginForm').addEventListener('submit', async (event) => { event.preventDefault(); byId('loginError').textContent = ''; try { const input = validateLoginInput(byId('phone').value, byId('pin').value); const result = await signIn(input.phone, input.pin); await loadDashboard(result.user); } catch (error) { byId('loginError').textContent = error.message; } });
byId('pinChangeForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const output = byId('pinChangeError'); const button = event.currentTarget.querySelector('button'); output.textContent = '';
  try {
    const pin = validatePin(byId('newPin').value); if (pin !== byId('confirmPin').value) throw new Error('새 PIN이 일치하지 않습니다.'); button.disabled = true;
    const { data: { user: currentUser }, error: userError } = await supabase.auth.getUser();
    if (userError || !currentUser?.email) throw new Error('다시 로그인하세요.');
    await invokeAuthenticated('change-pin', { pin });
    const result = await signIn(currentUser.email.split('@')[0], pin);
    event.currentTarget.reset(); await loadDashboard(result.user);
  } catch (error) { output.textContent = error.message; } finally { button.disabled = false; }
});
byId('logout').addEventListener('click', async () => { await signOut(); location.reload(); });
const { data: { user } } = await supabase.auth.getUser(); if (user) loadDashboard(user).catch((error) => { byId('loginError').textContent = error.message; });
