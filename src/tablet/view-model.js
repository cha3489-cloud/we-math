// 적용 경로: src/tablet/view-model.js
// 태블릿 화면 전용 순수 함수. DOM·네트워크 의존이 없어 단위 테스트로 검증한다.
// 과제 분류 자체는 domain.js의 groupAssignments를 그대로 쓰고, 여기서는 표시 순서와 문구만 정한다.
import {
  groupAssignments, assignmentStatus, latestAttempt, canSubmitAttempt,
  normalizeRelation, redoProblems, allFeedbackItems, STATUS_META,
} from '../portal/domain.js';
import { parseSubmissionBody } from './difficulty.js';

// 표시 순서는 급한 순이다. 재풀이가 가장 먼저 눈에 들어와야 한다.
export const TODAY_SECTIONS = [
  { key: 'redo', icon: '✏️', title: '재풀이 필요', hint: '선생님이 다시 확인해달라고 했어요.' },
  { key: 'open', icon: '📝', title: '오늘 할 과제', hint: '지금 풀고 제출하면 돼요.' },
  { key: 'review', icon: '⏳', title: '진행 중', hint: '선생님이 확인하고 있어요.' },
  { key: 'done', icon: '✅', title: '완료 · 피드백 확인', hint: '끝낸 과제예요.' },
];

export function todaySections(assignments = [], now = new Date()) {
  const groups = groupAssignments(assignments, now);
  return TODAY_SECTIONS.map((section) => {
    const items = groups[section.key] ?? [];
    return { ...section, items, count: items.length };
  });
}

export function totalAssignmentCount(sections = []) {
  return sections.reduce((sum, section) => sum + section.count, 0);
}

// 홈 상단 한 줄 요약. 급한 것부터 최대 2개까지만 말한다.
export function todaySummary(sections = []) {
  const countOf = (key) => sections.find((section) => section.key === key)?.count ?? 0;
  const parts = [];
  if (countOf('redo')) parts.push('다시 풀 과제 ' + countOf('redo') + '건');
  if (countOf('open')) parts.push('제출할 과제 ' + countOf('open') + '건');
  if (parts.length) return parts.slice(0, 2).join(' · ');
  if (countOf('review')) return '선생님이 확인하고 있어요.';
  if (countOf('done')) return '오늘 할 일을 다 마쳤어요.';
  return '';
}

const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

export function dueLabel(dueAt, now = new Date()) {
  if (!dueAt) return '';
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return '';
  const dayDiff = Math.round((startOfDay(due) - startOfDay(now)) / 86400000);
  if (dayDiff < 0) return '기한 지남';
  if (dayDiff === 0) return '오늘까지';
  if (dayDiff === 1) return '내일까지';
  return (due.getMonth() + 1) + '월 ' + due.getDate() + '일까지';
}

// 대형 키패드 입력. 숫자만 받고 최대 길이를 넘기지 않는다.
export function applyKeypadInput(current, key, maxLength = 6) {
  const value = String(current ?? '');
  if (key === 'clear') return '';
  if (key === 'back') return value.slice(0, -1);
  if (!/^[0-9]$/.test(String(key))) return value;
  if (value.length >= maxLength) return value;
  return value + key;
}

export function maskPin(value, maxLength = 6) {
  const length = Math.min(String(value ?? '').length, maxLength);
  return '●'.repeat(length) + '○'.repeat(Math.max(0, maxLength - length));
}

export function greeting(name) {
  const clean = String(name ?? '').trim();
  return clean ? clean + '님, 오늘도 한 걸음' : '오늘도 한 걸음';
}

// ── 매쓰플랫 안내 블록 ───────────────────────────────────────────────────
// 과제 설명(assignments.description) 안에 아래 형태로 적어두면 별도 카드로 강조한다.
//   [매쓰플랫]
//   단원: 일차방정식 활용
//   범위: 프린트 3번 ~ 18번
//   [/매쓰플랫]
// 규약을 쓰지 않은 기존 과제도 그대로 보여야 하므로, 블록이 없거나 형식이
// 깨져도 설명 전체를 잃지 않는 것을 우선한다.
const MATHFLAT_OPEN = '[매쓰플랫]';
const MATHFLAT_CLOSE = '[/매쓰플랫]';

