import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const html = read('tablet/index.html');
const main = read('src/tablet/main.js');

describe('tablet page boundaries', () => {
  it('reuses the shared portal logic instead of duplicating it', () => {
    expect(main).toContain("from '../portal/client.js'");
    expect(main).toContain("from '../portal/domain.js'");
    expect(main).toContain("from '../auth.js'");
    for (const fn of ['validateLoginInput', 'validatePin', 'authErrorMessage', 'assignmentStatus', 'STATUS_META']) {
      expect(main).toContain(fn);
    }
  });

  it('keeps its own stylesheet so the desktop portal is untouched', () => {
    expect(main).toContain("import './tablet.css'");
    expect(main).not.toContain('portal.css');
  });

  it('blocks the today view until a forced pin change is done', () => {
    // must_change_pin 인 학생은 PIN 변경 화면에서 멈추고 과제 조회로 넘어가지 않아야 한다.
    expect(main).toMatch(/if \(profile\.must_change_pin\) \{ showPanel\('pinChange'\); return; \}/);
    const pinChangeIndex = main.indexOf('must_change_pin');
    const assignmentsIndex = main.indexOf("from('assignments')");
    expect(pinChangeIndex).toBeGreaterThan(-1);
    expect(assignmentsIndex).toBeGreaterThan(pinChangeIndex);
  });

  it('only ever asks for the signed-in student rows', () => {
    // 학생 화면은 자기 id 로만 조회한다. RLS 가 최종 방어선이지만 화면도 같은 조건을 쓴다.
    expect(main).toContain(".eq('student_id', user.id)");
    expect(main).not.toMatch(/from\('assignments'\)[^;]*\.neq\(/);
  });

  it('refuses a session whose role is not student', () => {
    expect(main).toMatch(/data\?\.role !== 'student'/);
    expect(main).toContain('await signOut()');
  });

  it('treats a missing session as signed out rather than crashing', () => {
    expect(main).toContain('currentUserOrNull');
    expect(main).toMatch(/if \(currentUser\) await loadToday\(currentUser\); else showPanel\('login'\)/);
  });

  it('gives the student an explicit logout control', () => {
    expect(html).toContain('id=logout');
    expect(main).toMatch(/byId\('logout'\)\.addEventListener\('click'[\s\S]*?signOut\(\)/);
  });

  it('never renders admin-only surfaces on the student tablet', () => {
    for (const forbidden of ['admin-users', 'review_submission', 'user_roles\' ,', 'PIN 재설정', '계정 만들기', '학생 목록']) {
      expect(html).not.toContain(forbidden);
    }
    expect(main).not.toContain('admin-users');
    expect(main).not.toContain('review_submission');
  });

  // 이전 PR 까지는 "storage 를 쓰지 않는다"를 검사했다. 이번 PR 에서 사진 제출이
  // 들어오면서, 같은 자리를 "storage 를 올바르게만 쓴다"는 검사로 교체한다.
  it('uses only the submission bucket and never a public url', () => {
    expect(main).toContain("supabase.storage.from('submission-files')");
    expect(main).not.toContain('getPublicUrl');
    expect(main).not.toContain("from('assignment-files')");
  });

  it('uploads only to a path built from the signed-in student and the open assignment', () => {
    expect(main).toContain('buildSubmissionPath(currentUserId, currentDetailId');
    // 업로드 직전에 서버 정규식과 같은 조건을 한 번 더 확인한다.
    expect(main).toContain('isSubmissionPathValid(path, currentUserId, currentDetailId)');
    expect(main).toMatch(/if \(!isSubmissionPathValid[^)]*\)\) throw/);
  });

  it('lets the server decide attempt number, status and ownership', () => {
    // 클라이언트가 보내는 것은 과제 id, 본인 id, 파일 경로뿐이어야 한다.
    const insert = main.match(/from\('submissions'\)\.insert\(\{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(insert).toContain('assignment_id');
    expect(insert).toContain('student_id');
    expect(insert).toContain('file_paths');
    expect(insert).not.toContain('attempt_no');
    expect(insert).not.toContain('status');
    expect(insert).not.toContain('reviewed_at');
  });

  it('removes uploaded files when the submission row fails', () => {
    // 고아 파일을 남기지 않는다. 정리까지 실패하면 경로를 콘솔에 남겨 복구할 수 있게 한다.
    expect(main).toMatch(/if \(uploaded\.length\)[\s\S]*?\.remove\(uploaded\)/);
    expect(main).toContain('정리하지 못한 업로드 파일');
  });

  it('accepts only images and keeps the camera reachable', () => {
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('capture=environment');
    expect(html).toContain('multiple');
    expect(main).toContain('acceptFiles(selectedPhotos.length, chosen)');
  });

  it('shrinks a photo before uploading it', () => {
    expect(main).toContain('shrinkForUpload');
    expect(main).toContain('resizePlan');
    expect(main).toContain("canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)");
  });

  it('checks the upload size only after shrinking, so a big original still gets a chance', () => {
    const shrinkIndex = main.indexOf('await shrinkForUpload(');
    const gateIndex = main.indexOf('isUploadable(upload.size)');
    const uploadIndex = main.indexOf(".from('submission-files').upload(");
    expect(shrinkIndex).toBeGreaterThan(-1);
    // 축소 → 크기 검사 → 업로드 순서여야 한다
    expect(gateIndex).toBeGreaterThan(shrinkIndex);
    expect(uploadIndex).toBeGreaterThan(gateIndex);
    expect(main).toContain('throw resizedTooLargeError()');
  });

  it('lets the student say where they got stuck without forcing it', () => {
    expect(html).toContain('id=difficultyOptions');
    expect(html).toContain('id=difficultyNote');
    expect(html).toContain('어디서 막혔나요?');
    expect(html).toContain('안 골라도 제출할 수 있어요');
    // 제출 버튼이 선택 여부에 묶이면 안 된다. 사진만 있으면 제출 가능해야 한다.
    expect(main).toMatch(/byId\('photoSubmit'\)\.disabled = !model\.canSubmit \|\| submitting/);
    expect(main).not.toMatch(/photoSubmit'\)\.disabled[^;]*selectedTags/);
  });

  it('stores the stuck point in the existing body column, not a new field', () => {
    const insert = main.match(/from\('submissions'\)\.insert\(\{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(insert).toContain('body: composeSubmissionBody(selectedTags');
    // 보내는 컬럼은 기존 4개뿐이어야 한다. 새 컬럼을 만들지 않았다는 뜻이다.
    const columns = [...insert.matchAll(/^\s{6}([a-z_]+):/gm)].map((match) => match[1]);
    expect(columns.sort()).toEqual(['assignment_id', 'body', 'file_paths', 'student_id']);
  });

  it('shows the student only what they themselves wrote', () => {
    expect(html).toContain('id=detailMineBlock');
    expect(main).toContain('detail.myTags');
    expect(main).toContain('detail.myNote');
    // 다른 학생 메모나 내부 기록으로 이어지는 통로가 없어야 한다
    expect(main).not.toContain('review_events');
  });

  it('shows quality warnings without blocking the submission', () => {
    expect(main).toContain('assessImageQuality');
    expect(main).toContain('그래도 제출은 할 수 있어요');
  });

  // 이전 PR 까지는 createSignedUrl 자체를 금지했다. 이번 PR 에서 학생이 질문을 쓰기 전에
  // 자기 제출 사진을 다시 보는 기능이 들어오면서, 같은 자리를
  // "서명 URL 을 쓰지 않는다" → "제출 버킷에만, 본인 파일에만 쓴다"로 교체한다.
  it('signs urls only for the submission bucket, never assignment attachments', () => {
    // 주석에는 attachment_paths 를 설명으로 적을 수 있으므로 실행 코드만 두고 본다.
    const code = main.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    expect(code).toContain("supabase.storage.from('submission-files').createSignedUrl(");
    expect(code).not.toContain('attachment_paths');
    expect(code).not.toContain("from('assignment-files')");
    expect(code).not.toContain('getPublicUrl');
  });

  it('routes with the hash only, never the History API', () => {
    // GitHub Pages 에는 SPA fallback 이 없어 pushState 로 만든 경로는 새로고침 시 404 가 난다.
    expect(main).not.toContain('history.pushState');
    expect(main).not.toContain('history.replaceState');
    expect(main).toContain("location.hash = '#/assignment/'");
    expect(main).toMatch(/addEventListener\('hashchange'/);
  });

  it('opens a detail screen only for an assignment the student actually has', () => {
    expect(main).toContain('findAssignment(currentAssignments, route.id)');
    expect(main).toMatch(/if \(!assignment\) \{ showPanel\('today'\); goToday\(\); return; \}/);
  });

  it('clears the assignment route on logout so the next student starts clean', () => {
    expect(main).toMatch(/currentAssignments = \[\];[\s\S]*?signOut\(\)[\s\S]*?location\.replace\(location\.pathname\)/);
  });

  it('has a way back from the detail screen', () => {
    expect(html).toContain('id=detailBack');
    expect(main).toContain("byId('detailBack').addEventListener('click', goToday)");
  });

  it('renders the mathflat card as its own block', () => {
    expect(html).toContain('id=detailMathflat');
    expect(html).toContain('id=detailMathflatFields');
    expect(main).toContain('renderMathflat');
  });

  it('keeps the pin out of the DOM value and the network log', () => {
    // PIN 은 마스킹된 표시만 DOM 에 넣는다. input value 로 두지 않는다.
    expect(html).not.toMatch(/<input[^>]*id=pin[^>]*>/);
    expect(main).toContain('maskPin');
  });

  it('uses a large touch keypad instead of relying on the OS keyboard', () => {
    expect(html).toContain('id=loginKeypad');
    expect(html).toContain('id=pinKeypad');
    expect(read('src/tablet/tablet.css')).toContain('--touch-min:64px');
  });

  it('shows an empty state when the student has no assignment', () => {
    expect(html).toContain('id=emptyState');
    expect(main).toMatch(/byId\('emptyState'\)\.hidden = totalAssignmentCount\(sections\) > 0/);
  });
});

describe('tablet question form', () => {
  it('imports the question logic from its own module, not from submissions', () => {
    expect(main).toContain("from './question.js'");
    for (const fn of ['canSubmitQuestion', 'questionFormModel', 'questionInsertPayload', 'questionErrorMessage']) {
      expect(main).toContain(fn);
    }
  });

  it('offers a category picker and a free-text body, independent of the photo form', () => {
    expect(html).toContain('id=questionCategoryOptions');
    expect(html).toContain('id=questionBody');
    expect(html).toContain('id=questionSubmit');
    // 사진 제출 영역(submitBlock)과는 별개의 블록이어야 한다.
    expect(html).toMatch(/<div id=questionBlock[^>]*>/);
  });

  it('is not gated behind the photo submission open/closed state, unlike submitBlock', () => {
    // submitBlock 은 hidden 으로 시작해 renderDetail 이 열어준다. questionBlock 은
    // 사진 제출과 별개이므로 처음부터 숨겨두지 않는다.
    expect(html).toMatch(/<div id=submitBlock class=detail-block hidden>/);
    expect(html).toMatch(/<div id=questionBlock class=detail-block>/);
    expect(html).not.toMatch(/<div id=questionBlock class=detail-block hidden>/);
  });

  it('lets the student pick exactly one category', () => {
    expect(main).toContain('selectedQuestionCategory = option.tag;');
    expect(main).toContain("button.setAttribute('aria-pressed', String(option.selected))");
  });

  it('can be submitted with a category and body but no photo', () => {
    // insert 호출부에 파일 업로드나 selectedPhotos 참조가 없어야 한다.
    const handler = main.match(/byId\('questionSubmit'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(handler).toBeTruthy();
    expect(handler).not.toContain('selectedPhotos');
    expect(handler).not.toContain('storage');
    expect(handler).toContain("supabase.from('questions').insert(payload)");
  });

  it('blocks an empty submission before ever calling the server', () => {
    expect(main).toContain('if (!canSubmitQuestion(selectedQuestionCategory, ' + "byId('questionBody').value)) return;");
  });

  it('prevents a duplicate submission while one is already in flight', () => {
    expect(main).toMatch(/if \(questionSubmitting \|\| !currentUserId \|\| !currentDetailId\) return;/);
    expect(main).toContain('questionSubmitting = true;');
    expect(main).toMatch(/finally \{\s*questionSubmitting = false;/);
  });

  it('disables the picker, textarea and submit button while submitting', () => {
    expect(main).toContain('button.disabled = questionSubmitting;');
    expect(main).toContain("byId('questionBody').disabled = questionSubmitting;");
    expect(main).toContain('byId(\'questionSubmit\').disabled = !model.canSubmit || questionSubmitting;');
  });

  it('shows the exact confirmation text on success', () => {
    expect(main).toContain("byId('questionStatus').textContent = '질문을 남겼어요. 선생님이 확인할게요.';");
  });

  it('shows a failure message built from the server error, including the 10-open-question cap', () => {
    expect(main).toContain('showError(byId(\'questionError\'), questionErrorMessage(error))');
    const questionModule = read('src/tablet/question.js');
    expect(questionModule).toMatch(/too many open questions/i);
    expect(questionModule).toContain('답변을 기다리는 질문이 많아요');
  });

  it('lets the server decide status and answer fields — the payload builder only takes the minimum', () => {
    const questionModule = read('src/tablet/question.js');
    const payloadFn = questionModule.match(/export function questionInsertPayload\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(payloadFn).toContain('student_id');
    expect(payloadFn).toContain('assignment_id');
    expect(payloadFn).toContain('category');
    expect(payloadFn).toContain('body');
    for (const forbidden of ['status:', 'answered_at', 'answered_by', 'answer_body', 'closed_at']) {
      expect(payloadFn).not.toContain(forbidden);
    }
  });

  it('sends the current assignment id and the signed-in student id, never invented ones', () => {
    expect(main).toContain('assignmentId: currentDetailId,');
    expect(main).toContain('studentId: currentUserId,');
    // 다른 학생/과제 id 를 만들어내는 통로(crypto.randomUUID 등)가 이 흐름에 없어야 한다.
    const handler = main.match(/byId\('questionSubmit'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(handler).not.toContain('randomUUID');
  });

  it('shows only a bounded recent list for the current assignment, scoped to the signed-in student', () => {
    expect(main).toContain(".eq('assignment_id', assignmentId)");
    expect(main).toContain(".eq('student_id', currentUserId)");
    expect(main).toContain('.limit(3)');
  });

  it('resets the question form when switching to a different assignment', () => {
    expect(main).toMatch(/clearPhotos\(\);\s*clearQuestionForm\(\);/);
  });

  it('still leaves the existing photo submission flow untouched', () => {
    expect(main).toContain("supabase.from('submissions').insert({");
    expect(main).toContain('shrinkForUpload');
    expect(main).toContain('composeSubmissionBody(selectedTags');
  });

  it('still routes with the hash only', () => {
    expect(main).not.toContain('history.pushState');
    expect(main).toContain("location.hash = '#/assignment/'");
  });
});

describe('tablet reference image viewer wiring', () => {
  it('uses a native dialog for modality and the backdrop', () => {
    expect(html).toContain('<dialog id=referenceViewer');
    expect(main).toContain('dialog.showModal()');
  });

  it('closes on Escape explicitly, not only through the dialog default', () => {
    // 브라우저 기본 동작에만 기대지 않는다. 실측에서 keydown 이 문서까지 도달했는데도
    // dialog 가 스스로 닫지 않는 경우를 확인했다(자동화 환경).
    const handler = main.match(/byId\('referenceViewer'\)\.addEventListener\('keydown'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(handler).toBeTruthy();
    expect(handler).toContain("event.key !== 'Escape'");
    expect(handler).toContain('closeViewer()');
  });

  it('makes each thumbnail a real button that opens the viewer', () => {
    expect(main).toContain("button.className = 'question-reference-thumb'");
    expect(main).toContain("button.addEventListener('click', () => openViewer(index))");
    expect(main).toContain('크게 보기');
  });

  it('offers close, prev and next controls', () => {
    for (const id of ['referenceViewerClose', 'referenceViewerPrev', 'referenceViewerNext']) {
      expect(html).toContain('id=' + id);
      expect(main).toContain("byId('" + id + "').addEventListener('click'");
    }
  });

  it('closes when the backdrop itself is clicked', () => {
    expect(main).toMatch(/if \(event\.target === byId\('referenceViewer'\)\) closeViewer\(\)/);
  });

  it('hides the nav buttons when there is a single photo', () => {
    expect(main).toContain("byId('referenceViewerPrev').hidden = !model.showNav");
    expect(main).toContain("byId('referenceViewerNext').hidden = !model.showNav");
  });

  it('reuses the already-signed urls instead of asking storage again', () => {
    // 뷰어를 열고 넘기는 경로에 storage 호출이 없어야 한다.
    const viewer = main.match(/function openViewer\([\s\S]*?function moveViewer\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(viewer).toBeTruthy();
    expect(viewer).not.toContain('supabase.storage');
    expect(viewer).not.toContain('createSignedUrl');
    expect(viewer).toContain('referenceUrls');
  });

  it('closes the viewer when the assignment changes or the student logs out', () => {
    const loader = main.match(/async function loadReferencePhotos\([\s\S]*?referenceUrls = \[\];/)?.[0] ?? '';
    expect(loader).toContain('closeViewer()');
    const logout = main.match(/byId\('logout'\)\.addEventListener[\s\S]*?await signOut\(\)/)?.[0] ?? '';
    expect(logout).toContain('closeViewer()');
  });

  it('drops the image source on close so it does not linger for the next student', () => {
    expect(main).toContain("byId('referenceViewerImage').removeAttribute('src')");
  });

  it('still signs urls only for the submission bucket', () => {
    const code = main.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    expect(code).toContain("supabase.storage.from('submission-files').createSignedUrl(");
    expect(code).not.toContain("from('assignment-files')");
    expect(code).not.toContain('getPublicUrl');
  });

  it('keeps the viewer image contained and the buttons touch sized', () => {
    const css = read('src/tablet/tablet.css');
    expect(css).toMatch(/\.reference-viewer-image\{[\s\S]*?object-fit:contain/);
    const nav = css.match(/\.reference-viewer-nav,\.reference-viewer-close\{[\s\S]*?\}/)?.[0] ?? '';
    expect(nav).toContain('min-height:var(--touch-min)');
    expect(nav).toContain('min-width:var(--touch-min)');
  });
});
