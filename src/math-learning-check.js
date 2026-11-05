const DOMAIN_CONTENT = {
  start: {
    label: '학습 시작과 루틴',
    action: '매일 같은 시간에 20분만 시작하고, 끝낸 분량을 한 줄로 남겨보세요.',
  },
  interpret: {
    label: '조건 해석',
    action: '문제에서 구할 것과 주어진 조건에 각각 밑줄을 긋고 첫 줄을 써보세요.',
  },
  explain: {
    label: '풀이 과정 설명',
    action: '정답만 확인하지 말고 왜 그 식을 썼는지 한 문장으로 설명해보세요.',
  },
  retry: {
    label: '오답과 재풀이',
    action: '틀린 문제는 답을 본 날이 아니라 다음 날 다시 풀어 성공 여부를 기록해보세요.',
  },
};

export function evaluateMathLearningCheck(answers) {
  const grouped = new Map();
  answers.forEach(({ domain, score }) => {
    if (!DOMAIN_CONTENT[domain] || !Number.isFinite(score)) return;
    const values = grouped.get(domain) || [];
    values.push(score);
    grouped.set(domain, values);
  });

  const domainScores = [...grouped.entries()].map(([domain, scores]) => ({
    domain,
    score: scores.reduce((sum, value) => sum + value, 0) / scores.length,
  }));
  const overall = domainScores.length
    ? domainScores.reduce((sum, item) => sum + item.score, 0) / domainScores.length
    : 0;
  const lowestScore = domainScores.length
    ? Math.min(...domainScores.map((item) => item.score))
    : 0;
  const level = lowestScore >= 1.5 ? '안정적' : lowestScore >= 0.75 ? '조정하면 좋아요' : '점검 필요';
  const priorityDomains = domainScores
    .filter((item) => item.score === lowestScore)
    .map((item) => item.domain)
    .slice(0, 2);

  return {
    level,
    overall,
    priorityDomains,
    actions: priorityDomains.map((domain) => DOMAIN_CONTENT[domain].action),
    labels: priorityDomains.map((domain) => DOMAIN_CONTENT[domain].label),
  };
}

function setPageInert(elements, value) {
  elements.forEach((element) => {
    if (element) element.inert = value;
  });
}

function focusableElements(dialog) {
  return [...dialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
  )].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

export function initMathLearningCheck() {
  const trigger = document.getElementById('openMathCheck');
  const dialog = document.getElementById('mathCheckDialog');
  const closeButton = document.getElementById('closeMathCheck');
  const form = document.getElementById('mathCheckForm');
  const result = document.getElementById('mathCheckResult');
  if (!trigger || !dialog || !closeButton || !form || !result) return;

  const pageRegions = [
    document.getElementById('consultationHeader'),
    document.getElementById('consultationMain'),
  ];
  let returnFocus = null;

  const restorePage = () => {
    setPageInert(pageRegions, false);
    returnFocus?.focus();
  };
  const closeDialog = () => {
    restorePage();
    if (typeof dialog.close === 'function') dialog.close();
    else {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    }
  };

  trigger.addEventListener('click', () => {
    returnFocus = trigger;
    setPageInert(pageRegions, true);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    closeButton.focus();
  });

  closeButton.addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });
  dialog.addEventListener('close', restorePage);

  document.addEventListener('keydown', (event) => {
    if (!dialog.hasAttribute('open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = focusableElements(dialog);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const answers = [...form.querySelectorAll('fieldset[data-domain]')].map((fieldset) => {
      const selected = fieldset.querySelector('input[type="radio"]:checked');
      return { domain: fieldset.dataset.domain, score: Number(selected.value) };
    });
    const evaluation = evaluateMathLearningCheck(answers);
    document.getElementById('mathCheckResultTitle').textContent = `현재 상태: ${evaluation.level}`;
    document.getElementById('mathCheckResultSummary').textContent = evaluation.labels.length
      ? `먼저 살펴볼 영역은 ${evaluation.labels.join(', ')}입니다.`
      : '현재 학습 흐름을 차근차근 확인해보세요.';
    const actions = document.getElementById('mathCheckResultActions');
    actions.replaceChildren();
    evaluation.actions.forEach((action) => {
      const item = document.createElement('li');
      item.textContent = action;
      actions.append(item);
    });
    result.hidden = false;
    result.focus();
  });
}
