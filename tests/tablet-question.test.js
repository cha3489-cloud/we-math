import { describe, expect, it } from 'vitest';
import {
  QUESTION_CATEGORIES, MAX_QUESTION_BODY_LENGTH, RECENT_QUESTIONS_LIMIT,
  normalizeQuestionBody, canSubmitQuestion, questionFormModel,
  questionInsertPayload, questionErrorMessage, recentQuestionsModel,
} from '../src/tablet/question.js';

describe('question categories', () => {
  it('matches the server check constraint exactly', () => {
    // supabase/migrations/20260823000000_student_questions.sql 의 questions_category_check 와
    // 문자 하나까지 같아야 한다. 다르면 서버가 category 를 거부한다.
    expect(QUESTION_CATEGORIES).toEqual([
      '문제를 읽고 뭘 해야 할지 모르겠어요',
      '식을 어떻게 세울지 모르겠어요',
      '계산하다가 막혔어요',
      '개념이 기억나지 않아요',
      '풀이 중간에서 막혔어요',
      '기타',
    ]);
  });
});

describe('normalizeQuestionBody', () => {
  it('trims whitespace', () => {
    expect(normalizeQuestionBody('   질문이에요   ')).toBe('질문이에요');
  });

  it('caps length at the server limit', () => {
    expect(MAX_QUESTION_BODY_LENGTH).toBe(1000);
    const long = 'a'.repeat(1200);
    expect(normalizeQuestionBody(long)).toHaveLength(1000);
  });

  it('treats missing input as an empty string', () => {
    expect(normalizeQuestionBody(undefined)).toBe('');
    expect(normalizeQuestionBody(null)).toBe('');
  });
});

describe('canSubmitQuestion — 빈 질문 제출 방지', () => {
  it('requires both a valid category and a non-empty body', () => {
    // questions 테이블은 category, body 모두 not null 이고 body 는 빈 문자열도
    // check 제약으로 막는다. 그래서 하나만 있어도 되는 경로는 만들지 않는다.
    expect(canSubmitQuestion(null, '내용')).toBe(false);
    expect(canSubmitQuestion('기타', '')).toBe(false);
    expect(canSubmitQuestion('기타', '   ')).toBe(false);
    expect(canSubmitQuestion('아무거나', '내용')).toBe(false); // allowlist 밖
    expect(canSubmitQuestion('기타', '내용')).toBe(true);
  });

  it('rejects category-only submission even though body has a value in the model', () => {
    for (const category of QUESTION_CATEGORIES) {
      expect(canSubmitQuestion(category, '')).toBe(false);
    }
  });
});

describe('questionFormModel', () => {
  it('marks the chosen category as selected and the rest as not', () => {
    const model = questionFormModel('계산하다가 막혔어요', '');
    const selected = model.categories.filter((option) => option.selected);
    expect(selected).toEqual([{ tag: '계산하다가 막혔어요', selected: true }]);
    expect(model.categories).toHaveLength(QUESTION_CATEGORIES.length);
  });

  it('reflects canSubmit for the submit button state', () => {
    expect(questionFormModel(null, '').canSubmit).toBe(false);
    expect(questionFormModel('기타', '').canSubmit).toBe(false);
    expect(questionFormModel('기타', '질문').canSubmit).toBe(true);
  });

  it('reports remaining characters against the server limit', () => {
    const model = questionFormModel('기타', '12345');
    expect(model.bodyLength).toBe(5);
    expect(model.remaining).toBe(MAX_QUESTION_BODY_LENGTH - 5);
  });
});

describe('questionInsertPayload — insert 컬럼', () => {
  const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
  const ASSIGNMENT_ID = '22222222-2222-2222-2222-222222222222';

  it('sends only student_id, assignment_id, category, body', () => {
    const payload = questionInsertPayload({
      studentId: STUDENT_ID,
      assignmentId: ASSIGNMENT_ID,
      category: '기타',
      body: '  질문 내용  ',
    });
    expect(Object.keys(payload).sort()).toEqual(['assignment_id', 'body', 'category', 'student_id']);
    expect(payload.student_id).toBe(STUDENT_ID);
    expect(payload.assignment_id).toBe(ASSIGNMENT_ID);
    expect(payload.category).toBe('기타');
    expect(payload.body).toBe('질문 내용');
  });

  it('never includes status or answer fields the server must decide', () => {
    const payload = questionInsertPayload({
      studentId: STUDENT_ID, assignmentId: ASSIGNMENT_ID, category: '기타', body: '내용',
    });
    for (const forbidden of ['status', 'answered_at', 'answered_by', 'answer_body', 'closed_at', 'created_at', 'id']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it('does not invent a student or assignment id — it only carries what it is given', () => {
    // 화면에서 임의로 다른 학생/과제 id 를 생성하지 않는다는 것을 보장한다.
    const payload = questionInsertPayload({
      studentId: STUDENT_ID, assignmentId: ASSIGNMENT_ID, category: '기타', body: '내용',
    });
    expect(payload.student_id).toBe(STUDENT_ID);
    expect(payload.assignment_id).toBe(ASSIGNMENT_ID);
  });

  it('uses the current assignment id passed in, not a hardcoded or blank one', () => {
    const payload = questionInsertPayload({
      studentId: STUDENT_ID, assignmentId: ASSIGNMENT_ID, category: '기타', body: '내용',
    });
    expect(payload.assignment_id).toBeTruthy();
    expect(payload.assignment_id).toBe(ASSIGNMENT_ID);
  });
});

describe('questionErrorMessage — 실패 메시지', () => {
  it('explains the open question cap', () => {
    expect(questionErrorMessage(new Error('too many open questions')))
      .toMatch(/답변을 기다리는 질문이 많아요/);
  });

  it('explains RLS / permission rejection without technical detail', () => {
    expect(questionErrorMessage({ code: '42501', message: 'permission denied' }))
      .toMatch(/지금은 질문을 남길 수 없어요/);
    expect(questionErrorMessage({ status: 403, message: 'row-level security' }))
      .toMatch(/지금은 질문을 남길 수 없어요/);
  });

  it('explains a network failure', () => {
    expect(questionErrorMessage({ name: 'TypeError', message: 'Failed to fetch' }))
      .toMatch(/인터넷 연결이 끊긴 것 같아요/);
  });

  it('falls back to a generic retry message for anything else', () => {
    expect(questionErrorMessage(new Error('unexpected'))).toMatch(/질문을 남기지 못했어요/);
  });
});

describe('recentQuestionsModel — 과도한 이력 노출 방지', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    category: '기타',
    body: '질문 ' + index,
    status: 'open',
    answer_body: null,
  }));

  it('never shows more than the recent limit', () => {
    expect(RECENT_QUESTIONS_LIMIT).toBeLessThanOrEqual(3);
    expect(recentQuestionsModel(rows)).toHaveLength(RECENT_QUESTIONS_LIMIT);
  });

  it('only attaches an answer body when the question was actually answered', () => {
    const answered = recentQuestionsModel([
      { id: 'a', category: '기타', body: 'q', status: 'answered', answer_body: '이렇게 풀어보세요.' },
    ]);
    expect(answered[0].answerBody).toBe('이렇게 풀어보세요.');

    const open = recentQuestionsModel([
      { id: 'b', category: '기타', body: 'q', status: 'open', answer_body: null },
    ]);
    expect(open[0].answerBody).toBe('');
  });
});
