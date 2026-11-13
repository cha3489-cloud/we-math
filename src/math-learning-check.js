import { supabase } from './portal/client.js';

export const HABIT_QUESTIONS = [
  { domain: 'concept', student: '새 개념을 배우면 공식만 외우기보다 왜 그렇게 되는지까지 이해하려고 한다.', parent: '아이가 새 개념을 배우면 공식만 외우기보다 왜 그런지를 이해하려고 한다.' },
  { domain: 'concept', student: '오늘 배운 개념을 친구에게 내 말로 설명할 수 있다.', parent: '오늘 배운 내용을 물어보면 아이가 자기 말로 설명할 수 있다.' },
  { domain: 'concept', reverse: true, student: '아는 유형인데도 숫자나 표현이 조금 바뀌면 손을 못 대는 경우가 많다.', parent: '아는 유형인데도 숫자나 표현이 조금 바뀌면 틀렸다고 하는 경우가 많다.' },
  { domain: 'repeat', student: '수업에서 배운 내용을 그 주 안에 다시 풀어본다.', parent: '수업에서 배운 내용을 그 주 안에 다시 복습한다.' },
  { domain: 'repeat', student: '시험 범위의 문제를 2번 이상 반복해서 풀어본다.', parent: '시험 범위의 문제를 2번 이상 반복해서 풀어본다.' },
  { domain: 'repeat', reverse: true, student: '한 번 풀어서 맞힌 문제는 다시 보지 않는다.', parent: '한 번 맞힌 문제는 다시 보지 않고 넘어간다.' },
  { domain: 'wrong', student: '틀린 문제는 해설을 읽고 끝내지 않고 다시 혼자 풀어본다.', parent: '틀린 문제를 해설만 보고 끝내지 않고 다시 혼자 풀어본다.' },
  { domain: 'wrong', student: '틀린 이유를 개념 부족, 계산 실수, 문제 읽기 중 하나로 구분해서 기록한다.', parent: '틀린 이유를 개념 부족, 계산 실수, 문제 읽기 중 하나로 구분해서 정리한다.' },
  { domain: 'wrong', reverse: true, student: '같은 실수로 같은 유형을 또 틀린 적이 많다.', parent: '같은 실수로 같은 유형을 반복해서 틀린다.' },
  { domain: 'self', student: '모르는 문제를 만나면 최소 5분은 스스로 고민해 본다.', parent: '모르는 문제를 만나면 바로 묻기보다 스스로 충분히 고민해 본다.' },
  { domain: 'self', reverse: true, student: '막히면 바로 해설이나 정답부터 확인한다.', parent: '막히면 바로 해설이나 정답부터 확인하는 편이다.' },
  { domain: 'self', student: '답만 쓰지 않고 풀이 과정을 식으로 정리해서 쓴다.', parent: '답만 쓰지 않고 풀이 과정을 식으로 정리해서 쓴다.' },
  { domain: 'routine', student: '정해진 요일과 시간에 수학 공부를 한다.', parent: '정해진 요일과 시간에 꾸준히 수학 공부를 한다.' },
  { domain: 'routine', student: '시험 3~4주 전부터 계획을 세워 준비한다.', parent: '시험 3~4주 전부터 계획을 세워 준비한다.' },
  { domain: 'routine', reverse: true, student: '숙제는 주로 마감 직전에 몰아서 한다.', parent: '숙제를 주로 마감 직전에 몰아서 한다.' },
];

