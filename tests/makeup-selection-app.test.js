import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { mountMakeupSelection, readTokenFromHash } from '../src/makeup/app.js';

const root = resolve(import.meta.dirname, '..');
const html = readFileSync(resolve(root, 'makeup/index.html'), 'utf8');
const TOKEN = 'c'.repeat(64);
const options = [
  { id: 'o1', starts_at: '2099-11-17T07:00:00Z', ends_at: '2099-11-17T08:00:00Z', sort_order: 1, available: true },
  { id: 'o2', starts_at: '2099-11-18T07:00:00Z', ends_at: '2099-11-18T08:00:00Z', sort_order: 2, available: true },
  { id: 'o3', starts_at: '2099-11-19T07:00:00Z', ends_at: '2099-11-19T08:00:00Z', sort_order: 3, available: true },
];
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

function setup({ view = { result: 'open', student_label: '가○○', expires_at: '2099-11-16T14:59:59.999Z', options }, select = async () => ({ result: 'selected', starts_at: options[1].starts_at, ends_at: options[1].ends_at }) } = {}) {
  const dom = new JSDOM(html, { url: `https://example.test/makeup/#t=${TOKEN}` });
  const { document } = dom.window;
  const replaceState = vi.fn();
  const api = { view: vi.fn(async () => view), select: vi.fn(select) };
  mountMakeupSelection(document, { hash: dom.window.location.hash, replaceState, api });
  return { document, api, replaceState };
}
const $ = (d, id) => d.getElementById(id);

describe('parent makeup selection page', () => {
  it('reads the token only from the URL fragment and removes it from the address bar', async () => {
    expect(readTokenFromHash('#t=' + TOKEN)).toBe(TOKEN);
    expect(readTokenFromHash('#t=short')).toBe(null);
    expect(readTokenFromHash('')).toBe(null);
    const { api, replaceState } = setup();
    await flush();
    expect(api.view).toHaveBeenCalledWith(TOKEN);
    expect(replaceState).toHaveBeenCalled();
  });

  it('offers exactly the three server-provided choices as radio buttons with no free-text schedule entry', async () => {
    const { document } = setup();
    await flush();
    const radios = document.querySelectorAll('#makeupOptions input[type=radio]');
    expect(radios).toHaveLength(3);
    expect(document.querySelectorAll('#makeupForm textarea, #makeupForm input[type=text], #makeupForm input[type=date]')).toHaveLength(0);
    expect($(document, 'makeupOptions').textContent).toContain('11월 17일');
    expect($(document, 'makeupOptions').textContent).toContain('16:00');
    expect($(document, 'makeupDeadline').textContent).toBe('선택 기한: 11월 16일 23:59까지');
  });

  it('confirms only after the server accepts the selection', async () => {
    const { document, api } = setup();
    await flush();
    document.querySelector('#makeupOptions input[value=o2]').checked = true;
    $(document, 'makeupForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    $(document, 'makeupForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect(api.select).toHaveBeenCalledTimes(1);
    expect(api.select).toHaveBeenCalledWith(TOKEN, 'o2');
    expect($(document, 'makeupStatus').textContent).toBe('11월 18일 16:00 선택이 접수되었습니다. 결석 확인 후 보강 일정이 확정됩니다.');
    expect($(document, 'makeupForm').hidden).toBe(true);
  });

  it('uses confirmed wording only after the server says the makeup plan is finalized', async () => {
    const selected = options[1];
    const { document } = setup({ view: { result: 'selected', finalized: true, selected } });
    await flush();
    expect($(document, 'makeupStatus').textContent).toBe('11월 18일 16:00 보강으로 확정되었습니다.');
    expect($(document, 'makeupForm').hidden).toBe(true);
  });

  it('re-presents remaining choices when the chosen seat filled up meanwhile', async () => {
    const remaining = options.map((o) => (o.id === 'o1' ? { ...o, available: false } : o));
    const { document } = setup({ select: async () => ({ result: 'full', options: remaining }) });
    await flush();
    document.querySelector('#makeupOptions input[value=o1]').checked = true;
    $(document, 'makeupForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
    await flush();
    expect($(document, 'makeupStatus').textContent).toBe('방금 선택한 시간은 마감되었습니다. 다른 시간을 선택해 주세요.');
    expect(document.querySelector('#makeupOptions input[value=o1]').disabled).toBe(true);
    expect($(document, 'makeupForm').hidden).toBe(false);
  });

  it('shows an expired or invalid link without any selectable option', async () => {
    const expired = setup({ view: { result: 'expired' } });
    await flush();
    expect($(expired.document, 'makeupStatus').textContent).toBe('선택기한이 종료되었습니다. 학원으로 연락해 주세요.');
    expect(expired.document.querySelectorAll('#makeupOptions input')).toHaveLength(0);
    expect($(expired.document, 'makeupForm').hidden).toBe(true);
    const invalid = setup({ view: { result: 'not_found' } });
    await flush();
    expect($(invalid.document, 'makeupStatus').textContent).toBe('유효하지 않은 링크입니다.');
  });

  it('is a separate public page wired only to the narrow selection RPCs', () => {
    const main = readFileSync(resolve(root, 'src/makeup/main.js'), 'utf8');
    expect(main).toContain("rpc('makeup_offer_view'");
    expect(main).toContain("rpc('makeup_offer_select'");
    expect(main).not.toMatch(/from\(['"]/);
    expect(html).toContain('/src/makeup/main.js');
    expect(html).toContain('name=robots content=noindex');
  });
});

describe('makeup page Korean webfont', () => {
  const css = readFileSync(resolve(root, 'src/makeup/makeup.css'), 'utf8');
  it('self-hosts IBM Plex Sans KR 400/500/600/700 from the existing portal fonts and inherits it in controls', () => {
    for (const weight of [400, 500, 600, 700]) {
      expect(css).toMatch(new RegExp(`@font-face\\s*{[^}]*font-family:\\s*'IBM Plex Sans KR'[^}]*font-weight:\\s*${weight};[^}]*url\\('/portal/fonts/ibm-plex-sans-kr-${weight}\\.woff2'\\) format\\('woff2'\\)`));
      expect(readFileSync(resolve(root, `public/portal/fonts/ibm-plex-sans-kr-${weight}.woff2`)).length).toBeGreaterThan(0);
    }
    expect(css).toMatch(/body\.makeup-app\s*{[^}]*font-family:\s*'IBM Plex Sans KR', system-ui, sans-serif/);
    expect(css).not.toContain('Pretendard');
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\./);
    expect(css).toContain('.makeup button, .makeup input { font-family: inherit; }');
  });
});
