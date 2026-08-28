// 적용 경로: src/tablet/question.js
// 사진 없이 남기는 질문의 판단 로직만 모은 순수 함수 모듈. DOM·네트워크 의존이 없어
// 단위 테스트로 검증한다. 실제 insert 와 목록 조회는 main.js 가 맡는다.
//
// 서버 제약(supabase/migrations/20260823000000_student_questions.sql)과 반드시 같은 목록을 쓴다.
//   category: not null + check 제약 6종 중 하나
//   body:     not null + btrim 후 빈 문자열 금지 + 1000자 이하
// 두 값 모두 서버가 NOT NULL 로 강제하므로 "category 만으로 질문을 남기는" 경로는 없다.
// body 도 마찬가지라 "category 또는 body 중 하나만 있으면 된다"는 조건은 스키마와
// 맞지 않는다. 그래서 화면도 둘 다 요구한다(문서 24 참고).

export const QUESTION_CATEGORIES = [
  '문제를 읽고 뭘 해야 할지 모르겠어요',
  '식을 어떻게 세울지 모르겠어요',
  '계산하다가 막혔어요',
  '개념이 기억나지 않아요',
  '풀이 중간에서 막혔어요',
  '기타',
];

export const MAX_QUESTION_BODY_LENGTH = 1000;

export function normalizeQuestionBody(body) {
  return String(body ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_QUESTION_BODY_LENGTH);
}

export function canSubmitQuestion(category, body) {
  return QUESTION_CATEGORIES.includes(category) && normalizeQuestionBody(body) !== '';
}

// 질문 작성 영역 표시용 모델.
export function questionFormModel(category, body) {
  const clean = normalizeQuestionBody(body);
  return {
    categories: QUESTION_CATEGORIES.map((tag) => ({ tag, selected: tag === category })),
    bodyLength: clean.length,
    remaining: MAX_QUESTION_BODY_LENGTH - clean.length,
    canSubmit: canSubmitQuestion(category, body),
  };
}

// insert 컬럼은 여기서 최종 확정한다. status / answered_at / answered_by / answer_body 처럼
// 서버가 정하는 값은 절대 포함하지 않는다.
export function questionInsertPayload({ studentId, assignmentId, category, body }) {
  return {
    student_id: studentId,
    assignment_id: assignmentId,
    category,
    body: normalizeQuestionBody(body),
  };
}

// 서버가 돌려주는 오류를 학생이 읽을 수 있는 말로 바꾼다.
export function questionErrorMessage(error) {
  const raw = String(error?.message ?? error ?? '');
  const code = String(error?.code ?? '');
  const status = Number(error?.status ?? error?.statusCode ?? 0);

  if (error?.name === 'TypeError' || /failed to fetch|networkerror|network request failed/i.test(raw)) {
    return '인터넷 연결이 끊긴 것 같아요. 연결을 확인하고 다시 시도해 주세요.';
  }
  if (/too many open questions/i.test(raw)) {
    return '아직 답변을 기다리는 질문이 많아요. 선생님 답변을 먼저 기다려 주세요.';
  }
  if (code === '42501' || status === 403 || /row-level security|permission denied|violates row-level/i.test(raw)) {
    return '지금은 질문을 남길 수 없어요. 선생님께 문의해 주세요.';
  }
  if (/assignment not owned|invalid student/i.test(raw)) {
    return '내 과제가 아니에요. 화면을 새로고침해 주세요.';
  }
  if (/empty question/i.test(raw)) {
    return '질문 내용을 입력해 주세요.';
  }
  return '질문을 남기지 못했어요. 잠시 후 다시 시도해 주세요.';
}

// ── 질문 전에 확인하는 관련 자료 ─────────────────────────────────────────
// 학생이 "어떤 문항에 대한 질문인지" 스스로 확인하고 쓰도록 돕는 블록.
// 보여줄 수 있는 것은 이 학생이 이미 볼 권한을 가진 것뿐이다:
//   - 과제 제목·매쓰플랫 안내 (이미 상세 화면에 있는 정보)
//   - 자기가 낸 제출 사진 (Storage 정책 "submission files readable by owner")
// 매쓰플랫 원문 문제 이미지는 DB 에 없어서 보여줄 수 없다(docs/28).
export const MAX_REFERENCE_PHOTOS = 3;
// 학생이 질문을 쓰는 동안 만료되지 않을 만큼 넉넉히 준다. 만료되면 다시 받는다.
export const REFERENCE_URL_TTL_SECONDS = 300;

// 남의 파일이 섞여 들어오지 않게 경로를 한 번 더 거른다. RLS 와 Storage 정책이
// 최종 방어선이지만, 화면도 같은 조건을 쓴다(사진 제출 때와 같은 태도).
export function ownReferencePaths(paths, isOwnPath) {
  return (paths ?? [])
    .filter((path) => typeof path === 'string' && path !== '')
    .filter((path) => isOwnPath(path))
    .slice(0, MAX_REFERENCE_PHOTOS);
}