const stripMathflatMarkers = (value) => String(value ?? '')
  .split(MATHFLAT_OPEN).join('')
  .split(MATHFLAT_CLOSE).join('');

const collapseBlankLines = (value) => String(value ?? '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

function parseMathflatBody(raw, closed) {
  const lines = String(raw ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const fields = [];
  const notes = [];
  for (const line of lines) {
    // "단원: 값" / "범위： 값" 처럼 라벨이 붙은 줄만 표 형태로 세운다.
    const match = line.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
    if (match) fields.push({ label: match[1].trim(), value: match[2].trim() });
    else notes.push(line);
  }
  return { fields, notes, closed };
}

export function parseAssignmentDescription(description) {
  const source = String(description ?? '');
  const openIndex = source.indexOf(MATHFLAT_OPEN);
  if (openIndex === -1) {
    return { mathflat: null, description: collapseBlankLines(stripMathflatMarkers(source)) };
  }
  const bodyStart = openIndex + MATHFLAT_OPEN.length;
  const closeIndex = source.indexOf(MATHFLAT_CLOSE, bodyStart);
  const closed = closeIndex !== -1;
  // 닫는 태그가 없으면 남은 내용을 블록으로 본다. 그래야 설명에 여는 태그가 남지 않는다.
  const body = closed ? source.slice(bodyStart, closeIndex) : source.slice(bodyStart);
  const rest = source.slice(0, openIndex) + (closed ? source.slice(closeIndex + MATHFLAT_CLOSE.length) : '');
  return {
    mathflat: parseMathflatBody(body, closed),
    description: collapseBlankLines(stripMathflatMarkers(rest)),
  };
}

// ── 과제 상세 ────────────────────────────────────────────────────────────
export function assignmentDetail(assignment, now = new Date()) {
  if (!assignment) return null;
  const status = assignmentStatus(assignment, now);
  const meta = STATUS_META[status] ?? { icon: '•', label: status };
  const attempts = normalizeRelation(assignment.submissions);
  const latest = latestAttempt(attempts);
  const parsed = parseAssignmentDescription(assignment.description);
  const feedbackEntries = latest ? normalizeRelation(latest.feedback) : [];
  const feedbackText = feedbackEntries.map((entry) => String(entry?.body ?? '').trim()).filter(Boolean).at(-1) ?? '';
  // 학생이 지난 제출에 남긴 내용. 자기가 무엇을 적어 보냈는지만 되짚어 보게 한다.
  const mine = parseSubmissionBody(latest?.body);

  return {
    id: assignment.id,
    title: assignment.title,
    status,
    statusIcon: meta.icon,
    statusLabel: meta.label,
    due: dueLabel(assignment.due_at, now),
    mathflat: parsed.mathflat,
    description: parsed.description,
    attemptCount: attempts.length,
    latestAttemptNo: latest?.attempt_no ?? 0,
    submittedAt: latest?.submitted_at ?? null,
    canResubmit: canSubmitAttempt(attempts),
    feedbackText,
    redoProblems: latest ? redoProblems(latest.feedback) : [],
    feedbackItems: latest ? allFeedbackItems(latest.feedback) : [],
    myTags: mine.tags,
    myNote: mine.note || mine.rest,
    // 학생이 질문을 쓰기 전에 "내가 뭘 냈더라"를 다시 볼 수 있게 최근 회차의
    // 제출 사진 경로만 넘긴다. 실제 표시 여부와 개수 제한은 화면에서 정한다.
    myFilePaths: [...(latest?.file_paths ?? [])],
  };
}

export function submissionSummaryLabel(detail) {
  if (!detail) return '';
  if (!detail.attemptCount) return '아직 제출하지 않았어요.';
  const round = detail.latestAttemptNo > 1 ? detail.latestAttemptNo + '번째 제출' : '제출 완료';
  if (detail.status === 'needs_revision') return round + ' · 다시 풀어서 제출해요.';
  if (detail.status === 'completed') return round + ' · 확인이 끝났어요.';
  return round + ' · 선생님이 확인하고 있어요.';
}

export function findAssignment(assignments = [], id) {
  if (!id) return null;
  return assignments.find((item) => String(item?.id) === String(id)) ?? null;
}
