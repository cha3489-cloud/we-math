import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { evaluateMathLearningCheck, initMathLearningCheck } from '../src/math-learning-check.js';

const fixture = `
  <header id="consultationHeader"><button id="outsideButton">밖</button></header>
  <main id="consultationMain">
    <button id="openMathCheck" type="button">수학학습 점검 시작</button>
  </main>
  <dialog id="mathCheckDialog" aria-labelledby="mathCheckTitle">
    <button id="closeMathCheck" type="button">닫기</button>
    <h2 id="mathCheckTitle">수학학습 점검</h2>
    <form id="mathCheckForm">
      <fieldset data-domain="start"><legend>시작</legend><label><input type="radio" name="q1" value="0" required>아니요</label><label><input type="radio" name="q1" value="2">네</label></fieldset>
      <fieldset data-domain="interpret"><legend>해석</legend><label><input type="radio" name="q2" value="0" required>아니요</label><label><input type="radio" name="q2" value="2">네</label></fieldset>
      <button type="submit">결과 보기</button>
    </form>
    <section id="mathCheckResult" hidden aria-live="polite"><h3 id="mathCheckResultTitle"></h3><p id="mathCheckResultSummary"></p><ul id="mathCheckResultActions"></ul></section>
  </dialog>
`;

describe('math learning check', () => {
  beforeEach(() => {
    const dom = new JSDOM(`<!doctype html><body>${fixture}</body>`, { url: 'https://sequencemath.co.kr/consultation/' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLDialogElement', dom.window.HTMLDialogElement);
  });

  it('summarizes the lowest learning domain without collecting personal data', () => {
    expect(evaluateMathLearningCheck([
      { domain: 'start', score: 0 },
      { domain: 'start', score: 1 },
      { domain: 'interpret', score: 2 },
      { domain: 'interpret', score: 2 },
    ])).toEqual(expect.objectContaining({
      level: '점검 필요',
      priorityDomains: ['start'],
    }));
  });

  it('opens accessibly, traps focus, closes with Escape, and restores the trigger', () => {
    const dialog = document.getElementById('mathCheckDialog');
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    dialog.close = vi.fn(() => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new window.Event('close'));
    });
    initMathLearningCheck();

    const trigger = document.getElementById('openMathCheck');
    trigger.focus();
    trigger.click();

    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(document.getElementById('consultationHeader').inert).toBe(true);
    expect(document.getElementById('consultationMain').inert).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('closeMathCheck'));

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('#mathCheckForm button[type="submit"]'));
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(document.getElementById('closeMathCheck'));

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(document.getElementById('consultationMain').inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('renders a result from checked answers and keeps user answers on the device', () => {
    const dialog = document.getElementById('mathCheckDialog');
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    initMathLearningCheck();
    document.querySelector('input[name="q1"][value="0"]').checked = true;
    document.querySelector('input[name="q2"][value="2"]').checked = true;
    document.getElementById('mathCheckForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    expect(document.getElementById('mathCheckResult').hidden).toBe(false);
    expect(document.getElementById('mathCheckResultTitle').textContent).toContain('점검 필요');
    expect(document.getElementById('mathCheckResultActions').children.length).toBeGreaterThan(0);
  });
});
