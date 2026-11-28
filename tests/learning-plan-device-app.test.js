import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { mountPlanDevice, PLAN_DEVICE_TOKEN_KEY, PLAN_POLL_MS } from '../src/plan/app.js';
import config from '../vite.config.js';

const root = resolve(import.meta.dirname, '..');
const html = readFileSync(resolve(root, 'plan/index.html'), 'utf8');
const css = readFileSync(resolve(root, 'src/plan/plan.css'), 'utf8');
const mainJs = readFileSync(resolve(root, 'src/plan/main.js'), 'utf8');
const appJs = readFileSync(resolve(root, 'src/plan/app.js'), 'utf8');
const TOKEN = 'a1'.repeat(32);
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

const READY = {
  state: 'ready',
  plan_date: '2099-11-16',
  source_revision: 2,
  items: [
    { item_type: 'homework', title: '<img src=x onerror=alert(1)>숙제 p.30', body: '', teacher_status: 'pending' },
    { item_type: 'redo', title: '단원평가 · 3번', body: '계산·부호 확인', teacher_status: 'confirmed' },
  ],
};

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((k) => (map.has(k) ? map.get(k) : null)),
    setItem: vi.fn((k, v) => map.set(k, String(v))),
    removeItem: vi.fn((k) => map.delete(k)),
    dump: () => Object.fromEntries(map),
  };
}

