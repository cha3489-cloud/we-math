// 적용 경로: src/portal/domain.test.js (신규) — 실행: npx vitest run
import { describe, it, expect } from 'vitest';
import {
  normalizeRelation, latestAttempt, canSubmitAttempt, assignmentStatus,
  REVIEW_TAGS, validateFeedbackItems, checkItemsForStatus, composeFeedbackBody,
  reviewQueue, waitingLabel, groupAssignments, redoProblems, assessImageQuality,
  validateSubmissionInput,
} from './domain.js';

describe('normalizeRelation', () => {
  it('null/undefined → []', () => {
    expect(normalizeRelation(null)).toEqual([]);
    expect(normalizeRelation(undefined)).toEqual([]);
  });
  it('object → [object]', () => { expect(normalizeRelation({ a: 1 })).toEqual([{ a: 1 }]); });
  it('array passthrough', () => { expect(normalizeRelation([1, 2])).toEqual([1, 2]); });
});

describe('attempt/status', () => {
  const attempts = [
    { attempt_no: 1, status: 'needs_revision' },
    { attempt_no: 2, status: 'submitted' },
  ];
  it('latestAttempt picks highest attempt_no', () => {
    expect(latestAttempt(attempts).attempt_no).toBe(2);
  });
  it('canSubmitAttempt only when none or needs_revision', () => {
    expect(canSubmitAttempt([])).toBe(true);
    expect(canSubmitAttempt(attempts)).toBe(false);
    expect(canSubmitAttempt([{ attempt_no: 1, status: 'needs_revision' }])).toBe(true);
  });
  it('assignmentStatus handles object-shaped relation and overdue', () => {
    expect(assignmentStatus({ submissions: { attempt_no: 1, status: 'submitted' } })).toBe('submitted');
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(assignmentStatus({ submissions: null, due_at: past })).toBe('overdue');
    expect(assignmentStatus({ submissions: [] })).toBe('open');
  });
});

describe('validateFeedbackItems', () => {
  const good = { problem_ref: '3번', review_tag: REVIEW_TAGS[0], comment: '', redo_required: true };
  it('accepts valid items and normalizes', () => {
    const [item] = validateFeedbackItems([{ ...good, comment: ' 확인 ' }]);
    expect(item.comment).toBe('확인');
    expect(item.redo_required).toBe(true);
  });
  it('rejects unknown tag', () => {
    expect(() => validateFeedbackItems([{ ...good, review_tag: '정서·습관' }])).toThrow();
  });
  it('rejects empty problem_ref and >20 items', () => {
    expect(() => validateFeedbackItems([{ ...good, problem_ref: ' ' }])).toThrow();
    expect(() => validateFeedbackItems(Array.from({ length: 21 }, () => ({ ...good })))).toThrow();
  });
  it('rejects long comment', () => {
    expect(() => validateFeedbackItems([{ ...good, comment: 'a'.repeat(1001) }])).toThrow();
  });
});

describe('checkItemsForStatus', () => {
  const redo = { problem_ref: '1', review_tag: REVIEW_TAGS[0], comment: '', redo_required: true };
  const note = { ...redo, redo_required: false };
  it('needs_revision requires a redo item', () => {
    expect(() => checkItemsForStatus('needs_revision', [note])).toThrow();
    expect(checkItemsForStatus('needs_revision', [redo])).toBe(true);
  });
  it('completed forbids redo items', () => {
    expect(() => checkItemsForStatus('completed', [redo])).toThrow();
    expect(checkItemsForStatus('completed', [note])).toBe(true);
  });
});

describe('composeFeedbackBody', () => {
  it('uses comment when present', () => {
    expect(composeFeedbackBody([], '총평')).toBe('총평');
  });
  it('builds from items when comment empty', () => {
    const body = composeFeedbackBody([{ problem_ref: '3번', review_tag: '계산·부호 확인', comment: '부호 확인', redo_required: true }], '');
    expect(body).toContain('3번 · 계산·부호 확인 — 부호 확인');
  });
  it('throws when both empty', () => { expect(() => composeFeedbackBody([], '')).toThrow(); });
});

