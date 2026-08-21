import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const html = read('tablet/index.html');
const main = read('src/tablet/main.js');

describe('tablet page boundaries', () => {
  it('reuses the shared portal logic instead of duplicating it', () => {
    expect(main).toContain("from '../portal/client.js'");
    expect(main).toContain("from '../portal/domain.js'");
    expect(main).toContain("from '../auth.js'");
    for (const fn of ['validateLoginInput', 'validatePin', 'authErrorMessage', 'assignmentStatus', 'STATUS_META']) {
      expect(main).toContain(fn);
    }
  });

  it('keeps its own stylesheet so the desktop portal is untouched', () => {
    expect(main).toContain("import './tablet.css'");
    expect(main).not.toContain('portal.css');
  });

  it('blocks the today view until a forced pin change is done', () => {
    // must_change_pin 인 학생은 PIN 변경 화면에서 멈추고 과제 조회로 넘어가지 않아야 한다.
    expect(main).toMatch(/if \(profile\.must_change_pin\) \{ showPanel\('pinChange'\); return; \}/);
    const pinChangeIndex = main.indexOf('must_change_pin');
    const assignmentsIndex = main.indexOf("from('assignments')");
    expect(pinChangeIndex).toBeGreaterThan(-1);
    expect(assignmentsIndex).toBeGreaterThan(pinChangeIndex);
  });

  it('only ever asks for the signed-in student rows', () => {
    // 학생 화면은 자기 id 로만 조회한다. RLS 가 최종 방어선이지만 화면도 같은 조건을 쓴다.
    expect(main).toContain(".eq('student_id', user.id)");
    expect(main).not.toMatch(/from\('assignments'\)[^;]*\.neq\(/);
  });

  it('refuses a session whose role is not student', () => {
    expect(main).toMatch(/data\?\.role !== 'student'/);
    expect(main).toContain('await signOut()');
  });

  it('treats a missing session as signed out rather than crashing', () => {
    expect(main).toContain('currentUserOrNull');
    expect(main).toMatch(/if \(currentUser\) await loadToday\(currentUser\); else showPanel\('login'\)/);
  });

  it('gives the student an explicit logout control', () => {
    expect(html).toContain('id=logout');
    expect(main).toMatch(/byId\('logout'\)\.addEventListener\('click'[\s\S]*?signOut\(\)/);
  });

  it('never renders admin-only surfaces on the student tablet', () => {
    for (const forbidden of ['admin-users', 'review_submission', 'user_roles\' ,', 'PIN 재설정', '계정 만들기', '학생 목록']) {
      expect(html).not.toContain(forbidden);
    }
    expect(main).not.toContain('admin-users');
    expect(main).not.toContain('review_submission');
  });

  it('does not ship photo submission yet', () => {
    // 사진 제출은 다음 PR 범위다. 여기서 storage 를 건드리면 안 된다.
    expect(main).not.toContain('storage');
    expect(html).not.toContain('type=file');
    expect(main).not.toContain('createSignedUrl');
    expect(main).not.toContain('attachment_paths');
    expect(main).not.toContain('file_paths');
  });

  it('routes with the hash only, never the History API', () => {
    // GitHub Pages 에는 SPA fallback 이 없어 pushState 로 만든 경로는 새로고침 시 404 가 난다.
    expect(main).not.toContain('history.pushState');
    expect(main).not.toContain('history.replaceState');
    expect(main).toContain("location.hash = '#/assignment/'");
    expect(main).toMatch(/addEventListener\('hashchange'/);
  });

  it('opens a detail screen only for an assignment the student actually has', () => {
    expect(main).toContain('findAssignment(currentAssignments, route.id)');
    expect(main).toMatch(/if \(!assignment\) \{ showPanel\('today'\); goToday\(\); return; \}/);
  });

  it('clears the assignment route on logout so the next student starts clean', () => {
    expect(main).toMatch(/currentAssignments = \[\];[\s\S]*?signOut\(\)[\s\S]*?location\.replace\(location\.pathname\)/);
  });

  it('has a way back from the detail screen', () => {
    expect(html).toContain('id=detailBack');
    expect(main).toContain("byId('detailBack').addEventListener('click', goToday)");
  });

  it('renders the mathflat card as its own block', () => {
    expect(html).toContain('id=detailMathflat');
    expect(html).toContain('id=detailMathflatFields');
    expect(main).toContain('renderMathflat');
  });

  it('keeps the pin out of the DOM value and the network log', () => {
    // PIN 은 마스킹된 표시만 DOM 에 넣는다. input value 로 두지 않는다.
    expect(html).not.toMatch(/<input[^>]*id=pin[^>]*>/);
    expect(main).toContain('maskPin');
  });

  it('uses a large touch keypad instead of relying on the OS keyboard', () => {
    expect(html).toContain('id=loginKeypad');
    expect(html).toContain('id=pinKeypad');
    expect(read('src/tablet/tablet.css')).toContain('--touch-min:64px');
  });

  it('shows an empty state when the student has no assignment', () => {
    expect(html).toContain('id=emptyState');
    expect(main).toMatch(/byId\('emptyState'\)\.hidden = totalAssignmentCount\(sections\) > 0/);
  });
});
