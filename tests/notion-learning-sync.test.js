import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildDailyLearningPage,
  buildQueuePage,
  cleanItems,
  parentDraft,
  syncMarker,
  validateSubmissionId,
} from '../supabase/functions/notion-learning-sync/domain.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const reviewedRecord = {
  submissionId: '4f61bbcc-577d-4da8-a96c-0f83d50331d6',
  studentName: '테스트학생',
  assignmentTitle: '중선정리 기본 과제',
  assignmentDescription: '삼각형 심화 01',
  status: 'needs_revision',
  reviewedAt: '2026-09-10T12:34:56+09:00',
  feedbackBody: '이번 제출에서 다시 확인할 부분입니다.',
  internalNote: '원장만 보는 메모',
  items: [
    { problem_ref: '3번', review_tag: '개념 연결 보완', comment: '중점 조건 확인', redo_required: true },
    { problem_ref: '4번', review_tag: '계산·부호 확인', comment: '', redo_required: false },
  ],
};

describe('Notion learning sync domain', () => {
  it('validates submission UUIDs and builds a searchable marker', () => {
    expect(validateSubmissionId('4F61BBCC-577D-4DA8-A96C-0F83D50331D6')).toBe(reviewedRecord.submissionId);
    expect(() => validateSubmissionId('not-a-uuid')).toThrow('invalid submission');
    expect(syncMarker(reviewedRecord.submissionId)).toContain(reviewedRecord.submissionId);
  });

  it('maps reviewed submissions into the TEST daily learning record schema', () => {
    const page = buildDailyLearningPage('daily-ds', reviewedRecord);
    expect(page.parent).toEqual({ type: 'data_source_id', data_source_id: 'daily-ds' });
    expect(page.properties['제목'].title[0].text.content).toContain('테스트학생');
    expect(page.properties['수업날짜'].date.start).toBe('2026-09-10');
    expect(page.properties['공통진도'].rich_text[0].text.content).toBe('중선정리 기본 과제');
    expect(page.properties['막힌 지점'].multi_select).toEqual([{ name: '개념 연결 보완' }, { name: '계산·부호 확인' }]);
    expect(page.properties['재풀이 결과'].select.name).toBe('미실시');
    expect(page.properties['다음 관리강도'].select.name).toBe('강화');
    expect(page.properties['발송승인'].select.name).toBe('초안');
    expect(page.properties['we-math 출처ID'].rich_text[0].text.content).toContain(syncMarker(reviewedRecord.submissionId));
    expect(JSON.stringify(page.children)).toContain('원장만 보는 메모');
  });

  it('creates an operations queue row for redo follow-up without sending parent messages', () => {
    const page = buildQueuePage('queue-ds', reviewedRecord);
    expect(page.parent).toEqual({ type: 'data_source_id', data_source_id: 'queue-ds' });
    expect(page.properties['업무명'].title[0].text.content).toContain('재풀이 확인');
    expect(page.properties['업무분류'].multi_select).toEqual([{ name: '재풀이확인' }]);
    expect(page.properties['업무상태'].status.name).toBe('시작 전');
    expect(page.properties['우선순위'].select.name).toBe('높음');
    expect(page.properties['처리메모'].rich_text[0].text.content).toContain(syncMarker(reviewedRecord.submissionId));
    expect(page.properties['작성완료'].checkbox).toBe(false);
  });

  it('keeps completed submissions lower intensity', () => {
    const completed = { ...reviewedRecord, status: 'completed', items: [{ problem_ref: '1번', review_tag: '풀이 마무리·검산', redo_required: false }] };
    expect(parentDraft(completed)).toContain('제출을 완료했습니다');
    expect(buildDailyLearningPage('daily-ds', completed).properties['다음 관리강도'].select.name).toBe('유지');
    expect(buildQueuePage('queue-ds', completed).properties['업무분류'].multi_select).toEqual([{ name: '데일리레포트' }]);
  });

  it('normalizes sparse feedback items', () => {
    expect(cleanItems([{ problem_ref: ' ', review_tag: '', comment: '' }, { problem_ref: '2', review_tag: '계산', redo_required: true }]))
      .toEqual([{ problem_ref: '2', review_tag: '계산', comment: '', redo_required: true }]);
  });
});

describe('Notion learning sync integration wiring', () => {
  it('runs as an authenticated admin-only server boundary and keeps Notion secrets server-side', () => {
    const edge = read('supabase/functions/notion-learning-sync/index.ts');
    const config = read('supabase/config.toml');
    const browser = read('src/portal/admin.js');

    expect(edge).toContain("Deno.env.get('NOTION_API_KEY')");
    expect(edge).toContain("Deno.env.get('NOTION_LEARNING_DAILY_DATA_SOURCE_ID')");
    expect(edge).toContain("Deno.env.get('NOTION_LEARNING_QUEUE_DATA_SOURCE_ID')");
    expect(edge).toContain('ensureAdmin');
    expect(edge).toContain("service.from('user_roles')");
    expect(edge).toContain("service.from('profiles')");
    expect(edge).toContain('/data_sources/${dataSourceId}/query');
    expect(edge).toContain('syncMarker(submissionId)');
    expect(edge).toContain('AbortSignal.timeout(notionTimeoutMs)');
    expect(config).toMatch(/\[functions[.]notion-learning-sync\]\s+verify_jwt = false/);
    expect(browser).not.toMatch(/NOTION_API|NOTION_LEARNING|secret_/);
  });

  it('calls Notion sync only after review_submission_v2 succeeds and does not roll back review on sync failure', () => {
    const admin = read('src/portal/admin.js');
    expect(admin).toContain("invokeAuthenticated('notion-learning-sync', { submissionId })");
    expect(admin.indexOf("rpc('review_submission_v2'")).toBeLessThan(admin.indexOf('await syncReviewedSubmissionToNotion(decidedId)'));
    expect(admin.indexOf('if (result.error) throw result.error;')).toBeLessThan(admin.indexOf('await syncReviewedSubmissionToNotion(decidedId)'));
    expect(admin).toContain('검토 처리는 완료됐지만 Notion 학습기록 동기화는 실패했습니다');
  });
});
