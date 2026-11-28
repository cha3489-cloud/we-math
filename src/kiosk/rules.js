// Pure attendance rules shared by the entrance kiosk, admin dashboard, and tests.
// The database functions are the source of truth; these mirror them for display only.

function toMillis(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

export function classifyArrival(startsAt, arrivedAt) {
  const start = toMillis(startsAt);
  const arrived = toMillis(arrivedAt);
  if (Number.isNaN(start) || Number.isNaN(arrived)) return null;
  return arrived <= start ? 'present' : 'late';
}

export const MISSING_AFTER_MINUTES = 15;
export const CHECKOUT_GRACE_MINUTES = 30;
const MINUTE = 60_000;

export function isActiveException(exception) {
  return Boolean(exception && exception.status === 'active');
}

export function isMissingAttendance(record, session, now, exception = null) {
  if (!record || !session || session.status !== 'scheduled') return false;
  if (record.status !== 'scheduled' || record.checked_in_at) return false;
  if (isActiveException(exception)) return false;
  const start = toMillis(session.starts_at);
  const current = toMillis(now);
  if (Number.isNaN(start) || Number.isNaN(current)) return false;
  const missingAfter = Number.isInteger(session.missing_after_minutes) ? session.missing_after_minutes : MISSING_AFTER_MINUTES;
  return current > start + missingAfter * MINUTE;
}

export function isCheckoutOverdue(record, session, now) {
  if (!record || !session) return false;
  if (!['present', 'late'].includes(record.status) || !record.checked_in_at || record.checked_out_at) return false;
  const end = toMillis(session.ends_at);
  const current = toMillis(now);
  if (Number.isNaN(end) || Number.isNaN(current)) return false;
  return current > end + CHECKOUT_GRACE_MINUTES * MINUTE;
}

export function maskStudentName(name) {
  const chars = Array.from(typeof name === 'string' ? name.trim() : '');
  if (!chars.length) return '학생';
  return chars[0] + '○'.repeat(chars.length - 1);
}

const KST_OFFSET_MS = 9 * 60 * MINUTE;
export function kstEndOfDay(value) {
  const ms = toMillis(value);
  if (Number.isNaN(ms)) return null;
  const kst = new Date(ms + KST_OFFSET_MS);
  const endKstAsUtc = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 23, 59, 59, 999);
  return new Date(endKstAsUtc - KST_OFFSET_MS);
}

export function kstTimeText(value) {
  const ms = toMillis(value);
  if (Number.isNaN(ms)) return '';
  const kst = new Date(ms + KST_OFFSET_MS);
  return String(kst.getUTCHours()).padStart(2, '0') + ':' + String(kst.getUTCMinutes()).padStart(2, '0');
}

export const KIOSK_CODE_LENGTH = 6;
export function applyKeypadKey(code, key) {
  const current = typeof code === 'string' ? code.replace(/\D/g, '').slice(0, KIOSK_CODE_LENGTH) : '';
  if (key === 'clear' || key === 'Escape') return '';
  if (key === 'back' || key === 'Backspace') return current.slice(0, -1);
  if (/^\d$/.test(String(key)) && current.length < KIOSK_CODE_LENGTH) return current + key;
  return current;
}

const LOGIN_HINT = '학습 태블릿에서 전화번호와 PIN으로 로그인하세요.';
const RETRY_HINT = '계속 안 되면 선생님께 말해 주세요.';
export function kioskResultCopy(response, action) {
  const label = typeof response?.student_label === 'string' && response.student_label ? response.student_label : '학생';
  const at = kstTimeText(response?.at);
  switch (response?.result) {
    case 'checked_in':
      return { tone: 'success', title: label + ' 학생', detail: at + ' 등원 확인' + (response.status === 'late' ? ' · 지각' : ''), hint: LOGIN_HINT };
    case 'already_checked_in':
      return { tone: 'info', title: label + ' 학생', detail: '이미 ' + at + '에 등원 처리되었습니다.', hint: LOGIN_HINT };
    case 'checked_out':
      return { tone: 'success', title: label + ' 학생', detail: at + ' 하원 확인', hint: '안전하게 귀가하세요.' };
    case 'already_checked_out':
      return { tone: 'info', title: label + ' 학생', detail: '이미 ' + at + '에 하원 처리되었습니다.', hint: '' };
    case 'not_checked_in':
      return { tone: 'error', title: '등원 기록이 없습니다', detail: '하원은 등원 처리 후에만 할 수 있습니다.', hint: RETRY_HINT };
    case 'rate_limited':
      return { tone: 'error', title: '잠시 후 다시 시도해 주세요', detail: '번호를 여러 번 잘못 입력했습니다.', hint: RETRY_HINT };
    case 'device_not_registered':
      return { tone: 'error', title: '등록되지 않은 출석 기기입니다', detail: '관리자에게 기기 등록을 요청하세요.', hint: '' };
    case 'needs_staff':
      return { tone: 'error', title: '선생님께 확인해 주세요', detail: '이 수업은 직원 확인이 필요합니다.', hint: '' };
    case 'not_found':
    default:
      return { tone: 'error', title: '번호를 확인해 주세요', detail: '번호가 맞지 않거나 오늘 처리할 수업이 없습니다.', hint: RETRY_HINT };
  }
}
