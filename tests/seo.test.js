import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('검색엔진 소유권과 크롤링', () => {
  it('Google Search Console 소유권 인증 코드를 제공한다', () => {
    const homepage = read('index.html');
    expect(homepage).toContain(
      '<meta name="google-site-verification" content="jFqvcGrjnuEDrPYh2Sz7RuwU8RBDBuG9AoWlAAK_G9g" />',
    );
    expect(homepage).not.toContain('GOOGLE_VERIFICATION_CODE');
  });

  it('robots.txt가 공개 사이트맵을 안내한다', () => {
    expect(read('public/robots.txt')).toContain('Sitemap: https://sequencemath.co.kr/sitemap.xml');
  });
});
