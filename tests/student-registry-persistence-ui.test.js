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
      <section id="studentRegistryAttendanceCode" hidden>
        <button id="studentRegistryIssueCode" type="button">출석번호 발급</button>
        <p id="studentRegistryCodeSecret"></p>
      </section>
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
    const issueAttendanceCode = vi.fn().mockResolvedValue({ code: '482913', issue_kind: 'issued' });
    const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository, issueAttendanceCode });
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
    expect(issueAttendanceCode).toHaveBeenCalledWith('db-student-2');
    expect(repository.list).toHaveBeenCalledTimes(2);
    expect(dom.window.document.getElementById('studentRegistryRows').textContent).toContain('신규학생');
    expect(dom.window.document.getElementById('studentRegistryRows').textContent).not.toContain('482913');
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('등록하고 첫 출석번호를 발급했습니다');
    const secret = dom.window.document.getElementById('studentRegistryCodeSecret').textContent;
    expect(secret).toContain('신규학생');
    expect(secret).toContain('482913');
    expect(secret).toContain('다시 볼 수 없습니다');
    // Opening any detail hides the one-time number.
    dom.window.document.querySelector('button[data-student-id="db-student-2"]').click();
    expect(dom.window.document.getElementById('studentRegistryCodeSecret').textContent).toBe('');
  });

  it('keeps the registered student and states the partial failure when the first code cannot be issued, then retries from detail', async () => {
    const dom = persistenceDom();
    const created = savedStudent({ id: 'db-student-3', name: '부분성공' });
    const repository = {
      list: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([created]),
      create: vi.fn().mockResolvedValue('db-student-3'),
      update: vi.fn(),
    };
    const issueAttendanceCode = vi.fn()
      .mockRejectedValueOnce(new Error('attendance service unavailable'))
      .mockResolvedValueOnce({ code: '730148', issue_kind: 'issued' });
    const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository, issueAttendanceCode });
    await controller.loadRemote();
    dom.window.document.getElementById('studentRegistryNewButton').click();
    const form = dom.window.document.getElementById('studentRegistryForm');
    form.elements.name.value = '부분성공';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await controller.whenIdle();

    const message = dom.window.document.getElementById('studentRegistryStatusMessage').textContent;
    expect(message).toContain('학생은 등록됐지만 출석번호 발급에 실패했습니다');
    expect(message).toContain('출석번호 발급');
    expect(message).not.toContain('등록하고 첫 출석번호를 발급했습니다');
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(dom.window.document.getElementById('studentRegistryRows').textContent).toContain('부분성공');
    // The created student's detail stays open with a visible retry path.
    expect(dom.window.document.getElementById('studentRegistryDetail').hidden).toBe(false);
    expect(dom.window.document.getElementById('studentRegistryAttendanceCode').hidden).toBe(false);
    expect(dom.window.document.getElementById('studentRegistryCodeSecret').textContent).toBe('');

    dom.window.document.getElementById('studentRegistryIssueCode').click();
    await controller.whenIdle();
    expect(issueAttendanceCode).toHaveBeenLastCalledWith('db-student-3');
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(dom.window.document.getElementById('studentRegistryCodeSecret').textContent).toContain('730148');
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('출석번호를 발급했습니다');
  });

  it('offers code issuance only for saved students in persistent mode and reports a failed reissue truthfully', async () => {
    const dom = persistenceDom();
    const issueAttendanceCode = vi.fn().mockRejectedValue(new Error('forbidden'));
    const repository = { list: vi.fn().mockResolvedValue([savedStudent()]), create: vi.fn(), update: vi.fn() };
    const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository, issueAttendanceCode });
    dom.window.document.querySelector('button[data-student-id="test-student-1"]').click();
    expect(dom.window.document.getElementById('studentRegistryAttendanceCode').hidden).toBe(true);
    await controller.loadRemote();
    dom.window.document.getElementById('studentRegistryNewButton').click();
    expect(dom.window.document.getElementById('studentRegistryAttendanceCode').hidden).toBe(true);
    dom.window.document.querySelector('button[data-student-id="db-student-1"]').click();
    expect(dom.window.document.getElementById('studentRegistryAttendanceCode').hidden).toBe(false);
    dom.window.document.getElementById('studentRegistryIssueCode').click();
    await controller.whenIdle();
    expect(dom.window.document.getElementById('studentRegistryCodeSecret').textContent).toBe('');
    expect(dom.window.document.getElementById('studentRegistryStatusMessage').textContent).toContain('출석번호를 발급하지 못했습니다');
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

  describe('one-time attendance number boundary on partial refresh failure', () => {
    const SIX_DIGITS = /\d{6}/;
    async function createWithFailedRefresh(dom, { code = '482913' } = {}) {
      const repository = {
        list: vi.fn().mockResolvedValueOnce([savedStudent()]).mockRejectedValueOnce({ code: 'NETWORK', message: 'offline' }),
        create: vi.fn().mockResolvedValue('db-student-9'),
        update: vi.fn(),
      };
      const issueAttendanceCode = vi.fn().mockResolvedValue({ code, issue_kind: 'issued' });
      const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, { repository, issueAttendanceCode });
      await controller.loadRemote();
      dom.window.document.getElementById('studentRegistryNewButton').click();
      const form = dom.window.document.getElementById('studentRegistryForm');
      form.elements.name.value = '새로고침실패';
      form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
      await controller.whenIdle();
      return { controller, repository, issueAttendanceCode };
    }

    it('never puts the raw code in the general status message and shows it only in the secret container', async () => {
      const dom = persistenceDom();
      await createWithFailedRefresh(dom);
      const doc = dom.window.document;
      const message = doc.getElementById('studentRegistryStatusMessage').textContent;
      expect(message).toContain('목록 새로고침에 실패했습니다');
      expect(message).not.toMatch(SIX_DIGITS);
      expect(doc.getElementById('studentRegistryCodeSecret').textContent).toContain('482913');
      expect(doc.getElementById('studentRegistryAttendanceCode').hidden).toBe(false);
      expect(doc.getElementById('studentRegistryIssueCode').disabled).toBe(true);
      const outsideSecret = [...doc.body.querySelectorAll('*')]
        .filter((node) => node.children.length === 0 && node.id !== 'studentRegistryCodeSecret')
        .map((node) => node.textContent).join(' ');
      expect(outsideSecret).not.toContain('482913');
    });

    it('clears the partially-shown code when the user starts another registration or opens a student', async () => {
      const dom = persistenceDom();
      await createWithFailedRefresh(dom);
      const doc = dom.window.document;
      doc.getElementById('studentRegistryNewButton').click();
      expect(doc.getElementById('studentRegistryCodeSecret').textContent).toBe('');
      expect(doc.getElementById('studentRegistryAttendanceCode').hidden).toBe(true);
      expect(doc.body.textContent).not.toContain('482913');

      const other = persistenceDom();
      await createWithFailedRefresh(other);
      other.window.document.querySelector('button[data-student-id="db-student-1"]').click();
      expect(other.window.document.getElementById('studentRegistryCodeSecret').textContent).toBe('');
      expect(other.window.document.body.textContent).not.toContain('482913');
      expect(other.window.document.getElementById('studentRegistryIssueCode').disabled).toBe(false);
    });

    it('exposes clearSecret for admin navigation and wipes the code on a roster reset', async () => {
      const dom = persistenceDom();
      const { controller, repository } = await createWithFailedRefresh(dom);
      controller.clearSecret();
      expect(dom.window.document.getElementById('studentRegistryCodeSecret').textContent).toBe('');
      expect(dom.window.document.body.textContent).not.toContain('482913');

      const reset = persistenceDom();
      const second = await createWithFailedRefresh(reset);
      second.repository.list.mockResolvedValueOnce([savedStudent()]);
      await second.controller.loadRemote();
      expect(reset.window.document.getElementById('studentRegistryCodeSecret').textContent).toBe('');
      expect(reset.window.document.body.textContent).not.toContain('482913');
      expect(repository.create).toHaveBeenCalledTimes(1);

      const adminJs = (await import('node:fs')).readFileSync(new URL('../src/portal/admin.js', import.meta.url), 'utf8');
      expect(adminJs).toMatch(/async function switchTab\([^)]*\) \{\s*studentRegistry[.]clearSecret\(\);/);
    });

    it('does not fall back to the status message when no secret container exists', async () => {
      const dom = persistenceDom();
      dom.window.document.getElementById('studentRegistryCodeSecret').remove();
      const repository = {
        list: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([savedStudent({ id: 'db-student-9', name: '새학생' })]),
        create: vi.fn().mockResolvedValue('db-student-9'),
        update: vi.fn(),
      };
      const controller = bindStudentRegistry(dom.window.document, TEST_STUDENTS, {
        repository, issueAttendanceCode: vi.fn().mockResolvedValue({ code: '482913', issue_kind: 'issued' }),
      });
      await controller.loadRemote();
      dom.window.document.getElementById('studentRegistryNewButton').click();
      const form = dom.window.document.getElementById('studentRegistryForm');
      form.elements.name.value = '새학생';
      form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
      await controller.whenIdle();
      expect(dom.window.document.body.textContent).not.toContain('482913');
    });
  });

  describe('late attendance-code responses after clearSecret (navigation/logout/pagehide)', () => {
    const SIX_DIGITS = /\d{6}/;
    function deferred() {
      let resolve; let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const text = (doc, id) => doc.getElementById(id).textContent;
    function expectNoRawCode(doc, code) {
      expect(text(doc, 'studentRegistryCodeSecret')).toBe('');
      expect(text(doc, 'studentRegistryStatusMessage')).not.toMatch(SIX_DIGITS);
      expect(text(doc, 'studentRegistryRows')).not.toContain(code);
      expect(doc.body.textContent).not.toContain(code);
    }

    async function detailWithPendingIssue() {
      const dom = persistenceDom();
      const doc = dom.window.document;
      const pending = [];
      const issueAttendanceCode = vi.fn(() => { const d = deferred(); pending.push(d); return d.promise; });
      const repository = { list: vi.fn().mockResolvedValue([savedStudent()]), create: vi.fn(), update: vi.fn() };
      const controller = bindStudentRegistry(doc, TEST_STUDENTS, { repository, issueAttendanceCode });
      await controller.loadRemote();
      doc.querySelector('button[data-student-id="db-student-1"]').click();
      doc.getElementById('studentRegistryIssueCode').click();
      return { dom, doc, controller, pending, issueAttendanceCode };
    }

    it('drops a late detail reissue success after clearSecret', async () => {
      const { doc, controller, pending } = await detailWithPendingIssue();
      controller.clearSecret();
      pending[0].resolve({ code: '654321', issue_kind: 'rotated' });
      await controller.whenIdle();
      expectNoRawCode(doc, '654321');
      expect(text(doc, 'studentRegistryStatusMessage')).not.toContain('재발급했습니다');
      // The section stays only as the issue-button host for the still-open saved student; no orphan secret.
      expect(controller.state.orphanSecret).toBe(false);
    });

    it('does not repost a late detail reissue error after clearSecret', async () => {
      const { doc, controller, pending } = await detailWithPendingIssue();
      controller.clearSecret();
      pending[0].reject(new Error('late failure'));
      await controller.whenIdle();
      expect(text(doc, 'studentRegistryStatusMessage')).toBe('');
      expectNoRawCode(doc, '654321');
    });

    it('does not resurface a late response after navigating away and back to the same student', async () => {
      const { doc, controller, pending } = await detailWithPendingIssue();
      controller.clearSecret(); // leave the registry tab
      controller.clearSecret(); // come back (switchTab always clears)
      doc.querySelector('button[data-student-id="db-student-1"]').click();
      pending[0].resolve({ code: '654321', issue_kind: 'rotated' });
      await controller.whenIdle();
      expectNoRawCode(doc, '654321');
      expect(text(doc, 'studentRegistryStatusMessage')).toBe('');
    });

    it('keeps the newer issuance result when an older request resolves late', async () => {
      const { doc, controller, pending } = await detailWithPendingIssue();
      controller.clearSecret();
      doc.querySelector('button[data-student-id="db-student-1"]').click();
      doc.getElementById('studentRegistryIssueCode').click();
      expect(pending).toHaveLength(2);
      pending[1].resolve({ code: '222222', issue_kind: 'rotated' });
      await flush();
      pending[0].resolve({ code: '111111', issue_kind: 'rotated' });
      await controller.whenIdle();
      await flush();
      expect(text(doc, 'studentRegistryCodeSecret')).toContain('222222');
      expect(doc.body.textContent).not.toContain('111111');
      expect(text(doc, 'studentRegistryStatusMessage')).toContain('재발급했습니다');

      // A late failure of the older request must not overwrite the newer result either.
      const again = await detailWithPendingIssue();
      again.controller.clearSecret();
      again.doc.querySelector('button[data-student-id="db-student-1"]').click();
      again.doc.getElementById('studentRegistryIssueCode').click();
      again.pending[1].resolve({ code: '333333', issue_kind: 'rotated' });
      await flush();
      again.pending[0].reject(new Error('stale failure'));
      await flush();
      expect(text(again.doc, 'studentRegistryCodeSecret')).toContain('333333');
      expect(text(again.doc, 'studentRegistryStatusMessage')).not.toContain('발급하지 못했습니다');
    });

    async function createWithPendingIssue() {
      const dom = persistenceDom();
      const doc = dom.window.document;
      const created = savedStudent({ id: 'db-student-7', name: '지연등록' });
      const repository = {
        list: vi.fn().mockResolvedValueOnce([savedStudent()]).mockResolvedValue([savedStudent(), created]),
        create: vi.fn().mockResolvedValue('db-student-7'),
        update: vi.fn(),
      };
      const issue = deferred();
      const issueAttendanceCode = vi.fn(() => issue.promise);
      const controller = bindStudentRegistry(doc, TEST_STUDENTS, { repository, issueAttendanceCode });
      await controller.loadRemote();
      doc.getElementById('studentRegistryNewButton').click();
      const form = doc.getElementById('studentRegistryForm');
      form.elements.name.value = '지연등록';
      form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
      await flush();
      expect(issueAttendanceCode).toHaveBeenCalledWith('db-student-7');
      return { doc, controller, issue, repository };
    }

    it('drops a late create→issue success after clearSecret', async () => {
      const { doc, controller, issue, repository } = await createWithPendingIssue();
      controller.clearSecret();
      issue.resolve({ code: '112233', issue_kind: 'issued' });
      await controller.whenIdle();
      expect(repository.create).toHaveBeenCalledTimes(1);
      expectNoRawCode(doc, '112233');
      expect(text(doc, 'studentRegistryStatusMessage')).not.toContain('첫 출석번호를 발급했습니다');
      expect(doc.getElementById('studentRegistryAttendanceCode').hidden).toBe(true);
      expect(controller.state.orphanSecret).toBe(false);
    });

    it('does not post a stale create→issue failure after clearSecret', async () => {
      const { doc, controller, issue } = await createWithPendingIssue();
      controller.clearSecret();
      issue.reject(new Error('late failure'));
      await controller.whenIdle();
      expect(text(doc, 'studentRegistryStatusMessage')).not.toContain('출석번호 발급에 실패했습니다');
      expect(text(doc, 'studentRegistryStatusMessage')).not.toContain('late failure');
      expectNoRawCode(doc, '112233');
    });

    it('drops a create→issue code when clearSecret happens during the follow-up refresh', async () => {
      const dom = persistenceDom();
      const doc = dom.window.document;
      const list = deferred();
      const repository = {
        list: vi.fn().mockResolvedValueOnce([savedStudent()]).mockImplementationOnce(() => list.promise),
        create: vi.fn().mockResolvedValue('db-student-7'),
        update: vi.fn(),
      };
      const issueAttendanceCode = vi.fn().mockResolvedValue({ code: '445566', issue_kind: 'issued' });
      const controller = bindStudentRegistry(doc, TEST_STUDENTS, { repository, issueAttendanceCode });
      await controller.loadRemote();
      doc.getElementById('studentRegistryNewButton').click();
      doc.getElementById('studentRegistryForm').elements.name.value = '지연등록';
      doc.getElementById('studentRegistryForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
      await flush();
      expect(repository.list).toHaveBeenCalledTimes(2);
      controller.clearSecret();
      list.resolve([savedStudent(), savedStudent({ id: 'db-student-7', name: '지연등록' })]);
      await controller.whenIdle();
      expectNoRawCode(doc, '445566');
      expect(text(doc, 'studentRegistryStatusMessage')).not.toContain('첫 출석번호를 발급했습니다');
    });
  });
});
