// 적용 경로: src/tablet/view-model.js
// 태블릿 화면 전용 순수 함수. DOM·네트워크 의존이 없어 단위 테스트로 검증한다.
// 과제 분류 자체는 domain.js의 groupAssignments를 그대로 쓰고, 여기서는 표시 순서와 문구만 정한다.
import { groupAssignments } from '../portal/domain.js';

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
