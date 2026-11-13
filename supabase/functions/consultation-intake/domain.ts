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
      '처리 단계': { select: { name: '신규 접수' } },
      '접수 경로': { select: { name: '홈페이지' } },
      '개인정보 동의': { checkbox: true },
    },
  };
}

export type HabitDiagnosticInput = {
  kind?: unknown;
  questionnaireVersion?: unknown;
  respondent?: unknown;
  grade?: unknown;
  studentName?: unknown;
  parentPhone?: unknown;
  answers?: unknown;
  privacyConsent?: unknown;
  marketingConsent?: unknown;
  guardianConsent?: unknown;
  website?: unknown;
  submissionId?: unknown;
};

export type ValidatedHabitDiagnostic = {
  kind: 'habit-diagnostic';
  questionnaireVersion: 'habit-v1' | 'habit-v2' | 'habit-v3';
  respondent: 'parent' | 'student';
  grade: string;
  studentName: string;
  parentPhone: string;
  answers: Array<number | 'u'>;
  privacyConsent: true;
  marketingConsent: boolean;
  guardianConsent: boolean;
  submissionId: string;
};

const habitGrades = new Set(['초4', '초5', '초6', '중1', '중2', '중3', '고1', '고2', '고3']);
const under14Grades = new Set(['초4', '초5', '초6', '중1']);
const reverseQuestionIndexes = new Set([2, 5, 8, 10, 14]);
const habitDomainKeys = ['concept', 'repeat', 'wrong', 'self', 'routine'] as const;
const habitDomainLabels = {
  concept: '개념 이해', repeat: '반복·복습', wrong: '오답 관리', self: '스스로 푸는 힘', routine: '학습 루틴',
};
const notionGrade: Record<string, string> = {
  초4: '초등 고학년 (4–6학년)', 초5: '초등 고학년 (4–6학년)', 초6: '초등 고학년 (4–6학년)',
  중1: '중학교 1학년', 중2: '중학교 2학년', 중3: '중학교 3학년',
  고1: '고등학교 1학년', 고2: '고등학교 2학년', 고3: '고등학교 3학년 (수능)',
};

export function evaluateHabitDiagnostic(answers: Array<number | 'u'>) {
  const raw = { concept: 0, repeat: 0, wrong: 0, self: 0, routine: 0 };
  let unknown = 0;
  answers.forEach((answer, index) => {
    let score = answer === 'u' ? 1 : answer;
    if (answer === 'u') unknown += 1;
    else if (reverseQuestionIndexes.has(index)) score = 3 - score;
    raw[habitDomainKeys[Math.floor(index / 3)]] += score;
  });
  const percent = Object.fromEntries(
    habitDomainKeys.map((key) => [key, Math.round(raw[key] / 9 * 100)]),
  ) as Record<(typeof habitDomainKeys)[number], number>;
  const total = Math.round(Object.values(raw).reduce((sum, value) => sum + value, 0) / 45 * 100);
  const level = total >= 80 ? { step: 4, name: '반복 설계형' }
    : total >= 60 ? { step: 3, name: '성장 대기형' }
    : total >= 40 ? { step: 2, name: '노력 누수형' }
    : { step: 1, name: '루틴 재설계형' };
  const sorted = [...habitDomainKeys].sort((a, b) => percent[a] - percent[b]);
  const weak = sorted.filter((key) => percent[key] < 75).slice(0, 2);
  if (!weak.length) weak.push(sorted[0]);
  return { raw, percent, total, level, weak, unknown };
}

