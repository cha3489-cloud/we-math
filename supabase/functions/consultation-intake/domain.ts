export type ConsultationInput = {
  studentName?: unknown;
  parentPhone?: unknown;
  grade?: unknown;
  learningType?: unknown;
  difficulties?: unknown;
  studyHabit?: unknown;
  learningGoal?: unknown;
  message?: unknown;
  contactTimes?: unknown;
  privacyConsent?: unknown;
  website?: unknown;
  submissionId?: unknown;
};

export type ValidatedConsultation = {
  studentName: string;
  parentPhone: string;
  grade: string;
  learningType: string;
  difficulties: string[];
  studyHabit: string;
  learningGoal: string;
  message: string;
  contactTimes: string[];
  privacyConsent: true;
  submissionId: string;
};

const grades = new Set([
  '초등 저학년 (1–3학년)',
  '초등 고학년 (4–6학년)',
  '중학교 1학년',
  '중학교 2학년',
  '중학교 3학년',
  '고등학교 1학년',
  '고등학교 2학년',
  '고등학교 3학년 (수능)',
]);
const difficultyOptions = new Set([
  '개념 이해', '문제 해석', '계산', '풀이 습관',
  '학습 습관', '학습 자신감', '진도 부적응', '기타',
]);
const habitOptions = new Set(['있음', '부분적으로 있음', '없음', '확인 필요']);
const contactOptions = new Set([
  '오전 9시 ~ 12시', '점심시간(12시 ~ 1시)', '오후 1시 ~ 6시',
  '저녁 6시 이후', '주말', '기타',
]);
const learningTypeOptions = new Set([
  '대형학원', '소규모학원', '과외', '인강', '혼자 공부', '기타',
]);

function text(value: unknown, label: string, max: number) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label}을(를) 입력해주세요.`);
  if (normalized.length > max) throw new Error(`${label}이(가) 너무 깁니다.`);
  return normalized;
}

function optionalText(value: unknown, label: string, max: number) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > max) throw new Error(`${label}이(가) 너무 깁니다.`);
  return normalized;
}

function selections(value: unknown, label: string, allowed: Set<string>, required: boolean, max: number) {
  if (!Array.isArray(value)) throw new Error(`${label}을(를) 선택해주세요.`);
  const normalized = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (required && normalized.length === 0) throw new Error(`${label}을(를) 선택해주세요.`);
  if (normalized.length > max || normalized.some((item) => !allowed.has(item))) {
    throw new Error(`${label} 선택값이 올바르지 않습니다.`);
  }
  return normalized;
}

export function validateConsultationInput(input: ConsultationInput): ValidatedConsultation {
  if (String(input.website ?? '').trim()) throw new Error('접수할 수 없습니다.');
  const studentName = text(input.studentName, '학생 이름', 40);
  const parentPhoneInput = String(input.parentPhone ?? '').trim();
  if (!/^[0-9 -]+$/.test(parentPhoneInput)) throw new Error('연락처를 확인해주세요.');
  const parentPhone = parentPhoneInput.replace(/[ -]/g, '');
  if (!/^01[016789][0-9]{7,8}$/.test(parentPhone)) throw new Error('연락처를 확인해주세요.');
  const grade = text(input.grade, '학년', 30);
  if (!grades.has(grade)) throw new Error('학년 선택값이 올바르지 않습니다.');
  const learningType = text(input.learningType, '기존 학습 형태', 100);
  if (!learningTypeOptions.has(learningType)) throw new Error('기존 학습 형태 선택값이 올바르지 않습니다.');
  const difficulties = selections(input.difficulties, '어려움', difficultyOptions, true, 3);
  const studyHabit = text(input.studyHabit, '학습 습관', 30);
  if (!habitOptions.has(studyHabit)) throw new Error('학습 습관 선택값이 올바르지 않습니다.');
  const learningGoal = text(input.learningGoal, '학습 목표', 500);
  const message = optionalText(input.message, '추가 문의', 1000);
  const contactTimes = selections(input.contactTimes ?? [], '연락 가능 시간', contactOptions, false, 3);
  if (input.privacyConsent !== true) throw new Error('개인정보 수집·이용에 동의해주세요.');
  const submissionId = String(input.submissionId ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(submissionId)) {
    throw new Error('접수 식별자가 올바르지 않습니다.');
  }
  return {
    studentName, parentPhone, grade, learningType, difficulties,
    studyHabit, learningGoal, message, contactTimes, privacyConsent: true, submissionId,
  };
}

const richText = (content: string) => content ? [{ text: { content } }] : [];

export const submissionMarker = (submissionId: string) => `[홈페이지 접수 ID: ${submissionId}]`;

export function buildNotionPage(databaseId: string, input: ValidatedConsultation) {
  return {
    parent: { database_id: databaseId },
    properties: {
      '상담 기록명': { title: richText(`홈페이지 · ${input.studentName} · ${input.grade}`) },
      '학생 이름': { rich_text: richText(input.studentName) },
      '학부모 연락처': { phone_number: input.parentPhone },
      '학년': { select: { name: input.grade } },
      '기존 학습 형태': { rich_text: richText(input.learningType) },
      '어려움의 종류': { multi_select: input.difficulties.map((name) => ({ name })) },
      '규칙적 학습 습관': { select: { name: input.studyHabit } },
      '학습 목표': { rich_text: richText(input.learningGoal) },
      '추가 문의': {
        rich_text: richText([input.message, submissionMarker(input.submissionId)].filter(Boolean).join('\n\n')),
      },
      '연락 가능 시간': { multi_select: input.contactTimes.map((name) => ({ name })) },
      '상담 유형': { select: { name: '신규 문의' } },
      '상담 상태': { select: { name: '예정' } },
      '접수 경로': { select: { name: '홈페이지' } },
      '개인정보 동의': { checkbox: true },
    },
  };
}
