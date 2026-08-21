import { describe, expect, it } from 'vitest';
import {
  MAX_FILES, MAX_UPLOAD_BYTES, ALLOWED_TYPES, MAX_EDGE,
  sanitizeFileName, buildSubmissionPath, isSubmissionPathValid,
  acceptFiles, resizePlan, submissionErrorMessage, previewModel,
} from '../src/tablet/submission.js';

const STUDENT = '42d621e1-57ed-41ce-9771-c5e11ec55bf8';
const OTHER_STUDENT = 'e42f7cb1-633b-42e6-baa9-ee6a5ac88cc0';
const ASSIGNMENT = '1dbda8dd-64f9-4768-a6d3-407e1d76cc07';
const OTHER_ASSIGNMENT = '53cfd677-f553-4405-9de9-e4af3aa8a7d3';
const UID = '11111111-2222-4333-8444-555555555555';

const file = (overrides = {}) => ({ name: 'photo.jpg', type: 'image/jpeg', size: 1024, ...overrides });

describe('submission file limits', () => {
  it('accepts up to three photos', () => {
    const { accepted, rejected } = acceptFiles(0, [file(), file(), file()]);
    expect(accepted).toHaveLength(MAX_FILES);
    expect(rejected).toHaveLength(0);
  });

  it('rejects the fourth photo and explains why', () => {
    const { accepted, rejected } = acceptFiles(0, [file(), file(), file(), file({ name: 'four.jpg' })]);
    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('count');
    expect(rejected[0].message).toContain('최대 3장');
  });

  it('counts photos already picked when deciding how many more fit', () => {
    const { accepted, rejected } = acceptFiles(2, [file(), file()]);
    expect(accepted).toHaveLength(1);
    expect(rejected[0].reason).toBe('count');
  });

  it('allows only image types the bucket accepts', () => {
    expect(ALLOWED_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    const { accepted, rejected } = acceptFiles(0, [
      file({ type: 'image/png' }),
      file({ name: 'note.pdf', type: 'application/pdf' }),
      file({ name: 'clip.mp4', type: 'video/mp4' }),
      file({ name: 'unknown', type: '' }),
    ]);
    expect(accepted.map((item) => item.type)).toEqual(['image/png']);
    expect(rejected.map((item) => item.reason)).toEqual(['type', 'type', 'type']);
    expect(rejected[0].message).toContain('사진 파일만');
  });

  it('refuses an original larger than the bucket limit instead of uploading it', () => {
    const { accepted, rejected } = acceptFiles(0, [file({ size: MAX_UPLOAD_BYTES + 1 })]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe('size');
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('keeps a file that sits exactly on the limit', () => {
    expect(acceptFiles(0, [file({ size: MAX_UPLOAD_BYTES })]).accepted).toHaveLength(1);
  });
});

describe('resize plan before upload', () => {
  it('shrinks a tablet-sized photo down to the long-edge limit', () => {
    const plan = resizePlan({ width: 4032, height: 3024, size: 6 * 1024 * 1024 });
    expect(plan.resize).toBe(true);
    expect(Math.max(plan.width, plan.height)).toBe(MAX_EDGE);
    // 비율이 유지되어야 한다
    expect(plan.width / plan.height).toBeCloseTo(4032 / 3024, 2);
  });

  it('leaves a small light photo alone', () => {
    expect(resizePlan({ width: 1200, height: 900, size: 400 * 1024 }).resize).toBe(false);
  });

  it('still shrinks a small but heavy photo', () => {
    expect(resizePlan({ width: 1200, height: 900, size: 5 * 1024 * 1024 }).resize).toBe(true);
  });

  it('does nothing when dimensions are unknown', () => {
    for (const metrics of [null, undefined, {}, { width: 0, height: 0 }]) {
      expect(resizePlan(metrics).resize).toBe(false);
    }
  });

  it('handles a portrait photo the same way', () => {
    const plan = resizePlan({ width: 3024, height: 4032, size: 6 * 1024 * 1024 });
    expect(Math.max(plan.width, plan.height)).toBe(MAX_EDGE);
    expect(plan.height).toBeGreaterThan(plan.width);
  });
});

describe('storage path rule', () => {
  // 서버 규칙: Storage 정책은 경로 첫 칸을 auth.uid(), 둘째 칸을 본인 과제 id 로 요구하고
  // prepare_submission_attempt() 는 ^{uid}/{assignment_id}/[^/]+$ 를 다시 검사한다.
  it('builds the path the server trigger expects', () => {
    const path = buildSubmissionPath(STUDENT, ASSIGNMENT, 'photo.jpg', UID);
    expect(path).toBe(STUDENT + '/' + ASSIGNMENT + '/' + UID + '-photo.jpg');
    expect(isSubmissionPathValid(path, STUDENT, ASSIGNMENT)).toBe(true);
    expect(path.split('/')).toHaveLength(3);
  });

  it('never produces a path under another student or another assignment', () => {
    const path = buildSubmissionPath(STUDENT, ASSIGNMENT, 'photo.jpg', UID);
    expect(path.startsWith(STUDENT + '/')).toBe(true);
    expect(path).not.toContain(OTHER_STUDENT);
    expect(path).not.toContain(OTHER_ASSIGNMENT);
    expect(isSubmissionPathValid(path, OTHER_STUDENT, ASSIGNMENT)).toBe(false);
    expect(isSubmissionPathValid(path, STUDENT, OTHER_ASSIGNMENT)).toBe(false);
  });

  it('cannot be escaped by a crafted file name', () => {
    for (const name of [
      '../../' + OTHER_STUDENT + '/evil.jpg',
      'a/b/c.jpg',
      '..%2F..%2Fevil.jpg',
      '/absolute.jpg',
      '....//evil.jpg',
    ]) {
      const path = buildSubmissionPath(STUDENT, ASSIGNMENT, name, UID);
      const [owner, assignment, ...rest] = path.split('/');
      // 다른 학생의 uuid 가 파일명 안에 남는 것은 무해하다. 중요한 것은
      // 소유자 칸과 과제 칸이 절대 바뀌지 않고, 구분자가 더 생기지 않는 것이다.
      expect(owner).toBe(STUDENT);
      expect(assignment).toBe(ASSIGNMENT);
      expect(rest).toHaveLength(1);
      expect(isSubmissionPathValid(path, STUDENT, ASSIGNMENT)).toBe(true);
      expect(isSubmissionPathValid(path, OTHER_STUDENT, ASSIGNMENT)).toBe(false);
    }
  });

  it('refuses to build a path from a non-uuid owner or assignment', () => {
    expect(() => buildSubmissionPath('not-a-uuid', ASSIGNMENT, 'a.jpg', UID)).toThrow();
    expect(() => buildSubmissionPath(STUDENT, 'not-a-uuid', 'a.jpg', UID)).toThrow();
    expect(() => buildSubmissionPath(null, ASSIGNMENT, 'a.jpg', UID)).toThrow();
    expect(() => buildSubmissionPath(STUDENT, ASSIGNMENT, 'a.jpg', '')).toThrow();
  });

  it('keeps file names within the character set the server regex allows', () => {
    // 사·진·공백·'(' 네 글자가 각각 _ 로 바뀌고, 1 과 ).JPG 중 ')' 만 다시 _ 가 된다
    expect(sanitizeFileName('사진 (1).JPG')).toBe('____1_.JPG');
    expect(sanitizeFileName('..hidden')).toBe('hidden');
    expect(sanitizeFileName('')).toBe('photo.jpg');
    expect(sanitizeFileName('a'.repeat(200))).toHaveLength(80);
    expect(sanitizeFileName('x/y')).not.toContain('/');
  });
});

describe('submission error messages', () => {
  const messageFor = (error, stage) => submissionErrorMessage(error, stage);

  it('explains a dropped network connection', () => {
    expect(messageFor(new TypeError('Failed to fetch'))).toContain('인터넷 연결');
  });

  it('explains an upload rejected for size', () => {
    expect(messageFor({ status: 413, message: 'Payload too large' }, 'upload')).toContain('용량이 너무 커요');
  });

  it('explains an upload rejected for type', () => {
    expect(messageFor({ message: 'invalid_mime_type' }, 'upload')).toContain('사진 파일만');
  });

  it('explains an RLS refusal without exposing policy details', () => {
    const message = messageFor({ code: '42501', message: 'new row violates row-level security policy' }, 'insert');
    expect(message).toContain('선생님께 문의');
    expect(message).not.toContain('row-level');
    expect(message).not.toContain('42501');
  });

  it('explains the server refusing a second submission while under review', () => {
    expect(messageFor({ message: 'latest attempt is not open for revision' }, 'insert'))
      .toContain('선생님 확인이 끝난 뒤');
  });

  it('explains the server file-count guard', () => {
    expect(messageFor({ message: 'too many submission files' }, 'insert')).toContain('최대 3장');
  });

  it('explains an assignment ownership refusal', () => {
    expect(messageFor({ message: 'assignment not owned' }, 'insert')).toContain('내 과제가 아니에요');
  });

  it('falls back to a stage-specific message for anything unexpected', () => {
    expect(messageFor({ message: 'boom' }, 'upload')).toContain('사진을 올리지 못했어요');
    expect(messageFor({ message: 'boom' }, 'insert')).toContain('제출을 저장하지 못했어요');
    expect(messageFor(null)).toContain('제출에 실패했어요');
  });

  it('never leaks a raw server string to the student', () => {
    const raw = 'permission denied for table submissions';
    expect(messageFor({ message: raw }, 'insert')).not.toContain(raw);
  });
});

describe('preview view model', () => {
  const entry = (warnings = []) => ({ url: 'blob:x', warnings });

  it('describes an empty picker', () => {
    const model = previewModel([]);
    expect(model.count).toBe(0);
    expect(model.canSubmit).toBe(false);
    expect(model.canAddMore).toBe(true);
    expect(model.remaining).toBe(MAX_FILES);
    expect(model.pickLabel).toBe('사진 찍기 · 고르기');
  });

  it('counts what is picked and how much room is left', () => {
    const model = previewModel([entry(), entry()]);
    expect(model.count).toBe(2);
    expect(model.remaining).toBe(1);
    expect(model.canSubmit).toBe(true);
    expect(model.pickLabel).toContain('2/3');
  });

  it('closes the picker once three photos are chosen', () => {
    const model = previewModel([entry(), entry(), entry()]);
    expect(model.canAddMore).toBe(false);
    expect(model.remaining).toBe(0);
  });

  it('passes quality warnings through as advice, not as a block', () => {
    const model = previewModel([entry([{ code: 'blurry', message: '사진이 흐릿하게 보여요.' }])]);
    expect(model.items[0].warnings).toEqual(['사진이 흐릿하게 보여요.']);
    // 경고가 있어도 제출은 가능해야 한다
    expect(model.canSubmit).toBe(true);
  });

  it('labels each photo for screen readers', () => {
    expect(previewModel([entry(), entry()]).items.map((item) => item.label))
      .toEqual(['선택한 사진 1', '선택한 사진 2']);
  });
});
