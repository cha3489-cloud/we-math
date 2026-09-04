import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('portal design v2', () => {
  const student = read('student/index.html');
  const admin = read('admin/index.html');
  const studentJs = read('src/portal/student.js');
  const adminJs = read('src/portal/admin.js');
  const domainJs = read('src/portal/domain.js');
  const css = read('src/portal/portal.css');

  it('gives the student dashboard a clear coaching hierarchy', () => {
    expect(student).toContain('class="portal-kicker"');
    expect(student).toContain('class="student-hero"');
    expect(student).toContain('오늘 할 일');
    expect(student).toContain('class="student-status-nav"');
    expect(student).toContain('class="mobile-action-bar"');
    expect(studentJs).toContain("querySelector('.mobile-action-bar').hidden = !assignments.length");
  });

  it('turns the admin review view into a triage workspace', () => {
    expect(admin).toContain('class="workspace-header"');
    expect(admin).toContain('class="admin-stats"');
    expect(admin).toContain('class="queue-toolbar"');
    expect(admin).toContain('class="review-workbench"');
    expect(admin).toContain('확정 후 다음 제출로 이동');
  });

  it('links admin work lists to the count chips generated from their rendered rows', () => {
    expect(admin).toContain('id=actionItems class="cards action-items" aria-live=polite aria-describedby=actionSummaryCount');
    expect(admin).toContain('id=studentStatusItems class="cards student-status-items" aria-live=polite aria-describedby=studentStatusSummaryCount');
    expect(adminJs).toContain("byId('actionSummaryCount').textContent = adminSummaryCountCopy('actions', rows)");
    expect(adminJs).toContain("byId('actionItems').replaceChildren(...rows.map(actionCard))");
    expect(adminJs).toContain("byId('studentStatusSummaryCount').textContent = adminSummaryCountCopy('students', rows)");
    expect(adminJs).toContain("byId('studentStatusItems').replaceChildren(...rows.map(studentStatusCard))");
  });

  it('surfaces actionable revision and overdue work without making the operator inspect dates', () => {
    for (const id of ['principalCheckCount', 'questionCount', 'revisionCount', 'overdueCount', 'actionSection', 'actionItems', 'actionEmpty', 'studentStatusSection', 'studentStatusItems']) {
      expect(admin).toContain(`id=${id}`);
    }
    expect(admin).toContain('오늘 후속 확인');
    expect(admin).toContain('원장 확인 필요');
    expect(admin).toContain('질문 미답변');
    expect(admin).toContain('학생별 현재 상태');
    expect(adminJs).toContain('summarizeStudentOperations');
    expect(adminJs).toContain('studentOperationStatusCopy');
    expect(adminJs).toContain('renderStudentStatusItems');
    expect(adminJs).toContain('student-status-card');
    expect(admin).toContain('student-status-legend');
    expect(admin).toContain('우선순위 색상 안내');
    expect(admin).toContain('원장확인 우선');
    expect(admin).toContain('질문 답변 필요');
    expect(css).toContain('.student-status-legend');
    expect(adminJs).toContain('const statusKey = String(entry.status');
    expect(adminJs).toContain("card.className = 'card student-status-card student-status-' + statusKey");
    expect(adminJs).toContain("label.className = 'workflow-status status-' + statusKey");
    expect(css).toContain('.student-status-principal_check');
    expect(css).toContain('.student-status-questions');
    expect(adminJs).toContain("byId('studentStatusItems')");
    expect(admin).toContain('id=actionItems class="cards action-items" aria-live=polite');
    expect(admin).toContain('id=studentStatusItems class="cards student-status-items" aria-live=polite');
    expect(admin).toContain('id=studentStatusSummaryCount');
    expect(admin).toContain('조치 학생 집계 중');
    expect(adminJs).toContain("byId('studentStatusSummaryCount').textContent = adminSummaryCountCopy('students', rows)");
    expect(css).toContain('.student-status-count');
    expect(admin).toContain('id=userListPanel');
    expect(admin).toContain('id=workflowHistoryPanel');
    expect(admin).toContain('전체 사용자 목록');
    expect(admin).toContain('과제·제출 목록');
    expect(css).toContain('.admin-long-list');
    expect(admin).toContain('id=workflowFilterStatus');
    expect(admin).toContain('id=workflowFilterClear');
    expect(adminJs).toContain('workflowStudentFilter');
    expect(adminJs).toContain('filterWorkflowsByStudent');
    expect(adminJs).toContain('setWorkflowStudentFilter(safeStudentName)');
    expect(adminJs).toContain('openStudentReview(safeStudentName)');
    expect(adminJs).toContain('openStudentQuestions(safeStudentName)');
    expect(adminJs).toContain('questionStudentFilter');
    expect(adminJs).toContain('studentOperationSafeCounts');
    const studentStatusCardSource = adminJs.match(/function studentStatusCard[\s\S]*?\n}/)?.[0] || '';
    expect(studentStatusCardSource).not.toContain('entry.counts.');
    expect(adminJs).toContain('student-status-items-list');
    expect(adminJs).toContain('const visibleItems = Array.isArray(entry.visibleItems) ? entry.visibleItems : []');
    expect(adminJs).toContain('const hiddenItemCount = Number.isInteger(entry.hiddenItemCount) && entry.hiddenItemCount > 0 ? entry.hiddenItemCount : 0');
    expect(css).toContain('.student-status-more');
    expect(adminJs).toContain('student-status-actions');
    expect(css).toContain('.student-status-actions');
    expect(adminJs).toContain('showQuestions.hidden = !actionCounts.questions');
    expect(adminJs).toContain("showHistory.setAttribute('aria-label'");
    expect(adminJs).toContain("showReview.setAttribute('aria-label'");
    expect(adminJs).toContain("showQuestions.setAttribute('aria-label'");
    expect(domainJs).toContain('historyLabel');
    expect(domainJs).toContain('questionsLabel');
    expect(adminJs).toContain('fetchQuestionSummary');
    expect(admin).toContain('id=questionFilterStatus');
    expect(admin).toContain('id=questionFilterClear');
    expect(adminJs).toContain("byId('questionCount').textContent");
    expect(adminJs).toContain('loadQuestionCount');
    expect(adminJs).toContain("switchTab('questions')");
    expect(adminJs).toContain("openActionFilter('principal_check')");
    expect(admin).toContain('id=actionSummaryCount');
    expect(admin).toContain('후속 확인 집계 중');
    expect(adminJs).toContain("byId('actionSummaryCount').textContent = adminSummaryCountCopy('actions', rows)");
    expect(css).toContain('.action-summary-count');
    expect(adminJs).toContain('action-reason');
    expect(adminJs).toContain('action-next');
    expect(adminJs).toContain('action-card-actions');
    expect(adminJs).toContain("showHistory.setAttribute('aria-label', assignmentStudent(assignment) + ' 학생 ' + assignment.title + ' 기록 보기')");
    expect(adminJs).toContain("byId('actionSection').classList.toggle('action-section-filtered'");
    expect(adminJs).toContain("byId('actionShowAll').setAttribute('aria-label', copy.resetAriaLabel)");
    expect(css).toContain('.action-section-filtered');
    expect(css).toMatch(/@media\(max-width:640px\)[\s\S]*[.]action-section,[.]student-status-section\{padding:14px/);
    expect(css).toMatch(/@media\(max-width:640px\)[\s\S]*[.]action-card-actions,[.]student-status-actions\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    expect(css).toMatch(/@media\(max-width:640px\)[\s\S]*[.]action-card-actions button,[.]student-status-actions button\{width:100%;min-width:0/);
    expect(adminJs).toContain("byId('questionsSection').classList.toggle('question-section-filtered'");
    expect(css).toContain('.question-section-filtered');
    expect(adminJs).toContain('setWorkflowStudentFilter(assignmentStudent(assignment))');
    expect(adminJs).toContain('entry.reason');
    expect(adminJs).toContain('entry.nextAction');
    expect(adminJs).toContain('summarizeAdminWorkflows');
    expect(adminJs).toContain('REMOTE_PAGE_SIZE = 1000');
    expect(adminJs).toContain('collectKeysetPages(fetchQueuePage, REMOTE_PAGE_SIZE)');
    expect(adminJs).toContain('const nextQueue = reviewQueue(activeAssignments)');
    expect(adminJs).toContain('reconcileQueueSelection(current, nextQueue)');
    expect(adminJs).toContain('collectKeysetPages(fetchOperationsSummaryPage, REMOTE_PAGE_SIZE)');
    expect(adminJs).toContain("query = query.gt('id', cursor)");
    expect(adminJs).not.toContain('.limit(100);');
    expect(adminJs).not.toMatch(/OPERATIONS_SUMMARY_SELECT[\s\S]{0,500}[.]range\(/);
    expect(adminJs).toContain('queueRequestGate.isLatest(request)');
    expect(adminJs).toContain('operationsSummaryRequestGate.isLatest(request)');
    expect(adminJs).toContain('usersRequestGate.isLatest(request)');
    expect(adminJs).toContain('workflowsRequestGate.isLatest(request)');
    expect(adminJs).toContain("roles.get(user.id) === 'student' && isActiveProfile(user)");
    expect(adminJs).toContain('Promise.all([loadUsers(), loadQueue(), loadWorkflows(), loadOperationsSummary()])');
    expect(adminJs).toContain('처리는 완료됐지만 화면 새로고침에 실패했습니다.');
    expect(adminJs).toContain('과제 등록은 완료됐지만 화면 새로고침에 실패했습니다.');
    expect(adminJs).toContain('isActiveStudentAssignment');
    expect(domainJs).toContain("!profile.suspended_at");
    expect(domainJs).toContain('마감 지남 · 미제출');
    expect(adminJs).toContain("card.className = 'card workflow-card workflow-' + meta.status");
    expect(adminJs).toMatch(/card[.]append\(heading, status, title, metaLine\)/);
    expect(css).toContain('.workflow-overdue');
    expect(css).toContain('.workflow-status');
  });

  it('keeps malformed student status item previews from breaking card rendering', () => {
    const source = adminJs.match(/function studentStatusCard[\s\S]*?\n}/)?.[0] || '';
    const render = (entry) => {
      const dom = new JSDOM('<div id=adminError></div>');
      const byId = (id) => dom.window.document.getElementById(id);
      const showError = (el, message) => { el.textContent = message || ''; };
      const noop = () => {};
      const cardFactory = new Function(
        'document',
        'studentOperationStatusCopy',
        'studentOperationSafeCounts',
        'setWorkflowStudentFilter',
        'openStudentReview',
        'openStudentQuestions',
        'showError',
        'byId',
        source + '; return studentStatusCard;',
      );
      const studentOperationStatusCopy = () => ({
        summary: '처리할 항목 0건',
        historyLabel: '과제 이력 보기',
        reviewLabel: '검토 대기 열기',
        questionsLabel: '질문 보기',
      });
      const studentOperationSafeCounts = () => ({ submitted: 0, questions: 0 });
      return cardFactory(
        dom.window.document,
        studentOperationStatusCopy,
        studentOperationSafeCounts,
        noop,
        async () => {},
        noop,
        showError,
        byId,
      )(entry);
    };

    for (const visibleItems of [null, '검토 대기 · 문자열', { 0: '검토 대기 · 객체' }, undefined]) {
      expect(() => render({ name: '테스트 A', label: '검토 대기', status: 'submitted', visibleItems, hiddenItemCount: 0 })).not.toThrow();
    }
    for (const hiddenItemCount of [-1, 1.5, true, '2', Infinity]) {
      const card = render({ name: '테스트 A', label: '검토 대기', status: 'submitted', visibleItems: ['검토 대기 · A'], hiddenItemCount });
      expect(card.textContent).not.toContain('외 ');
    }

    const card = render({ name: '테스트 A', label: '검토 대기', status: 'submitted', visibleItems: ['검토 대기 · A'], hiddenItemCount: 2 });
    expect(card.textContent).toContain('외 2건은 이 학생 기록에서 확인');
  });

  it('falls back for malformed student status card strings', () => {
    const source = adminJs.match(/function studentStatusCard[\s\S]*?\n}/)?.[0] || '';
    const render = (entry, statusCopy = {}) => {
      const dom = new JSDOM('<div id=adminError></div>');
      const byId = (id) => dom.window.document.getElementById(id);
      const showError = (el, message) => { el.textContent = message || ''; };
      const noop = () => {};
      const cardFactory = new Function(
        'document',
        'studentOperationStatusCopy',
        'studentOperationSafeCounts',
        'setWorkflowStudentFilter',
        'openStudentReview',
        'openStudentQuestions',
        'showError',
        'byId',
        source + '; return studentStatusCard;',
      );
      const studentOperationStatusCopy = () => ({
        summary: '처리할 항목 0건',
        historyLabel: '과제 이력 보기',
        reviewLabel: '검토 대기 열기',
        questionsLabel: '질문 보기',
        ...statusCopy,
      });
      const studentOperationSafeCounts = () => ({ submitted: 1, questions: 1 });
      return cardFactory(
        dom.window.document,
        studentOperationStatusCopy,
        studentOperationSafeCounts,
        noop,
        async () => {},
        noop,
        showError,
        byId,
      )(entry);
    };

    const card = render({
      name: { raw: '테스트 A' },
      label: ['검토 대기'],
      status: 'submitted',
      nextAction: () => '제출물을 검토하세요.',
      visibleItems: ['검토 대기 · A', { text: '객체 항목' }, undefined],
      hiddenItemCount: 0,
    }, {
      summary: { text: '처리할 항목 1건' },
      historyLabel: undefined,
      reviewLabel: ['검토 대기 열기'],
      questionsLabel: () => '질문 보기',
    });

    expect(card.querySelector('h3')?.textContent).toBe('학생');
    expect(card.querySelector('.workflow-status')?.textContent).toBe('상태 확인 필요');
    expect(card.querySelector('.meta')?.textContent).toBe('처리할 항목 0건');
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['과제 이력 보기', '검토 대기 열기', '질문 보기']);
    expect(card.querySelector('.action-next')?.textContent).toBe('다음 조치: 담당자가 상태를 확인하세요.');
    expect(card.textContent).not.toContain('[object Object]');
    expect(card.textContent).not.toContain('undefined');
    expect(card.textContent).not.toContain('() =>');
  });

  it('keeps filtered history and question empty states specific to the selected student', () => {
    expect(domainJs).toContain('filteredAdminListCopy');
    expect(admin).toContain('id=workflowEmpty');
    expect(adminJs).toContain('filteredAdminListCopy');
    expect(adminJs).toContain("const copy = filteredAdminListCopy('questions', questionStudentFilter)");
    expect(adminJs).toContain("byId('questionsEmpty').querySelector('h3').textContent = questionStudentFilter ? copy.emptyTitle : emptyCopy.title");
    expect(adminJs).toContain("byId('questionFilterClear').textContent = copy.resetLabel");
    expect(adminJs).toContain("byId('questionFilterClear').setAttribute('aria-label', copy.resetAriaLabel)");
    expect(adminJs).toContain("byId('questionFilterClear').hidden = copy.clearHidden");
    expect(adminJs).toContain("const copy = filteredAdminListCopy('workflows', workflowStudentFilter)");
    expect(adminJs).toContain("byId('workflowEmpty').querySelector('h3').textContent = copy.emptyTitle");
    expect(adminJs).toContain("byId('workflowFilterClear').textContent = copy.resetLabel");
    expect(adminJs).toContain("byId('workflowFilterClear').setAttribute('aria-label', copy.resetAriaLabel)");
    expect(adminJs).toContain("byId('workflowFilterClear').hidden = copy.clearHidden");
  });

  it('keeps routine admin tools folded below today work so the page is less cluttered', () => {
    expect(admin).toContain('id=adminTools');
    expect(admin).toContain('<summary><span>운영 도구</span>');
    expect(admin).toContain('계정 발급과 과제 등록은 필요할 때만 펼쳐서 사용합니다.');
    expect(admin).toMatch(/<details id=adminTools class="admin-tools">[\s\S]*<div class=manage-grid>/);
    expect(admin).not.toMatch(/<details id=adminTools[^>]*open/);
    expect(css).toContain('.admin-tools');
    expect(css).toContain('.admin-tools summary');
  });

  it('makes collapsed admin long lists scannable when opened', () => {
    expect(admin).toContain('<small>이름·역할·상태만 빠르게 확인할 때 펼칩니다.</small>');
    expect(admin).toContain('<div id=users class="cards compact-admin-cards user-list-cards"></div>');
    expect(admin).toContain('<small>최근 50개씩, 상태 배지와 제출 차수 중심으로 확인합니다.</small>');
    expect(admin).toContain('<div id=workflows class="cards compact-admin-cards workflow-history-cards"></div>');
    expect(css).toContain('.admin-long-list[open] summary');
    expect(css).toContain('.compact-admin-cards');
    expect(css).toContain('.compact-admin-cards .card');
    expect(css).toContain('.workflow-history-cards .workflow-card');
    expect(css).toContain('.workflow-history-cards .workflow-card h3{font-size:1.02rem;line-height:1.2}');
    expect(css).toContain('.workflow-history-cards .workflow-card .meta{margin-bottom:4px;font-size:.82rem}');
    expect(css).toContain('.workflow-history-cards .workflow-card>p:not(.workflow-title):not(.meta){margin-bottom:6px;font-size:.86rem;line-height:1.35}');
    expect(css).toContain('.workflow-history-cards .attempt-history');
    expect(adminJs).toContain("card.className = 'card admin-user-card user-role-' + roleKey");
    expect(adminJs).toContain("roleBadge.className = 'account-status user-role-badge role-' + roleKey");
    expect(adminJs).toContain("statusBadge.textContent = user.suspended_at ? '정지' : '활성'");
    expect(css).toContain('.user-list-cards .admin-user-card');
    expect(css).toContain('.user-list-cards .user-role-badge');
    expect(css).toContain('.user-list-cards .account-status');
    expect(css).toContain('.role-admin');
    expect(css).toContain('@media(max-width:640px)');
    expect(css).toContain('.admin-long-list summary{display:grid');
  });

  it('shows live count chips on collapsed admin inventory panels', () => {
    expect(admin).toContain('id=userListSummaryCount');
    expect(admin).toContain('id=workflowHistorySummaryCount');
    expect(admin).toContain('사용자 불러오는 중');
    expect(admin).toContain('기록 불러오는 중');
    expect(adminJs).toContain("byId('userListSummaryCount').textContent = cards.length ? '사용자 ' + cards.length + '명' : '사용자 없음'");
    expect(adminJs).toContain("byId('workflowHistorySummaryCount').textContent = total ? '과제 ' + total + '건' : '과제 없음'");
    expect(css).toContain('.admin-long-list summary strong');
    expect(css).toContain('.admin-long-list[open] summary strong');
  });

  it('uses sanitized Claude illustrations with the portal brand palette', () => {
    expect(student).toContain('/portal/login-progress.svg');
    expect(student).toContain('/portal/empty-state.svg');
    expect(admin).toContain('/portal/login-progress.svg');
    expect(admin).toContain('/portal/empty-state.svg');

    for (const name of ['login-progress.svg', 'empty-state.svg']) {
      const svg = read(`public/portal/${name}`);
      expect(svg).toContain('#173F3A');
      expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+=|(?:href|src)=/i);
      expect(svg).not.toMatch(/<text/i);
    }
  });

  it('uses a shared warm, accessible design system', () => {
    for (const token of ['--ink:', '--navy:', '--mint:', '--cream:', '--coral:', '--focus-ring:']) {
      expect(css).toContain(token);
    }
    expect(css).toContain(':focus-visible');
    expect(css).toMatch(/@media\(max-width:640px\)/);
    expect(css).toContain('min-height:44px');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toMatch(/body::before\{[^}]*z-index:0/);
    expect(css).toMatch(/\.portal\{[^}]*position:relative;z-index:1/);
    expect(css).toContain('.admin-stats{background:var(--navy);');
    expect(css).toMatch(/\.review-head\{[^}]*word-break:keep-all/);
  });
});
