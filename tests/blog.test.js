import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../vite.config.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const pngSize = (path) => {
  const image = readFileSync(resolve(root, path));
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
};

describe('시퀀스 수학 블로그', () => {
  it('블로그 목록과 첫 글을 Vite 진입점으로 빌드한다', () => {
    const inputs = config.build.rollupOptions.input;
    expect(inputs).toHaveProperty('blog');
    expect(inputs).toHaveProperty('blogChoosingAcademy');
  });

  it('홈페이지의 데스크톱·모바일 메뉴에서 블로그로 이동할 수 있다', () => {
    const homepage = read('index.html');
    expect(homepage.match(/href="\/blog\/"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('블로그 목록에서 첫 교육 칼럼으로 이동할 수 있다', () => {
    const blog = read('blog/index.html');
    expect(blog).toContain('수학교습소 선택 기준');
    expect(blog).toContain('/blog/choosing-math-academy/');
    expect(blog).toContain('https://sequencemath.co.kr/blog/');
  });

  it('첫 글은 독립 canonical과 교육용 구조화 데이터를 제공한다', () => {
    const article = read('blog/choosing-math-academy/index.html');
    expect(article).toContain('https://sequencemath.co.kr/blog/choosing-math-academy/');
    expect(article).toContain('"@type": "BlogPosting"');
    expect(article).toContain('학생에게 맞는 학습 환경');
  });

  it('개원 준비 단계에서 모집성 표현을 쓰지 않는다', () => {
    const pages = [
      read('blog/index.html'),
      read('blog/choosing-math-academy/index.html'),
      read('blog/homework-routine-recovery/index.html'),
    ].join('\n');
    for (const phrase of ['수강생 모집', '상담 예약', '등록 문의', '선착순', '수강료 안내', '지금 신청하세요']) {
      expect(pages).not.toContain(phrase);
    }
  });

  it('사이트맵에 블로그 목록과 첫 글이 포함된다', () => {
    const sitemap = read('public/sitemap.xml');
    expect(sitemap).toContain('https://sequencemath.co.kr/blog/');
    expect(sitemap).toContain('https://sequencemath.co.kr/blog/choosing-math-academy/');
  });

  it('네이버 검색 수집용 RSS에 공개 글 두 개를 제공한다', () => {
    const rss = read('public/rss.xml');
    expect(rss).toContain('<rss version="2.0"');
    expect(rss).toContain('https://sequencemath.co.kr/rss.xml');
    expect(rss).toContain('https://sequencemath.co.kr/blog/choosing-math-academy/');
    expect(rss).toContain('https://sequencemath.co.kr/blog/homework-routine-recovery/');
    expect(rss.match(/<item>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('두 번째 글 숙제 루틴 회복 칼럼을 목록·빌드·사이트맵에 자동 등록한다', () => {
    const inputs = config.build.rollupOptions.input;
    const blog = read('blog/index.html');
    const sitemap = read('public/sitemap.xml');
    const articleUrl = 'https://sequencemath.co.kr/blog/homework-routine-recovery/';
    expect(inputs).toHaveProperty('blogHomeworkRoutine');
    expect(blog).toContain('/blog/homework-routine-recovery/');
    expect(blog).toContain('수학 숙제를 안 하는 아이');
    expect(sitemap).toContain(articleUrl);
    const article = read('blog/homework-routine-recovery/index.html');
    expect(article).toContain(articleUrl);
    expect(article).toContain('필수 과제');
    expect(article).toContain('도전 과제');
    expect(article).toContain('회복 과제');
    expect(article).toContain('2주');
    expect(article).toContain('"@type": "BlogPosting"');
  });

  it('두 글에 1200×630 공유 이미지와 관련 글 이동 경로를 제공한다', () => {
    const academy = read('blog/choosing-math-academy/index.html');
    const homework = read('blog/homework-routine-recovery/index.html');
    expect(academy).toContain('<meta property="og:image" content="https://sequencemath.co.kr/img/blog/choosing-math-academy-og.png"');
    expect(homework).toContain('<meta property="og:image" content="https://sequencemath.co.kr/img/blog/homework-routine-recovery-og.png"');
    expect(academy).toContain('name="twitter:card" content="summary_large_image"');
    expect(homework).toContain('name="twitter:card" content="summary_large_image"');
    expect(academy).toContain('/blog/homework-routine-recovery/');
    expect(homework).toContain('/blog/choosing-math-academy/');
    expect(pngSize('public/img/blog/choosing-math-academy-og.png')).toEqual({ width: 1200, height: 630 });
    expect(pngSize('public/img/blog/homework-routine-recovery-og.png')).toEqual({ width: 1200, height: 630 });
  });
});
