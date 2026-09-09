// 적용 경로: src/portal/admin-internal-notes.js (신규)

// ── ADMIN-ONLY 내부 메모(원장 전용): 학생 화면에는 절대 import 하지 않는다 ───────────────
// 빈 값은 오류가 아니라 "메모 없음"이다. RPC 가 빈 값을 받으면 기존 행을 지운다.
export function validateInternalNote(note) {
  const clean = String(note ?? '').trim();
  if (clean.length > 2000) throw new Error('내부 메모는 2000자까지 입력할 수 있습니다.');
  return clean;
}

export const OBSERVATION_CAUSES = Object.freeze(['문제해석', '식변환', '개념연결', '계산부호', '마무리검산', '집중흐름', '기타']);
export const EXPLANATION_LEVELS = Object.freeze(['설명가능', '부분설명', '결과만말함', '설명불가']);
export const RETRY_RESULTS = Object.freeze(['성공', '힌트후성공', '실패', '미실시']);
export const NEXT_INTENSITIES = Object.freeze(['유지', '약화', '강화', '원장확인']);

function checkedValue(value, allowed) {
  const clean = String(value ?? '').trim();
  if (!clean) return '';
  if (!allowed.includes(clean)) throw new Error('허용되지 않은 관찰값입니다.');
  return clean;
}

export function composeObservationInternalNote(observation = {}, memo = '') {
  const causes = Array.isArray(observation.causes) ? observation.causes : [];
  const cleanCauses = causes.map((cause) => checkedValue(cause, OBSERVATION_CAUSES)).filter(Boolean);
  const parts = [];
  if (cleanCauses.length) parts.push('원인=' + cleanCauses.join(','));
  const explanation = checkedValue(observation.explanation, EXPLANATION_LEVELS);
  const retry = checkedValue(observation.retry, RETRY_RESULTS);
  const intensity = checkedValue(observation.intensity, NEXT_INTENSITIES);
  if (explanation) parts.push('설명=' + explanation);
  if (retry) parts.push('재풀이=' + retry);
  if (intensity) parts.push('다음=' + intensity);
  const cleanMemo = validateInternalNote(memo);
  return [parts.length ? '[관찰] ' + parts.join(' / ') : '', cleanMemo && parts.length ? '[메모] ' + cleanMemo : cleanMemo]
    .filter(Boolean).join('\n');
}
