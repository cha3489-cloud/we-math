import './style.css';

// ─── Math background symbols ──────────────────────────────────────────────────
const SYMBOLS = ['∑','∫','∞','√','π','Δ','∂','≈','≠','∈','∀','∃','θ','α','β','λ','σ','±','f(x)','dx','lim','→','log','sin','cos','tan','n²','xⁿ'];

function initMathBg() {
  const bg = document.getElementById('mathBg');
  if (!bg) return;
  for (let i = 0; i < 40; i++) {
    const el = document.createElement('div');
    el.className = 'math-symbol';
    el.textContent = SYMBOLS[i % SYMBOLS.length];
    const size = Math.random() * 64 + 20;
    el.style.cssText = `
      left: ${Math.random() * 100}%;
      top:  ${Math.random() * 100}%;
      font-size: ${size}px;
      transform: rotate(${(Math.random() - 0.5) * 50}deg);
      opacity: ${Math.random() * 0.5 + 0.5};
    `;
    bg.appendChild(el);
  }
}

// ─── Nav scroll shadow + scroll-to-top visibility ─────────────────────────────
function initNav() {
  const nav       = document.getElementById('mainNav');
  const scrollBtn = document.getElementById('scrollTopBtn');
  if (!nav) return;

  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
    if (scrollBtn) scrollBtn.style.opacity = window.scrollY > 300 ? '1' : '0.3';
  }, { passive: true });
}

// ─── Mobile hamburger menu ────────────────────────────────────────────────────
function initHamburger() {
  const hamburger  = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobileMenu');
  if (!hamburger || !mobileMenu) return;

  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('open');
    mobileMenu.classList.toggle('open');
  });

  mobileMenu.querySelectorAll('.m-link').forEach(link => {
    link.addEventListener('click', () => {
      hamburger.classList.remove('open');
      mobileMenu.classList.remove('open');
    });
  });
}

// ─── Scroll reveal (Intersection Observer) ───────────────────────────────────
function initReveal() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          observer.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

// ─── Counter animation ────────────────────────────────────────────────────────
function animateCounter(el, target, isDecimal) {
  const DURATION = 1800;
  const start    = performance.now();

  const update = (now) => {
    const progress = Math.min((now - start) / DURATION, 1);
    const ease     = 1 - Math.pow(1 - progress, 3);
    el.textContent = isDecimal
      ? (ease * target).toFixed(1)
      : Math.round(ease * target);
    if (progress < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

function initCounters() {
  const counterObs = new IntersectionObserver(
    (entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const el     = e.target;
          const target = parseFloat(el.dataset.target);
          const isDec  = el.classList.contains('count-up-dec');
          animateCounter(el, target, isDec);
          counterObs.unobserve(el);
        }
      });
    },
    { threshold: 0.5 }
  );
  document.querySelectorAll('.count-up, .count-up-dec').forEach(el => counterObs.observe(el));
}

// ─── Curriculum tabs ──────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const panel = btn.dataset.tab;
      document.querySelectorAll('.curriculum-panel').forEach(p => {
        p.classList.toggle('active', p.dataset.panel === panel);
      });
    });
  });
}

// ─── Toast helper ─────────────────────────────────────────────────────────────
function showToast(msg, duration = 4000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ─── Contact form ─────────────────────────────────────────────────────────────
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

    ['f-name', 'f-phone', 'f-grade', 'f-msg'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  });
}

// ─── Scroll to top ────────────────────────────────────────────────────────────
function initScrollTop() {
  const btn = document.getElementById('scrollTopBtn');
  if (!btn) return;
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMathBg();
  initNav();
  initHamburger();
  initReveal();
  initCounters();
  initTabs();
  initForm();
  initScrollTop();
});
