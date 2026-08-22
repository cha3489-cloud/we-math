// 적용 경로: src/tablet/submission.js
// 사진 제출의 판단 로직만 모은 순수 함수 모듈. DOM·네트워크·Canvas 의존이 없어
// 단위 테스트로 검증한다. 실제 업로드와 리사이즈 실행은 main.js 가 맡는다.
//
// 서버가 이미 강제하는 규칙 (supabase/migrations/20260724000000_student_portal_mvp.sql):
//   - Storage 정책: 경로 첫 칸 = auth.uid(), 둘째 칸 = 본인에게 배정된 과제 id
//   - prepare_submission_attempt(): 경로 정규식 ^{uid}/{assignment_id}/[^/]+$,
//     Storage 실제 존재, 파일 3개 이하, 직전 attempt 가 needs_revision 일 때만 재제출,
//     attempt_no / status 는 서버가 덮어씀
// 아래 값은 그 규칙을 화면에서 미리 맞춰주기 위한 것이지, 보안 경계가 아니다.

export const MAX_FILES = 3;
// 원본 선택 한계와 업로드 최종 한계는 다르다.
// 최신 기기는 10~20MB 사진을 만드는데, 그것을 선택 단계에서 막아버리면
// 축소해서 올릴 기회 자체가 사라진다. 그래서 선택은 넉넉히 받고,
// 축소한 결과가 버킷 한계(10MB)를 넘을 때만 막는다.
export const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 서버 정규식의 [^/]+ 를 만족시키기 위해 경로 구분자와 특수문자를 모두 없앤다.
export function sanitizeFileName(name) {
  const clean = String(name ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean.slice(-80) || 'photo.jpg';
}

export function buildSubmissionPath(studentId, assignmentId, fileName, uniqueId) {
  if (!UUID.test(String(studentId ?? ''))) throw new Error('학생 정보를 확인할 수 없어요. 다시 로그인해 주세요.');
  if (!UUID.test(String(assignmentId ?? ''))) throw new Error('과제 정보를 확인할 수 없어요.');
  const unique = String(uniqueId ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!unique) throw new Error('파일 이름을 만들 수 없어요.');
  return studentId + '/' + assignmentId + '/' + unique + '-' + sanitizeFileName(fileName);
}

// 서버 트리거가 쓰는 정규식을 화면에서도 동일하게 확인한다.
export function isSubmissionPathValid(path, studentId, assignmentId) {
  const pattern = new RegExp('^' + String(studentId) + '/' + String(assignmentId) + '/[^/]+$');
  return pattern.test(String(path ?? ''));
}

const reasonText = {
  count: '사진은 최대 ' + MAX_FILES + '장까지 올릴 수 있어요.',
  type: '사진 파일만 올릴 수 있어요. (JPG, PNG, WebP)',
  size: '사진 용량이 너무 커요. 카메라 설정을 낮추거나 다시 촬영해 주세요.',
};

// 축소까지 했는데도 버킷 한계를 넘는 경우. 원본 거부와 다른 문구를 쓴다.
export const RESIZED_TOO_LARGE_MESSAGE = '사진을 줄였지만 아직 너무 커요. 더 가까이·밝게 다시 찍어 주세요.';
const RESIZED_TOO_LARGE_CODE = 'resized_too_large';

// 축소가 끝난 파일이 실제로 올라갈 수 있는 크기인지 확인한다.
export function isUploadable(bytes) {
  return Number(bytes ?? 0) > 0 && Number(bytes) <= MAX_UPLOAD_BYTES;
}

export function resizedTooLargeError() {
  return new Error(RESIZED_TOO_LARGE_CODE);
}

// files 는 { name, type, size } 만 있으면 되므로 File 객체 없이도 테스트할 수 있다.
export function acceptFiles(currentCount, files = [], { maxBytes = MAX_ORIGINAL_BYTES } = {}) {
  const accepted = [];
  const rejected = [];
  let room = MAX_FILES - Number(currentCount || 0);
  for (const file of files) {
    if (room <= 0) { rejected.push({ name: file?.name ?? '', reason: 'count', message: reasonText.count }); continue; }
    if (!ALLOWED_TYPES.includes(String(file?.type ?? ''))) {
      rejected.push({ name: file?.name ?? '', reason: 'type', message: reasonText.type });
      continue;
    }
    // 축소해도 감당이 안 될 만큼 큰 원본만 여기서 막는다. 10MB 대의 카메라
    // 원본은 통과시키고, 축소 결과가 한계를 넘는지는 제출 직전에 다시 본다.
    if (Number(file?.size ?? 0) > maxBytes) {
      rejected.push({ name: file?.name ?? '', reason: 'size', message: reasonText.size });
      continue;
    }
    accepted.push(file);
    room -= 1;
  }
  return { accepted, rejected };
}

// 긴 변이 MAX_EDGE 를 넘거나 파일이 크면 줄인다. 태블릿 원본은 대개 둘 다 해당된다.
export function resizePlan(metrics, { maxEdge = MAX_EDGE, sizeThreshold = 1.5 * 1024 * 1024 } = {}) {
  const width = Number(metrics?.width ?? 0);
  const height = Number(metrics?.height ?? 0);
  const size = Number(metrics?.size ?? 0);
  if (!width || !height) return { resize: false, width, height };
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge && size <= sizeThreshold) return { resize: false, width, height };
  const scale = Math.min(1, maxEdge / longEdge);
  return {
    resize: true,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// 서버가 돌려주는 오류를 학생이 읽을 수 있는 말로 바꾼다.
// 원문은 콘솔에만 남기고 화면에는 이 문구만 보여준다.
export function submissionErrorMessage(error, stage = 'submit') {
  const raw = String(error?.message ?? error ?? '');
  const code = String(error?.code ?? '');
  const status = Number(error?.status ?? error?.statusCode ?? 0);

  if (error?.name === 'TypeError' || /failed to fetch|networkerror|network request failed/i.test(raw)) {
    return '인터넷 연결이 끊긴 것 같아요. 연결을 확인하고 다시 시도해 주세요.';
  }
  // 여기까지 온 파일은 이미 축소를 거쳤다. 그래서 원본 거부와 다른 안내를 한다.
  if (raw === RESIZED_TOO_LARGE_CODE
    || status === 413
    || /payload too large|exceeded the maximum allowed size/i.test(raw)) {
    return RESIZED_TOO_LARGE_MESSAGE;
  }
  if (/mime type|invalid_mime_type/i.test(raw)) return reasonText.type;
  if (code === '42501' || status === 403 || /row-level security|permission denied|violates row-level/i.test(raw)) {
    return '지금은 제출할 수 없는 과제예요. 선생님께 문의해 주세요.';
  }
  if (/too many submission files/i.test(raw)) return reasonText.count;
  if (/latest attempt is not open for revision/i.test(raw)) {
    return '이미 제출한 과제예요. 선생님 확인이 끝난 뒤에 다시 제출할 수 있어요.';
  }
  if (/assignment not owned|invalid student/i.test(raw)) {
    return '내 과제가 아니에요. 화면을 새로고침해 주세요.';
  }
  if (/invalid submission file/i.test(raw)) {
    return '사진을 올리는 중 문제가 생겼어요. 다시 시도해 주세요.';
  }
  if (/duplicate|already exists/i.test(raw)) {
    return '같은 이름의 사진이 이미 올라갔어요. 다시 시도해 주세요.';
  }
  if (stage === 'upload') return '사진을 올리지 못했어요. 잠시 후 다시 시도해 주세요.';
  if (stage === 'insert') return '제출을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
  return '제출에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

// 미리보기 목록 표시용. 경고는 제출을 막지 않고 다시 촬영을 권하는 문구로만 쓴다.
export function previewModel(selected = []) {
  return {
    count: selected.length,
    remaining: Math.max(0, MAX_FILES - selected.length),
    canAddMore: selected.length < MAX_FILES,
    canSubmit: selected.length > 0,
    pickLabel: selected.length ? '사진 더 담기 (' + selected.length + '/' + MAX_FILES + ')' : '사진 찍기 · 고르기',
    items: selected.map((entry, index) => ({
      index,
      label: '선택한 사진 ' + (index + 1),
      url: entry?.url ?? null,
      warnings: (entry?.warnings ?? []).map((warning) => warning.message),
    })),
  };
}