describe('reviewQueue', () => {
  it('keeps only latest submitted attempts, oldest first', () => {
    const rows = reviewQueue([
      { id: 'a', submissions: [{ attempt_no: 1, status: 'submitted', submitted_at: '2026-07-25T10:00:00Z' }] },
      { id: 'b', submissions: [{ attempt_no: 1, status: 'completed', submitted_at: '2026-07-20T10:00:00Z' }] },
      { id: 'c', submissions: { attempt_no: 1, status: 'submitted', submitted_at: '2026-07-24T10:00:00Z' } },
      { id: 'd', submissions: null },
    ]);
    expect(rows.map((r) => r.assignment.id)).toEqual(['c', 'a']);
  });
  it('uses latest attempt only', () => {
    const rows = reviewQueue([{
      id: 'a',
      submissions: [
        { attempt_no: 2, status: 'submitted', submitted_at: '2026-07-25T10:00:00Z' },
        { attempt_no: 1, status: 'needs_revision', submitted_at: '2026-07-20T10:00:00Z' },
      ],
    }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt.attempt_no).toBe(2);
  });
});

describe('waitingLabel', () => {
  const now = new Date('2026-07-26T12:00:00Z');
  it('formats minutes/hours/days', () => {
    expect(waitingLabel('2026-07-26T11:59:30Z', now)).toBe('방금 제출');
    expect(waitingLabel('2026-07-26T11:30:00Z', now)).toBe('30분 대기');
    expect(waitingLabel('2026-07-26T09:00:00Z', now)).toBe('3시간 대기');
    expect(waitingLabel('2026-07-24T09:00:00Z', now)).toBe('2일 대기');
  });
});

describe('groupAssignments', () => {
  it('routes by derived status', () => {
    const groups = groupAssignments([
      { id: 'r', submissions: [{ attempt_no: 1, status: 'needs_revision' }] },
      { id: 'o', submissions: [] },
      { id: 'v', submissions: [{ attempt_no: 1, status: 'submitted' }] },
      { id: 'd', submissions: [{ attempt_no: 1, status: 'completed' }] },
    ]);
    expect(groups.redo.map((a) => a.id)).toEqual(['r']);
    expect(groups.open.map((a) => a.id)).toEqual(['o']);
    expect(groups.review.map((a) => a.id)).toEqual(['v']);
    expect(groups.done.map((a) => a.id)).toEqual(['d']);
  });
});

describe('redoProblems', () => {
  it('handles object/array feedback and nested items', () => {
    const feedback = {
      body: 'x',
      feedback_items: [
        { problem_ref: '3', redo_required: true },
        { problem_ref: '5', redo_required: false },
      ],
    };
    expect(redoProblems(feedback)).toEqual(['3']);
    expect(redoProblems([feedback])).toEqual(['3']);
    expect(redoProblems(null)).toEqual([]);
  });
});

describe('assessImageQuality', () => {
  it('warns on low resolution and blur, silent on failure', () => {
    expect(assessImageQuality(null)).toEqual([]);
    expect(assessImageQuality({ width: 400, height: 300, blurScore: 200 }).map((w) => w.code)).toEqual(['low_resolution']);
    expect(assessImageQuality({ width: 2000, height: 1500, blurScore: 10 }).map((w) => w.code)).toEqual(['blurry']);
    expect(assessImageQuality({ width: 2000, height: 1500, blurScore: 200 })).toEqual([]);
  });
});

describe('validateSubmissionInput (기존 동작 회귀)', () => {
  it('requires body or files, max 3 files', () => {
    expect(() => validateSubmissionInput('', [])).toThrow();
    expect(() => validateSubmissionInput('', [1, 2, 3, 4])).toThrow();
    expect(validateSubmissionInput('풀이', []).body).toBe('풀이');
  });
});
