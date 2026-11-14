import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { bindStudentRegistry, TEST_STUDENTS } from '../src/portal/student-registry.js';

function persistenceDom() {
  return new JSDOM(`
    <strong id="studentRegistryModeLabel">테스트 데이터 모드</strong><span id="studentRegistryModeCopy"></span>
    <button id="studentRegistryNewButton" disabled>학생 등록</button>
    <input id="studentRegistrySearch">
    <select id="studentRegistryStatus"><option value="">전체</option><option value="active">재원</option><option value="paused">휴원</option><option value="returning">복학예정</option><option value="withdrawn">퇴원</option></select>
    <strong id="studentRegistryCount"></strong>
    <table><tbody id="studentRegistryRows"></tbody></table><div id="studentRegistryEmpty" hidden></div>
    <aside id="studentRegistryDetail" hidden>
      <strong id="studentRegistryDetailName"></strong><span id="studentRegistryTestBadge"></span>
      <form id="studentRegistryForm">
        <input name="name"><select name="status"><option value="active">재원</option><option value="paused">휴원</option><option value="returning">복학예정</option><option value="withdrawn">퇴원</option></select>
        <input name="grade"><input name="school"><input name="course"><input name="classGroup">
        <input name="guardianName"><input name="guardianPhone"><input name="registeredOn"><textarea name="note"></textarea>
        <input name="isTestData" type="checkbox"><button id="studentRegistrySubmit" type="submit">저장</button>
        <p id="studentRegistryPersistenceHelp"></p>
      </form>
    </aside>
    <p id="studentRegistryStatusMessage"></p>
  `);
}

const savedStudent = (overrides = {}) => ({
  id: 'db-student-1', name: '저장학생', status: 'active', grade: '중등 1학년', school: '저장중학교',
  course: '', classGroup: '', guardianName: '저장보호자', guardianPhone: '010-0000-0099', registeredOn: '2026-10-31',
  note: '', isTestData: true, accountProfileId: null, ...overrides,
});

