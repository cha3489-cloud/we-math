export function normalizePhone(value) {
  const phone = String(value ?? '').replace(/[^0-9]/g, '');
  if (!/^01[016789][0-9]{7,8}$/.test(phone)) throw new Error('올바른 휴대전화 번호를 입력하세요.');
  return phone;
}
export function validatePin(pin) { if (!/^\d{6}$/.test(String(pin ?? ''))) throw new Error('PIN은 숫자 6자리여야 합니다.'); return String(pin); }
export function validateLoginPin(pin) { const value = String(pin ?? ''); if (!/^(?:[0-9]{4}|[0-9]{6})$/.test(value)) throw new Error('PIN은 숫자 4자리 또는 6자리여야 합니다.'); return value; }
export function validateLoginInput(phone, pin) { return { phone: normalizePhone(phone), pin: validateLoginPin(pin) }; }
export function validateAccountInput(input) {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 40) throw new Error('이름은 1~40자로 입력하세요.');
  if (!['student', 'admin'].includes(input.role)) throw new Error('허용되지 않은 역할입니다.');
  return { name, phone: normalizePhone(input.phone), pin: validatePin(input.pin), role: input.role };
}
export function validateSubmissionInput(body, files = []) {
  const clean = String(body ?? '').trim();
  if (files.length > 3) throw new Error('제출 파일은 최대 3개까지 가능합니다.');
  if (!clean && !files.length) throw new Error('제출 내용 또는 파일을 추가하세요.');
  return { body: clean, hasFiles: files.length > 0 };
}
export function feedbackItems(value) { return Array.isArray(value) ? value : value ? [value] : []; }
export function latestAttempt(attempts = []) {
  return [...attempts].sort((a, b) => Number(b.attempt_no) - Number(a.attempt_no))[0] ?? null;
}
export function canSubmitAttempt(attempts = []) {
  const latest = latestAttempt(attempts);
  return !latest || latest.status === 'needs_revision';
}
export function assignmentStatus(assignment, now = new Date()) {
  const latest = latestAttempt(assignment.submissions);
  if (latest) return latest.status;
  if (assignment.due_at && new Date(assignment.due_at) < now) return 'overdue';
  return 'open';
}
