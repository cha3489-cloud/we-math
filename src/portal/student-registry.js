import { loadPersistentStudentRegistry } from './student-registry-repository.js';

const TEST_DATA_NOTICE = '가상 테스트 학생 · 실제 학생/보호자 정보가 아닙니다.';

export const STUDENT_STATUS_LABELS = Object.freeze({
  active: '재원',
  paused: '휴원',
  returning: '복학예정',
  withdrawn: '퇴원',
});

export const TEST_STUDENTS = Object.freeze([
  Object.freeze({
    id: 'test-student-1', name: '홍길동1', status: 'active', grade: '초등 6학년',
    school: '시퀀스 테스트초등학교', course: '초등 수학 테스트 과정 A', classGroup: '테스트 A반',
    guardianName: '테스트 보호자1', guardianPhone: '010-0000-0001', registeredOn: '2026-10-01',
    note: TEST_DATA_NOTICE, isTestData: true, accountProfileId: null,
  }),
  Object.freeze({
    id: 'test-student-2', name: '홍길동2', status: 'paused', grade: '중등 2학년',
    school: '시퀀스 테스트중학교', course: '중등 수학 테스트 과정 A', classGroup: '테스트 B반',
    guardianName: '테스트 보호자2', guardianPhone: '010-0000-0002', registeredOn: '2026-10-02',
    note: TEST_DATA_NOTICE, isTestData: true, accountProfileId: null,
  }),
  Object.freeze({
    id: 'test-student-3', name: '홍길동3', status: 'returning', grade: '고등 1학년',
    school: '시퀀스 테스트고등학교', course: '고등 수학 테스트 과정 A', classGroup: '테스트 C반',
    guardianName: '테스트 보호자3', guardianPhone: '010-0000-0003', registeredOn: '2026-10-03',
    note: TEST_DATA_NOTICE, isTestData: true, accountProfileId: null,
  }),
]);

const EDITABLE_FIELDS = new Set([
  'name', 'status', 'grade', 'school', 'course', 'classGroup',
  'guardianName', 'guardianPhone', 'registeredOn', 'note',
]);

function normalized(value) {
  return String(value || '').trim().toLocaleLowerCase('ko-KR');
}

export function filterStudentRegistry(students, filters = {}) {
  const query = normalized(filters.query);
  const status = String(filters.status || '');
  return students.filter((student) => {
    if (status && student.status !== status) return false;
    if (!query) return true;
    return [student.name, student.school, student.grade, student.course, student.classGroup]
      .some((value) => normalized(value).includes(query));
  });
}

export function updateStudentRecord(students, studentId, changes) {
  const index = students.findIndex((student) => student.id === studentId);
  if (index < 0) throw new Error('학생을 찾을 수 없습니다.');
  const keys = Object.keys(changes || {});
  if (keys.some((key) => !EDITABLE_FIELDS.has(key))) throw new Error('수정할 수 없는 학생 항목입니다.');
  if (Object.hasOwn(changes, 'status') && !Object.hasOwn(STUDENT_STATUS_LABELS, changes.status)) {
    throw new Error('올바른 재원 상태가 아닙니다.');
  }
  return students.map((student, studentIndex) => (
    studentIndex === index ? { ...student, ...changes } : { ...student }
  ));
}

function appendCell(document, row, value, label, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.dataset.label = label;
  cell.textContent = value;
  row.append(cell);
  return cell;
}

function formValue(form, name, fallback = '') {
  const control = form.elements.namedItem(name);
  return control ? String(control.value || '').trim() : String(fallback || '');
}

function formPayload(form, current = {}) {
  return {
    name: formValue(form, 'name', current.name),
    status: formValue(form, 'status', current.status || 'active'),
    grade: formValue(form, 'grade', current.grade),
    school: formValue(form, 'school', current.school),
    course: formValue(form, 'course', current.course),
    classGroup: formValue(form, 'classGroup', current.classGroup),
    guardianName: formValue(form, 'guardianName', current.guardianName),
    guardianPhone: formValue(form, 'guardianPhone', current.guardianPhone),
    registeredOn: formValue(form, 'registeredOn', current.registeredOn),
    note: formValue(form, 'note', current.note),
    isTestData: form.elements.namedItem('isTestData')?.checked === true,
  };
}