const DOMAIN_CONTENT = {
  concept: { label: '개념 이해', tip: '오늘 배운 개념 하나를 노트 없이 1분 동안 말로 설명해 보세요.' },
  repeat: { label: '반복·복습', tip: '수업 다음 날, 3일 뒤, 1주 뒤에 같은 문제를 다시 풀어보세요.' },
  wrong: { label: '오답 관리', tip: '틀린 이유를 개념·계산·문제 읽기로 구분하고 3일 뒤 다시 풀어보세요.' },
  self: { label: '스스로 푸는 힘', tip: '모르는 문제는 5분 동안 아는 조건부터 식으로 적은 뒤 해설을 보세요.' },
  routine: { label: '학습 루틴', tip: '이번 주 수학 공부 요일과 시간을 두 개만 정해 고정해 보세요.' },
};
const DOMAIN_KEYS = Object.keys(DOMAIN_CONTENT);
const OPTIONS = ['전혀 아니다', '가끔 그렇다', '자주 그렇다', '항상 그렇다'];
const GRADES = ['초4', '초5', '초6', '중1', '중2', '중3', '고1', '고2', '고3'];
const UNDER_14 = new Set(['초4', '초5', '초6', '중1']);
const STORAGE_KEY = 'sequence-habit-diagnostic-submission-id';

export function evaluateMathLearningCheck(answers) {
  const raw = Object.fromEntries(DOMAIN_KEYS.map((key) => [key, 0]));
  let unknown = 0;
  answers.forEach((answer, index) => {
    let score = answer === 'u' ? 1 : Number(answer);
    if (answer === 'u') unknown += 1;
    else if (HABIT_QUESTIONS[index]?.reverse) score = 3 - score;
    const domain = HABIT_QUESTIONS[index]?.domain;
    if (domain) raw[domain] += score;
  });
  const percent = Object.fromEntries(DOMAIN_KEYS.map((key) => [key, Math.round(raw[key] / 9 * 100)]));
  const total = Math.round(Object.values(raw).reduce((sum, score) => sum + score, 0) / 45 * 100);
  const level = total >= 80 ? { step: 4, name: '반복 설계형', summary: '공부 습관의 기본기가 탄탄합니다. 이제 학습 순서와 깊이를 정교하게 설계할 단계입니다.' }
    : total >= 60 ? { step: 3, name: '성장 대기형', summary: '기본 습관은 잡혀 있지만 약한 습관 한두 가지가 성장을 붙잡고 있습니다.' }
    : total >= 40 ? { step: 2, name: '노력 누수형', summary: '공부한 시간에 비해 점수로 남는 양이 적습니다. 노력보다 학습 방식의 조정이 먼저입니다.' }
    : { step: 1, name: '루틴 재설계형', summary: '공부 방식을 작게 나누어 다시 설계할 단계입니다. 반복 가능한 구조부터 만들면 됩니다.' };
  const sorted = [...DOMAIN_KEYS].sort((a, b) => percent[a] - percent[b]);
  const weak = sorted.filter((key) => percent[key] < 75).slice(0, 2);
  if (!weak.length) weak.push(sorted[0]);
  return { raw, percent, total, level, weak, unknown };
}

function setPageInert(elements, value) {
  elements.forEach((element) => { if (element) element.inert = value; });
}

