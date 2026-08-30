import { describe, expect, it } from 'vitest';
import { normalizePhone, validatePin, validateLoginInput, validateAccountInput, validateSubmissionInput, assignmentStatus, latestAttempt, canSubmitAttempt, feedbackItems, isAutoComposedFeedback, authErrorMessage, adminWorkflowMeta, summarizeAdminWorkflows, isActiveStudentAssignment, isActiveProfile, collectKeysetPages, createLatestRequestGate, reconcileQueueSelection } from '../src/portal/domain.js';
describe('portal domain rules', () => {
  it('normalizes Korean mobile numbers', () => { expect(normalizePhone('010-1234-5678')).toBe('01012345678'); expect(() => normalizePhone('02-123-4567')).toThrow(); });
  it('temporarily accepts legacy four-digit or current six-digit login PINs', () => { expect(validateLoginInput('01012345678', '1234').pin).toBe('1234'); expect(validateLoginInput('01012345678', '123456').pin).toBe('123456'); for (const bad of ['12345', '1234567', '12ab']) expect(() => validateLoginInput('01012345678', bad)).toThrow('PIN'); });
  it('keeps new PIN validation strictly six digits', () => { expect(validatePin('123456')).toBe('123456'); for (const bad of ['1234', '12345', '1234567', '12ab56']) expect(() => validatePin(bad)).toThrow('PIN'); });
  it('maps only exact recognized authentication failures to student-safe Korean guidance', () => {
    expect(authErrorMessage({ code: 'user_banned', message: 'A changed upstream message' })).toBe('현재 이용이 중지된 계정입니다. 원장님께 문의해 주세요.');
    expect(authErrorMessage({ message: 'User is banned' })).toBe('현재 이용이 중지된 계정입니다. 원장님께 문의해 주세요.');
    expect(authErrorMessage({ code: 'invalid_credentials', message: 'A changed upstream message' })).toBe('전화번호 또는 PIN이 올바르지 않습니다.');
    expect(authErrorMessage({ message: 'Invalid login credentials' })).toBe('전화번호 또는 PIN이 올바르지 않습니다.');
    for (const message of ['USER IS BANNED', 'User is banned.', ' User is banned ', 'Gateway says user is banned upstream']) {
      expect(authErrorMessage({ message })).toBe(message);
    }
    for (const message of ['INVALID LOGIN CREDENTIALS', 'Invalid login credentials.', ' Invalid login credentials ', 'Unexpected invalid login credentials provider mismatch']) {
      expect(authErrorMessage({ message })).toBe(message);
    }
    expect(authErrorMessage({ code: 'USER_BANNED', message: 'Changed' })).toBe('Changed');
    expect(authErrorMessage({ code: 'INVALID_CREDENTIALS', message: 'Changed' })).toBe('Changed');
    expect(authErrorMessage({ message: 'Database unavailable' })).toBe('Database unavailable');
    expect(authErrorMessage(null)).toBe('로그인에 실패했습니다. 다시 시도해 주세요.');
  });
  it('validates principal-issued accounts', () => { expect(validateAccountInput({ name: 'Student', phone: '010-2222-3333', pin: '987654', role: 'student' })).toEqual({ name: 'Student', phone: '01022223333', pin: '987654', role: 'student' }); expect(() => validateAccountInput({ name: '', phone: '01022223333', pin: '987654', role: 'student' })).toThrow(); expect(() => validateAccountInput({ name: 'X', phone: '01022223333', pin: '987654', role: 'owner' })).toThrow(); });
  it('requires text or files', () => { expect(validateSubmissionInput(' done ', [])).toEqual({ body: 'done', hasFiles: false }); expect(validateSubmissionInput('', [{ name: 'a.pdf' }])).toEqual({ body: '', hasFiles: true }); expect(() => validateSubmissionInput(' ', [])).toThrow(); });
  it('limits each submission to three files', () => { expect(validateSubmissionInput('', [{}, {}, {}]).hasFiles).toBe(true); expect(() => validateSubmissionInput('', [{}, {}, {}, {}])).toThrow('3개'); });
  it('chooses the newest attempt and supports revision retries only', () => { const attempts = [{ attempt_no: 1, status: 'needs_revision' }, { attempt_no: 2, status: 'submitted' }]; expect(latestAttempt(attempts)).toEqual(attempts[1]); expect(canSubmitAttempt([])).toBe(true); expect(canSubmitAttempt([{ attempt_no: 1, status: 'needs_revision' }])).toBe(true); expect(canSubmitAttempt(attempts)).toBe(false); expect(canSubmitAttempt([{ attempt_no: 1, status: 'completed' }])).toBe(false); });
  it('classifies assignment state from the latest attempt', () => { const now = new Date('2026-07-24T12:00:00Z'); expect(assignmentStatus({ submissions: [{ attempt_no: 1, status: 'needs_revision' }] }, now)).toBe('needs_revision'); expect(assignmentStatus({ submissions: [{ attempt_no: 1, status: 'completed' }] }, now)).toBe('completed'); expect(assignmentStatus({ submissions: [{ attempt_no: 1, status: 'submitted' }] }, now)).toBe('submitted'); expect(assignmentStatus({ due_at: '2026-07-24T11:00:00Z', submissions: [] }, now)).toBe('overdue'); expect(assignmentStatus({ due_at: '2026-07-25T11:00:00Z' }, now)).toBe('open'); });
  it('gives administrators explicit text labels for every workflow state', () => {
    const now = new Date('2026-07-24T12:00:00Z');
    expect(adminWorkflowMeta({ due_at: '2026-07-24T11:00:00Z', submissions: [] }, now)).toEqual({ status: 'overdue', label: '마감 지남 · 미제출', actionRequired: true, priority: 1, nextAction: '학생에게 제출 가능 여부를 확인하세요.' });
    expect(adminWorkflowMeta({ submissions: [{ attempt_no: 1, status: 'needs_revision' }] }, now)).toEqual({ status: 'needs_revision', label: '수정 필요', actionRequired: true, priority: 2, nextAction: '재풀이 제출 여부를 확인하세요.' });
    expect(adminWorkflowMeta({ submissions: [{ attempt_no: 1, status: 'submitted' }] }, now)).toEqual({ status: 'submitted', label: '검토 대기', actionRequired: false, priority: 3 });
    expect(adminWorkflowMeta({ due_at: '2026-07-25T11:00:00Z', submissions: [] }, now)).toEqual({ status: 'open', label: '미제출', actionRequired: false, priority: 4 });
    expect(adminWorkflowMeta({ submissions: [{ attempt_no: 1, status: 'completed' }] }, now)).toEqual({ status: 'completed', label: '완료', actionRequired: false, priority: 5 });
  });
  it('promotes repeated misses and repeated revision failures to principal check with a reason', () => {
    const now = new Date('2026-07-24T12:00:00Z');
    expect(adminWorkflowMeta({ due_at: '2026-07-22T11:00:00Z', submissions: [] }, now)).toEqual({ status: 'principal_check', label: '원장 확인 필요', actionRequired: true, priority: 0, reason: '마감 2일 이상 미제출', nextAction: '오늘 수업 전 과제량과 난이도 조정을 확인하세요.' });
    expect(adminWorkflowMeta({ submissions: [{ attempt_no: 2, status: 'needs_revision' }] }, now)).toEqual({ status: 'principal_check', label: '원장 확인 필요', actionRequired: true, priority: 0, reason: '2차 수정 필요', nextAction: '재풀이 실패 원인을 확인하고 다음 과제 분량을 조정하세요.' });
  });
  it('summarizes only latest states and prioritizes principal-check items first', () => {
    const now = new Date('2026-07-24T12:00:00Z');
    const assignments = [
      { title: '재제출됨', submissions: [{ attempt_no: 1, status: 'needs_revision' }, { attempt_no: 2, status: 'submitted' }] },
      { title: '수정 대기', submissions: [{ attempt_no: 1, status: 'needs_revision', reviewed_at: '2026-07-24T10:00:00Z' }] },
      { title: '원장 확인 재풀이', submissions: [{ attempt_no: 2, status: 'needs_revision', reviewed_at: '2026-07-24T09:00:00Z' }] },
      { title: '오래된 미제출', due_at: '2026-07-22T10:00:00Z', submissions: [] },
      { title: '오늘 미제출', due_at: '2026-07-24T10:00:00Z', submissions: [] },
      { title: '미래 과제', due_at: '2026-07-25T10:00:00Z', submissions: [] },
      { title: '완료', submissions: [{ attempt_no: 1, status: 'completed' }] },
    ];
    const summary = summarizeAdminWorkflows(assignments, now);
    expect(summary.counts).toEqual({ principal_check: 2, submitted: 1, needs_revision: 1, overdue: 1 });
    expect(summary.actionItems.map((item) => item.assignment.title)).toEqual(['오래된 미제출', '원장 확인 재풀이', '오늘 미제출', '수정 대기']);
  });
  it('includes only assignments whose student profile exists and is active', () => {
    expect(isActiveProfile({ suspended_at: null })).toBe(true);
    expect(isActiveProfile({ suspended_at: '2026-07-24T12:00:00Z' })).toBe(false);
    expect(isActiveProfile(null)).toBe(false);
    expect(isActiveStudentAssignment({ profiles: { suspended_at: null } })).toBe(true);
    expect(isActiveStudentAssignment({ profiles: [{ suspended_at: '2026-07-24T12:00:00Z' }] })).toBe(false);
    expect(isActiveStudentAssignment({ profiles: null })).toBe(false);
  });
  it('collects every exact-size keyset page without offset gaps', async () => {
    const rows = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
    const cursors = [];
    const result = await collectKeysetPages(async (cursor, size) => {
      cursors.push(cursor);
      const start = cursor === null ? 0 : rows.findIndex((row) => row.id === cursor) + 1;
      return rows.slice(start, start + size);
    }, 2);
    expect(result).toEqual(rows);
    expect(cursors).toEqual([null, '2', '4']);
  });
  it('accepts canonical UUID cursors in database order', async () => {
    const rows = [
      { id: '0fffffff-ffff-4fff-8fff-ffffffffffff' },
      { id: '10000000-0000-4000-8000-000000000000' },
      { id: 'a0000000-0000-4000-8000-000000000000' },
    ];
    const result = await collectKeysetPages(async (cursor) => {
      const start = cursor === null ? 0 : rows.findIndex((row) => row.id === cursor) + 1;
      return rows.slice(start, start + 1);
    }, 1000);
    expect(result).toEqual(rows);
  });
  it('continues keyset pagination when the server caps pages below the requested size', async () => {
    const rows = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }];
    const cursors = [];
    const result = await collectKeysetPages(async (cursor) => {
      cursors.push(cursor);
      const start = cursor === null ? 0 : rows.findIndex((row) => row.id === cursor) + 1;
      return rows.slice(start, start + 2); // 서버 max_rows가 요청 pageSize보다 작은 상황
    }, 1000);
    expect(result).toEqual(rows);
    expect(cursors).toEqual([null, '2', '4', '5']);
  });
  it('returns immediately for an empty first keyset page', async () => {
    let calls = 0;
    const result = await collectKeysetPages(async () => { calls += 1; return []; }, 1000);
    expect(result).toEqual([]);
    expect(calls).toBe(1);
  });
  it('fails closed when a keyset page has no terminal id', async () => {
    await expect(collectKeysetPages(async () => [{ title: 'missing id' }], 1000))
      .rejects.toThrow('did not advance');
  });
  it('fails closed when a keyset cursor repeats immediately', async () => {
    await expect(collectKeysetPages(async () => [{ id: 'a' }], 1000))
      .rejects.toThrow('did not advance');
  });
  it('fails closed when a keyset cursor decreases', async () => {
    const pages = [[{ id: 'b' }], [{ id: 'a' }]];
    await expect(collectKeysetPages(async () => pages.shift() || [], 1000))
      .rejects.toThrow('did not advance');
  });
  it('fails closed on a multi-cursor cycle instead of looping', async () => {
    let calls = 0;
    await expect(collectKeysetPages(async (cursor) => {
      calls += 1;
      if (calls > 5) throw new Error('cycle escaped pagination guard');
      if (cursor === null) return [{ id: 'a' }];
      if (cursor === 'a') return [{ id: 'b' }];
      return [{ id: 'a' }];
    }, 1000)).rejects.toThrow('did not advance');
    expect(calls).toBe(3);
  });
  it('allows only the latest overlapping request to publish state', () => {
    const gate = createLatestRequestGate();
    const oldRequest = gate.begin();
    const newRequest = gate.begin();
    expect(gate.isLatest(oldRequest)).toBe(false);
    expect(gate.isLatest(newRequest)).toBe(true);
  });
  it('invalidates a selected review that disappeared and refreshes one that remains', () => {
    const selected = { attempt: { id: 'selected', body: 'old' } };
    const refreshed = { attempt: { id: 'selected', body: 'new' } };
    expect(reconcileQueueSelection(selected, [refreshed])).toBe(refreshed);
    expect(reconcileQueueSelection(selected, [{ attempt: { id: 'other' } }])).toBeNull();
    expect(reconcileQueueSelection(null, [refreshed])).toBeNull();
  });
  it('normalizes absent, singular, and array feedback relations', () => { const note = { body: '다시 풀기' }; expect(feedbackItems(null)).toEqual([]); expect(feedbackItems(note)).toEqual([note]); expect(feedbackItems([note])).toEqual([note]); });
  it('uses explicit feedback source and limits prefix inference to legacy rows', () => {
    const structured = [{ problem_ref: '3번' }];
    const prefix = '이번 제출에서 다시 확인할 부분입니다.\n3번';
    expect(isAutoComposedFeedback({ body: '직접 쓴 총평', auto_composed: true }, structured)).toBe(true);
    expect(isAutoComposedFeedback({ body: prefix, auto_composed: false }, structured)).toBe(false);
    expect(isAutoComposedFeedback({ body: prefix, auto_composed: null }, structured)).toBe(true);
    expect(isAutoComposedFeedback({ body: prefix }, [])).toBe(false);
  });
});
