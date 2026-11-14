import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { bindStudentRegistry, TEST_STUDENTS } from '../src/portal/student-registry.js';

function registryDom() {
  return new JSDOM(`
    <input id="studentRegistrySearch">
    <select id="studentRegistryStatus"><option value="">전체</option><option value="active">재원</option><option value="paused">휴원</option><option value="returning">복학예정</option></select>
    <strong id="studentRegistryCount"></strong>
    <table><tbody id="studentRegistryRows"></tbody></table>
    <div id="studentRegistryEmpty" hidden></div>
    <aside id="studentRegistryDetail" hidden>
      <strong id="studentRegistryDetailName"></strong>
      <span id="studentRegistryTestBadge"></span>
      <form id="studentRegistryForm">
        <select name="status"><option value="active">재원</option><option value="paused">휴원</option><option value="returning">복학예정</option></select>
        <input name="grade"><input name="school"><input name="course"><input name="classGroup">
        <input name="guardianName"><input name="guardianPhone"><input name="registeredOn"><textarea name="note"></textarea>
        <button type="submit">수정 저장</button>
      </form>
    </aside>
    <p id="studentRegistryStatusMessage"></p>
  `);
}

describe('student registry pilot UI', () => {
  it('renders three synthetic students and filters the shared list population', () => {
    const dom = registryDom();
    const document = dom.window.document;
    bindStudentRegistry(document, TEST_STUDENTS);

    expect(document.querySelectorAll('#studentRegistryRows tr')).toHaveLength(3);
    expect(document.getElementById('studentRegistryCount').textContent).toBe('3명');

    const status = document.getElementById('studentRegistryStatus');
    status.value = 'paused';
    status.dispatchEvent(new dom.window.Event('change'));
    expect(document.querySelectorAll('#studentRegistryRows tr')).toHaveLength(1);
    expect(document.getElementById('studentRegistryRows').textContent).toContain('홍길동2');

    status.value = '';
    status.dispatchEvent(new dom.window.Event('change'));
    const search = document.getElementById('studentRegistrySearch');
    search.value = '테스트고등';
    search.dispatchEvent(new dom.window.Event('input'));
    expect(document.querySelectorAll('#studentRegistryRows tr')).toHaveLength(1);
    expect(document.getElementById('studentRegistryRows').textContent).toContain('홍길동3');
  });

  it('opens a selected student and safely refreshes list and detail after a status change', () => {
    const dom = registryDom();
    const document = dom.window.document;
    bindStudentRegistry(document, TEST_STUDENTS);

    const statusFilter = document.getElementById('studentRegistryStatus');
    statusFilter.value = 'paused';
    statusFilter.dispatchEvent(new dom.window.Event('change'));
    document.querySelector('button[data-student-id="test-student-2"]').click();

    const detail = document.getElementById('studentRegistryDetail');
    const form = document.getElementById('studentRegistryForm');
    expect(detail.hidden).toBe(false);
    expect(document.getElementById('studentRegistryDetailName').textContent).toContain('홍길동2');
    expect(document.getElementById('studentRegistryTestBadge').textContent).toBe('가상 테스트 학생');
    expect(form.elements.course.value).toBe('중등 수학 테스트 과정 A');

    form.elements.status.value = 'active';
    form.elements.course.value = '중등 수학 테스트 과정 B';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));

    expect(document.getElementById('studentRegistryStatusMessage').textContent).toContain('수정했습니다');
    expect(document.querySelectorAll('#studentRegistryRows tr')).toHaveLength(0);
    expect(detail.hidden).toBe(true);
  });
});