export function bindStudentRegistry(document, initialStudents = TEST_STUDENTS, options = {}) {
  const rows = document.getElementById('studentRegistryRows');
  if (!rows) return null;
  const repository = options.repository || null;
  const search = document.getElementById('studentRegistrySearch');
  const statusFilter = document.getElementById('studentRegistryStatus');
  const count = document.getElementById('studentRegistryCount');
  const empty = document.getElementById('studentRegistryEmpty');
  const detail = document.getElementById('studentRegistryDetail');
  const detailName = document.getElementById('studentRegistryDetailName');
  const testBadge = document.getElementById('studentRegistryTestBadge');
  const form = document.getElementById('studentRegistryForm');
  const message = document.getElementById('studentRegistryStatusMessage');
  const modeLabel = document.getElementById('studentRegistryModeLabel');
  const modeCopy = document.getElementById('studentRegistryModeCopy');
  const persistenceHelp = document.getElementById('studentRegistryPersistenceHelp');
  const newButton = document.getElementById('studentRegistryNewButton');
  const submitButton = document.getElementById('studentRegistrySubmit') || form.querySelector('button[type="submit"]');
  const state = {
    students: initialStudents.map((student) => ({ ...student })),
    selectedId: null,
    formMode: 'edit',
    mode: 'fixture',
    pending: Promise.resolve(),
    loadGeneration: 0,
  };

  const setFixtureMode = (copy = '홍길동1·2·3은 기능 검증용 가상 학생입니다. 실제 정보가 아니며 새로고침하면 초기화됩니다.') => {
    state.mode = 'fixture';
    if (modeLabel) modeLabel.textContent = '테스트 데이터 모드';
    if (modeCopy) modeCopy.textContent = copy;
    if (persistenceHelp) persistenceHelp.textContent = '현재 브라우저 안에서만 변경됩니다. 새로고침하면 초기화됩니다.';
    if (newButton) newButton.disabled = true;
  };

  const setPersistentMode = () => {
    state.mode = 'persistent';
    if (modeLabel) modeLabel.textContent = '실제 저장 모드';
    if (modeCopy) modeCopy.textContent = '관리자 전용 학생 운영대장에 저장됩니다. TEST 표시는 가상 검증 데이터입니다.';
    if (persistenceHelp) persistenceHelp.textContent = '학생 운영대장에 실제 저장됩니다. 과정·반 배정은 다음 단계에서 연결합니다.';
    if (newButton) newButton.disabled = false;
  };

  const closeDetail = () => {
    state.selectedId = null;
    state.formMode = 'edit';
    detail.hidden = true;
  };

  const populateForm = (student) => {
    for (const field of EDITABLE_FIELDS) {
      const control = form.elements.namedItem(field);
      if (control) control.value = student[field] || '';
    }
    const testControl = form.elements.namedItem('isTestData');
    if (testControl) {
      testControl.checked = student.isTestData === true;
      testControl.disabled = true;
    }
    for (const field of ['course', 'classGroup']) {
      const control = form.elements.namedItem(field);
      if (control) control.readOnly = state.mode === 'persistent';
    }
  };

  const openDetail = (studentId) => {
    const student = state.students.find((entry) => entry.id === studentId);
    if (!student) return;
    state.selectedId = student.id;
    state.formMode = 'edit';
    detailName.textContent = `${student.name} · ${STUDENT_STATUS_LABELS[student.status] || student.status}`;
    testBadge.textContent = student.isTestData ? '가상 테스트 학생' : '운영 학생';
    populateForm(student);
    if (submitButton) submitButton.textContent = state.mode === 'persistent' ? '학생 정보 저장' : '테스트 정보 수정';
    detail.hidden = false;
  };

  const openCreate = () => {
    if (state.mode !== 'persistent') return;
    state.selectedId = null;
    state.formMode = 'create';
    form.reset();
    detailName.textContent = '새 학생 등록';
    testBadge.textContent = '관리자 등록';
    const status = form.elements.namedItem('status');
    if (status) status.value = 'active';
    const testControl = form.elements.namedItem('isTestData');
    if (testControl) { testControl.disabled = false; testControl.checked = false; }
    for (const field of ['course', 'classGroup']) {
      const control = form.elements.namedItem(field);
      if (control) { control.value = ''; control.readOnly = true; }
    }
    if (submitButton) submitButton.textContent = '학생 등록';
    detail.hidden = false;
  };

  const render = () => {
    const visible = filterStudentRegistry(state.students, { query: search.value, status: statusFilter.value });
    count.textContent = `${visible.length}명`;
    empty.hidden = visible.length > 0;
    rows.replaceChildren(...visible.map((student) => {
      const row = document.createElement('tr');
      row.dataset.studentId = student.id;
      const nameCell = appendCell(document, row, student.name, '학생명', 'student-registry-name');
      if (student.isTestData) {
        const badge = document.createElement('span');
        badge.className = 'student-test-badge';
        badge.textContent = 'TEST';
        nameCell.append(' ', badge);
      }
      appendCell(document, row, STUDENT_STATUS_LABELS[student.status] || student.status, '상태');
      appendCell(document, row, student.grade, '학년');
      appendCell(document, row, student.school, '학교');
      appendCell(document, row, student.classGroup || '미배정', '반');
      appendCell(document, row, student.course || '미배정', '과정');
      appendCell(document, row, student.guardianPhone || '-', '보호자 연락처');
      const actionCell = document.createElement('td');
      actionCell.dataset.label = '상세';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary small';
      button.dataset.studentId = student.id;
      button.textContent = '상세';
      button.addEventListener('click', () => openDetail(student.id));
      actionCell.append(button);
      row.append(actionCell);
      return row;
    }));
    if (state.selectedId && !visible.some((student) => student.id === state.selectedId)) closeDetail();
  };

  const replaceFromServer = (students) => {
    state.students = students.map((student) => ({ ...student }));
    closeDetail();
    render();
  };

  const loadRemote = async () => {
    if (!repository) return false;
    const generation = ++state.loadGeneration;
    try {
      const result = await loadPersistentStudentRegistry(repository);
      if (generation !== state.loadGeneration) return false;
      if (!result.available) {
        setFixtureMode('학생 운영대장 migration 적용 전입니다. 홍길동 가상 데이터만 표시하며 저장되지 않습니다.');
        render();
        return false;
      }
      setPersistentMode();
      replaceFromServer(result.students);
      return true;
    } catch (error) {
      if (generation === state.loadGeneration) message.textContent = `학생 운영대장을 불러오지 못했습니다: ${error?.message || '알 수 없는 오류'}`;
      throw error;
    }
  };

  const savePersistent = async (mode, targetId, payload) => {
    if (submitButton) submitButton.disabled = true;
    try {
      if (mode === 'create') await repository.create(payload);
      else await repository.update(targetId, payload);
      try {
        const students = await repository.list();
        setPersistentMode();
        replaceFromServer(students);
        message.textContent = mode === 'create' ? '학생을 등록했습니다.' : '학생 정보를 수정했습니다.';
      } catch (refreshError) {
        message.textContent = `${mode === 'create' ? '등록' : '수정'}은 완료됐지만 목록 새로고침에 실패했습니다. 페이지를 새로고침해 주세요.`;
      }
    } catch (error) {
      message.textContent = `학생 정보를 저장하지 못했습니다: ${error?.message || '알 수 없는 오류'}`;
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  };

  search.addEventListener('input', render);
  statusFilter.addEventListener('change', render);
  if (newButton) newButton.addEventListener('click', openCreate);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const mode = state.formMode;
    const targetId = state.selectedId;
    const current = state.students.find((student) => student.id === targetId) || {};
    const payload = formPayload(form, current);
    if (state.mode === 'persistent') {
      if (mode === 'edit' && !targetId) return;
      state.pending = savePersistent(mode, targetId, payload);
      return;
    }
    if (!targetId) return;
    const { isTestData: _ignored, ...changes } = payload;
    state.students = updateStudentRecord(state.students, targetId, changes);
    message.textContent = '테스트 학생 정보를 수정했습니다. 새로고침하면 초기 테스트 데이터로 돌아갑니다.';
    render();
    if (state.selectedId) openDetail(state.selectedId);
  });

  setFixtureMode();
  render();
  return {
    state,
    render,
    openDetail,
    loadRemote,
    whenIdle: () => state.pending,
  };
}
