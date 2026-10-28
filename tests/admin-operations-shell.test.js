import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { activateAdminView, bindAdminShell, createAdminNavigationGate, studentSearchMatches } from '../src/portal/admin-shell.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function shellDom() {
  const dom = new JSDOM(`
    <header id="portalHeader"><button id="logout"></button></header>
    <button id="adminMenuToggle" aria-expanded="false"></button>
    <div id="adminShell" data-menu-open="false">
      <aside id="adminSidebar">
      <button id="adminMenuClose"></button>
      <button data-admin-view="dashboard"></button>
      <button data-admin-view="review"></button>
      <button id="manageRoot" data-admin-view="manage" data-admin-target="action"></button>
      <button id="manageStudents" data-admin-view="manage" data-admin-target="students"></button>
      <button data-admin-view="questions"></button>
      <button id="manageUsers" data-admin-view="manage" data-admin-target="users"></button>
      <button id="manageWorkflows" data-admin-view="manage" data-admin-target="workflows"></button>
      </aside>
      <div id="adminShellMain">
        <span id="adminCrumbGroup"></span>
        <span id="adminCrumbTitle"></span>
        <h1 id="adminViewTitle"></h1>
        <p id="adminViewDescription"></p>
        <main id="adminDashboard"></main>
        <section id="reviewSection"></section>
        <section id="manageSection"></section>
        <section id="questionsSection"></section>
      </div>
    </div>
  `, { url: 'https://example.test' });
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {} });
  return dom;
}

