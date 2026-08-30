// 적용 경로: src/portal/domain.js (전체 교체 — 기존 export 전부 유지 + 신규 추가)

// ── 기존 함수 (변경 없음) ────────────────────────────────────────────────
export function normalizePhone(value) {
  const phone = String(value ?? '').replace(/[^0-9]/g, '');
  if (!/^01[016789][0-9]{7,8}$/.test(phone)) throw new Error('올바른 휴대전화 번호를 입력하세요.');
  return phone;
}
export function validatePin(pin) { if (!/^\d{6}$/.test(String(pin ?? ''))) throw new Error('PIN은 숫자 6자리여야 합니다.'); return String(pin); }
export function validateLoginPin(pin) { const value = String(pin ?? ''); if (!/^(?:[0-9]{4}|[0-9]{6})$/.test(value)) throw new Error('PIN은 숫자 4자리 또는 6자리여야 합니다.'); return value; }
export function validateLoginInput(phone, pin) { return { phone: normalizePhone(phone), pin: validateLoginPin(pin) }; }
export function authErrorMessage(error) {
  const code = error?.code;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === 'user_banned' || message === 'User is banned') {
    return '현재 이용이 중지된 계정입니다. 원장님께 문의해 주세요.';
  }
  if (code === 'invalid_credentials' || message === 'Invalid login credentials') {
    return '전화번호 또는 PIN이 올바르지 않습니다.';
  }
  return message || '로그인에 실패했습니다. 다시 시도해 주세요.';
}
export function validateAccountInput(input) {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 40) throw new Error('이름은 1~40자로 입력하세요.');
  if (!['student', 'admin'].includes(input.role)) throw new Error('허용되지 않은 역할입니다.');
  return { name, phone: normalizePhone(input.phone), pin: validatePin(input.pin), role: input.role };
}
export function validateSubmissionInput(body, files = []) {
  const clean = String(body ?? '').trim();
  if (files.length > 3) throw new Error('제출 파일은 최대 3개까지 가능합니다.');
  if (!clean && !files.length) throw new Error('제출 내용 또는 파일을 추가하세요.');
  return { body: clean, hasFiles: files.length > 0 };
}
export function latestAttempt(attempts = []) {
  return [...attempts].sort((a, b) => Number(b.attempt_no) - Number(a.attempt_no))[0] ?? null;
}
export function canSubmitAttempt(attempts = []) {
  const latest = latestAttempt(attempts);
  return !latest || latest.status === 'needs_revision';
}
export function assignmentStatus(assignment, now = new Date()) {
  const latest = latestAttempt(normalizeRelation(assignment.submissions));
  if (latest) return latest.status;
  if (assignment.due_at && new Date(assignment.due_at) < now) return 'overdue';
  return 'open';
}

