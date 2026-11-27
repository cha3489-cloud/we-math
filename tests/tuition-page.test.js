import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('public tuition guide', () => {
  it('publishes all six reported courses with exact schedule, minutes, fees, and no extra charges', () => {
    const html = read('tuition/index.html');
    const required = [
      '교습과정 및 교습비', '제2082호', '2026년 11월 20일',
      '기본관리', '주 3회', '회당 120분', '월 1,620분',
      '집중관리', '평일 주 2회 × 120분', '토요일 주 1회 × 180분', '월 1,890분',
      '초등 수학', '300,000원', '350,000원',
      '중등 수학', '320,000원', '370,000원',
      '고등 수학', '330,000원', '390,000원',
      '기타경비 없음(0원)', '수강하는 과정 기준'
    ];
    for (const text of required) expect(html).toContain(text);
  });

  it('links the guide from the homepage footer and includes it in the production build', () => {
    expect(read('index.html')).toContain('href="/tuition/"');
    expect(read('vite.config.js')).toMatch(/tuition:\s*resolve\([^\n]+tuition\/index[.]html/);
  });

  it('adds the canonical public guide to the sitemap', () => {
    expect(read('public/sitemap.xml')).toContain('<loc>https://sequencemath.co.kr/tuition/</loc>');
  });
});

describe('public tuition guide accuracy and resilience', () => {
  const html = read('tuition/index.html');
  const text = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('pairs each course with its own fee, with no other won amounts on the page', () => {
    const expected = {
      '초등 수학 기본관리': '300,000', '중등 수학 기본관리': '320,000', '고등 수학 기본관리': '330,000',
      '초등 수학 집중관리': '350,000', '중등 수학 집중관리': '370,000', '고등 수학 집중관리': '390,000',
    };
    for (const [course, fee] of Object.entries(expected)) {
      expect(html).toMatch(new RegExp(`<th scope="row">${course}</th><td>월 ${fee}원</td>`));
    }
    expect([...text.matchAll(/[\d,]+원/g)].map((m) => m[0]).sort())
      .toEqual(['0원', '300,000원', '320,000원', '330,000원', '350,000원', '370,000원', '390,000원'].sort());
  });

  it('states only official facts: no unverified refund, absence, or week-count policy', () => {
    for (const unverified of ['4.5주', '환불', '결석', '교재비·', '미리 안내']) expect(text).not.toContain(unverified);
    expect(text).not.toMatch(/재학\s*학년\s*(기준|별)/);
  });

  it('is static, mobile-ready, and canonical without depending on JavaScript', () => {
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
    expect(html).toContain('<link rel="canonical" href="https://sequencemath.co.kr/tuition/" />');
    expect(html).not.toMatch(/<script[^>]+\bsrc=/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(html).toContain('@media (max-width: 700px)');
  });

  it('is reachable from desktop nav, mobile menu, and footer on the homepage', () => {
    const home = read('index.html');
    expect(home.match(/href="\/tuition\/"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('does not touch the cached-asset recovery plugin wiring', () => {
    expect(read('vite.config.js')).toContain('plugins: [homepageAssetResilience()]');
  });
});