function focusableElements(dialog) {
  return [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')]
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function phoneValue(value) {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length < 4) return digits;
  if (digits.length < 8) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, digits.length - 4)}-${digits.slice(-4)}`;
}

export function initMathLearningCheck() {
  const trigger = document.getElementById('openMathCheck');
  const dialog = document.getElementById('mathCheckDialog');
  const closeButton = document.getElementById('closeMathCheck');
  const widget = document.getElementById('habitDiagnosticWidget');
  if (!trigger || !dialog || !closeButton || !widget) return;

  const pageRegions = [document.getElementById('consultationHeader'), document.getElementById('consultationMain')];
  let returnFocus = null;
  let state;
  let advanceTimer = null;

  const cancelAdvance = () => {
    if (advanceTimer !== null) window.clearTimeout(advanceTimer);
    advanceTimer = null;
  };

  const reset = () => {
    cancelAdvance();
    state = { screen: 'intro', respondent: null, grade: null, index: 0, answers: Array(15).fill(null), info: null };
  };
  reset();

  const render = (markup) => {
    widget.innerHTML = markup;
    widget.querySelector('button, input, select')?.focus({ preventScroll: true });
  };

  const stair = (filled) => {
    let index = 0;
    return `<div class="hd-stair" aria-hidden="true">${[1, 2, 3, 4, 5].map((count) => `<span>${Array.from({ length: count }, () => {
      const current = index;
      index += 1;
      return `<i class="${current < filled ? 'filled' : current === filled ? 'next' : ''}"></i>`;
    }).join('')}</span>`).join('')}</div>`;
  };

  const renderIntro = () => {
    state.screen = 'intro';
    render(`
    <section class="hd-screen">
      <h3>우리 아이 수학 점수,<br>습관에서 답을 찾아보세요</h3>
      <p>질문 15개로 지금의 공부 방식을 다섯 가지 영역에서 점검하고, 상담에서 먼저 확인할 습관을 정리합니다.</p>
      <div class="hd-hero">${stair(0)}<small>3분이면 충분합니다. 진단 결과와 응답은 상담 준비 자료로 안전하게 저장됩니다.</small></div>
      <button class="hd-primary" type="button" data-action="setup">진단 시작하기</button>
    </section>`);
  };

  const renderSetup = () => {
    state.screen = 'setup';
    render(`
    <section class="hd-screen">
      <h3>시작하기 전에 두 가지만 알려주세요</h3>
      <p class="hd-label">누가 응답하나요?</p>
      <div class="hd-segment">
        <button type="button" data-respondent="parent" aria-pressed="${state.respondent === 'parent'}" class="${state.respondent === 'parent' ? 'selected' : ''}">학부모<small>아이를 지켜본 대로 응답</small></button>
        <button type="button" data-respondent="student" aria-pressed="${state.respondent === 'student'}" class="${state.respondent === 'student' ? 'selected' : ''}">학생<small>내 공부를 직접 응답</small></button>
      </div>
      <p class="hd-label">학생 학년</p>
      <div class="hd-grades">${GRADES.map((grade) => `<button type="button" data-grade="${grade}" aria-pressed="${state.grade === grade}" class="${state.grade === grade ? 'selected' : ''}">${grade}</button>`).join('')}</div>
      <div class="hd-actions"><button class="hd-link" type="button" data-action="intro">처음으로</button><button class="hd-primary" type="button" data-action="questions" ${state.respondent && state.grade ? '' : 'disabled'}>질문 시작하기</button></div>
    </section>`);
  };

  const renderQuestion = () => {
    state.screen = 'question';
    const question = HABIT_QUESTIONS[state.index];
    const text = state.respondent === 'parent' ? question.parent : question.student;
    const currentAnswer = state.answers[state.index];
    const options = OPTIONS.map((option, index) => `<button class="hd-option ${currentAnswer === index ? 'selected' : ''}" type="button" role="radio" aria-checked="${currentAnswer === index}" tabindex="${currentAnswer === index || (currentAnswer === null && index === 0) ? '0' : '-1'}" data-answer="${index}"><span></span>${option}</button>`).join('');
    const unknown = state.respondent === 'parent' ? `<button class="hd-option hd-unknown ${currentAnswer === 'u' ? 'selected' : ''}" type="button" role="radio" aria-checked="${currentAnswer === 'u'}" tabindex="${currentAnswer === 'u' ? '0' : '-1'}" data-answer="u"><span></span>잘 모르겠어요</button>` : '';
    render(`<section class="hd-screen">
      <div class="hd-progress">${stair(state.index)}<b>${state.index + 1} / 15</b></div>
      <p class="hd-area">${DOMAIN_CONTENT[question.domain].label}</p>
      <h3 class="hd-question">${text}</h3>
      <div class="hd-options" role="radiogroup" aria-label="응답 선택">${options}${unknown}</div>
      <button class="hd-link" type="button" data-action="previous">이전 질문</button>
    </section>`);
  };

  const renderContact = () => {
    state.screen = 'contact';
    const needsGuardian = state.respondent === 'student' && UNDER_14.has(state.grade);
    render(`<section class="hd-screen">
      <div class="hd-complete">${stair(15)}<strong>15칸을 모두 쌓았어요</strong></div>
      <h3>결과를 상담 자료로 저장할게요</h3>
      <p>학생 이름과 학부모 연락처를 남기면 결과가 바로 표시되고, 이후 상담에서 같은 내용을 반복해서 설명하지 않아도 됩니다.</p>
      <form id="habitContactForm" class="hd-contact">
        <label>학생 이름<input id="habitStudentName" type="text" maxlength="40" autocomplete="name" required></label>
        <label>학부모 연락처<input id="habitParentPhone" type="tel" inputmode="numeric" maxlength="13" autocomplete="tel" placeholder="010-0000-0000" required></label>
        <input id="habitWebsite" class="honeypot" type="url" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="hd-privacy"><strong>개인정보 수집·이용 안내</strong><span>수집: 이름·연락처·학년·진단 응답 / 목적: 결과 저장 및 학습 상담 / 보유: 상담 종료 후 1년</span><span>동의를 거부할 수 있으나 결과 저장과 상담이 제한됩니다.</span></div>
        <label class="hd-check"><input id="habitPrivacy" type="checkbox" required> 개인정보 수집·이용에 동의합니다 (필수)</label>
        ${needsGuardian ? '<label class="hd-check"><input id="habitGuardian" type="checkbox" required> 법정대리인의 동의를 받았습니다 (필수)</label>' : ''}
        <label class="hd-check"><input id="habitMarketing" type="checkbox"> 설명회와 학습 자료 소식을 받습니다 (선택)</label>
        <p id="habitSubmitError" class="hd-error" role="alert"></p>
        <div class="hd-actions"><button class="hd-link" type="button" data-action="previous">마지막 질문으로</button><button class="hd-primary" id="habitSubmit" type="submit">저장하고 결과 보기</button></div>
      </form>
    </section>`);
    const phone = document.getElementById('habitParentPhone');
    phone.addEventListener('input', () => { phone.value = phoneValue(phone.value); });
  };

  const renderResult = () => {
    state.screen = 'result';
    const result = evaluateMathLearningCheck(state.answers);
    render(`<section class="hd-screen hd-result" tabindex="-1">
      <div class="hd-result-head"><div><p><span id="habitResultName"></span> 학생 · ${state.grade}</p><h3>${result.level.step}번째 계단,<br>${result.level.name}</h3></div><strong>${result.total}<small>100점 기준</small></strong></div>
      <p>${result.level.summary}</p>
      <div class="hd-score-grid">${DOMAIN_KEYS.map((key) => `<div class="${result.weak.includes(key) ? 'weak' : ''}"><b>${result.percent[key]}</b><span>${DOMAIN_CONTENT[key].label}</span></div>`).join('')}</div>
      <h4>상담에서 먼저 확인할 습관</h4>
      ${result.weak.map((key) => `<article><strong>${DOMAIN_CONTENT[key].label}</strong><p>${DOMAIN_CONTENT[key].tip}</p></article>`).join('')}
      <div class="hd-saved"><strong>상담 자료 저장 완료</strong><p>원장이 진단 결과와 15개 응답을 확인한 뒤 상담에 참고합니다.</p></div>
      <button class="hd-primary" type="button" data-action="close">확인</button>
      <button class="hd-link" type="button" data-action="restart">처음부터 다시 진단하기</button>
    </section>`);
    document.getElementById('habitResultName').textContent = state.info.name;
  };

  const closeDialog = () => {
    cancelAdvance();
    setPageInert(pageRegions, false);
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    returnFocus?.focus();
  };

  trigger.addEventListener('click', () => {
    returnFocus = trigger;
    setPageInert(pageRegions, true);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    renderIntro();
    closeButton.focus();
  });
  closeButton.addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });

  document.addEventListener('keydown', (event) => {
    if (!dialog.hasAttribute('open') || event.key !== 'Tab') return;
    const focusables = focusableElements(dialog);
    const first = focusables[0];
    const last = focusables.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  const selectAnswer = (target) => {
    state.answers[state.index] = target.dataset.answer === 'u' ? 'u' : Number(target.dataset.answer);
    widget.querySelectorAll('[data-answer]').forEach((button) => {
      const selected = button === target;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  };

  widget.addEventListener('keydown', (event) => {
    const target = event.target.closest('[data-answer]');
    if (!target || !['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const options = [...widget.querySelectorAll('[data-answer]')];
    const current = options.indexOf(target);
    let nextIndex = current;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = options.length - 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (current - 1 + options.length) % options.length;
    else nextIndex = (current + 1) % options.length;
    event.preventDefault();
    cancelAdvance();
    selectAnswer(options[nextIndex]);
    options[nextIndex].focus();
  });

  widget.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action], [data-respondent], [data-grade], [data-answer]');
    if (!target) return;
    if (target.dataset.respondent) { state.respondent = target.dataset.respondent; renderSetup(); return; }
    if (target.dataset.grade) { state.grade = target.dataset.grade; renderSetup(); return; }
    if (target.dataset.answer !== undefined) {
      cancelAdvance();
      selectAnswer(target);
      advanceTimer = window.setTimeout(() => {
        advanceTimer = null;
        if (state.index < 14) { state.index += 1; renderQuestion(); }
        else if (state.answers.every((answer) => answer === 'u' || Number.isInteger(answer))) renderContact();
        else { state.index = state.answers.findIndex((answer) => answer === null); renderQuestion(); }
      }, 120);
      return;
    }
    cancelAdvance();
    switch (target.dataset.action) {
      case 'setup': renderSetup(); break;
      case 'intro': renderIntro(); break;
      case 'questions': if (state.respondent && state.grade) { state.index = 0; renderQuestion(); } break;
      case 'previous':
        if (state.screen === 'contact') { state.index = 14; renderQuestion(); }
        else if (state.index > 0) { state.index -= 1; renderQuestion(); }
        else renderSetup();
        break;
      case 'restart': reset(); renderIntro(); break;
      case 'close': closeDialog(); break;
    }
  });

  widget.addEventListener('submit', async (event) => {
    if (event.target.id !== 'habitContactForm') return;
    event.preventDefault();
    if (!event.target.reportValidity()) return;
    const submit = document.getElementById('habitSubmit');
    const errorBox = document.getElementById('habitSubmitError');
    if (!state.answers.every((answer) => answer === 'u' || (Number.isInteger(answer) && answer >= 0 && answer <= 3))) {
      errorBox.textContent = '15개 질문에 모두 응답해주세요.';
      return;
    }
    const submissionId = sessionStorage.getItem(STORAGE_KEY) || crypto.randomUUID();
    sessionStorage.setItem(STORAGE_KEY, submissionId);
    const body = {
      kind: 'habit-diagnostic',
      respondent: state.respondent,
      grade: state.grade,
      studentName: document.getElementById('habitStudentName').value,
      parentPhone: document.getElementById('habitParentPhone').value,
      answers: state.answers,
      privacyConsent: document.getElementById('habitPrivacy').checked,
      marketingConsent: document.getElementById('habitMarketing').checked,
      guardianConsent: document.getElementById('habitGuardian')?.checked ?? false,
      website: document.getElementById('habitWebsite').value,
      submissionId,
    };
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    errorBox.textContent = '';
    try {
      const { data, error } = await supabase.functions.invoke('consultation-intake', { body, signal: AbortSignal.timeout(15_000) });
      if (error || !data?.ok) throw error || new Error('habit diagnostic intake failed');
      state.info = { name: body.studentName.trim(), phone: body.parentPhone };
      sessionStorage.setItem(STORAGE_KEY, crypto.randomUUID());
      renderResult();
    } catch {
      errorBox.textContent = '저장하지 못했습니다. 입력 내용은 유지됩니다. 잠시 후 다시 시도하거나 010-2496-4031로 문자를 남겨주세요.';
    } finally {
      if (document.body.contains(submit)) {
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
      }
    }
  });
}