const ADMIN_WORKFLOW_META = {
  principal_check: { label: '원장 확인 필요', actionRequired: true, priority: 0 },
  overdue: { label: '마감 지남 · 미제출', actionRequired: true, priority: 1, nextAction: '학생에게 제출 가능 여부를 확인하세요.' },
  needs_revision: { label: '수정 필요', actionRequired: true, priority: 2, nextAction: '재풀이 제출 여부를 확인하세요.' },
  submitted: { label: '검토 대기', actionRequired: false, priority: 3 },
  open: { label: '미제출', actionRequired: false, priority: 4 },
  completed: { label: '완료', actionRequired: false, priority: 5 },
};
function principalCheckReason(assignment, now = new Date()) {
  const latest = latestAttempt(normalizeRelation(assignment.submissions));
  if (latest?.status === 'needs_revision' && Number(latest.attempt_no) >= 2) return `${Number(latest.attempt_no)}차 수정 필요`;
  if (!latest && assignment.due_at) {
    const due = new Date(assignment.due_at).getTime();
    const current = new Date(now).getTime();
    if (Number.isFinite(due) && Number.isFinite(current) && current - due >= 2 * 24 * 60 * 60 * 1000) return '마감 2일 이상 미제출';
  }
  return '';
}
function principalCheckNextAction(reason) {
  if (reason === '마감 2일 이상 미제출') return '오늘 수업 전 과제량과 난이도 조정을 확인하세요.';
  if (/차 수정 필요$/.test(reason)) return '재풀이 실패 원인을 확인하고 다음 과제 분량을 조정하세요.';
  return '';
}
export function adminWorkflowMeta(assignment, now = new Date()) {
  const reason = principalCheckReason(assignment, now);
  const status = reason ? 'principal_check' : assignmentStatus(assignment, now);
  const meta = { status, ...ADMIN_WORKFLOW_META[status], ...(reason ? { reason } : {}) };
  const nextAction = reason ? principalCheckNextAction(reason) : meta.nextAction;
  return nextAction ? { ...meta, nextAction } : meta;
}
export function isActiveProfile(profile) {
  return Boolean(profile) && !profile.suspended_at;
}
export function isActiveStudentAssignment(assignment) {
  const profile = normalizeRelation(assignment?.profiles)[0];
  return isActiveProfile(profile);
}
export async function collectKeysetPages(fetchPage, pageSize = 1000) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer');
  const rows = [];
  const seenCursors = new Set();
  let cursor = null;
  for (;;) {
    const page = normalizeRelation(await fetchPage(cursor, pageSize));
    if (!page.length) return rows;
    rows.push(...page);
    const nextCursor = page.at(-1)?.id;
    const nextCursorKey = String(nextCursor || '');
    if (!nextCursorKey || seenCursors.has(nextCursorKey)
      || (cursor !== null && nextCursorKey <= String(cursor))) {
      throw new Error('Keyset pagination did not advance');
    }
    seenCursors.add(nextCursorKey);
    cursor = nextCursorKey;
  }
}
export function createLatestRequestGate() {
  let current = 0;
  return {
    begin() { current += 1; return current; },
    isLatest(request) { return request === current; },
  };
}
export function reconcileQueueSelection(selected, queue = []) {
  const selectedId = selected?.attempt?.id;
  if (!selectedId) return null;
  return queue.find((entry) => entry?.attempt?.id === selectedId) ?? null;
}
export function filteredAdminListCopy(kind, studentName = '') {
  const name = String(studentName || '').trim();
  if (kind === 'questions') {
    return name ? {
      status: name + ' 학생 질문만 표시합니다.',
      emptyTitle: name + ' 학생의 답변 대기 질문이 없습니다.',
      emptyBody: '필터를 해제하면 전체 학생 질문을 다시 볼 수 있습니다.',
      resetLabel: '전체 학생 질문 보기',
      resetAriaLabel: name + ' 학생 질문 필터를 해제하고 전체 학생 질문 보기',
      clearHidden: false,
    } : {
      status: '전체 학생 질문을 표시합니다.',
      emptyTitle: '답변을 기다리는 질문이 없습니다.',
      emptyBody: '학생이 새 질문을 남기면 여기에 표시됩니다.',
      resetLabel: '필터 해제',
      resetAriaLabel: '학생 질문 필터 없이 전체 질문 보기',
      clearHidden: true,
    };
  }
  return name ? {
    status: name + ' 학생 기록만 표시합니다.',
    emptyTitle: name + ' 학생의 표시할 과제 기록이 없습니다.',
    emptyBody: '필터를 해제하면 전체 학생 기록을 다시 볼 수 있습니다.',
    resetLabel: '전체 학생 기록 보기',
    resetAriaLabel: name + ' 학생 기록 필터를 해제하고 전체 학생 기록 보기',
    clearHidden: false,
  } : {
    status: '전체 학생 기록을 표시합니다.',
    emptyTitle: '과제 없음',
    emptyBody: '등록된 과제가 생기면 여기에 표시됩니다.',
    resetLabel: '필터 해제',
    resetAriaLabel: '학생 기록 필터 없이 전체 기록 보기',
    clearHidden: true,
  };
}
export function summarizeAdminWorkflows(assignments = [], now = new Date()) {
  const counts = { principal_check: 0, submitted: 0, needs_revision: 0, overdue: 0 };
  const actionItems = [];
  for (const assignment of assignments) {
    const meta = adminWorkflowMeta(assignment, now);
    if (Object.hasOwn(counts, meta.status)) counts[meta.status] += 1;
    if (meta.actionRequired) actionItems.push({ assignment, ...meta });
  }
  actionItems.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aLatest = latestAttempt(normalizeRelation(a.assignment.submissions));
    const bLatest = latestAttempt(normalizeRelation(b.assignment.submissions));
    const aTime = new Date(a.assignment.due_at || aLatest?.reviewed_at || aLatest?.submitted_at || 0).getTime();
    const bTime = new Date(b.assignment.due_at || bLatest?.reviewed_at || bLatest?.submitted_at || 0).getTime();
    return aTime - bTime;
  });
  return { counts, actionItems };
}
export function summarizeStudentOperations(assignments = [], now = new Date(), questions = []) {
  const byStudent = new Map();
  const ensureRow = (name) => {
    if (!byStudent.has(name)) {
      byStudent.set(name, { name, total: 0, label: '', status: '', priority: Infinity, counts: { principal_check: 0, submitted: 0, needs_revision: 0, overdue: 0, questions: 0 }, nextAction: '', items: [] });
    }
    return byStudent.get(name);
  };
  for (const assignment of assignments) {
    const meta = adminWorkflowMeta(assignment, now);
    if (!meta.actionRequired && meta.status !== 'submitted') continue;
    const profile = normalizeRelation(assignment?.profiles)[0];
    const name = profile?.name || '학생';
    const row = ensureRow(name);
    row.total += 1;
    if (Object.hasOwn(row.counts, meta.status)) row.counts[meta.status] += 1;
    row.items.push({ priority: meta.priority, text: `${meta.label} · ${assignment.title || '과제'}` });
    if (meta.priority < row.priority) {
      row.priority = meta.priority;
      row.label = meta.label;
      row.status = meta.status;
      row.nextAction = meta.nextAction || (meta.status === 'submitted' ? '제출물을 검토하세요.' : '');
    }
  }
  for (const question of normalizeRelation(questions)) {
    const profile = normalizeRelation(question?.profiles)[0];
    if (!isActiveProfile(profile)) continue;
    const name = profile.name || '학생';
    const row = ensureRow(name);
    row.total += 1;
    row.counts.questions += 1;
    if (6 < row.priority) {
      row.priority = 6;
      row.label = '질문 미답변';
      row.status = 'questions';
      row.nextAction = '질문에 답변하세요.';
    }
  }
  return [...byStudent.values()]
    .map((row) => {
      const items = row.counts.questions
        ? [...row.items, { priority: 6, text: `질문 미답변 · ${row.counts.questions}건` }]
        : row.items;
      const orderedItems = items.sort((a, b) => a.priority - b.priority).map((item) => item.text);
      return { ...row, items: orderedItems, visibleItems: orderedItems.slice(0, 3), hiddenItemCount: Math.max(0, orderedItems.length - 3) };
    })
    .sort((a, b) => a.priority - b.priority || b.total - a.total || a.name.localeCompare(b.name, 'ko'))
    .map(({ priority, ...row }) => row);
}

