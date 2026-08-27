import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWER_FILES, MAX_ANSWER_FILE_BYTES, ALLOWED_ANSWER_TYPES,
  sanitizeAnswerFileName, buildAnswerFilePath, isAnswerFilePathValid,
  acceptAnswerImages, answerImagesPreviewModel, canSubmitAnswer, answerErrorMessage,
} from '../src/portal/answer-attachments.js';

const QUESTION_ID = '11111111-2222-3333-4444-555555555555';

describe('sanitizeAnswerFileName', () => {
  it('strips characters the server path regex would reject', () => {
    // 한글 4자 + 공백 1자 = 밑줄 5개. 나머지는 허용 문자라 그대로 남는다.
    expect(sanitizeAnswerFileName('스크린샷 2026-08-25.png')).toBe('_____2026-08-25.png');
  });

  it('falls back to a default name when nothing is left', () => {
    expect(sanitizeAnswerFileName('')).toBe('image.jpg');
    expect(sanitizeAnswerFileName(undefined)).toBe('image.jpg');
  });

  it('caps length so extremely long names do not break the path', () => {
    expect(sanitizeAnswerFileName('a'.repeat(200) + '.png')).toHaveLength(80);
  });
});

describe('buildAnswerFilePath — {question_id}/{uuid}-{safe_filename}', () => {
  it('builds the path in the required shape', () => {
    const path = buildAnswerFilePath(QUESTION_ID, 'shot.png', 'aaaa1111-bbbb-2222-cccc-333344445555');
    expect(path).toBe(QUESTION_ID + '/aaaa1111-bbbb-2222-cccc-333344445555-shot.png');
  });

  it('rejects a question id that is not a uuid', () => {
    expect(() => buildAnswerFilePath('not-a-uuid', 'shot.png', 'x')).toThrow();
  });

  it('rejects a missing unique id', () => {
    expect(() => buildAnswerFilePath(QUESTION_ID, 'shot.png', '')).toThrow();
  });

  it('sanitizes the file name inside the path', () => {
    // 슬래시를 없애 경로 탈출을 막는 것이 핵심이다. 살아남는 점(.) 자체는
    // 구분자가 아니라 무해하다 — 서버 정규식도 [^/]+ 로 슬래시만 금지한다.
    const path = buildAnswerFilePath(QUESTION_ID, '../../etc/passwd', 'unique');
    const [, fileNamePart] = path.split(QUESTION_ID + '/');
    expect(fileNamePart).not.toContain('/');
    expect(path.split('/')).toHaveLength(2);
  });
});

describe('isAnswerFilePathValid', () => {
  it('accepts a path that starts with the question id and has one more segment', () => {
    expect(isAnswerFilePathValid(QUESTION_ID + '/unique-shot.png', QUESTION_ID)).toBe(true);
  });

  it('rejects a path for a different question', () => {
    expect(isAnswerFilePathValid('99999999-9999-9999-9999-999999999999/x.png', QUESTION_ID)).toBe(false);
  });

  it('rejects a path with an extra path segment', () => {
    expect(isAnswerFilePathValid(QUESTION_ID + '/sub/x.png', QUESTION_ID)).toBe(false);
  });

  it('rejects a bare question id with no file name segment', () => {
    expect(isAnswerFilePathValid(QUESTION_ID, QUESTION_ID)).toBe(false);
    expect(isAnswerFilePathValid(QUESTION_ID + '/', QUESTION_ID)).toBe(false);
  });
});

describe('acceptAnswerImages — 이미지 파일만, 최대 3장, 파일당 10MB', () => {
  it('accepts allowed image types', () => {
    for (const type of ALLOWED_ANSWER_TYPES) {
      const { accepted, rejected } = acceptAnswerImages(0, [{ name: 'a', type, size: 1000 }]);
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    }
  });

  it('rejects non-image files', () => {
    const { accepted, rejected } = acceptAnswerImages(0, [{ name: 'a.pdf', type: 'application/pdf', size: 1000 }]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe('type');
  });

  it('rejects files over the per-file limit', () => {
    expect(MAX_ANSWER_FILE_BYTES).toBe(10 * 1024 * 1024);
    const { accepted, rejected } = acceptAnswerImages(0, [
      { name: 'big.png', type: 'image/png', size: MAX_ANSWER_FILE_BYTES + 1 },
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe('size');
  });

  it('accepts a file exactly at the limit', () => {
    const { accepted } = acceptAnswerImages(0, [
      { name: 'edge.png', type: 'image/png', size: MAX_ANSWER_FILE_BYTES },
    ]);
    expect(accepted).toHaveLength(1);
  });

  it('caps the total at three, counting what is already selected', () => {
    expect(MAX_ANSWER_FILES).toBe(3);
    const files = [
      { name: 'a.png', type: 'image/png', size: 100 },
      { name: 'b.png', type: 'image/png', size: 100 },
    ];
    const { accepted, rejected } = acceptAnswerImages(2, files);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('count');
  });

  it('rejects everything once already at three', () => {
    const { accepted, rejected } = acceptAnswerImages(3, [{ name: 'a.png', type: 'image/png', size: 100 }]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe('count');
  });
});

describe('answerImagesPreviewModel — 미리보기', () => {
  it('builds one preview entry per selected file, with the picker label counting up', () => {
    const selected = [{ url: 'blob:a' }, { url: 'blob:b' }];
    const model = answerImagesPreviewModel(selected);
    expect(model.count).toBe(2);
    expect(model.items).toHaveLength(2);
    expect(model.items[0].url).toBe('blob:a');
    expect(model.pickLabel).toContain('2/3');
    expect(model.canAddMore).toBe(true);
  });

  it('reports no room left at the cap', () => {
    const model = answerImagesPreviewModel([{ url: 'a' }, { url: 'b' }, { url: 'c' }]);
    expect(model.canAddMore).toBe(false);
    expect(model.remaining).toBe(0);
  });

  it('shows a plain picker label with nothing selected', () => {
    expect(answerImagesPreviewModel([]).pickLabel).toBe('이미지 첨부');
  });
});

describe('canSubmitAnswer — 답변 본문 필수, 첨부만으로는 불가', () => {
  it('requires a non-empty body regardless of attachments', () => {
    expect(canSubmitAnswer('')).toBe(false);
    expect(canSubmitAnswer('   ')).toBe(false);
    expect(canSubmitAnswer('이렇게 풀어보세요.')).toBe(true);
  });
});

describe('answerErrorMessage', () => {
  it('explains the three-attachment cap', () => {
    expect(answerErrorMessage(new Error('too many answer files'))).toMatch(/최대 3장/);
  });

  it('explains a missing or invalid attachment', () => {
    expect(answerErrorMessage(new Error('invalid answer file'))).toMatch(/다시 첨부/);
    expect(answerErrorMessage(new Error('answer file missing'))).toMatch(/다시 첨부/);
  });

  it('explains an empty answer', () => {
    expect(answerErrorMessage(new Error('empty answer'))).toMatch(/답변 내용을 입력/);
  });

  it('explains permission failures without technical detail', () => {
    expect(answerErrorMessage({ code: '42501', message: 'permission denied' })).toMatch(/권한이 없어요/);
    expect(answerErrorMessage(new Error('admin required'))).toMatch(/관리자 권한/);
  });

  it('explains a network failure', () => {
    expect(answerErrorMessage({ name: 'TypeError', message: 'Failed to fetch' })).toMatch(/인터넷 연결/);
  });

  it('falls back to a generic retry message', () => {
    expect(answerErrorMessage(new Error('unexpected'))).toMatch(/다시 시도/);
  });
});
