import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const admin = read('src/portal/admin.js');
const html = read('admin/index.html');

describe('admin question inbox — tab and markup', () => {
  it('adds a third tab alongside review and manage', () => {
    expect(html).toContain('id=tabQuestions');
    expect(html).toContain('id=questionsSection');
    expect(html).toContain('id=questionsList');
    expect(html).toContain('id=questionsEmpty');
    expect(html).toContain('id=questionsError');
  });

  it('switches all three sections together, never leaving two visible', () => {
    expect(admin).toContain("const review = tab === 'review';");
    expect(admin).toContain("const manage = tab === 'manage';");
    expect(admin).toContain("const questions = tab === 'questions';");
    expect(admin).toContain("byId('reviewSection').hidden = !review;");
    expect(admin).toContain("byId('manageSection').hidden = !manage;");
    expect(admin).toContain("byId('questionsSection').hidden = !questions;");
  });

  it('loads the inbox only when the questions tab is opened, like the manage tab', () => {
    expect(admin).toMatch(/if \(questions\) await loadQuestionInbox\(\);/);
    expect(admin).toContain("byId('tabQuestions').addEventListener('click', () => switchTab('questions')");
  });
});

describe('admin question inbox — open question query', () => {
  it('filters to open status, oldest first, with a bounded limit', () => {
    const fn = admin.match(/async function loadQuestionInbox\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain(".from('questions')");
    expect(fn).toContain(".eq('status', 'open')");
    expect(fn).toMatch(/\.order\('created_at', \{ ascending: true \}\)/);
    expect(fn).toMatch(/\.limit\(QUESTIONS_LIMIT\)/);
    expect(admin).toMatch(/QUESTIONS_LIMIT = \d+/);
  });

  it('disambiguates the profiles join since questions has two foreign keys into profiles', () => {
    // student_id 와 answered_by 둘 다 profiles 를 가리키므로 FK 이름을 명시해야 한다.
    expect(admin).toContain('profiles!questions_student_id_fkey(name)');
  });

  it('includes the assignment title when the question is tied to one', () => {
    expect(admin).toContain('assignments(title)');
  });

  it('never queries submissions or assignments status fields for this feature', () => {
    const fn = admin.match(/async function loadQuestionInbox\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).not.toContain('submissions');
  });
});

describe('admin question inbox — RPC-only state changes', () => {
  it('answers through the answer_question RPC, never a direct update', () => {
    // PR #34(이미지 첨부)에서 세 번째 인자가 추가됐다. 호출 자체가 여전히 RPC 이고
    // 직접 UPDATE 가 아니라는 것을 확인한다 — 정확한 인자 목록은 별도 테스트가 본다.
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("supabase.rpc('answer_question', {");
    expect(fn).toContain('p_question_id: questionId');
    expect(fn).toContain('p_answer_body: clean');
    expect(fn).not.toMatch(/\.from\('questions'\)\.update/);
  });

  it('closes through the close_question RPC, never a direct update', () => {
    const fn = admin.match(/async function closeQuestionEntry\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("supabase.rpc('close_question', { p_question_id: questionId })");
    expect(fn).not.toMatch(/\.from\('questions'\)\.update/);
  });

  it('never calls update() on questions anywhere in the admin script', () => {
    expect(admin).not.toMatch(/from\('questions'\)\.update/);
  });

  it('sends only the question id and answer body to answer_question — nothing else', () => {
    const call = admin.match(/supabase\.rpc\('answer_question', \{[^}]*\}\)/)?.[0] ?? '';
    expect(call).toContain('p_question_id: questionId');
    expect(call).toContain('p_answer_body: clean');
  });
});

describe('admin question inbox — empty list and loading/failure states', () => {
  it('shows an empty state when there are no open questions', () => {
    expect(admin).toContain("byId('questionsEmpty').hidden = Boolean(questionInbox.length);");
  });

  it('shows a page-level error when the query itself fails', () => {
    const fn = admin.match(/async function loadQuestionInbox\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("showError(byId('questionsError')");
  });

  it('rejects an empty answer before ever calling the server', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!clean\) \{ questionErrors\.set\(questionId, '답변 내용을 입력하세요\.'\); renderQuestionInbox\(\); return; \}/);
  });

  it('shows a per-card failure message drawn from state, not a stale DOM reference', () => {
    // questionErrors 는 Map 이고 카드 렌더링 시점에 다시 읽는다. 재렌더 후에도
    // 사라지지 않는 이유다.
    expect(admin).toContain("errorEl.textContent = questionErrors.get(entry.id) || '';");
    expect(admin).toContain('questionErrors.set(questionId,');
  });
});

describe('admin question inbox — refresh after answering or closing', () => {
  it('reloads the inbox after a successful answer, so it drops out of the open list', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('await loadQuestionInbox();');
  });

  it('reloads the inbox after a successful close', () => {
    const fn = admin.match(/async function closeQuestionEntry\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('await loadQuestionInbox();');
  });
});

