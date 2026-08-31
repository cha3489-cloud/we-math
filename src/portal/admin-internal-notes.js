// 적용 경로: src/portal/admin-internal-notes.js (신규)

// ── 내부 메모(원장 전용): 학생 화면에는 절대 import 하지 않는다 ───────────────
// 빈 값은 오류가 아니라 "메모 없음"이다. RPC 가 빈 값을 받으면 기존 행을 지운다.
export function validateInternalNote(note) {
  const clean = String(note ?? '').trim();
  if (clean.length > 2000) throw new Error('내부 메모는 2000자까지 입력할 수 있습니다.');
  return clean;
}
