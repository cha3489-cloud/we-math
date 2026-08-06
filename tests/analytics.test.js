import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureInitialAttribution, initAnalytics } from '../src/analytics.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const storage = () => {
  const values = new Map();
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  };
};

const browser = (href = 'https://sequencemath.co.kr/') => {
  const appended = [];
  const documentObj = {
    createElement: vi.fn(() => ({ dataset: {} })),
    querySelector: vi.fn(() => null),
    head: { append: vi.fn((element) => appended.push(element)) },
  };
  const windowObj = { location: { href }, sessionStorage: storage() };
  return { windowObj, documentObj, appended };
};

describe('방문 유입 분석', () => {
  it('최초 UTM 유입값을 세션에 보존한다', () => {
    const sessionStorage = storage();
    const result = captureInitialAttribution({
      href: 'https://sequencemath.co.kr/blog/?utm_source=naver&utm_medium=blog&utm_campaign=homework-routine&ref=post',
      storage: sessionStorage,
    });

    expect(result).toEqual({
      utm_source: 'naver',
      utm_medium: 'blog',
      utm_campaign: 'homework-routine',
    });
    expect(sessionStorage.setItem).toHaveBeenCalledOnce();
  });

  it('이미 저장된 최초 유입값을 덮어쓰지 않는다', () => {
    const sessionStorage = storage();
    sessionStorage.setItem('sequence_initial_attribution', JSON.stringify({ utm_source: 'instagram' }));

    expect(captureInitialAttribution({
      href: 'https://sequencemath.co.kr/?utm_source=naver',
      storage: sessionStorage,
    })).toEqual({ utm_source: 'instagram' });
  });

  it('측정 ID가 없으면 외부 분석 스크립트를 로드하지 않는다', () => {
    const context = browser();
    expect(initAnalytics({ measurementId: '', ...context })).toBe(false);
    expect(context.documentObj.head.append).not.toHaveBeenCalled();
  });

  it('유효한 측정 ID가 있을 때만 GA4를 초기화한다', () => {
    const context = browser('https://sequencemath.co.kr/?utm_source=instagram&utm_medium=social&utm_campaign=blog-launch');
    expect(initAnalytics({ measurementId: 'G-ABC1234567', ...context })).toBe(true);
    expect(context.appended).toHaveLength(1);
    expect(context.appended[0].src).toContain('G-ABC1234567');
    expect(context.windowObj.dataLayer).toHaveLength(2);
  });

  it('개인 포털을 제외한 공개 페이지가 분석 모듈을 불러온다', () => {
    for (const page of [
      'index.html',
      'blog/index.html',
      'blog/choosing-math-academy/index.html',
      'blog/homework-routine-recovery/index.html',
      'consultation/index.html',
    ]) {
      expect(read(page), page).toContain('<script type="module" src="/src/analytics.js"></script>');
    }
  });

  it('운영 기본값으로 GA4 측정 ID를 제공한다', () => {
    expect(read('src/analytics.js')).toContain("const DEFAULT_MEASUREMENT_ID = 'G-BXMYNFJFZ8'");
  });
});
