import './style.css';
import { signUp, signIn, signOut, onAuthChange, getProfile, updateProfileName, updatePin, deleteAccount, isWithdrawnPhone } from './auth.js';

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

// ── AUTH ────────────────────────────────────────
function initAuth() {
  const overlay        = document.getElementById('authOverlay');
  const closeBtn       = document.getElementById('authClose');
  const navAuthBtn     = document.getElementById('navAuthBtn');
  const navLogoutBtn   = document.getElementById('navLogoutBtn');
  const navMypageBtn   = document.getElementById('navMypageBtn');
  const dropdown       = document.getElementById('authDropdown');
  const dropPhone      = document.getElementById('dropdownPhone');

  const mypageOverlay  = document.getElementById('mypageOverlay');
  const mypageClose    = document.getElementById('mypageClose');
  const mypageName     = document.getElementById('mypageName');
  const mypagePhone    = document.getElementById('mypagePhone');
  const mypageSave     = document.getElementById('mypageSave');
  const mypageNewPin        = document.getElementById('mypageNewPin');
  const mypageNewPinConfirm = document.getElementById('mypageNewPinConfirm');
  const mypagePinSave       = document.getElementById('mypagePinSave');
  const mypageDeleteBtn = document.getElementById('mypageDeleteBtn');

  let currentUser = null;

  if (!overlay) return;

  // 모달 열기/닫기
  const openModal = () => overlay.classList.add('open');
  const closeModal = () => {
    overlay.classList.remove('open');
    clearErrors();
  };

  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  closeBtn.addEventListener('click', closeModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeMypageModal(); }
  });

  // 마이페이지 모달 열기/닫기
  const openMypageModal = () => mypageOverlay.classList.add('open');
  const closeMypageModal = () => {
    mypageOverlay.classList.remove('open');
    document.getElementById('mypageError').textContent = '';
    document.getElementById('mypagePinError').textContent = '';
    mypageNewPin.value = '';
    mypageNewPinConfirm.value = '';
  };
  mypageOverlay.addEventListener('click', e => { if (e.target === mypageOverlay) closeMypageModal(); });
  mypageClose.addEventListener('click', closeMypageModal);

  // 탭 전환
  document.querySelectorAll('[data-auth-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.authTab;
      document.querySelectorAll('[data-auth-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(target === 'login' ? 'authPanelLogin' : 'authPanelSignup')
        .classList.add('active');
      clearErrors();
    });
  });

  function clearErrors() {
    document.getElementById('loginError').textContent  = '';
    document.getElementById('signupError').textContent = '';
  }

  function setError(id, msg) {
    document.getElementById(id).textContent = msg;
  }

  function validatePhone(phone) {
    return /^01[0-9]{8,9}$/.test(phone.replace(/[^0-9]/g, ''));
  }

  function validatePin(pin) {
    return /^\d{4}$/.test(pin);
  }

  // 로그인
  document.getElementById('loginSubmit').addEventListener('click', async () => {
    const phone = document.getElementById('loginPhone').value.trim();
    const pin   = document.getElementById('loginPin').value;
    if (!validatePhone(phone)) { setError('loginError', '올바른 전화번호를 입력하세요 (예: 01012345678)'); return; }
    if (!validatePin(pin))     { setError('loginError', 'PIN은 숫자 4자리여야 합니다'); return; }

    const btn = document.getElementById('loginSubmit');
    btn.disabled = true; btn.textContent = '로그인 중...';
    try {
      await signIn(phone, pin);
      closeModal();
      showToast('로그인되었습니다');
    } catch (err) {
      if (err.message?.includes('Invalid login')) {
        let withdrawn = false;
        try { withdrawn = await isWithdrawnPhone(phone); } catch { /* 확인 실패 시 일반 안내로 처리 */ }
        if (withdrawn) {
          document.querySelector('[data-auth-tab="signup"]').click();
          document.getElementById('signupPhone').value = phone;
          setError('signupError', '탈퇴한 계정입니다. 다시 회원가입해 주세요.');
          showToast('탈퇴한 계정입니다. 다시 회원가입해 주세요.', 4000);
        } else {
          setError('loginError', '전화번호 또는 PIN이 올바르지 않습니다');
        }
      } else {
        setError('loginError', err.message);
      }
    } finally {
      btn.disabled = false; btn.textContent = '로그인';
    }
  });

  // 회원가입
  document.getElementById('signupSubmit').addEventListener('click', async () => {
    const name    = document.getElementById('signupName').value.trim();
    const phone   = document.getElementById('signupPhone').value.trim();
    const pin     = document.getElementById('signupPin').value;
    const pinConf = document.getElementById('signupPinConfirm').value;

    if (!name)                 { setError('signupError', '학생 이름을 입력하세요'); return; }
    if (!validatePhone(phone)) { setError('signupError', '올바른 전화번호를 입력하세요 (예: 01012345678)'); return; }
    if (!validatePin(pin))     { setError('signupError', 'PIN은 숫자 4자리여야 합니다'); return; }
    if (pin !== pinConf)       { setError('signupError', 'PIN이 일치하지 않습니다'); return; }

    const btn = document.getElementById('signupSubmit');
    btn.disabled = true; btn.textContent = '처리 중...';
    try {
      await signUp(phone, pin, name);
      closeModal();
      showToast('회원가입이 완료되었습니다! 로그인해 주세요.');
      // 로그인 탭으로 전환
      document.querySelector('[data-auth-tab="login"]').click();
      document.getElementById('loginPhone').value = phone;
      openModal();
    } catch (err) {
      const msg = err.message?.includes('already registered') ? '이미 가입된 전화번호입니다' : err.message;
      setError('signupError', msg);
    } finally {
      btn.disabled = false; btn.textContent = '회원가입';
    }
  });

  // 네비 버튼 — 로그인 상태에 따라 토글
  navAuthBtn.addEventListener('click', () => {
    if (navAuthBtn.classList.contains('logged-in')) {
      dropdown.classList.toggle('open');
    } else {
      openModal();
    }
  });

  // 드롭다운 외부 클릭 닫기
  document.addEventListener('click', e => {
    if (!e.target.closest('.nav-auth-wrap')) dropdown.classList.remove('open');
  });

  // 로그아웃
  navLogoutBtn.addEventListener('click', async () => {
    await signOut();
    dropdown.classList.remove('open');
    showToast('로그아웃되었습니다');
  });

  // 마이페이지 열기
  navMypageBtn.addEventListener('click', async () => {
    dropdown.classList.remove('open');
    if (!currentUser) return;
    const phone = currentUser.email?.split('@')[0] ?? '';
    mypagePhone.textContent = phone;
    mypageName.value = '';
    try {
      const profile = await getProfile(currentUser.id);
      mypageName.value = profile?.name ?? '';
    } catch { /* 조회 실패 시 빈 값으로 둠 */ }
    openMypageModal();
  });

  // 마이페이지 — 이름 저장
  mypageSave.addEventListener('click', async () => {
    const name = mypageName.value.trim();
    if (!name) { document.getElementById('mypageError').textContent = '이름을 입력하세요'; return; }

    mypageSave.disabled = true; mypageSave.textContent = '저장 중...';
    try {
      await updateProfileName(currentUser.id, name);
      navAuthBtn.textContent = `${name} ▾`;
      dropPhone.textContent = name + ' ';
      showToast('저장되었습니다');
      closeMypageModal();
    } catch (err) {
      document.getElementById('mypageError').textContent = err.message;
    } finally {
      mypageSave.disabled = false; mypageSave.textContent = '저장';
    }
  });

  // 마이페이지 — PIN 변경
  mypagePinSave.addEventListener('click', async () => {
    const pin     = mypageNewPin.value;
    const pinConf = mypageNewPinConfirm.value;
    const errEl   = document.getElementById('mypagePinError');
    if (!validatePin(pin))  { errEl.textContent = 'PIN은 숫자 4자리여야 합니다'; return; }
    if (pin !== pinConf)    { errEl.textContent = 'PIN이 일치하지 않습니다'; return; }

    mypagePinSave.disabled = true; mypagePinSave.textContent = '변경 중...';
    try {
      await updatePin(pin);
      errEl.textContent = '';
      mypageNewPin.value = '';
      mypageNewPinConfirm.value = '';
      showToast('PIN이 변경되었습니다');
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      mypagePinSave.disabled = false; mypagePinSave.textContent = 'PIN 변경';
    }
  });

  // 마이페이지 — 회원 탈퇴
  mypageDeleteBtn.addEventListener('click', async () => {
    if (!confirm('정말 탈퇴하시겠습니까? 모든 정보가 삭제되며 복구할 수 없습니다.')) return;

    mypageDeleteBtn.disabled = true; mypageDeleteBtn.textContent = '처리 중...';
    try {
      await deleteAccount();
      closeMypageModal();
      showToast('탈퇴가 완료되었습니다');
    } catch (err) {
      document.getElementById('mypageError').textContent = err.message;
    } finally {
      mypageDeleteBtn.disabled = false; mypageDeleteBtn.textContent = '회원 탈퇴';
    }
  });

  // 인증 상태 구독
  onAuthChange(async user => {
    currentUser = user;
    if (user) {
      const phone = user.email?.split('@')[0] ?? '';
      let displayName = phone;
      try {
        const profile = await getProfile(user.id);
        if (profile?.name) displayName = profile.name;
      } catch { /* 프로필 조회 실패 시 전화번호로 대체 표시 */ }
      navAuthBtn.textContent = `${displayName} ▾`;
      navAuthBtn.classList.add('logged-in');
      dropPhone.textContent = displayName + ' ';
    } else {
      navAuthBtn.textContent = '로그인';
      navAuthBtn.classList.remove('logged-in');
      dropdown.classList.remove('open');
    }
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