export function referenceModel(detail) {
  const title = String(detail?.title ?? '');
  // 매쓰플랫 카드는 이 화면 위쪽에 이미 그려져 있다. 내용을 또 찍지 않고 가리키기만 한다.
  const mathflatNote = detail?.mathflat ? '위쪽 매쓰플랫 안내도 함께 확인하세요.' : '';
  return {
    title,
    mathflatNote,
    hasPhotos: Boolean(detail?.myFilePaths?.length),
    visible: Boolean(title || mathflatNote || detail?.myFilePaths?.length),
  };
}

// ── 제출 사진 크게 보기 ──────────────────────────────────────────────────
// 썸네일은 문항을 확인하기엔 작다. 이미 발급받은 서명 URL 을 그대로 다시 써서
// 크게 보여준다. 뷰어를 열고 넘기는 동안 Storage 요청을 새로 만들지 않는다.

// 마지막에서 다음을 누르면 처음으로 돌아온다. 관리자 화면 뷰어와 같은 방식이다.
export function nextViewerIndex(index, total, delta) {
  const count = Number(total) || 0;
  if (count <= 0) return 0;
  const from = Number(index) || 0;
  return ((from + Number(delta || 0)) % count + count) % count;
}

// labelPrefix 는 alt 텍스트 접두어다. 기본값은 기존 호출(제출 사진 다시 보기)과
// 그대로 호환된다. 답변 이미지는 "내가 낸 사진"이 아니라 선생님이 보낸 것이므로,
// PR #34 뷰어를 그대로 재사용하되 이 한 값만 다르게 넘긴다(문서 38 조사 결과).
export function viewerModel(urls = [], index = 0, labelPrefix = '내가 낸 사진') {
  const list = Array.isArray(urls) ? urls : [];
  const total = list.length;
  const safeIndex = total ? Math.min(Math.max(0, Number(index) || 0), total - 1) : 0;
  return {
    total,
    index: safeIndex,
    url: list[safeIndex]?.url ?? '',
    label: labelPrefix + ' ' + (safeIndex + 1),
    counter: total ? (safeIndex + 1) + ' / ' + total : '',
    // 한 장뿐이면 이전/다음을 감춘다. 눌러도 같은 사진이라 혼란만 준다.
    showNav: total > 1,
    canOpen: total > 0,
  };
}

export function referencePhotoErrorMessage(error) {
  const raw = String(error?.message ?? error ?? '');
  if (error?.name === 'TypeError' || /failed to fetch|networkerror/i.test(raw)) {
    return '사진을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.';
  }
  return '사진을 불러오지 못했어요. 다시 시도해 주세요.';
}

// 과도한 이력 노출을 피하려고 화면에는 최근 몇 건만 보여준다.
export const RECENT_QUESTIONS_LIMIT = 3;

const STATUS_LABEL = { open: '답변 기다리는 중', answered: '답변 완료', closed: '정리됨' };

// ── 답변 이미지 (관리자가 답변에 붙인 스크린샷) ──────────────────────────
// 서버(20260825000000_question_answer_attachments.sql)가 이미 강제하는 규칙:
//   - answer-files 버킷: 이미지만, 파일당 10MB, 최대 3장
//   - Storage 정책: 경로 첫 칸 = question_id, 그 question 의 answer_file_paths 에
//     실제로 들어 있어야 학생에게 읽힌다
// 아래 값은 그 규칙을 화면에서 미리 맞춰 헛된 서명 URL 요청을 줄이는 것이지,
// 보안 경계가 아니다. 최종 방어선은 RLS 와 Storage 정책이다.
export const MAX_ANSWER_PHOTOS = 3;

// 관리자 화면(src/portal/answer-attachments.js)의 isAnswerFilePathValid 와 같은
// 조건이다. 두 앱은 번들이 분리돼 있어 import 하지 않고 각자 작게 다시 둔다.
export function isAnswerFilePathValid(path, questionId) {
  const pattern = new RegExp('^' + String(questionId) + '/[^/]+$');
  return pattern.test(String(path ?? ''));
}

// 서버가 돌려준 배열을 그대로 믿지 않는다. 이 질문 id로 시작하는 경로만,
// 최대 3장으로 다시 자른다.
export function ownAnswerFilePaths(question) {
  const id = String(question?.id ?? '');
  const raw = Array.isArray(question?.answer_file_paths) ? question.answer_file_paths : [];
  return raw
    .filter((path) => typeof path === 'string' && path !== '')
    .filter((path) => isAnswerFilePathValid(path, id))
    .slice(0, MAX_ANSWER_PHOTOS);
}

// 이 과제에 대해 최근 남긴 질문만 화면에 필요한 범위로 추려낸다.
export function recentQuestionsModel(questions = []) {
  return (questions ?? []).slice(0, RECENT_QUESTIONS_LIMIT).map((question) => ({
    id: question.id,
    category: question.category,
    body: question.body,
    statusLabel: STATUS_LABEL[question.status] ?? question.status,
    answerBody: question.status === 'answered' ? String(question.answer_body ?? '') : '',
    // 첨부는 답변이 실제로 된 질문에서만 노출한다. answerBody 와 같은 조건이다.
    answerFilePaths: question.status === 'answered' ? ownAnswerFilePaths(question) : [],
  }));
}