function setup({ token = TOKEN, readPlan = vi.fn(async () => READY) } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/plan/', pretendToBeVisual: true });
  const { document } = dom.window;
  const storage = memoryStorage(token ? { [PLAN_DEVICE_TOKEN_KEY]: token } : {});
  const timers = [];
  const setIntervalFn = vi.fn((fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; });
  const clearIntervalFn = vi.fn((id) => { if (timers[id - 1]) timers[id - 1].cleared = true; });
  const api = mountPlanDevice(document, { readPlan, storage, setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  const tick = async () => { for (const t of timers.filter((x) => !x.cleared)) t.fn(); await flush(); };
  return { document, storage, readPlan, timers, tick, api, window: dom.window };
}
const $ = (d, id) => d.getElementById(id);
const deferred = () => { let resolveFn; let rejectFn; const promise = new Promise((r, j) => { resolveFn = r; rejectFn = j; }); return { promise, resolve: resolveFn, reject: rejectFn }; };

describe('dedicated learning-plan device page', () => {
  it('starts on the setup screen without a stored token and stores only a valid high-entropy token', async () => {
    const { document, storage, readPlan } = setup({ token: null });
    await flush();
    expect($(document, 'planSetup').hidden).toBe(false);
    expect($(document, 'planView').hidden).toBe(true);
    expect(document.activeElement).toBe($(document, 'planSetupToken'));
    expect(readPlan).not.toHaveBeenCalled();
    $(document, 'planSetupToken').value = '123456'; // an attendance number is never accepted
    $(document, 'planSetupForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    expect($(document, 'planSetupError').textContent).toBe('등록 코드를 다시 확인해 주세요.');
    expect(storage.setItem).not.toHaveBeenCalled();
    $(document, 'planSetupToken').value = `  ${TOKEN.toUpperCase()}  `;
    $(document, 'planSetupForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect(storage.dump()).toEqual({ [PLAN_DEVICE_TOKEN_KEY]: TOKEN });
    expect($(document, 'planSetupToken').value).toBe('');
    expect($(document, 'planSetup').hidden).toBe(true);
    expect(readPlan).toHaveBeenCalledWith(TOKEN);
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
  });

  it('renders the published plan read-only, as text, with no completion controls and no student identity', async () => {
    const { document } = setup();
    await flush();
    expect($(document, 'planView').hidden).toBe(false);
    const items = document.querySelectorAll('#planItems li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('<img src=x onerror=alert(1)>숙제 p.30');
    expect(document.querySelector('#planItems img')).toBeNull();
    expect(items[1].textContent).toContain('계산·부호 확인');
    expect(items[1].textContent).toContain('확인 완료');
    expect(document.querySelectorAll('#planItems button, #planItems input, #planItems a')).toHaveLength(0);
    expect($(document, 'planDate').textContent).toBe('11월 16일 학습 계획');
    expect(document.body.textContent).not.toMatch(/학생 이름|가나다/);
  });

  it('shows calm Korean copy for preparing, no session, and errors without raw backend details', async () => {
    const preparing = setup({ readPlan: vi.fn(async () => ({ state: 'preparing', plan_date: '2099-11-16' })) });
    await flush();
    expect($(preparing.document, 'planStatusTitle').textContent).toBe('오늘 계획을 준비하고 있어요');
    expect(preparing.document.querySelectorAll('#planItems li')).toHaveLength(0);

    const none = setup({ readPlan: vi.fn(async () => ({ state: 'no_session' })) });
    await flush();
    expect($(none.document, 'planStatusTitle').textContent).toBe('아직 연결된 학습이 없어요');
    expect(none.storage.dump()[PLAN_DEVICE_TOKEN_KEY]).toBe(TOKEN); // never reveals whether the token is revoked

    const failing = setup({ readPlan: vi.fn(async () => { throw Object.assign(new Error('PGRST202 public.learning_device_today_plan 7f3e-uuid'), { code: 'PGRST202' }); }) });
    await flush();
    expect($(failing.document, 'planStatusTitle').textContent).toBe('잠시 연결이 원활하지 않아요');
    expect(failing.document.body.textContent).not.toMatch(/PGRST|uuid|learning_device/);

    const weird = setup({ readPlan: vi.fn(async () => ({ state: 'ready', items: 'nope', student_name: '가나다' })) });
    await flush();
    expect(weird.document.querySelectorAll('#planItems li')).toHaveLength(0);
    expect(weird.document.body.textContent).not.toContain('가나다');
  });

  it('polls every 30 seconds and applies only the latest request, suppressing stale results and errors', async () => {
    const calls = [];
    const readPlan = vi.fn(() => { const d = deferred(); calls.push(d); return d.promise; });
    const { document, tick, timers } = setup({ readPlan });
    expect(PLAN_POLL_MS).toBe(30_000);
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([30_000]);
    await tick(); // second request in flight while the first is still pending
    expect(calls).toHaveLength(2);
    calls[1].resolve(READY);
    await flush();
    expect(document.querySelectorAll('#planItems li')).toHaveLength(2);
    calls[0].resolve({ state: 'no_session' }); // stale success
    await flush();
    expect(document.querySelectorAll('#planItems li')).toHaveLength(2);
    await tick();
    await tick();
    calls[3].resolve(READY);
    await flush();
    calls[2].reject(new Error('stale network failure'));
    await flush();
    expect($(document, 'planStatusTitle').textContent).not.toBe('잠시 연결이 원활하지 않아요');
    expect(document.querySelectorAll('#planItems li')).toHaveLength(2);
    // A failure of the latest request keeps the last good plan on screen with a quiet note.
    await tick();
    calls[4].reject(new Error('offline'));
    await flush();
    expect(document.querySelectorAll('#planItems li')).toHaveLength(2);
    expect($(document, 'planNote').textContent).toBe('연결을 다시 확인하고 있어요. 화면의 계획은 마지막으로 받은 내용이에요.');
  });

  it('clears the device: forgets the token, stops polling, ignores in-flight responses, and returns to setup', async () => {
    const calls = [];
    const readPlan = vi.fn(() => { const d = deferred(); calls.push(d); return d.promise; });
    const { document, storage, timers, window } = setup({ readPlan });
    window.confirm = () => true;
    $(document, 'planClearDevice').click();
    expect(storage.dump()).toEqual({});
    expect(timers.every((t) => t.cleared)).toBe(true);
    expect($(document, 'planSetup').hidden).toBe(false);
    calls[0].resolve(READY);
    await flush();
    expect(document.querySelectorAll('#planItems li')).toHaveLength(0);
    expect($(document, 'planView').hidden).toBe(true);
    expect(document.activeElement).toBe($(document, 'planSetupToken'));
  });
});

describe('plan page source contracts', () => {
  it('is a standalone noindex page wired only to the read-only device RPC', () => {
    expect(html).toContain('/src/plan/main.js');
    expect(html).toContain('name=robots content=noindex');
    expect(html).toContain('name=referrer content=no-referrer');
    expect(html).toMatch(/name=viewport content='width=device-width, initial-scale=1/);
    expect(mainJs).toContain("rpc('learning_device_today_plan'");
    expect(mainJs).toContain('persistSession: false');
    expect(mainJs).not.toMatch(/from\(['"]/);
    expect(mainJs + appJs).not.toMatch(/submit_learning_item|student_today_learning_plan|attendance-code|innerHTML/);
    expect(appJs).not.toMatch(/sessionStorage|document\.cookie/);
  });

  it('self-hosts IBM Plex Sans KR and keeps the layout inside a 375px viewport with visible focus', () => {
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*'IBM Plex Sans KR'[^}]*url\('\/portal\/fonts\/ibm-plex-sans-kr-400\.woff2'\)/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\./);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/box-sizing:\s*border-box/);
    expect(css).toMatch(/@media \(max-width: 480px\)/);
    expect(css).toMatch(/:focus-visible/);
    // No fixed widths that would overflow a 375px phone.
    for (const [, px] of css.matchAll(/(?<!max-)(?:min-)?width:\s*(\d+)px/g)) expect(Number(px)).toBeLessThanOrEqual(343);
    expect(css).not.toMatch(/100vw/);
  });

  it('is a Vite entry outside the generated blog blocks and deploys with the Pages workflow', () => {
    expect(config.build.rollupOptions.input.plan).toBe(resolve(root, 'plan/index.html'));
    const source = readFileSync(resolve(root, 'vite.config.js'), 'utf8');
    for (const block of source.match(/generated-vite-input:[^\n]*:start[\s\S]*?generated-vite-input:[^\n]*:end/g) ?? []) expect(block).not.toContain('plan/index.html');
    const pages = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8');
    expect(pages).toMatch(/run: npm run build/);
    expect(pages).not.toMatch(/^\s+paths:/m); // every page, including /plan/, ships with the static build
  });
});