export function studentOperationStatusCopy(entry = {}) {
  const counts = entry.counts || {};
  const parts = [
    ['principal_check', '원장확인'],
    ['submitted', '검토'],
    ['needs_revision', '수정'],
    ['overdue', '미제출'],
    ['questions', '질문'],
  ]
    .map(([key, label]) => ({ label, count: Number(counts[key] || 0) }))
    .filter((item) => item.count > 0)
    .map((item) => item.label + ' ' + item.count);
  const fallbackTotal = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
  const total = Number(entry.total || fallbackTotal);
  const submittedCount = Number(counts.submitted || 0);
  const questionCount = Number(counts.questions || 0);
  return {
    summary: ['처리할 항목 ' + total + '건', ...parts].join(' · '),
    historyLabel: '과제 이력 보기',
    reviewLabel: submittedCount > 1 ? '검토 대기 ' + submittedCount + '건 열기' : '검토 대기 열기',
    questionsLabel: questionCount > 1 ? '질문 ' + questionCount + '건 보기' : '질문 보기',
  };
}

const ADMIN_ACTION_FILTER_COPY = {
  all: {
    status: '전체 후속 확인: 원장 확인, 수정 대기, 미제출 지연을 조치 순서대로 표시합니다.',
    emptyTitle: '후속 확인이 필요한 과제가 없습니다.',
    emptyBody: '새 원장 확인·수정 대기·미제출 지연이 생기면 여기에 표시됩니다.',
    resetLabel: '전체 보기',
    resetAriaLabel: '후속 확인 필터 없이 전체 항목 보기',
    clearHidden: true,
  },
  principal_check: {
    status: '원장 확인 필요만 표시합니다: 반복 미제출 또는 반복 수정으로 원장 판단이 필요한 학생입니다.',
    emptyTitle: '원장 확인 필요 과제가 없습니다.',
    emptyBody: '필터를 해제하면 수정 대기와 미제출 지연까지 다시 볼 수 있습니다.',
    resetLabel: '전체 후속 확인 보기',
    resetAriaLabel: '원장 확인 필요 필터를 해제하고 전체 후속 확인 보기',
    clearHidden: false,
  },
  needs_revision: {
    status: '수정 대기만 표시합니다: 피드백 이후 재풀이 제출을 기다리는 학생입니다.',
    emptyTitle: '수정 대기 과제가 없습니다.',
    emptyBody: '필터를 해제하면 원장 확인과 미제출 지연까지 다시 볼 수 있습니다.',
    resetLabel: '전체 후속 확인 보기',
    resetAriaLabel: '수정 대기 필터를 해제하고 전체 후속 확인 보기',
    clearHidden: false,
  },
  overdue: {
    status: '미제출 지연만 표시합니다: 마감이 지났지만 아직 제출이 없는 학생입니다.',
    emptyTitle: '미제출 지연 과제가 없습니다.',
    emptyBody: '필터를 해제하면 원장 확인과 수정 대기까지 다시 볼 수 있습니다.',
    resetLabel: '전체 후속 확인 보기',
    resetAriaLabel: '미제출 지연 필터를 해제하고 전체 후속 확인 보기',
    clearHidden: false,
  },
};
export function adminActionFilterCopy(filter = 'all') {
  return ADMIN_ACTION_FILTER_COPY[filter] || ADMIN_ACTION_FILTER_COPY.all;
}

