import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { evaluateMathLearningCheck, initMathLearningCheck } from '../src/math-learning-check.js';
import { supabase } from '../src/portal/client.js';

vi.mock('../src/portal/client.js', () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

const fixture = `
  <header id="consultationHeader"><button id="outsideButton">밖</button></header>
  <main id="consultationMain"><button id="openMathCheck" type="button">진단 시작</button></main>
  <dialog id="mathCheckDialog" aria-labelledby="mathCheckTitle">
    <div class="math-check-panel">
      <button id="closeMathCheck" type="button">닫기</button>
      <h2 id="mathCheckTitle">수학 공부 습관 진단</h2>
      <div id="habitDiagnosticWidget"></div>
    </div>
  </dialog>
`;

describe('math habit diagnostic', () => {
  beforeEach(() => {
    const dom = new JSDOM(`<!doctype html><body>${fixture}</body>`, { url: 'https://sequencemath.co.kr/consultation/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('4f61bbcc-577d-4da8-a96c-0f83d50331d6');
    globalThis.sessionStorage = dom.window.sessionStorage;
    supabase.functions.invoke.mockReset();
  });

  it('scores all five domains and reverses negative questions', () => {
    const result = evaluateMathLearningCheck([3, 3, 0, 2, 2, 1, 3, 2, 0, 2, 1, 2, 3, 2, 0]);
    expect(result.raw).toEqual({ concept: 9, repeat: 6, wrong: 8, self: 6, routine: 8 });
    expect(result.total).toBe(82);
    expect(result.level.name).toBe('반복 설계형');
    expect(result.weak).toEqual(['repeat', 'self']);
  });

  it('opens accessibly, traps focus, closes with Escape, and restores the trigger', () => {
    const dialog = document.getElementById('mathCheckDialog');
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    dialog.close = vi.fn(() => dialog.removeAttribute('open'));
    initMathLearningCheck();

    const trigger = document.getElementById('openMathCheck');
    trigger.focus();
    trigger.click();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(document.getElementById('consultationHeader').inert).toBe(true);
    expect(document.getElementById('consultationMain').inert).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('closeMathCheck'));

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement.dataset.action).toBe('setup');
    document.getElementById('closeMathCheck').click();
    expect(document.getElementById('consultationHeader').inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('collects 15 answers, submits them through the intake function, and then renders the saved result', async () => {
    vi.useFakeTimers();
    supabase.functions.invoke.mockResolvedValue({ data: { ok: true }, error: null });
    const dialog = document.getElementById('mathCheckDialog');
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    initMathLearningCheck();
    document.getElementById('openMathCheck').click();
    document.querySelector('[data-action="setup"]').click();
    document.querySelector('[data-respondent="parent"]').click();
    document.querySelector('[data-grade="중2"]').click();
    document.querySelector('[data-action="questions"]').click();

    for (let index = 0; index < 15; index += 1) {
      document.querySelector('[data-answer="3"]').click();
      await vi.advanceTimersByTimeAsync(130);
    }
    expect(document.getElementById('habitContactForm')).not.toBeNull();
    document.getElementById('habitStudentName').value = '테스트학생';
    document.getElementById('habitParentPhone').value = '010-1234-5678';
    document.getElementById('habitPrivacy').checked = true;
    document.getElementById('habitContactForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(supabase.functions.invoke).toHaveBeenCalledWith('consultation-intake', expect.objectContaining({
      body: expect.objectContaining({ kind: 'habit-diagnostic', grade: '중2', answers: Array(15).fill(3) }),
    }));
    expect(document.querySelector('.hd-saved')?.textContent).toContain('상담 자료 저장 완료');
    vi.useRealTimers();
  });

  it('cancels a pending auto-advance when an answer is changed quickly', async () => {
    vi.useFakeTimers();
    const dialog = document.getElementById('mathCheckDialog');
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    initMathLearningCheck();
    document.getElementById('openMathCheck').click();
    document.querySelector('[data-action="setup"]').click();
    document.querySelector('[data-respondent="parent"]').click();
    document.querySelector('[data-grade="중2"]').click();
    document.querySelector('[data-action="questions"]').click();

    document.querySelector('[data-answer="3"]').click();
    document.querySelector('[data-answer="2"]').click();
    await vi.advanceTimersByTimeAsync(130);
    expect(document.querySelector('.hd-progress b').textContent).toContain('2 / 15');
    await vi.advanceTimersByTimeAsync(130);
    expect(document.querySelector('.hd-progress b').textContent).toContain('2 / 15');
    vi.useRealTimers();
  });

  it('supports radiogroup arrow keys with one tabbable option and no forced advance', async () => {
    vi.useFakeTimers();
    const dialog = document.getElementById('mathCheckDialog');
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    initMathLearningCheck();
    document.getElementById('openMathCheck').click();
    document.querySelector('[data-action="setup"]').click();
    document.querySelector('[data-respondent="parent"]').click();
    document.querySelector('[data-grade="중2"]').click();
    document.querySelector('[data-action="questions"]').click();

    const options = [...document.querySelectorAll('[data-answer]')];
    expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1);
    options[0].focus();
    options[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement.dataset.answer).toBe('1');
    expect(document.activeElement.getAttribute('aria-checked')).toBe('true');
    expect([...document.querySelectorAll('[data-answer]')].filter((option) => option.tabIndex === 0)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(130);
    expect(document.querySelector('.hd-progress b').textContent).toContain('1 / 15');
    vi.useRealTimers();
  });
});
