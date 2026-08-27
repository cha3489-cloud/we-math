// 적용 경로: src/portal/answer-attachments.js
// 관리자가 학생 질문 답변에 붙이는 이미지 첨부의 판단 로직만 모은 순수 함수 모듈.
// DOM·네트워크 의존이 없어 단위 테스트로 검증한다. 실제 업로드·삭제 실행은 admin.js 가 맡는다.
//
// src/tablet/submission.js 와 목적이 비슷하지만 일부러 새로 쓴다:
//   - 대상 버킷(answer-files)과 경로 규칙(첫 칸이 학생 id 가 아니라 question id)이 다르다
//   - tablet 은 완전히 분리된 번들이라, 거기서 가져오면 admin 번들에 tablet 코드가
//     섞이거나(직접 import) admin 번들 크기·해시가 불필요하게 흔들린다(재수출 경유)
//   - v1 은 리사이즈를 하지 않는다(PR #32 결정사항 3) — MAX_ORIGINAL_BYTES 개념이 없다
//
// 서버가 강제하는 규칙 (supabase/migrations/20260825000000_question_answer_attachments.sql):
//   - answer-files 버킷: 이미지만(jpeg/png/webp), 파일당 10MB
//   - Storage 정책: 경로 첫 칸 = question_id, 그 question 의 answer_file_paths 에
//     실제로 들어 있어야 학생에게 읽힌다
//   - answer_question RPC: 경로 정규식 ^{question_id}/[^/]+$, Storage 실제 존재 확인,
//     최대 3장, answer_body 가 비어 있으면 거부(첨부만으로는 답변할 수 없다)
// 아래 값은 그 규칙을 화면에서 미리 맞춰주는 것이지, 보안 경계가 아니다. 최종 방어선은
// RPC 와 Storage 정책이다.

export const MAX_ANSWER_FILES = 3;
export const MAX_ANSWER_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_ANSWER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 서버 정규식의 [^/]+ 를 만족시키기 위해 경로 구분자와 특수문자를 모두 없앤다.
export function sanitizeAnswerFileName(name) {
  const clean = String(name ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean.slice(-80) || 'image.jpg';
}

export function buildAnswerFilePath(questionId, fileName, uniqueId) {
  if (!UUID.test(String(questionId ?? ''))) throw new Error('질문 정보를 확인할 수 없습니다.');
  const unique = String(uniqueId ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!unique) throw new Error('파일 이름을 만들 수 없습니다.');
  return questionId + '/' + unique + '-' + sanitizeAnswerFileName(fileName);
}

// 서버 RPC 가 쓰는 정규식(20260825000000)을 화면에서도 동일하게 다시 확인한다.
// 업로드 직전에 한 번 더 걸러, 어긋나면 업로드 자체를 하지 않는다.
export function isAnswerFilePathValid(path, questionId) {
  const pattern = new RegExp('^' + String(questionId) + '/[^/]+$');
  return pattern.test(String(path ?? ''));
}

const reasonText = {
  count: '이미지는 최대 ' + MAX_ANSWER_FILES + '장까지 첨부할 수 있어요.',
  type: '이미지 파일만 첨부할 수 있어요. (JPG, PNG, WebP)',
  size: '파일 용량이 너무 커요. 10MB 이하로 올려주세요.',
};

// files 는 { name, type, size } 만 있으면 되므로 File 객체 없이도 테스트할 수 있다.
export function acceptAnswerImages(currentCount, files = [], { maxBytes = MAX_ANSWER_FILE_BYTES } = {}) {
  const accepted = [];
  const rejected = [];
  let room = MAX_ANSWER_FILES - Number(currentCount || 0);
  for (const file of files) {
    if (room <= 0) { rejected.push({ name: file?.name ?? '', reason: 'count', message: reasonText.count }); continue; }
    if (!ALLOWED_ANSWER_TYPES.includes(String(file?.type ?? ''))) {
      rejected.push({ name: file?.name ?? '', reason: 'type', message: reasonText.type });
      continue;
    }
    if (Number(file?.size ?? 0) > maxBytes) {
      rejected.push({ name: file?.name ?? '', reason: 'size', message: reasonText.size });
      continue;
    }
    accepted.push(file);
    room -= 1;
  }
  return { accepted, rejected };
}

// 미리보기 목록 표시용.
export function answerImagesPreviewModel(selected = []) {
  return {
    count: selected.length,
    remaining: Math.max(0, MAX_ANSWER_FILES - selected.length),
    canAddMore: selected.length < MAX_ANSWER_FILES,
    pickLabel: selected.length
      ? '이미지 더 담기 (' + selected.length + '/' + MAX_ANSWER_FILES + ')'
      : '이미지 첨부',
    items: selected.map((entry, index) => ({
      index,
      label: '첨부 이미지 ' + (index + 1),
      url: entry?.url ?? null,
    })),
  };
}

// 답변 본문은 첨부 여부와 무관하게 항상 필수다(운영 결정 2 — questions_answer_files_answered_check
// 가 이미 이 규칙을 서버에서 강제한다). 화면은 그 규칙을 미리 반영해 제출 버튼을 잠근다.
export function canSubmitAnswer(body) {
  return String(body ?? '').trim() !== '';
}

// 서버가 돌려주는 오류를 관리자가 읽을 수 있는 말로 바꾼다.
export function answerErrorMessage(error) {
  const raw = String(error?.message ?? error ?? '');
  const code = String(error?.code ?? '');
  const status = Number(error?.status ?? error?.statusCode ?? 0);

  if (error?.name === 'TypeError' || /failed to fetch|networkerror|network request failed/i.test(raw)) {
    return '인터넷 연결이 끊긴 것 같아요. 연결을 확인하고 다시 시도해 주세요.';
  }
  if (status === 413 || /payload too large|exceeded the maximum allowed size/i.test(raw)) {
    return reasonText.size;
  }
  if (/mime type|invalid_mime_type/i.test(raw)) return reasonText.type;
  if (code === '42501' || status === 403 || /row-level security|permission denied|violates row-level/i.test(raw)) {
    return '이 작업을 처리할 권한이 없어요.';
  }
  if (/too many answer files/i.test(raw)) return reasonText.count;
  if (/invalid answer file|answer file missing/i.test(raw)) {
    return '첨부 이미지를 확인하지 못했어요. 다시 첨부해 주세요.';
  }
  if (/empty answer/i.test(raw)) return '답변 내용을 입력하세요.';
  if (/admin required/i.test(raw)) return '관리자 권한이 필요해요.';
  if (/question not open/i.test(raw)) return '이미 처리된 질문이에요. 목록을 새로고침했어요.';
  return '답변을 보내지 못했어요. 잠시 후 다시 시도해 주세요.';
}
