import { describe, expect, it } from 'vitest';
import { buildCampaignUrl } from '../src/marketing/utm.js';

describe('buildCampaignUrl', () => {
  it('네이버 블로그 유입용 UTM 링크를 만든다', () => {
    const result = buildCampaignUrl('https://sequencemath.co.kr/blog/homework-routine-recovery/', {
      source: 'naver',
      medium: 'blog',
      campaign: 'homework-routine-recovery',
      content: 'post',
    });

    expect(result).toBe(
      'https://sequencemath.co.kr/blog/homework-routine-recovery/?utm_source=naver&utm_medium=blog&utm_campaign=homework-routine-recovery&utm_content=post',
    );
  });

  it('기존 query와 hash를 보존한다', () => {
    const result = buildCampaignUrl('https://sequencemath.co.kr/blog/?ref=profile#latest', {
      source: 'instagram',
      medium: 'social',
      campaign: 'blog-launch',
      content: 'profile',
    });

    expect(result).toBe(
      'https://sequencemath.co.kr/blog/?ref=profile&utm_source=instagram&utm_medium=social&utm_campaign=blog-launch&utm_content=profile#latest',
    );
  });

  it('선택한 content가 없으면 utm_content를 생략한다', () => {
    const result = buildCampaignUrl('https://sequencemath.co.kr/blog/', {
      source: 'threads',
      medium: 'social',
      campaign: 'math-confidence',
    });

    expect(result).toBe(
      'https://sequencemath.co.kr/blog/?utm_source=threads&utm_medium=social&utm_campaign=math-confidence',
    );
  });

  it.each([
    ['source', { source: 'facebook', medium: 'social', campaign: 'test' }],
    ['medium', { source: 'instagram', medium: 'email', campaign: 'test' }],
    ['campaign', { source: 'instagram', medium: 'social', campaign: '' }],
  ])('잘못된 %s 값은 거부한다', (_field, options) => {
    expect(() => buildCampaignUrl('https://sequencemath.co.kr/blog/', options)).toThrow();
  });
});
