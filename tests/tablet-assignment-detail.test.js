import { describe, expect, it } from 'vitest';
import { assignmentDetail, submissionSummaryLabel, findAssignment } from '../src/tablet/view-model.js';

const NOW = new Date('2026-08-21T10:00:00+09:00');

const build = (overrides = {}) => ({
  id: 'a-1',
  title: '일차방정식 활용',
  description: '',
  due_at: null,
  submissions: [],
  ...overrides,
});

const attempt = (overrides = {}) => ({
  id: 's-1', attempt_no: 1, status: 'submitted',
  submitted_at: '2026-08-20T10:00:00+09:00', feedback: [], ...overrides,
});

describe('assignment detail view model', () => {
  it('carries the basics a student needs to see', () => {
    const detail = assignmentDetail(build({ due_at: '2026-08-21T23:00:00+09:00' }), NOW);
    expect(detail.title).toBe('일차방정식 활용');
    expect(detail.status).toBe('open');
    expect(detail.statusLabel).toBe('제출할 과제');
    expect(detail.due).toBe('오늘까지');
  });

  it('splits the mathflat card out of the description', () => {
    const detail = assignmentDetail(build({
      description: '프린트를 먼저 보세요.\n[매쓰플랫]\n단원: 일차방정식 활용\n[/매쓰플랫]',
    }), NOW);
    expect(detail.mathflat.fields).toEqual([{ label: '단원', value: '일차방정식 활용' }]);
    expect(detail.description).toBe('프린트를 먼저 보세요.');
  });

  it('reports attempt count and the latest round', () => {
    const detail = assignmentDetail(build({
      submissions: [
        attempt({ id: 's-1', attempt_no: 1, status: 'needs_revision' }),
        attempt({ id: 's-2', attempt_no: 2, status: 'submitted' }),
      ],
    }), NOW);
    expect(detail.attemptCount).toBe(2);
    expect(detail.latestAttemptNo).toBe(2);
    expect(detail.status).toBe('submitted');
  });

  it('allows resubmission only while the latest attempt needs revision', () => {
    const needsRevision = assignmentDetail(build({ submissions: [attempt({ status: 'needs_revision' })] }), NOW);
    const underReview = assignmentDetail(build({ submissions: [attempt({ status: 'submitted' })] }), NOW);
    const completed = assignmentDetail(build({ submissions: [attempt({ status: 'completed' })] }), NOW);
    expect(needsRevision.canResubmit).toBe(true);
    expect(underReview.canResubmit).toBe(false);
    expect(completed.canResubmit).toBe(false);
  });

  it('surfaces the student-visible feedback and the problems to redo', () => {
    const detail = assignmentDetail(build({
      submissions: [attempt({
        status: 'needs_revision',
        feedback: [{
          body: '부호를 한 번 더 확인해요.',
          created_at: '2026-08-20T12:00:00+09:00',
          feedback_items: [
            { problem_ref: '12번', review_tag: '계산·부호 확인', comment: '', redo_required: true },
            { problem_ref: '15번', review_tag: '풀이 마무리·검산', comment: '', redo_required: true },
            { problem_ref: '3번', review_tag: '개념 연결 보완', comment: '', redo_required: false },
          ],
        }],
      })],
    }), NOW);
    expect(detail.feedbackText).toBe('부호를 한 번 더 확인해요.');
    expect(detail.redoProblems).toEqual(['12번', '15번']);
    expect(detail.feedbackItems).toHaveLength(3);
  });

  it('stays empty rather than throwing when there is no submission yet', () => {
    const detail = assignmentDetail(build(), NOW);
    expect(detail.attemptCount).toBe(0);
    expect(detail.feedbackText).toBe('');
    expect(detail.redoProblems).toEqual([]);
    expect(detail.feedbackItems).toEqual([]);
  });

  it('tolerates relation fields arriving as a single object instead of an array', () => {
    const detail = assignmentDetail(build({
      submissions: attempt({ status: 'completed', feedback: { body: '잘했어요.', feedback_items: [] } }),
    }), NOW);
    expect(detail.attemptCount).toBe(1);
    expect(detail.feedbackText).toBe('잘했어요.');
  });

  it('returns null for a missing assignment', () => {
    expect(assignmentDetail(null, NOW)).toBeNull();
    expect(assignmentDetail(undefined, NOW)).toBeNull();
  });
});

describe('submission summary label', () => {
  const labelFor = (submissions) => submissionSummaryLabel(assignmentDetail(build({ submissions }), NOW));

  it('tells a student who has not submitted what to expect', () => {
    expect(labelFor([])).toBe('아직 제출하지 않았어요.');
  });

  it('names the round once a student has resubmitted', () => {
    expect(labelFor([attempt({ attempt_no: 1, status: 'needs_revision' }), attempt({ id: 's-2', attempt_no: 2 })]))
      .toBe('2번째 제출 · 선생님이 확인하고 있어요.');
  });

  it('asks for a redo when the teacher sent it back', () => {
    expect(labelFor([attempt({ status: 'needs_revision' })])).toBe('제출 완료 · 다시 풀어서 제출해요.');
  });

  it('closes the loop when the work is accepted', () => {
    expect(labelFor([attempt({ status: 'completed' })])).toBe('제출 완료 · 확인이 끝났어요.');
  });

  it('returns empty for a missing detail', () => {
    expect(submissionSummaryLabel(null)).toBe('');
  });
});

describe('assignment lookup for hash routing', () => {
  const list = [build({ id: 'a-1' }), build({ id: 'a-2' })];

  it('finds the assignment named in the hash', () => {
    expect(findAssignment(list, 'a-2').id).toBe('a-2');
  });

  it('returns null for an id the student does not own', () => {
    // 다른 학생의 과제 id 를 hash 에 넣어도 목록에 없으므로 열리지 않는다.
    expect(findAssignment(list, 'someone-elses-id')).toBeNull();
  });

  it('returns null for missing input', () => {
    expect(findAssignment(list, '')).toBeNull();
    expect(findAssignment(list, null)).toBeNull();
    expect(findAssignment([], 'a-1')).toBeNull();
  });
});