describe('academy operations shell', () => {
  it('matches the supplied academy-system frame before exposing live workflows', () => {
    const admin = read('admin/index.html');
    const css = read('src/portal/portal.css');

    expect(admin).toContain('class=academy-topbar');
    expect(admin).toContain('id=adminCrumbGroup');
    expect(admin).toContain('id=adminCrumbTitle');
    expect(admin).toContain('id=adminViewTitle');
    expect(admin).toContain('id=adminViewDescription');
    expect(admin).toContain('id=adminStudentSearchForm');
    expect(admin).toContain('id=adminStudentSearch');
    expect(admin).toContain('placeholder="학생 이름 검색"');
    expect(admin).toContain('오늘 할 일');
    expect(admin).toContain('학생·사용자');
    expect(admin).toContain('과제·제출·재풀이');
    expect(admin).toContain('제출 검토');
    expect(admin).toContain('질문');
    expect(css).toContain("font-family:'IBM Plex Sans KR'");
    expect(css).toContain("url('/portal/fonts/ibm-plex-sans-kr-400.woff2')");
    expect(css).not.toContain('fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR');
    expect(css).not.toContain('--academy-navy:#0a1530');
    expect(css).toContain('--academy-sky:#0ea5e9');
    expect(css).toContain('background:#f3f6fa');
    expect(css).toMatch(/[.]admin-shell\{[^}]*grid-template-columns:248px minmax\(0,1fr\)/);
    expect(css).toMatch(/[.]academy-topbar\{[^}]*background:#fff/);
    expect(css).toMatch(/[.]admin-authenticated [.]admin-sidebar\{[^}]*background:#fff/);
    expect(css).toMatch(/[.]admin-authenticated [.]admin-sidebar-nav button\[aria-current=page\]\{[^}]*background:#e0f2fe;[^}]*color:#075985/);
  });

  it('ships the reference-like information architecture without fake operational metrics', () => {
    const admin = read('admin/index.html');
    const css = read('src/portal/portal.css');

    expect(admin).toContain('id=adminShell');
    expect(admin).toContain('class=admin-sidebar');
    expect(admin).toContain('id=adminSidebar');
    expect(admin).toContain('실제 데이터 메뉴');
    expect(admin).not.toContain('준비 중');
    expect(admin).not.toContain('업무 캘린더');
    expect(admin).not.toContain('출결 관리');
    expect(admin).not.toContain('상담·등록');
    expect(admin).not.toContain('교재 관리');
    expect(admin).not.toContain('다음 구축 영역');
    expect(admin).toContain('data-admin-view=dashboard');
    expect(admin).toContain('data-admin-view=review');
    expect(admin).toContain('data-admin-view=manage');
    expect(admin).toContain('data-admin-view=questions');
    expect(admin).toContain('id=adminDashboard');
    expect(admin).toContain('id=adminMenuClose');
    expect(admin).not.toContain('재원생 96');
    expect(css).toContain('.admin-shell');
    expect(css).toContain('.admin-sidebar');
    expect(css).toContain('@media(max-width:900px)');
    expect(css).toMatch(/@media\(max-width:640px\)[\s\S]*[.]admin-stats\{[^}]*width:100%;[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    expect(css).toMatch(/@media\(max-width:640px\)[\s\S]*[.]admin-stat\{[^}]*min-width:0/);
  });

  it('connects the shell to the existing secure admin workflows and opens home first', () => {
    const adminJs = read('src/portal/admin.js');

    expect(adminJs).toContain("from './admin-shell.js'");
    expect(adminJs).toContain('activateAdminView(document, tab, target)');
    expect(adminJs).toContain('bindAdminShell(document');
    expect(adminJs).toContain('const adminNavigationGate = createAdminNavigationGate()');
    expect(adminJs).toContain('if (!adminNavigationGate.isLatest(navigation)) return');
    expect(adminJs).toContain('async function openReview(index, navigation = null)');
    expect(adminJs).toContain('const reviewNavigation = adminNavigationGate.ensure(navigation)');
    expect(adminJs).toContain('if (!isCurrentAdminNavigation(reviewNavigation)) return');
    expect(adminJs).toContain('await openReview(index, navigation)');
    expect(adminJs).toContain('const followUpNavigation = adminNavigationGate.begin()');
    expect(adminJs).toContain('await openReview(next, followUpNavigation)');
    expect(adminJs).toMatch(/function setWorkflowStudentFilter[\s\S]*const navigation = adminNavigationGate[.]begin\(\);[\s\S]*if \(!adminNavigationGate[.]isLatest\(navigation\)\) return;/);
    expect(adminJs).toContain("await switchTab('dashboard')");
    expect(adminJs).toContain("byId('adminQuickTabs').hidden = dashboard");
  });

  it('shows exactly one operational view and marks its navigation item active', () => {
    const dom = shellDom();
    const document = dom.window.document;

    activateAdminView(document, 'manage');

    expect(document.getElementById('adminDashboard').hidden).toBe(true);
    expect(document.getElementById('reviewSection').hidden).toBe(true);
    expect(document.getElementById('manageSection').hidden).toBe(false);
    expect(document.getElementById('questionsSection').hidden).toBe(true);
    expect(document.querySelector('[data-admin-view="manage"]').getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-admin-view="review"]').hasAttribute('aria-current')).toBe(false);
    expect(document.getElementById('adminCrumbGroup').textContent).toBe('운영');
    expect(document.getElementById('adminCrumbTitle').textContent).toBe('오늘 후속 확인');
    expect(document.getElementById('adminViewTitle').textContent).toBe('오늘 후속 확인');
    expect(document.getElementById('adminViewDescription').textContent).toContain('실제 과제 상태');
  });

  it('falls back to the dashboard and closes the mobile menu after navigation', () => {
    const dom = shellDom();
    const document = dom.window.document;
    const changes = [];
    bindAdminShell(document, (view) => changes.push(view));

    document.getElementById('adminMenuToggle').click();
    expect(document.getElementById('adminShell').dataset.menuOpen).toBe('true');
    expect(document.getElementById('adminMenuToggle').getAttribute('aria-expanded')).toBe('true');

    document.querySelector('[data-admin-view="review"]').click();
    expect(changes).toEqual(['review']);
    expect(document.getElementById('adminShell').dataset.menuOpen).toBe('false');
    expect(document.getElementById('adminMenuToggle').getAttribute('aria-expanded')).toBe('false');

    activateAdminView(document, 'not-a-view');
    expect(document.getElementById('adminDashboard').hidden).toBe(false);
    expect(document.querySelector('[data-admin-view="dashboard"]').getAttribute('aria-current')).toBe('page');
  });

  it('lets mobile users close the drawer without choosing a destination', () => {
    const dom = shellDom();
    const document = dom.window.document;
    bindAdminShell(document, () => {});

    expect(document.getElementById('adminSidebar').hasAttribute('inert')).toBe(true);
    expect(document.getElementById('adminSidebar').getAttribute('aria-hidden')).toBe('true');

    document.getElementById('adminMenuToggle').click();
    expect(document.getElementById('adminSidebar').hasAttribute('inert')).toBe(false);
    expect(document.getElementById('adminSidebar').hasAttribute('aria-hidden')).toBe(false);
    expect(document.getElementById('adminShellMain').hasAttribute('inert')).toBe(true);
    expect(document.getElementById('portalHeader').hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('adminMenuClose'));
    document.getElementById('adminMenuClose').click();
    expect(document.getElementById('adminShell').dataset.menuOpen).toBe('false');
    expect(document.getElementById('adminSidebar').hasAttribute('inert')).toBe(true);
    expect(document.getElementById('adminShellMain').hasAttribute('inert')).toBe(false);
    expect(document.getElementById('portalHeader').hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('adminMenuToggle'));

    document.getElementById('adminMenuToggle').click();
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('adminShell').dataset.menuOpen).toBe('false');
    expect(document.activeElement).toBe(document.getElementById('adminMenuToggle'));
  });

  it('keeps the desktop sidebar available to keyboard and assistive technology', () => {
    const dom = shellDom();
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {} });
    const document = dom.window.document;

    bindAdminShell(document, () => {});

    expect(document.getElementById('adminSidebar').hasAttribute('inert')).toBe(false);
    expect(document.getElementById('adminSidebar').hasAttribute('aria-hidden')).toBe(false);
    expect(document.getElementById('adminShellMain').hasAttribute('inert')).toBe(false);
  });

  it('restores focus safely when the responsive breakpoint changes', () => {
    const dom = shellDom();
    let listener;
    const media = {
      matches: false,
      addEventListener(_event, handler) { listener = handler; },
    };
    dom.window.matchMedia = () => media;
    const document = dom.window.document;
    bindAdminShell(document, () => {});
    activateAdminView(document, 'review');

    document.querySelector('[data-admin-view="review"]').focus();
    media.matches = true;
    listener({ matches: true });
    expect(document.activeElement).toBe(document.getElementById('adminMenuToggle'));
    expect(document.getElementById('adminSidebar').hasAttribute('inert')).toBe(true);

    document.getElementById('adminMenuToggle').click();
    expect(document.activeElement).toBe(document.getElementById('adminMenuClose'));
    media.matches = false;
    listener({ matches: false });
    expect(document.activeElement).toBe(document.querySelector('[data-admin-view="review"]'));
    expect(document.getElementById('adminSidebar').hasAttribute('inert')).toBe(false);
    expect(document.getElementById('adminShellMain').hasAttribute('inert')).toBe(false);
  });

  it('passes a sidebar deep-link target to the secure view controller', () => {
    const dom = shellDom();
    const document = dom.window.document;
    const changes = [];
    bindAdminShell(document, (view, target) => changes.push({ view, target }));

    document.querySelector('[data-admin-target="users"]').click();

    expect(changes).toEqual([{ view: 'manage', target: 'users' }]);
  });

  it('marks only the selected management shortcut as current', () => {
    const dom = shellDom();
    const document = dom.window.document;

    activateAdminView(document, 'manage', 'users');

    expect(document.getElementById('manageRoot').hasAttribute('aria-current')).toBe(false);
    expect(document.getElementById('manageUsers').getAttribute('aria-current')).toBe('page');
    expect(document.getElementById('manageWorkflows').hasAttribute('aria-current')).toBe(false);
    expect(document.getElementById('adminCrumbGroup').textContent).toBe('학생');
    expect(document.getElementById('adminCrumbTitle').textContent).toBe('학생·사용자');
  });

  it('marks only the selected reference-style management destination as current', () => {
    const dom = shellDom();
    const document = dom.window.document;

    activateAdminView(document, 'manage', 'students');

    expect(document.querySelectorAll('[data-admin-view][aria-current="page"]')).toHaveLength(1);
    expect(document.getElementById('manageStudents').getAttribute('aria-current')).toBe('page');
    expect(document.getElementById('manageRoot').hasAttribute('aria-current')).toBe(false);
    expect(document.getElementById('adminCrumbTitle').textContent).toBe('학생별 학습상태');
  });

  it('labels assignment history from its real backend meaning', () => {
    const dom = shellDom();
    const document = dom.window.document;

    activateAdminView(document, 'manage', 'workflows');

    expect(document.getElementById('adminCrumbGroup').textContent).toBe('학습관리');
    expect(document.getElementById('adminCrumbTitle').textContent).toBe('과제·제출·재풀이');
    expect(document.getElementById('adminViewDescription').textContent).toContain('실제 배정과 제출 이력');
  });

  it('matches student names safely for the top-bar search', () => {
    expect(studentSearchMatches('김민수', '민수')).toBe(true);
    expect(studentSearchMatches('김민수', ' 김민수 ')).toBe(true);
    expect(studentSearchMatches('김민수', '')).toBe(true);
    expect(studentSearchMatches('김민수', '박')).toBe(false);
    expect(studentSearchMatches(null, '김')).toBe(false);
  });

  it('suppresses stale continuations when a newer navigation wins', async () => {
    const gate = createAdminNavigationGate();
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    const first = gate.begin();
    const staleCompletion = delayed.then(() => gate.isLatest(first));

    const second = gate.begin();
    expect(gate.isLatest(second)).toBe(true);
    release();

    await expect(staleCompletion).resolves.toBe(false);
  });

  it('gives direct review operations a concrete generation that newer work invalidates', () => {
    const gate = createAdminNavigationGate();
    const directReview = gate.ensure();
    expect(gate.isLatest(directReview)).toBe(true);

    const automaticNextReview = gate.ensure();
    expect(gate.isLatest(directReview)).toBe(false);
    expect(gate.isLatest(automaticNextReview)).toBe(true);
    expect(gate.ensure(automaticNextReview)).toBe(automaticNextReview);
  });
});