export function validateHabitDiagnosticInput(input: HabitDiagnosticInput): ValidatedHabitDiagnostic {
  if (String(input.website ?? '').trim()) throw new Error('접수할 수 없습니다.');
  if (input.kind !== 'habit-diagnostic') throw new Error('접수 유형이 올바르지 않습니다.');
  const questionnaireVersion = input.questionnaireVersion ?? 'habit-v1';
  if (questionnaireVersion !== 'habit-v1' && questionnaireVersion !== 'habit-v2' && questionnaireVersion !== 'habit-v3') {
    throw new Error('문항 버전이 올바르지 않습니다.');
  }
  if (input.respondent !== 'parent' && input.respondent !== 'student') throw new Error('응답자를 선택해주세요.');
  const grade = text(input.grade, '학년', 10);
  if (!habitGrades.has(grade)) throw new Error('학년 선택값이 올바르지 않습니다.');
  const studentName = text(input.studentName, '학생 이름', 40);
  const parentPhoneInput = String(input.parentPhone ?? '').trim();
  if (!/^[0-9 -]+$/.test(parentPhoneInput)) throw new Error('연락처를 확인해주세요.');
  const parentPhone = parentPhoneInput.replace(/[ -]/g, '');
  if (!/^01[016789][0-9]{7,8}$/.test(parentPhone)) throw new Error('연락처를 확인해주세요.');
  if (!Array.isArray(input.answers) || input.answers.length !== 15) throw new Error('15개 질문에 모두 응답해주세요.');
  if (input.answers.some((answer) => answer !== 'u'
    && (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer > 3))) {
    throw new Error('진단 응답이 올바르지 않습니다.');
  }
  const answers = input.answers as Array<number | 'u'>;
  if (input.respondent === 'student' && answers.includes('u')) throw new Error('학생 응답에는 잘 모르겠어요를 선택할 수 없습니다.');
  if (input.privacyConsent !== true) throw new Error('개인정보 수집·이용에 동의해주세요.');
  if (input.respondent === 'student' && under14Grades.has(grade) && input.guardianConsent !== true) {
    throw new Error('만 14세 미만 학생은 법정대리인 동의가 필요합니다.');
  }
  const submissionId = String(input.submissionId ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(submissionId)) {
    throw new Error('접수 식별자가 올바르지 않습니다.');
  }
  return {
    kind: 'habit-diagnostic', questionnaireVersion, respondent: input.respondent, grade, studentName, parentPhone,
    answers, privacyConsent: true, marketingConsent: input.marketingConsent === true,
    guardianConsent: input.guardianConsent === true, submissionId,
  };
}

export function buildHabitDiagnosticNotionPage(databaseId: string, input: ValidatedHabitDiagnostic) {
  const result = evaluateHabitDiagnostic(input.answers);
  const scoreLine = habitDomainKeys.map((key) => `${habitDomainLabels[key]} ${result.percent[key]}`).join(' · ');
  const answerLine = input.answers.map((answer) => answer === 'u' ? '?' : String(answer + 1)).join(',');
  const weakLabels = result.weak.map((key) => habitDomainLabels[key]).join(', ');
  const detail = [
    `[수학 공부 습관 진단] ${result.level.step}단계 ${result.level.name} · 종합 ${result.total}점`,
    `문항 버전: ${input.questionnaireVersion}`,
    `응답자: ${input.respondent === 'parent' ? '학부모' : '학생'} · 실제 학년: ${input.grade}`,
    `영역별: ${scoreLine}`,
    `우선 확인: ${weakLabels}`,
    `잘 모르겠어요: ${result.unknown}개 · 마케팅 동의: ${input.marketingConsent ? 'Y' : 'N'} · 법정대리인 동의: ${input.guardianConsent ? 'Y' : 'N'}`,
    `응답: ${answerLine}`,
    submissionMarker(input.submissionId),
  ].join('\n');
  const difficultyMap = { concept: '개념 이해', repeat: '학습 습관', wrong: '풀이 습관', self: '풀이 습관', routine: '학습 습관' };
  const difficulties = [...new Set(result.weak.map((key) => difficultyMap[key]))];
  const habit = result.total >= 80 ? '있음' : result.total >= 60 ? '부분적으로 있음' : '없음';
  return {
    parent: { database_id: databaseId },
    properties: {
      '상담 기록명': { title: richText(`습관진단 · ${input.studentName} · ${input.grade}`) },
      '학생 이름': { rich_text: richText(input.studentName) },
      '학부모 연락처': { phone_number: input.parentPhone },
      '학년': { select: { name: notionGrade[input.grade] } },
      '기존 학습 형태': { rich_text: richText('수학 공부 습관 진단') },
      '어려움의 종류': { multi_select: difficulties.map((name) => ({ name })) },
      '규칙적 학습 습관': { select: { name: habit } },
      '학습 목표': { rich_text: richText('수학 공부 습관 진단 결과를 바탕으로 상담 희망') },
      '추가 문의': { rich_text: richText(detail) },
      '연락 가능 시간': { multi_select: [] },
      '상담 유형': { select: { name: '신규 문의' } },
      '상담 상태': { select: { name: '예정' } },
      '처리 단계': { select: { name: '신규 접수' } },
      '접수 경로': { select: { name: '홈페이지' } },
      '개인정보 동의': { checkbox: true },
    },
  };
}
