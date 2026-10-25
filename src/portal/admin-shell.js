const ADMIN_VIEWS = ['dashboard', 'review', 'manage', 'questions'];

function safeView(view) {
  return ADMIN_VIEWS.includes(view) ? view : 'dashboard';
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
  const target = view === 'manage' ? requestedTarget : '';
  const surfaces = {
    dashboard: document.getElementById('adminDashboard'),
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

  return view;
}

function mobileMenuQuery(document) {
  return document.defaultView?.matchMedia?.('(max-width:900px)');
}

export function closeAdminMenu(document, { restoreFocus = true } = {}) {
  const shell = document.getElementById('adminShell');
  const sidebar = document.getElementById('adminSidebar');
  const main = document.getElementById('adminShellMain');
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
  if (mobile && restoreFocus) toggle?.focus();
}

function openAdminMenu(document) {
  const shell = document.getElementById('adminShell');
  const sidebar = document.getElementById('adminSidebar');
  const main = document.getElementById('adminShellMain');
  const toggle = document.getElementById('adminMenuToggle');
  const close = document.getElementById('adminMenuClose');
  if (shell) shell.dataset.menuOpen = 'true';
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  sidebar?.removeAttribute('inert');
  sidebar?.removeAttribute('aria-hidden');
  if (mobileMenuQuery(document)?.matches === true) main?.setAttribute('inert', '');
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
