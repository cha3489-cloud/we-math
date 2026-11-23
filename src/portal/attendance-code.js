// Admin-side attendance-code issuance. Always goes through the authenticated attendance-code
// Edge Function; there is no database RPC that returns or accepts a raw six-digit code.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAttendanceCodeIssuer(invoke) {
  return async function issueAttendanceCode(studentId) {
    if (typeof studentId !== 'string' || !UUID_PATTERN.test(studentId)) throw new Error('저장된 학생만 출석번호를 발급할 수 있습니다.');
    const data = await invoke('attendance-code', { op: 'issue', student_id: studentId });
    if (!data || typeof data.code !== 'string' || !/^\d{6}$/.test(data.code)) throw new Error('출석번호 응답을 확인할 수 없습니다.');
    return { code: data.code, issue_kind: data.issue_kind === 'rotated' ? 'rotated' : 'issued' };
  };
}
