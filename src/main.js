import './style.css';
import { signIn, signOut, onAuthChange, getProfile } from './auth.js';
import { validateLoginInput } from './portal/domain.js';
import { supabase } from './portal/client.js';

// ── Nav 스크롤 ─────────────────────────────────
function initNav() {
  const nav       = document.getElementById('mainNav');
  const scrollBtn = document.getElementById('scrollTopBtn');
  if (!nav) return;
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
    if (scrollBtn) scrollBtn.style.opacity = window.scrollY > 300 ? '1' : '0.4';
  }, { passive: true });
}

// ── 모바일 햄버거 ──────────────────────────────
function initHamburger() {
  const btn  = document.getElementById('hamburger');
  const menu = document.getElementById('mobileMenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', () => {
    btn.classList.toggle('open');
    menu.classList.toggle('open');
  });
  menu.querySelectorAll('.m-link').forEach(a =>
    a.addEventListener('click', () => {
      btn.classList.remove('open');
      menu.classList.remove('open');
    })
  );
}

// ── 스크롤 리빌 ────────────────────────────────
function initReveal() {
  const obs = new IntersectionObserver(
    entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
    }),
    { threshold: 0.1 }
  );
  document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
}

// ── 카운터 애니메이션 ──────────────────────────
function animateCounter(el, target, isDecimal) {
  const DURATION = 1800;
  const start    = performance.now();
  const tick = now => {
    const p = Math.min((now - start) / DURATION, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = isDecimal ? (e * target).toFixed(1) : Math.round(e * target);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function initCounters() {
  const obs = new IntersectionObserver(
    entries => entries.forEach(e => {
      if (e.isIntersecting) {
        const el  = e.target;
        const dec = el.classList.contains('count-up-dec');
        animateCounter(el, parseFloat(el.dataset.target), dec);
        obs.unobserve(el);
      }
    }),
    { threshold: 0.5 }
  );
  document.querySelectorAll('.count-up, .count-up-dec').forEach(el => obs.observe(el));
}

// ── 커리큘럼 탭 ────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const panel = btn.dataset.tab;
      document.querySelectorAll('.curriculum-panel').forEach(p =>
        p.classList.toggle('active', p.dataset.panel === panel)
      );
    })
  );
}

// ── 토스트 ─────────────────────────────────────
function showToast(msg, duration = 4000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ── 상담 신청 폼 ────────────────────────────────
function initForm() {
  const btn = document.getElementById('formSubmit');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const name  = document.getElementById('f-name')?.value.trim();
    const phone = document.getElementById('f-phone')?.value.trim();
    const grade = document.getElementById('f-grade')?.value;
    if (!name || !phone || !grade) {
      showToast('⚠️ 이름, 연락처, 학년을 입력해주세요.', 3000);
      return;
    }
    showToast('✅ 상담 신청이 접수되었습니다! 빠르게 연락드리겠습니다.');
    ['f-name', 'f-phone', 'f-grade', 'f-type', 'f-worry', 'f-msg'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  });
}

// ── FAQ 아코디언 ────────────────────────────────
function initFAQ() {
  document.querySelectorAll('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item   = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(i => {
        i.classList.remove('open');
        i.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        item.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
}

// ── 맨 위로 ────────────────────────────────────
function initScrollTop() {
  const btn = document.getElementById('scrollTopBtn');
  if (!btn) return;
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

// ── AUTH
async function portalPath(userId) {
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', userId).single();
  if (error) throw error;
  return data.role === 'admin' ? './admin/' : './student/';
}

function initAuth() {
  const overlay = document.getElementById('authOverlay');
  const close = document.getElementById('authClose');
  const navButton = document.getElementById('navAuthBtn');
  const dropdown = document.getElementById('authDropdown');
  const error = document.getElementById('loginError');
  if (!overlay) return;
  const hide = () => overlay.classList.remove('open');
  close.addEventListener('click', hide);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) hide(); });
  navButton.addEventListener('click', () => navButton.classList.contains('logged-in') ? dropdown.classList.toggle('open') : overlay.classList.add('open'));
  document.getElementById('loginSubmit').addEventListener('click', async () => {
    error.textContent = '';
    try {
      const input = validateLoginInput(document.getElementById('loginPhone').value, document.getElementById('loginPin').value);
      const result = await signIn(input.phone, input.pin); hide(); location.href = await portalPath(result.user.id);
    } catch (cause) { error.textContent = cause.message?.includes('Invalid login') ? '전화번호 또는 PIN이 올바르지 않습니다.' : cause.message; }
  });
  document.getElementById('navLogoutBtn').addEventListener('click', async () => { await signOut(); location.reload(); });
  onAuthChange(async (user) => {
    if (!user) { navButton.textContent = '로그인'; navButton.classList.remove('logged-in'); return; }
    let name = user.email?.split('@')[0] || '사용자';
    const portalLink = document.getElementById('navPortalLink');
    try {
      const [profile, path] = await Promise.all([getProfile(user.id), portalPath(user.id)]); name = profile.name || name;
      portalLink.href = path; portalLink.textContent = path === './admin/' ? '관리자 포털' : '학생 포털'; portalLink.hidden = false;
    } catch { portalLink.hidden = true; }
    navButton.textContent = name + ' ▾'; navButton.classList.add('logged-in');
  });
}

// ── 부트스트랩 ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initHamburger();
  initReveal();
  initCounters();
  initTabs();
  initForm();
  initFAQ();
  initScrollTop();
  initAuth();
});
