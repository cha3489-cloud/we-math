const TEST_DATA_NOTICE = '가상 테스트 학생 · 실제 학생/보호자 정보가 아닙니다.';

export const STUDENT_STATUS_LABELS = Object.freeze({
  active: '재원',
  paused: '휴원',
  returning: '복학예정',
});

export const TEST_STUDENTS = Object.freeze([
  Object.freeze({
    id: 'test-student-1',
    name: '홍길동1',
    status: 'active',
    grade: '초등 6학년',
    school: '시퀀스 테스트초등학교',
    course: '초등 수학 테스트 과정 A',
    classGroup: '테스트 A반',
    guardianName: '테스트 보호자1',
    guardianPhone: '010-0000-0001',
    registeredOn: '2026-10-01',
    note: TEST_DATA_NOTICE,
    isTestData: true,
    accountProfileId: null,
  }),
  Object.freeze({
    id: 'test-student-2',
    name: '홍길동2',
    status: 'paused',
    grade: '중등 2학년',
    school: '시퀀스 테스트중학교',
    course: '중등 수학 테스트 과정 A',
    classGroup: '테스트 B반',
    guardianName: '테스트 보호자2',
    guardianPhone: '010-0000-0002',
    registeredOn: '2026-10-02',
    note: TEST_DATA_NOTICE,
    isTestData: true,
    accountProfileId: null,
  }),
  Object.freeze({
    id: 'test-student-3',
    name: '홍길동3',
    status: 'returning',
    grade: '고등 1학년',
    school: '시퀀스 테스트고등학교',
    course: '고등 수학 테스트 과정 A',
    classGroup: '테스트 C반',
    guardianName: '테스트 보호자3',
    guardianPhone: '010-0000-0003',
    registeredOn: '2026-10-03',
    note: TEST_DATA_NOTICE,
    isTestData: true,
    accountProfileId: null,
  }),
]);

const EDITABLE_FIELDS = new Set([
  'status',
  'grade',
  'school',
  'course',
  'classGroup',
  'guardianName',
  'guardianPhone',
  'registeredOn',
  'note',
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
  if (keys.some((key) => !EDITABLE_FIELDS.has(key))) {
    throw new Error('수정할 수 없는 학생 항목입니다.');
  }
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

function formValue(form, name) {
  return String(form.elements.namedItem(name)?.value || '').trim();
}

export function bindStudentRegistry(document, initialStudents = TEST_STUDENTS) {
  const rows = document.getElementById('studentRegistryRows');
  if (!rows) return null;
  const search = document.getElementById('studentRegistrySearch');
  const statusFilter = document.getElementById('studentRegistryStatus');
  const count = document.getElementById('studentRegistryCount');
  const empty = document.getElementById('studentRegistryEmpty');
  const detail = document.getElementById('studentRegistryDetail');
  const detailName = document.getElementById('studentRegistryDetailName');
  const testBadge = document.getElementById('studentRegistryTestBadge');
  const form = document.getElementById('studentRegistryForm');
  const message = document.getElementById('studentRegistryStatusMessage');
  const state = {
    students: initialStudents.map((student) => ({ ...student })),
    selectedId: null,
  };

  const closeDetail = () => {
    state.selectedId = null;
    detail.hidden = true;
  };

  const openDetail = (studentId) => {
    const student = state.students.find((entry) => entry.id === studentId);
    if (!student) return;
    state.selectedId = student.id;
    detailName.textContent = `${student.name} · ${STUDENT_STATUS_LABELS[student.status] || student.status}`;
    testBadge.textContent = student.isTestData ? '가상 테스트 학생' : '';
    for (const field of EDITABLE_FIELDS) {
      const control = form.elements.namedItem(field);
      if (control) control.value = student[field] || '';
    }
    detail.hidden = false;
  };

  const render = () => {
    const visible = filterStudentRegistry(state.students, {
      query: search.value,
      status: statusFilter.value,
    });
    count.textContent = `${visible.length}명`;
    empty.hidden = visible.length > 0;
    rows.replaceChildren(...visible.map((student) => {
      const row = document.createElement('tr');
      row.dataset.studentId = student.id;
      const nameCell = appendCell(document, row, student.name, '학생명', 'student-registry-name');
      const badge = document.createElement('span');
      badge.className = 'student-test-badge';
      badge.textContent = 'TEST';
      nameCell.append(' ', badge);
      appendCell(document, row, STUDENT_STATUS_LABELS[student.status] || student.status, '상태');
      appendCell(document, row, student.grade, '학년');
      appendCell(document, row, student.school, '학교');
      appendCell(document, row, student.classGroup, '반');
      appendCell(document, row, student.course, '과정');
      appendCell(document, row, student.guardianPhone, '보호자 연락처');
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

  search.addEventListener('input', render);
  statusFilter.addEventListener('change', render);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const targetId = state.selectedId;
    if (!targetId) return;
    const changes = Object.fromEntries([...EDITABLE_FIELDS].map((field) => [field, formValue(form, field)]));
    state.students = updateStudentRecord(state.students, targetId, changes);
    message.textContent = '테스트 학생 정보를 수정했습니다. 새로고침하면 초기 테스트 데이터로 돌아갑니다.';
    render();
    if (state.selectedId) openDetail(state.selectedId);
  });
  render();
  return { state, render, openDetail };
}
