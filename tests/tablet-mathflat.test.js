import { describe, expect, it } from 'vitest';
import { parseAssignmentDescription } from '../src/tablet/view-model.js';

const BLOCK = [
  '[매쓰플랫]',
  '단원: 일차방정식 활용',
  '범위: 프린트 3번 ~ 18번',
  '안내: 매쓰플랫에서 먼저 풀고, 틀린 문제 풀이 과정을 사진으로 제출하세요.',
  '[/매쓰플랫]',
].join('\n');

const labels = (result) => result.mathflat.fields.map((field) => field.label);
const valueOf = (result, label) => result.mathflat.fields.find((field) => field.label === label)?.value;

describe('mathflat block parsing', () => {
  it('pulls the labelled lines out of a well-formed block', () => {
    const result = parseAssignmentDescription(BLOCK);
    expect(labels(result)).toEqual(['단원', '범위', '안내']);
    expect(valueOf(result, '단원')).toBe('일차방정식 활용');
    expect(valueOf(result, '범위')).toBe('프린트 3번 ~ 18번');
    expect(result.mathflat.closed).toBe(true);
  });

  it('removes the block from the plain description so nothing shows twice', () => {
    const result = parseAssignmentDescription('앞 안내입니다.\n\n' + BLOCK + '\n\n뒤 안내입니다.');
    expect(result.description).toBe('앞 안내입니다.\n\n뒤 안내입니다.');
    expect(result.description).not.toContain('매쓰플랫');
    expect(result.description).not.toContain('일차방정식');
    expect(valueOf(result, '단원')).toBe('일차방정식 활용');
  });

  it('leaves a description without the block completely untouched', () => {
    const plain = '유형서 104쪽부터 107쪽까지 풀어오세요.';
    const result = parseAssignmentDescription(plain);
    expect(result.mathflat).toBeNull();
    expect(result.description).toBe(plain);
  });

  it('handles an empty or missing description', () => {
    for (const value of ['', null, undefined, '   ']) {
      const result = parseAssignmentDescription(value);
      expect(result.mathflat).toBeNull();
      expect(result.description).toBe('');
    }
  });
});

describe('mathflat block with broken formatting', () => {
  it('still reads the block when the closing tag is missing', () => {
    const result = parseAssignmentDescription('[매쓰플랫]\n단원: 이차함수\n범위: 12~30번');
    expect(valueOf(result, '단원')).toBe('이차함수');
    expect(result.mathflat.closed).toBe(false);
    // 여는 태그가 설명에 그대로 남으면 안 된다.
    expect(result.description).toBe('');
  });

  it('never leaks a stray marker into the description', () => {
    for (const source of [
      '설명입니다.\n[/매쓰플랫]',
      '[매쓰플랫]설명입니다.',
      '[매쓰플랫][/매쓰플랫]설명입니다.',
      '앞\n[매쓰플랫]\n단원: A\n[/매쓰플랫]\n[매쓰플랫]\n단원: B\n[/매쓰플랫]',
    ]) {
      const result = parseAssignmentDescription(source);
      expect(result.description).not.toContain('[매쓰플랫]');
      expect(result.description).not.toContain('[/매쓰플랫]');
    }
  });

  it('returns no card when the block is empty rather than rendering a blank one', () => {
    for (const source of ['[매쓰플랫][/매쓰플랫]', '[매쓰플랫]\n\n[/매쓰플랫]', '[매쓰플랫]   [/매쓰플랫]']) {
      expect(parseAssignmentDescription(source).mathflat).toBeNull();
    }
  });

  it('keeps unlabelled lines as free notes instead of dropping them', () => {
    const result = parseAssignmentDescription('[매쓰플랫]\n단원: 확률\n오늘 안에 꼭 풀어주세요.\n[/매쓰플랫]');
    expect(valueOf(result, '단원')).toBe('확률');
    expect(result.mathflat.notes).toEqual(['오늘 안에 꼭 풀어주세요.']);
  });

  it('accepts the full-width colon that a Korean keyboard produces', () => {
    const result = parseAssignmentDescription('[매쓰플랫]\n단원： 삼각비\n[/매쓰플랫]');
    expect(valueOf(result, '단원')).toBe('삼각비');
  });

  it('does not treat a long sentence with a colon as a label', () => {
    const result = parseAssignmentDescription('[매쓰플랫]\n오늘은 이렇게 풀어보세요 그리고 확인하세요: 끝까지\n[/매쓰플랫]');
    expect(result.mathflat.fields).toEqual([]);
    expect(result.mathflat.notes).toHaveLength(1);
  });
});