// ── 관계 데이터 정규화: null / object / array 어떤 형태든 배열로 ──────────
export function normalizeRelation(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}
// 기존 호출부 호환 유지
export function feedbackItems(value) { return normalizeRelation(value); }

// ── 상태 표시 (문구 + 아이콘, 색상 단독 구분 금지) ─────────────────────
export const STATUS_META = {
  open: { icon: '📝', label: '제출할 과제' },
  overdue: { icon: '⏰', label: '기한이 지났어요 · 지금도 제출할 수 있어요' },
  submitted: { icon: '⏳', label: '선생님 확인 중' },
  needs_revision: { icon: '✏️', label: '다시 확인할 부분 있음' },
  completed: { icon: '✅', label: '완료' },
};

// ── 1차 피드백 태그: 성격·태도 평가가 아니라 이번 풀이의 확인 지점 ─────
export const REVIEW_TAGS = [
  '풀이 시작 보완',
  '조건·문제 이해 확인',
  '개념 연결 보완',
  '계산·부호 확인',
  '풀이 마무리·검산',
];

export function validateProblemRef(value) {
  const clean = String(value ?? '').trim();
  if (!clean || clean.length > 40) throw new Error('문제 번호는 1~40자로 입력하세요.');
  return clean;
}

export function validateFeedbackItems(items = []) {
  if (!Array.isArray(items)) throw new Error('피드백 항목 형식이 올바르지 않습니다.');
  if (items.length > 20) throw new Error('피드백 항목은 최대 20개까지 가능합니다.');
  return items.map((item) => {
    const tag = String(item?.review_tag ?? '');
    if (!REVIEW_TAGS.includes(tag)) throw new Error('허용되지 않은 확인 태그입니다.');
    const comment = String(item?.comment ?? '').trim();
    if (comment.length > 1000) throw new Error('항목 코멘트는 1000자 이내로 입력하세요.');
    return {
      problem_ref: validateProblemRef(item?.problem_ref),
      review_tag: tag,
      comment,
      redo_required: Boolean(item?.redo_required),
    };
  });
}

export function checkItemsForStatus(status, items = []) {
  const redo = items.filter((item) => item.redo_required).length;
  if (status === 'needs_revision' && redo === 0) throw new Error('수정 필요로 확정하려면 다시 풀 문제를 1개 이상 지정하세요.');
  if (status === 'completed' && redo > 0) throw new Error('완료로 확정하려면 다시 풀 문제 지정을 해제하세요.');
  return true;
}

