import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildHabitDiagnosticNotionPage,
  evaluateHabitDiagnostic,
  validateHabitDiagnosticInput,
} from '../supabase/functions/consultation-intake/domain.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const validInput = {
  kind: 'habit-diagnostic',
  questionnaireVersion: 'habit-v2',
  respondent: 'parent',
  grade: '중2',
  studentName: ' 김학생 ',
  parentPhone: '010-1234-5678',
  answers: [3, 3, 0, 2, 2, 1, 3, 2, 0, 2, 1, 2, 3, 2, 0],
  privacyConsent: true,
  marketingConsent: false,
  guardianConsent: false,
  website: '',
  submissionId: '4f61bbcc-577d-4da8-a96c-0f83d50331d6',
};

describe('15-question habit diagnostic intake', () => {
  it('scores five domains and reverses negative questions on the server', () => {
    const result = evaluateHabitDiagnostic(validInput.answers);
    expect(result.raw).toEqual({ concept: 9, repeat: 6, wrong: 8, self: 6, routine: 8 });
    expect(result.percent).toEqual({ concept: 100, repeat: 67, wrong: 89, self: 67, routine: 89 });
    expect(result.total).toBe(82);
    expect(result.level).toEqual({ step: 4, name: '반복 설계형' });
    expect(result.weak).toEqual(['repeat', 'self']);
  });

  it('validates identity, consent, the exact answer count and answer allowlist', () => {
    expect(validateHabitDiagnosticInput(validInput)).toMatchObject({
      kind: 'habit-diagnostic', questionnaireVersion: 'habit-v2', respondent: 'parent', grade: '중2',
      studentName: '김학생', parentPhone: '01012345678',
      answers: validInput.answers, privacyConsent: true,
    });
    expect(() => validateHabitDiagnosticInput({ ...validInput, answers: [1, 2] })).toThrow('15개');
    expect(() => validateHabitDiagnosticInput({ ...validInput, answers: [...validInput.answers.slice(0, 14), 4] })).toThrow('응답');
    for (const invalid of [null, true, false, '', '2', {}, []]) {
      expect(() => validateHabitDiagnosticInput({ ...validInput, answers: Array(15).fill(invalid) })).toThrow('응답');
    }
    expect(() => validateHabitDiagnosticInput({ ...validInput, privacyConsent: false })).toThrow('개인정보');
    expect(() => validateHabitDiagnosticInput({ ...validInput, respondent: 'unknown' })).toThrow('응답자');
    expect(validateHabitDiagnosticInput({ ...validInput, questionnaireVersion: undefined }).questionnaireVersion).toBe('habit-v1');
    expect(() => validateHabitDiagnosticInput({ ...validInput, questionnaireVersion: 'habit-v3' })).toThrow('문항 버전');
  });

  it('scores unknown answers neutrally even on reverse questions', () => {
    const result = evaluateHabitDiagnostic(Array(15).fill('u'));
    expect(result.raw).toEqual({ concept: 3, repeat: 3, wrong: 3, self: 3, routine: 3 });
    expect(result.total).toBe(33);
    expect(result.unknown).toBe(15);
  });

  it('requires guardian consent for an under-14 student response', () => {
    const under14 = {
      ...validInput,
      respondent: 'student',
      grade: '초4',
      guardianConsent: false,
      answers: Array(15).fill(2),
    };
    expect(() => validateHabitDiagnosticInput(under14)).toThrow('법정대리인');
    expect(validateHabitDiagnosticInput({ ...under14, guardianConsent: true }).guardianConsent).toBe(true);
  });

  it('maps the result and all answers into the existing Notion consultation database', () => {
    const input = validateHabitDiagnosticInput(validInput);
    const page = buildHabitDiagnosticNotionPage('db-id', input);
    const detail = page.properties['추가 문의'].rich_text[0].text.content;
    expect(page.parent).toEqual({ database_id: 'db-id' });
    expect(page.properties['상담 기록명'].title[0].text.content).toContain('습관진단');
    expect(page.properties['학생 이름'].rich_text[0].text.content).toBe('김학생');
    expect(page.properties['학년'].select.name).toBe('중학교 2학년');
    expect(page.properties['접수 경로'].select.name).toBe('홈페이지');
    expect(detail).toContain('반복 설계형');
    expect(detail).toContain('문항 버전: habit-v2');
    expect(detail).toContain('반복·복습 67');
    expect(detail).toContain('응답: 4,4,1,3,3,2,4,3,1,3,2,3,4,3,1');
    expect(detail).toContain(validInput.submissionId);
  });

  it('replaces the old 8-question local-only widget with a 15-question saved diagnostic', () => {
    const html = read('consultation/index.html');
    const source = read('src/math-learning-check.js');
    expect(html).toContain('id="habitDiagnosticWidget"');
    expect(html).toContain('15개 질문');
    expect(html).not.toContain('답변은 전송되거나 저장되지 않습니다');
    expect(source).toContain('HABIT_QUESTIONS');
    expect(source).toContain("kind: 'habit-diagnostic'");
    expect(source).toContain("supabase.functions.invoke('consultation-intake'");
    expect(source).toContain('privacyConsent:');
    expect(source).toContain('sessionStorage');
  });
});