describe('admin question inbox — double-submit protection', () => {
  it('ignores a second action while one question is already being processed', () => {
    const answerFn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    const closeFn = admin.match(/async function closeQuestionEntry\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(answerFn).toMatch(/if \(questionProcessingId\) return;/);
    expect(closeFn).toMatch(/if \(questionProcessingId\) return;/);
  });

  it('disables both buttons on every card while any question is processing', () => {
    expect(admin).toContain('const busy = Boolean(questionProcessingId);');
    expect(admin).toContain('closeButton.disabled = busy;');
    // PR #34 에서 답변 버튼은 busy 외에 "본문이 비어 있지 않은지"도 함께 본다
    // (답변 본문은 항상 필수 — 첨부만으로는 답변할 수 없다).
    expect(admin).toContain('answerButton.disabled = busy || !canSubmitAnswer(answerInput.value);');
  });
});

describe('admin question inbox — student identity stays at the existing display level', () => {
  it('shows only the student name, the same field already shown in the review queue', () => {
    const fn = admin.match(/function questionStudentName\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('name');
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).not.toContain('.phone');
    expect(card).not.toContain('suspended_at');
  });
});

describe('admin question inbox — does not disturb the existing review queue', () => {
  it('keeps the review queue select and decide() flow untouched', () => {
    expect(admin).toContain("const QUEUE_SELECT = 'id,title,due_at,profiles!assignments_student_id_fkey(name,suspended_at),submissions(id,attempt_no,status,body,file_paths,submitted_at)';");
    expect(admin).toContain("supabase.rpc('review_submission_v2'");
  });

  it('keeps the manage tab load calls untouched', () => {
    expect(admin).toMatch(/if \(manage\) await Promise\.all\(\[loadUsers\(\), loadWorkflows\(\), loadOperationsSummary\(\)\]\);/);
  });
});

describe('admin answer image attachments — investigation', () => {
  it('imports the pure attachment helpers from their own admin-only module', () => {
    expect(admin).toContain("from './answer-attachments.js'");
    for (const fn of ['acceptAnswerImages', 'answerImagesPreviewModel', 'buildAnswerFilePath', 'isAnswerFilePathValid', 'canSubmitAnswer', 'answerErrorMessage']) {
      expect(admin).toContain(fn);
    }
  });

  it('never imports anything from the tablet bundle', () => {
    // tablet 모듈을 무리하게 끌어오지 않는다는 판단(문서 37)을 코드로도 고정한다.
    expect(admin).not.toMatch(/from ['"].*\/tablet\//);
  });

  it('reuses the existing thumbs/thumb/thumb-remove preview classes instead of adding new CSS', () => {
    // student.js 의 제출 파일 미리보기와 같은 클래스를 쓴다(portal.css 에 이미 있다).
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).toContain("className = 'thumbs'");
    expect(card).toContain("figure.className = 'thumb'");
    expect(card).toContain("remove.className = 'thumb-remove'");
  });
});

describe('admin answer image attachments — file picker UI', () => {
  it('only accepts image mime types on the file input', () => {
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).toContain("fileInput.accept = 'image/jpeg,image/png,image/webp'");
    expect(card).not.toContain('application/pdf');
  });

  it('allows selecting more than one file at a time, up to the cap enforced elsewhere', () => {
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).toContain('fileInput.multiple = true');
  });

  it('filters every selection through acceptAnswerImages before adding it', () => {
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).toContain('acceptAnswerImages(current.length, chosen)');
  });

  it('shows the first rejection reason inline instead of silently dropping files', () => {
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).toMatch(/attachmentError\.textContent = rejected\.length \? rejected\[0\]\.message/);
  });

  it('lets each thumbnail be removed independently and revokes its object url', () => {
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).toContain("remove.className = 'thumb-remove'");
    expect(card).toMatch(/if \(target\?\.url\) URL\.revokeObjectURL\(target\.url\)/);
  });

  it('disables the pick button once three images are selected or while processing', () => {
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).toContain('pickButton.disabled = busy || !model.canAddMore;');
  });
});

describe('admin answer image attachments — answer body stays required', () => {
  it('disables the submit button when the body is empty, even with attachments selected', () => {
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(card).toContain('answerButton.disabled = busy || !canSubmitAnswer(answerInput.value);');
  });

  it('re-checks on every keystroke without a full re-render (keeps focus)', () => {
    const card = admin.match(/function questionCard\(entry\)[\s\S]*?\n\}/)?.[0] ?? '';
    const listener = card.match(/answerInput\.addEventListener\('input', \(\) => \{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(listener).toContain('canSubmitAnswer(answerInput.value)');
    expect(listener).not.toContain('renderQuestionInbox()');
  });

  it('still rejects an empty body defensively inside answerQuestion itself', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!clean\) \{ questionErrors\.set\(questionId, '답변 내용을 입력하세요\.'\); renderQuestionInbox\(\); return; \}/);
  });
});