// 총평이 비어 있으면 항목으로 하위 호환용 feedback.body를 구성
export function composeFeedbackBody(items = [], comment = '') {
  const clean = String(comment ?? '').trim();
  if (clean) return clean.slice(0, 4000);
  if (!items.length) throw new Error('총평 또는 확인 항목을 1개 이상 입력하세요.');
  const lines = items.map((item) =>
    item.problem_ref + ' · ' + item.review_tag + (item.comment ? ' — ' + item.comment : ''));
  return ['이번 제출에서 다시 확인할 부분입니다.', ...lines].join('\n').slice(0, 4000);
}

// ── 검토 대기열: 최신 attempt가 submitted인 것만, 오래된 순 ─────────────
export function reviewQueue(assignments = []) {
  const rows = [];
  for (const assignment of assignments) {
    const attempts = normalizeRelation(assignment.submissions);
    const latest = latestAttempt(attempts);
    if (latest && latest.status === 'submitted') rows.push({ assignment, attempt: latest });
  }
  return rows.sort((a, b) => new Date(a.attempt.submitted_at) - new Date(b.attempt.submitted_at));
}

export function waitingLabel(submittedAt, now = new Date()) {
  const ms = now - new Date(submittedAt);
  if (!Number.isFinite(ms) || ms < 60000) return '방금 제출';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return minutes + '분 대기';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + '시간 대기';
  return Math.floor(hours / 24) + '일 대기';
}

// ── 학생 대시보드 그룹: 수정 필요 → 제출할 것 → 확인 중 → 완료 ──────────
export function groupAssignments(assignments = [], now = new Date()) {
  const groups = { redo: [], open: [], review: [], done: [] };
  for (const assignment of assignments) {
    const status = assignmentStatus(assignment, now);
    if (status === 'needs_revision') groups.redo.push(assignment);
    else if (status === 'submitted') groups.review.push(assignment);
    else if (status === 'completed') groups.done.push(assignment);
    else groups.open.push(assignment); // open + overdue
  }
  return groups;
}

// 최신 피드백에서 다시 풀 문제 목록 추출
export function redoProblems(feedbackValue) {
  const items = normalizeRelation(feedbackValue)
    .flatMap((entry) => normalizeRelation(entry?.feedback_items));
  return items.filter((item) => item?.redo_required).map((item) => item.problem_ref);
}
export function allFeedbackItems(feedbackValue) {
  return normalizeRelation(feedbackValue)
    .flatMap((entry) => normalizeRelation(entry?.feedback_items));
}
// ── 내부 메모(원장 전용): 학생 화면에는 절대 실리지 않는다 ───────────────
// 빈 값은 오류가 아니라 "메모 없음"이다. RPC 가 빈 값을 받으면 기존 행을 지운다.
export function validateInternalNote(note) {
  const clean = String(note ?? '').trim();
  if (clean.length > 2000) throw new Error('내부 메모는 2000자까지 입력할 수 있습니다.');
  return clean;
}

export function isAutoComposedFeedback(note, structuredItems = []) {
  if (note?.auto_composed === true) return true;
  if (note?.auto_composed === false) return false;
  return structuredItems.length > 0
    && String(note?.body || '').startsWith('이번 제출에서 다시 확인할 부분입니다.');
}

// ── 업로드 품질 검사(순수 판정부): 경고만, 제출 차단 금지 ────────────────
export function assessImageQuality(metrics, { minDimension = 900, blurThreshold = 60 } = {}) {
  if (!metrics) return []; // 분석 실패 시 경고 없이 제출 허용
  const warnings = [];
  if (Math.max(metrics.width || 0, metrics.height || 0) < minDimension) {
    warnings.push({ code: 'low_resolution', message: '해상도가 낮아요. 조금 더 가까이에서 찍으면 선생님이 정확히 볼 수 있어요.' });
  }
  if (typeof metrics.blurScore === 'number' && metrics.blurScore < blurThreshold) {
    warnings.push({ code: 'blurry', message: '사진이 흐릿하게 보여요. 초점을 맞춰 다시 찍는 것을 권해요.' });
  }
  return warnings;
}
