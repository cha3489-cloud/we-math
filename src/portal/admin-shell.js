const ADMIN_VIEWS = ['dashboard', 'calendar', 'students', 'withdrawals', 'review', 'manage', 'questions'];
const ADMIN_VIEW_COPY = {
  dashboard: ['운영', '오늘 할 일', '실제 제출·재풀이·질문 데이터에서 지금 처리할 항목만 봅니다.'],
  calendar: ['운영', '업무 캘린더', '실제 학원 일정과 담당 업무를 날짜별로 등록하고 확인합니다.'],
  students: ['학생', '학생 관리', '학생 운영 원본과 수강·보호자 정보를 한 명씩 관리합니다.'],
  withdrawals: ['학생', '퇴원 관리', '퇴원·휴원 이력과 상담·복학 예정 상태를 보존합니다.'],
  review: ['학습관리', '제출 검토', '학생이 실제로 제출한 답안과 풀이를 확인하고 피드백을 확정합니다.'],
  questions: ['소통', '질문', '학생이 실제로 남긴 질문과 답변 상태를 확인합니다.'],
};
const ADMIN_MANAGE_COPY = {
  action: ['운영', '오늘 후속 확인', '실제 과제 상태에서 원장 확인·수정 대기·미제출 지연만 모아 봅니다.'],
  users: ['학생', '학생·사용자', '실제 등록된 프로필의 역할과 계정 상태를 확인합니다.'],
  workflows: ['학습관리', '과제·제출·재풀이', '실제 배정과 제출 이력, 재풀이 상태를 함께 확인합니다.'],
  students: ['학생', '학생별 학습상태', '실제 과제·제출·질문에서 조치가 필요한 학생만 모아 봅니다.'],
};

function safeView(view) {
  return ADMIN_VIEWS.includes(view) ? view : 'dashboard';
}

export function studentSearchMatches(studentName, query) {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLocaleLowerCase('ko-KR') : '';
  if (!normalizedQuery) return true;
  if (typeof studentName !== 'string') return false;
  return studentName.trim().toLocaleLowerCase('ko-KR').includes(normalizedQuery);
}

export function createAdminNavigationGate() {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    isLatest(request) {
      return request === generation;
    },
    ensure(request = null) {
      return request === null ? this.begin() : request;
    },
  };
}

export function activateAdminView(document, requestedView, requestedTarget = '') {
  const view = safeView(requestedView);
  const target = view === 'manage' ? (requestedTarget || 'action') : '';
  const surfaces = {
    dashboard: document.getElementById('adminDashboard'),
    calendar: document.getElementById('calendarSection'),
    students: document.getElementById('studentsSection'),
    withdrawals: document.getElementById('withdrawalsSection'),
    review: document.getElementById('reviewSection'),
    manage: document.getElementById('manageSection'),
    questions: document.getElementById('questionsSection'),
  };

  for (const [key, element] of Object.entries(surfaces)) {
    if (element) element.hidden = key !== view;
  }

  for (const button of document.querySelectorAll('[data-admin-view]')) {
    const buttonTarget = button.dataset.adminTarget || '';
    const active = button.dataset.adminView === view && (view !== 'manage' || buttonTarget === target);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  const [group, title, description] = view === 'manage'
    ? (ADMIN_MANAGE_COPY[target] || ADMIN_MANAGE_COPY.action)
    : ADMIN_VIEW_COPY[view];
  const crumbGroup = document.getElementById('adminCrumbGroup');
  const crumbTitle = document.getElementById('adminCrumbTitle');
  const viewTitle = document.getElementById('adminViewTitle');
  const viewDescription = document.getElementById('adminViewDescription');
  if (crumbGroup) crumbGroup.textContent = group;
  if (crumbTitle) crumbTitle.textContent = title;
  if (viewTitle) viewTitle.textContent = title;
  if (viewDescription) viewDescription.textContent = description;

  return view;
}

function mobileMenuQuery(document) {
  return document.defaultView?.matchMedia?.('(max-width:900px)');
}

export function closeAdminMenu(document, { restoreFocus = true } = {}) {
  const shell = document.getElementById('adminShell');
  const sidebar = document.getElementById('adminSidebar');
  const main = document.getElementById('adminShellMain');
  const portalHeader = document.getElementById('portalHeader');
  const toggle = document.getElementById('adminMenuToggle');
  const mobile = mobileMenuQuery(document)?.matches === true;
  if (shell) shell.dataset.menuOpen = 'false';
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  if (sidebar && mobile) {
    sidebar.setAttribute('inert', '');
    sidebar.setAttribute('aria-hidden', 'true');
  } else if (sidebar) {
    sidebar.removeAttribute('inert');
    sidebar.removeAttribute('aria-hidden');
  }
  main?.removeAttribute('inert');
  portalHeader?.removeAttribute('inert');
  if (mobile && restoreFocus) toggle?.focus();
}

function openAdminMenu(document) {
  const shell = document.getElementById('adminShell');
  const sidebar = document.getElementById('adminSidebar');
  const main = document.getElementById('adminShellMain');
  const portalHeader = document.getElementById('portalHeader');
  const toggle = document.getElementById('adminMenuToggle');
  const close = document.getElementById('adminMenuClose');
  if (shell) shell.dataset.menuOpen = 'true';
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  sidebar?.removeAttribute('inert');
  sidebar?.removeAttribute('aria-hidden');
  if (mobileMenuQuery(document)?.matches === true) {
    main?.setAttribute('inert', '');
    portalHeader?.setAttribute('inert', '');
  }
  close?.focus();
}

export function bindAdminShell(document, onNavigate) {
  const shell = document.getElementById('adminShell');
  const toggle = document.getElementById('adminMenuToggle');
  const close = document.getElementById('adminMenuClose');
  const media = mobileMenuQuery(document);

  closeAdminMenu(document, { restoreFocus: false });
  media?.addEventListener?.('change', (event) => {
    const active = document.activeElement;
    const focusWillHide = event.matches
      ? document.getElementById('adminSidebar')?.contains(active)
      : active === close;
    closeAdminMenu(document, { restoreFocus: false });
    if (focusWillHide) {
      if (event.matches) toggle?.focus();
      else document.querySelector('[data-admin-view][aria-current="page"]')?.focus();
    }
  });
  toggle?.addEventListener('click', () => {
    if (shell?.dataset.menuOpen === 'true') closeAdminMenu(document);
    else openAdminMenu(document);
  });
  close?.addEventListener('click', () => closeAdminMenu(document));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && shell?.dataset.menuOpen === 'true') closeAdminMenu(document);
  });

  for (const button of document.querySelectorAll('[data-admin-view]')) {
    button.addEventListener('click', () => {
      const view = safeView(button.dataset.adminView);
      closeAdminMenu(document);
      onNavigate(view, button.dataset.adminTarget || '');
    });
  }
}
