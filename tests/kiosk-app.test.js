import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { mountKiosk } from '../src/kiosk/app.js';

const TOKEN = 'ab'.repeat(32);
const root = resolve(import.meta.dirname, '..');
const html = readFileSync(resolve(root, 'kiosk/index.html'), 'utf8');
const css = readFileSync(resolve(root, 'src/kiosk/kiosk.css'), 'utf8');

function setup({ token = TOKEN, response = { result: 'checked_in', status: 'present', student_label: '가○○', at: '2026-11-16T07:00:00Z' } } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { document } = dom.window;
  const storage = new Map(token ? [['sequence.kiosk.deviceToken', token]] : []);
  const store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const calls = [];
  let resolveCall;
  const callKiosk = vi.fn((tokenArg, action, code) => {
    calls.push([tokenArg, action, code]);
    return typeof response === 'function' ? response() : Promise.resolve(response);
  });
  vi.useFakeTimers();
  const kiosk = mountKiosk(document, { callKiosk, storage: store, resetMs: 12_000 });
  return { dom, document, calls, callKiosk, kiosk, storage, resolveCall };
}
const $ = (document, id) => document.getElementById(id);
const press = (document, key) => document.querySelector(`[data-key="${key}"]`).click();

describe('entrance kiosk', () => {
  it('self-hosts a Korean-capable font for shared academy tablets', () => {
    expect(css).toContain("font-family: 'IBM Plex Sans KR'");
    expect(css).toContain('/portal/fonts/ibm-plex-sans-kr-400.woff2');
    expect(css).toContain('/portal/fonts/ibm-plex-sans-kr-700.woff2');
    expect(css).toContain('.kiosk button, .kiosk input { font-family: inherit; }');
  });

  it('starts with explicit 등원하기/하원하기 choices and shows the keypad only after a choice', () => {
    const { document } = setup();
    expect($(document, 'kioskChoice').hidden).toBe(false);
    expect($(document, 'kioskKeypadPanel').hidden).toBe(true);
    expect($(document, 'kioskCheckIn').textContent).toContain('등원하기');
    expect($(document, 'kioskCheckOut').textContent).toContain('하원하기');
    $(document, 'kioskCheckOut').click();
    expect($(document, 'kioskKeypadPanel').hidden).toBe(false);
    expect($(document, 'kioskModeTitle').textContent).toBe('하원 · 6자리 번호를 눌러주세요');
    expect(document.activeElement).toBe($(document, 'kioskCodeDisplay'));
    vi.useRealTimers();
  });

  it('masks entered digits, accepts only six, supports physical keys, and enables confirm at six digits', () => {
    const { document } = setup();
    $(document, 'kioskCheckIn').click();
    for (const key of ['1', '2', '3']) press(document, key);
    expect($(document, 'kioskCodeDisplay').textContent).toBe('●●●○○○');
    expect($(document, 'kioskSubmit').disabled).toBe(true);
    const KeyboardEvent = document.defaultView.KeyboardEvent;
    for (const key of ['4', '5', '6', '7']) document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    expect($(document, 'kioskCodeDisplay').textContent).toBe('●●●●●●');
    expect($(document, 'kioskSubmit').disabled).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect($(document, 'kioskCodeDisplay').textContent).toBe('●●●●●○');
    expect($(document, 'kioskCodeDisplay').textContent).not.toMatch(/\d/);
    expect($(document, 'kioskCodeDisplay').getAttribute('aria-label')).toBe('6자리 중 5자리 입력');
    vi.useRealTimers();
  });

  it('submits once, shows minimal masked confirmation via textContent, then resets automatically', async () => {
    const { document, calls } = setup({ response: { result: 'checked_in', status: 'late', student_label: '<img src=x>', at: '2026-11-16T07:05:00Z' } });
    $(document, 'kioskCheckIn').click();
    for (const key of '482913') press(document, key);
    $(document, 'kioskSubmit').click();
    $(document, 'kioskSubmit').click();
    await vi.runAllTicks();
    await Promise.resolve();
    expect(calls).toEqual([[TOKEN, 'check_in', '482913']]);
    expect($(document, 'kioskResult').hidden).toBe(false);
    expect($(document, 'kioskResultTitle').textContent).toBe('<img src=x> 학생');
    expect(document.querySelector('#kioskResult img')).toBeNull();
    expect($(document, 'kioskResultDetail').textContent).toBe('16:05 등원 확인 · 지각');
    expect(document.body.textContent).not.toContain('482913');
    vi.advanceTimersByTime(12_000);
    expect($(document, 'kioskChoice').hidden).toBe(false);
    expect($(document, 'kioskResult').hidden).toBe(true);
    expect($(document, 'kioskCodeDisplay').textContent).toBe('○○○○○○');
    expect(document.activeElement).toBe($(document, 'kioskCheckIn'));
    vi.useRealTimers();
  });

  it('returns to the choice screen with Escape and restores focus to the chosen action', () => {
    const { document } = setup();
    $(document, 'kioskCheckOut').click();
    press(document, '1');
    document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($(document, 'kioskChoice').hidden).toBe(false);
    expect(document.activeElement).toBe($(document, 'kioskCheckOut'));
    $(document, 'kioskCheckOut').click();
    expect($(document, 'kioskCodeDisplay').textContent).toBe('○○○○○○');
    vi.useRealTimers();
  });

  it('shows a staff-help message on network failure without caching anything offline', async () => {
    const { document, storage } = setup({ response: () => Promise.reject(new Error('Failed to fetch')) });
    $(document, 'kioskCheckIn').click();
    for (const key of '111222') press(document, key);
    $(document, 'kioskSubmit').click();
    await Promise.resolve(); await Promise.resolve();
    expect($(document, 'kioskResultTitle').textContent).toBe('연결이 원활하지 않습니다');
    expect($(document, 'kioskResultDetail').textContent).toBe('선생님께 말하면 직접 출결을 처리해 드립니다.');
    expect([...storage.keys()]).toEqual(['sequence.kiosk.deviceToken']);
    vi.useRealTimers();
  });

  it('requires one-time device setup when no registered token is stored and forgets a rejected token', async () => {
    const { document, storage, calls } = setup({ token: null, response: { result: 'device_not_registered' } });
    expect($(document, 'kioskSetup').hidden).toBe(false);
    expect($(document, 'kioskChoice').hidden).toBe(true);
    $(document, 'kioskSetupToken').value = '  a'.padEnd(66, 'b') + '  ';
    $(document, 'kioskSetupForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    expect(storage.get('sequence.kiosk.deviceToken')).toBe('a'.padEnd(64, 'b'));
    expect($(document, 'kioskChoice').hidden).toBe(false);
    $(document, 'kioskCheckIn').click();
    for (const key of '111222') press(document, key);
    $(document, 'kioskSubmit').click();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect($(document, 'kioskResultTitle').textContent).toBe('등록되지 않은 출석 기기입니다');
    expect(storage.has('sequence.kiosk.deviceToken')).toBe(false);
    vi.useRealTimers();
  });

  it('is a separate page from the learning tablet login and never mentions PIN entry for attendance', () => {
    expect(html).toContain('/src/kiosk/main.js');
    expect(html).not.toContain('loginForm');
    const tablet = readFileSync(resolve(root, 'tablet/index.html'), 'utf8');
    expect(tablet).toContain('id=loginForm');
    expect(tablet).not.toContain('kiosk');
    expect(readFileSync(resolve(root, 'vite.config.js'), 'utf8')).toContain("kiosk: resolve(import.meta.dirname, 'kiosk/index.html')");
  });
});

describe('entrance kiosk stale responses', () => {
  function deferredSetup() {
    const pending = [];
    const ctx = setup({ response: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    return { ...ctx, pending };
  }
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  const enter = (document, action, code) => {
    $(document, action).click();
    for (const key of code) press(document, key);
    $(document, 'kioskSubmit').click();
  };

  it('ignores a late success after the user returns to the choice screen', async () => {
    const { document, pending, storage } = deferredSetup();
    enter(document, 'kioskCheckIn', '482913');
    expect(pending).toHaveLength(1);
    $(document, 'kioskBack').click();
    expect($(document, 'kioskChoice').hidden).toBe(false);
    const focusedBefore = document.activeElement;
    pending[0].resolve({ result: 'checked_in', status: 'present', student_label: '가○○', at: '2026-11-16T07:00:00Z' });
    await flush();
    expect($(document, 'kioskChoice').hidden).toBe(false);
    expect($(document, 'kioskResult').hidden).toBe(true);
    expect($(document, 'kioskResultTitle').textContent).toBe('');
    expect(document.body.textContent).not.toContain('가○○');
    expect(document.activeElement).toBe(focusedBefore);
    vi.advanceTimersByTime(12_000);
    expect($(document, 'kioskChoice').hidden).toBe(false);
    expect([...storage.keys()]).toEqual(['sequence.kiosk.deviceToken']);
    vi.useRealTimers();
  });

  it('ignores a late failure or device rejection after Escape and keeps the stored token', async () => {
    const { document, pending, storage } = deferredSetup();
    enter(document, 'kioskCheckOut', '111222');
    document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    pending[0].reject(new Error('Failed to fetch'));
    await flush();
    expect($(document, 'kioskResult').hidden).toBe(true);
    expect($(document, 'kioskResultTitle').textContent).toBe('');
    enter(document, 'kioskCheckOut', '111222');
    $(document, 'kioskBack').click();
    pending[1].resolve({ result: 'device_not_registered' });
    await flush();
    expect($(document, 'kioskResult').hidden).toBe(true);
    expect(storage.has('sequence.kiosk.deviceToken')).toBe(true);
    vi.useRealTimers();
  });

  it('does not let a stale response unlock or overwrite a newer in-flight submission', async () => {
    const { document, pending } = deferredSetup();
    enter(document, 'kioskCheckIn', '482913');
    $(document, 'kioskBack').click();
    enter(document, 'kioskCheckIn', '135791');
    expect(pending).toHaveLength(2);
    pending[0].resolve({ result: 'checked_in', status: 'present', student_label: '가○○', at: '2026-11-16T07:00:00Z' });
    await flush();
    expect($(document, 'kioskResult').hidden).toBe(true);
    press(document, '1');
    expect($(document, 'kioskCodeDisplay').textContent).toBe('○○○○○○');
    pending[1].resolve({ result: 'checked_in', status: 'present', student_label: '나○○', at: '2026-11-16T07:01:00Z' });
    await flush();
    expect($(document, 'kioskResult').hidden).toBe(false);
    expect($(document, 'kioskResultTitle').textContent).toBe('나○○ 학생');
    expect(document.body.textContent).not.toContain('가○○');
    vi.useRealTimers();
  });
});