describe('persistent student registry UI', () => {
  it('switches from fixtures to remote rows only after an authenticated load succeeds', async () => {
    const dom = persistenceDom();
    const repository = { list: vi.fn().mockResolvedValue([savedStudent()]), create: vi.fn(), update: vi.fn() };
    const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository });

    expect(dom.window.document.getElementById('studentRegistryRows').textContent).toContain('홍길동1');
    await controller.loadRemote();

    expect(dom.window.document.getElementById('studentRegistryRows').textContent).toContain('저장학생');
    expect(dom.window.document.getElementById('studentRegistryRows').textContent).not.toContain('홍길동1');
    expect(dom.window.document.getElementById('studentRegistryModeLabel').textContent).toBe('실제 저장 모드');
    expect(dom.window.document.getElementById('studentRegistryPersistenceHelp').textContent).toContain('실제 저장');
    expect(dom.window.document.getElementById('studentRegistryNewButton').disabled).toBe(false);
    expect(controller.state.mode).toBe('persistent');
  });

  it('keeps clearly labeled fixtures when the migration is missing but surfaces permission failures', async () => {
    const missingDom = persistenceDom();
    const missing = { code: 'PGRST205', message: "Could not find the table 'public.students'" };
    const fallback = bindStudentRegistry(missingDom.window.document, TEST_STUDENTS, {
      repository: { list: vi.fn().mockRejectedValue(missing) },
    });
    await expect(fallback.loadRemote()).resolves.toBe(false);
    expect(missingDom.window.document.getElementById('studentRegistryRows').textContent).toContain('홍길동1');
    expect(missingDom.window.document.getElementById('studentRegistryNewButton').disabled).toBe(true);
    expect(missingDom.window.document.getElementById('studentRegistryModeCopy').textContent).toContain('migration 적용 전');
    expect(missingDom.window.document.getElementById('studentRegistryPersistenceHelp').textContent).toContain('새로고침하면 초기화');

    const deniedDom = persistenceDom();
    const denied = { code: '42501', message: 'permission denied for table students' };
    const blocked = bindStudentRegistry(deniedDom.window.document, TEST_STUDENTS, {
      repository: { list: vi.fn().mockRejectedValue(denied) },
    });
    await expect(blocked.loadRemote()).rejects.toBe(denied);
    expect(deniedDom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('불러오지 못했습니다');
  });

  it('creates a student through the RPC repository and reloads server truth', async () => {
    const dom = persistenceDom();
    const created = savedStudent({ id: 'db-student-2', name: '신규학생' });
    const repository = {
      list: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([created]),
      create: vi.fn().mockResolvedValue('db-student-2'),
      update: vi.fn(),
    };
    const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository });
    await controller.loadRemote();
    dom.window.document.getElementById('studentRegistryNewButton').click();
    const form = dom.window.document.getElementById('studentRegistryForm');
    form.elements.name.value = '신규학생';
    form.elements.grade.value = '중등 1학년';
    form.elements.school.value = '테스트중학교';
    form.elements.status.value = 'active';
    form.elements.isTestData.checked = true;
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await controller.whenIdle();

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ name: '신규학생', isTestData: true }));
    expect(repository.list).toHaveBeenCalledTimes(2);
    expect(dom.window.document.getElementById('studentRegistryRows').textContent).toContain('신규학생');
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('등록했습니다');
  });

  it('shows the reloaded primary guardian after a successful persistent update', async () => {
    const dom = persistenceDom();
    const updated = savedStudent({ guardianName: '변경 보호자', guardianPhone: '010-1111-2222' });
    const repository = {
      list: vi.fn().mockResolvedValueOnce([savedStudent()]).mockResolvedValueOnce([updated]),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository });
    await controller.loadRemote();
    dom.window.document.querySelector('button[data-student-id="db-student-1"]').click();
    const form = dom.window.document.getElementById('studentRegistryForm');
    form.elements.guardianName.value = '변경 보호자';
    form.elements.guardianPhone.value = '010-1111-2222';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await controller.whenIdle();

    expect(repository.update).toHaveBeenCalledWith('db-student-1', expect.objectContaining({
      guardianName: '변경 보호자', guardianPhone: '010-1111-2222',
    }));
    expect(dom.window.document.getElementById('studentRegistryRows').textContent).toContain('010-1111-2222');
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('수정했습니다');
  });

  it('does not report success when the server rejects clearing an existing primary guardian', async () => {
    const dom = persistenceDom();
    const repository = {
      list: vi.fn().mockResolvedValue([savedStudent()]),
      create: vi.fn(),
      update: vi.fn().mockRejectedValue(new Error('primary guardian cannot be cleared')),
    };
    const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository });
    await controller.loadRemote();
    dom.window.document.querySelector('button[data-student-id="db-student-1"]').click();
    const form = dom.window.document.getElementById('studentRegistryForm');
    form.elements.guardianName.value = '';
    form.elements.guardianPhone.value = '';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await controller.whenIdle();

    expect(repository.list).toHaveBeenCalledTimes(1);
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('저장하지 못했습니다');
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).not.toContain('수정했습니다');
  });

  it('reports a committed update separately when its follow-up refresh fails', async () => {
    const dom = persistenceDom();
    const refreshError = { code: 'NETWORK', message: 'offline' };
    const repository = {
      list: vi.fn().mockResolvedValueOnce([savedStudent()]).mockRejectedValueOnce(refreshError),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository });
    await controller.loadRemote();
    dom.window.document.querySelector('button[data-student-id="db-student-1"]').click();
    const form = dom.window.document.getElementById('studentRegistryForm');
    form.elements.grade.value = '중등 2학년';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await controller.whenIdle();

    expect(repository.update).toHaveBeenCalledWith('db-student-1', expect.objectContaining({ grade: '중등 2학년' }));
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('수정은 완료됐지만');
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('새로고침');
  });
});
