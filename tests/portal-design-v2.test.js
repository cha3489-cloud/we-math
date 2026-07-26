import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  it('surfaces actionable revision and overdue work without making the operator inspect dates', () => {
    for (const id of ['revisionCount', 'overdueCount', 'actionSection', 'actionItems', 'actionEmpty']) {
      expect(admin).toContain(`id=${id}`);
    }
    expect(admin).toContain('오늘 후속 확인');
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
