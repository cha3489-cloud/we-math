import { describe, expect, it } from 'vitest';
import {
  TODAY_SECTIONS, todaySections, todaySummary, totalAssignmentCount,
  dueLabel, applyKeypadInput, maskPin, greeting,
} from '../src/tablet/view-model.js';

const NOW = new Date('2026-08-21T10:00:00+09:00');
const assignment = (title, overrides = {}) => ({
  id: title, title, due_at: null, submissions: [], ...overrides,
});
const attempt = (status, attemptNo = 1) => ({ id: status + attemptNo, attempt_no: attemptNo, status });

describe('tablet today sections', () => {
  it('orders sections by urgency so redo work is seen first', () => {
    expect(TODAY_SECTIONS.map((section) => section.key)).toEqual(['redo', 'open', 'review', 'done']);
  });

  it('splits assignments into the four student-facing groups', () => {
    const sections = todaySections([
      assignment('재풀이', { submissions: [attempt('needs_revision')] }),
      assignment('제출전'),
      assignment('확인중', { submissions: [attempt('submitted')] }),
      assignment('완료', { submissions: [attempt('completed')] }),
    ], NOW);
    const byKey = Object.fromEntries(sections.map((section) => [section.key, section.items.map((item) => item.title)]));
    expect(byKey.redo).toEqual(['재풀이']);
    expect(byKey.open).toEqual(['제출전']);
    expect(byKey.review).toEqual(['확인중']);
    expect(byKey.done).toEqual(['완료']);
  });

  it('keeps an overdue assignment in the actionable group rather than hiding it', () => {
    const sections = todaySections([assignment('지난과제', { due_at: '2026-08-01T00:00:00+09:00' })], NOW);
    const open = sections.find((section) => section.key === 'open');
    expect(open.items.map((item) => item.title)).toEqual(['지난과제']);
  });

  it('uses the latest attempt when a student has resubmitted', () => {
    const sections = todaySections([
      assignment('재제출함', { submissions: [attempt('needs_revision', 1), attempt('submitted', 2)] }),
    ], NOW);
    expect(sections.find((section) => section.key === 'review').count).toBe(1);
    expect(sections.find((section) => section.key === 'redo').count).toBe(0);
  });

  it('counts every assignment across sections', () => {
    const sections = todaySections([
      assignment('a'), assignment('b'),
      assignment('c', { submissions: [attempt('completed')] }),
    ], NOW);
    expect(totalAssignmentCount(sections)).toBe(3);
    expect(totalAssignmentCount(todaySections([], NOW))).toBe(0);
  });
});

describe('tablet today summary', () => {
  const summaryOf = (assignments) => todaySummary(todaySections(assignments, NOW));

  it('leads with redo work, then work still to submit', () => {
    expect(summaryOf([
      assignment('r', { submissions: [attempt('needs_revision')] }),
      assignment('o'),
    ])).toBe('다시 풀 과제 1건 · 제출할 과제 1건');
  });

  it('reassures when everything is waiting on the teacher', () => {
    expect(summaryOf([assignment('s', { submissions: [attempt('submitted')] })]))
      .toBe('선생님이 확인하고 있어요.');
  });

  it('celebrates when only completed work remains', () => {
    expect(summaryOf([assignment('d', { submissions: [attempt('completed')] })]))
      .toBe('오늘 할 일을 다 마쳤어요.');
  });

  it('says nothing when there is no assignment at all', () => {
    expect(summaryOf([])).toBe('');
  });
});

describe('tablet due label', () => {
  it('describes near deadlines in words a student reads quickly', () => {
    expect(dueLabel('2026-08-21T23:00:00+09:00', NOW)).toBe('오늘까지');
    expect(dueLabel('2026-08-22T09:00:00+09:00', NOW)).toBe('내일까지');
    expect(dueLabel('2026-08-25T09:00:00+09:00', NOW)).toBe('8월 25일까지');
  });

  it('flags a passed deadline without hiding the assignment', () => {
    expect(dueLabel('2026-08-20T23:59:00+09:00', NOW)).toBe('기한 지남');
  });

  it('returns empty for a missing or unparsable due date', () => {
    expect(dueLabel(null, NOW)).toBe('');
    expect(dueLabel('', NOW)).toBe('');
    expect(dueLabel('not-a-date', NOW)).toBe('');
  });
});

describe('tablet keypad input', () => {
  it('appends digits up to the pin length', () => {
    expect(applyKeypadInput('', '1')).toBe('1');
    expect(applyKeypadInput('12345', '6')).toBe('123456');
  });

  it('refuses to grow past the maximum length', () => {
    expect(applyKeypadInput('123456', '7')).toBe('123456');
    expect(applyKeypadInput('1234', '5', 4)).toBe('1234');
  });

  it('ignores anything that is not a single digit', () => {
    for (const key of ['a', '', '12', null, undefined, '-']) expect(applyKeypadInput('12', key)).toBe('12');
  });

  it('supports backspace and clear', () => {
    expect(applyKeypadInput('123', 'back')).toBe('12');
    expect(applyKeypadInput('', 'back')).toBe('');
    expect(applyKeypadInput('123456', 'clear')).toBe('');
  });
});

describe('tablet pin masking', () => {
  it('shows progress without ever revealing digits', () => {
    expect(maskPin('', 6)).toBe('○○○○○○');
    expect(maskPin('123', 6)).toBe('●●●○○○');
    expect(maskPin('123456', 6)).toBe('●●●●●●');
    expect(maskPin('123', 6)).not.toContain('1');
  });

  it('does not overflow when the value is longer than the mask', () => {
    expect(maskPin('12345678', 6)).toBe('●●●●●●');
  });
});

describe('tablet greeting', () => {
  it('uses the student name when it is available', () => {
    expect(greeting('김수학')).toBe('김수학님, 오늘도 한 걸음');
  });

  it('falls back gracefully when the name is missing', () => {
    for (const value of ['', '   ', null, undefined]) expect(greeting(value)).toBe('오늘도 한 걸음');
  });
});
