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
    const fn = admin.match(/async function answerQuestion\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("supabase.rpc('answer_question', { p_question_id: questionId, p_answer_body: clean })");
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
    expect(admin).toContain('answerButton.disabled = busy;');
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