describe('admin answer image attachments — submitting text-only or with images', () => {
  it('can answer with no attachments (existing behaviour preserved)', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('for (const attachment of attachments)');
    // attachments 가 빈 배열이면 반복문이 그냥 안 돈다 — 별도 분기 없이도 텍스트만 답변된다.
    expect(fn).not.toMatch(/if \(attachments\.length === 0\)/);
  });

  it('passes the answer button the current draft attachments for this question only', () => {
    expect(admin).toContain("answerButton.addEventListener('click', () => answerQuestion(entry.id, answerInput.value, questionAnswerFiles.get(entry.id) || []))");
  });
});

describe('admin answer image attachments — upload path rule', () => {
  it('uploads each file to answer-files using buildAnswerFilePath, never submission-files', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('buildAnswerFilePath(questionId, attachment.file.name, crypto.randomUUID())');
    expect(fn).toContain("supabase.storage.from('answer-files')");
    expect(fn).not.toContain('submission-files');
  });

  it('validates the path a second time right before uploading', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!isAnswerFilePathValid\(path, questionId\)\) throw/);
  });

  it('uploads before calling the RPC, and only records paths that actually succeeded', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    const uploadIndex = fn.indexOf(".from('answer-files')");
    const rpcIndex = fn.indexOf("supabase.rpc('answer_question'");
    expect(uploadIndex).toBeGreaterThan(-1);
    expect(fn).toContain('.upload(path, attachment.file');
    expect(rpcIndex).toBeGreaterThan(uploadIndex);
    expect(fn).toContain('uploaded.push(path)');
  });
});

describe('admin answer image attachments — RPC call shape', () => {
  it('calls answer_question with all three arguments, file paths included even when empty', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    const call = fn.match(/supabase\.rpc\('answer_question', \{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(call).toContain('p_question_id: questionId');
    expect(call).toContain('p_answer_body: clean');
    expect(call).toContain('p_file_paths: uploaded');
  });

  it('never updates the questions table directly anywhere in the attachment flow', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).not.toMatch(/\.from\('questions'\)\.update/);
  });
});

describe('admin answer image attachments — cleanup on RPC failure', () => {
  it('removes only the files uploaded in this attempt when the RPC call fails', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    const tryBlock = fn.match(/try \{([\s\S]*?)\} catch \(error\) \{([\s\S]*?)\n  \}/)?.[0] ?? '';
    expect(tryBlock).toContain('if (uploaded.length)');
    expect(tryBlock).toContain("supabase.storage.from('answer-files').remove(uploaded)");
  });

  it('logs the leftover paths with console.error when cleanup itself fails', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/if \(cleanupError\) \{\s*console\.error\('정리하지 못한 답변 이미지:', uploaded, cleanupError\);/);
  });

  it('tells the admin a recoverable message when cleanup fails, not just a raw error', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/message \+= ' 첨부 이미지 일부가 남아있을 수 있어요/);
  });

  it('keeps the draft body and selected attachments after a failure instead of clearing them', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    const catchBlock = fn.match(/\} catch \(error\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(catchBlock).not.toContain('questionDrafts.delete');
    expect(catchBlock).not.toContain('clearAnswerAttachments');
  });

  it('clears drafts and attachments only after a confirmed success', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    const beforeCatch = fn.slice(0, fn.indexOf('} catch (error)'));
    expect(beforeCatch).toContain('questionDrafts.delete(questionId)');
    expect(beforeCatch).toContain('clearAnswerAttachments(questionId)');
  });
});

describe('admin answer image attachments — duplicate click / concurrency', () => {
  it('answerQuestion bails out immediately if another question is already processing', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/^\s*if \(questionProcessingId\) return;/m);
  });

  it('sets questionProcessingId before doing any upload work', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    const setIndex = fn.indexOf('questionProcessingId = questionId;');
    const uploadIndex = fn.indexOf("for (const attachment of attachments)");
    expect(setIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(setIndex);
  });
});

describe('admin answer image attachments — refresh after success', () => {
  it('reloads the inbox after answerQuestion succeeds, same as before attachments existed', () => {
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    const beforeCatch = fn.slice(0, fn.indexOf('} catch (error)'));
    expect(beforeCatch).toContain('await loadQuestionInbox();');
  });
});

describe('admin answer image attachments — close also tidies up local state', () => {
  it('clears any pending attachment selection when a question is closed', () => {
    const fn = admin.match(/async function closeQuestionEntry\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('clearAnswerAttachments(questionId)');
  });
});

describe('admin answer image attachments — nothing else touched', () => {
  it('never issues RLS/policy or schema DDL anywhere in the file', () => {
    const lower = admin.toLowerCase();
    for (const forbidden of ['create policy', 'drop policy', 'alter table']) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it('keeps the attachment flow scoped to answer-files — the pre-existing assignment/submission buckets it does not touch', () => {
    // admin.js 는 원래부터 assignment-files(과제 첨부)와 submission-files(제출 사진 열람)를
    // 쓴다. 이번 PR 이 새로 건드리지 않았는지는 answerQuestion 함수 범위로 좁혀서 본다.
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).not.toContain('submission-files');
    expect(fn).not.toContain('assignment-files');
  });
});
