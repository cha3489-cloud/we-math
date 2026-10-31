import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { activateAdminView } from '../src/portal/admin-shell.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function prototypeDom() {
  return new JSDOM(`
    <button id="calendarNav" data-admin-view="calendar"></button>
    <button id="studentsNav" data-admin-view="students"></button>
    <button id="withdrawalsNav" data-admin-view="withdrawals"></button>
    <span id="adminCrumbGroup"></span><span id="adminCrumbTitle"></span>
    <h1 id="adminViewTitle"></h1><p id="adminViewDescription"></p>
    <main id="adminDashboard"></main><section id="reviewSection"></section>
    <section id="manageSection"></section><section id="questionsSection"></section>
    <section id="calendarSection"></section><section id="studentsSection"></section>
    <section id="withdrawalsSection"></section>
  `);
}

describe('mockup-based core operations prototype', () => {
  it('ships the three reference-shaped work surfaces without fabricated records or KPIs', () => {
    const admin = read('admin/index.html');

    expect(admin).toContain('data-admin-view=calendar');
    expect(admin).toContain('data-admin-view=students');
    expect(admin).toContain('data-admin-view=withdrawals');
    expect(admin).toContain('id=calendarSection');
    expect(admin).toContain('id=studentsSection');
    expect(admin).toContain('id=withdrawalsSection');
    expect(admin).toContain('업무 일정 등록');
    expect(admin).toContain('학생 등록');
    expect(admin).toContain('퇴원·휴원 기록');
    expect(admin).toContain('공식 학사일정 확인본');
    expect(admin).toContain('id=schoolCalendarGrid');
    expect(admin).toContain('id=calendarSchoolFilter');
    expect(admin).toContain('등록된 학생이 없습니다.');
    expect(admin).toContain('퇴원·휴원 기록이 없습니다.');
    expect(admin).not.toMatch(/재원생\s*96|퇴원생\s*12|김민수|이서연|박지우/);
  });

  it('preserves the mockup table and form contracts for each operation', () => {
    const admin = read('admin/index.html');

    for (const label of ['일정 유형', '날짜', '시작 시간', '종료 시간', '연결 대상', '담당자', '진행 상태', '메모']) {
      expect(admin).toContain(label);
    }
    for (const heading of ['학생명', '구분', '학년', '학교', '담당', '등원시간', '과정', '학부모 연락처', '학교성적']) {
      expect(admin).toContain(`<th>${heading}</th>`);
    }
    for (const heading of ['학생명', '등록일', '마지막 수업일', '퇴원·휴원일', '재원기간', '사유', '복학 여부']) {
      expect(admin).toContain(`<th>${heading}</th>`);
    }
  });

  it.each([
    ['calendar', '운영', '업무 캘린더', '공식 학사일정'],
    ['students', '학생', '학생 관리', '학생 운영 원본'],
    ['withdrawals', '학생', '퇴원 관리', '퇴원·휴원 이력'],
  ])('activates only the %s surface and updates its heading', (view, group, title, description) => {
    const dom = prototypeDom();
    const document = dom.window.document;

    activateAdminView(document, view);

    expect(document.getElementById(`${view}Section`).hidden).toBe(false);
    expect(document.querySelectorAll('[data-admin-view][aria-current="page"]')).toHaveLength(1);
    expect(document.querySelector(`[data-admin-view="${view}"]`).getAttribute('aria-current')).toBe('page');
    expect(document.getElementById('adminCrumbGroup').textContent).toBe(group);
    expect(document.getElementById('adminCrumbTitle').textContent).toBe(title);
    expect(document.getElementById('adminViewDescription').textContent).toContain(description);
  });

  it('styles dense desktop tables and switches to card-like rows on mobile', () => {
    const css = read('src/portal/portal.css');

    expect(css).toContain('.operations-table');
    expect(css).toContain('.operations-split');
    expect(css).toMatch(/@media\(max-width:640px\)[\s\S]*[.]operations-table thead\{display:none\}/);
    expect(css).toMatch(/@media\(max-width:640px\)[\s\S]*[.]operations-table tr\{[^}]*display:grid/);
  });
});
