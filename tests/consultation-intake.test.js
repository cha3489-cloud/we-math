import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildNotionPage,
  validateConsultationInput,
} from '../supabase/functions/consultation-intake/domain.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const validInput = {
  studentName: ' 홍길동 ',
  parentPhone: '010-1234-5678',
  grade: '중학교 2학년',
  learningType: '대형학원',
  difficulties: ['개념 이해', '학습 자신감'],
  studyHabit: '부분적으로 있음',
  learningGoal: '중2 과정의 개념을 다시 정리하고 싶습니다.',
  message: '전화 전에 문자 부탁드립니다.',
  contactTimes: ['저녁 6시 이후'],
  privacyConsent: true,
  website: '',
  submissionId: '4f61bbcc-577d-4da8-a96c-0f83d50331d6',
};

describe('public consultation intake', () => {
  it('normalizes the five diagnostic fields and parent contact data', () => {
    expect(validateConsultationInput(validInput)).toEqual({
      studentName: '홍길동',
      parentPhone: '01012345678',
      grade: '중학교 2학년',
      learningType: '대형학원',
      difficulties: ['개념 이해', '학습 자신감'],
      studyHabit: '부분적으로 있음',
      learningGoal: '중2 과정의 개념을 다시 정리하고 싶습니다.',
      message: '전화 전에 문자 부탁드립니다.',
      contactTimes: ['저녁 6시 이후'],
      privacyConsent: true,
      submissionId: '4f61bbcc-577d-4da8-a96c-0f83d50331d6',
    });
  });

  it.each([
    [{ ...validInput, studentName: '' }, '학생 이름'],
    [{ ...validInput, parentPhone: '1234' }, '연락처'],
    [{ ...validInput, parentPhone: 'call 010-1234-5678' }, '연락처'],
    [{ ...validInput, grade: '' }, '학년'],
    [{ ...validInput, learningType: '' }, '기존 학습 형태'],
    [{ ...validInput, learningType: '임의 입력' }, '기존 학습 형태 선택값'],
    [{ ...validInput, difficulties: [] }, '어려움'],
    [{ ...validInput, studyHabit: '' }, '학습 습관'],
    [{ ...validInput, learningGoal: '' }, '학습 목표'],
    [{ ...validInput, privacyConsent: false }, '개인정보'],
    [{ ...validInput, website: 'spam.example' }, '접수할 수 없습니다'],
    [{ ...validInput, submissionId: 'not-a-uuid' }, '접수 식별자'],
  ])('rejects invalid or automated input', (input, message) => {
    expect(() => validateConsultationInput(input)).toThrow(message);
  });

  it.each(['대형학원', '소규모학원', '과외', '인강', '혼자 공부', '기타'])(
    'accepts the UI learning type allowlist value %s',
    (learningType) => {
      expect(validateConsultationInput({ ...validInput, learningType }).learningType).toBe(learningType);
    },
  );

  it('maps a validated request to the TEST database properties', () => {
    const validated = validateConsultationInput(validInput);
    const page = buildNotionPage('43430764-7dec-42d8-922c-bfe18ac4a327', validated);

    expect(page.parent).toEqual({ database_id: '43430764-7dec-42d8-922c-bfe18ac4a327' });
    expect(page.properties['상담 기록명'].title[0].text.content).toBe('홈페이지 · 홍길동 · 중학교 2학년');
    expect(page.properties['학생 이름'].rich_text[0].text.content).toBe('홍길동');
    expect(page.properties['학부모 연락처'].phone_number).toBe('01012345678');
    expect(page.properties['학년'].select.name).toBe('중학교 2학년');
    expect(page.properties['기존 학습 형태'].rich_text[0].text.content).toBe('대형학원');
    expect(page.properties['어려움의 종류'].multi_select).toEqual([{ name: '개념 이해' }, { name: '학습 자신감' }]);
    expect(page.properties['규칙적 학습 습관'].select.name).toBe('부분적으로 있음');
    expect(page.properties['학습 목표'].rich_text[0].text.content).toContain('중2 과정');
    expect(page.properties['추가 문의'].rich_text[0].text.content).toContain('문자');
    expect(page.properties['추가 문의'].rich_text[0].text.content).toContain(validInput.submissionId);
    expect(page.properties['연락 가능 시간'].multi_select).toEqual([{ name: '저녁 6시 이후' }]);
    expect(page.properties['상담 유형'].select.name).toBe('신규 문의');
    expect(page.properties['상담 상태'].select.name).toBe('예정');
    expect(page.properties['접수 경로'].select.name).toBe('홈페이지');
    expect(page.properties['개인정보 동의'].checkbox).toBe(true);
  });

  it('requires server-side rate limiting backed by a service-only RPC', () => {
    const edge = read('supabase/functions/consultation-intake/index.ts');
    const migration = read('supabase/migrations/20260804045106_consultation_intake_rate_limit.sql');

    expect(edge).toContain('checkConsultationRateLimit');
    expect(edge).toContain('CONSULTATION_RATE_LIMIT_SALT');
    expect(edge).toContain('check_consultation_intake_rate_limit');
    expect(edge).toContain("request.headers.get('cf-connecting-ip')");
    expect(edge).not.toContain("request.headers.get('x-forwarded-for')");
    expect(edge).not.toContain("request.headers.get('x-real-ip')");
    expect(edge).toContain("hash('ip', clientIp)");
    expect(edge).toContain("hash('phone', parentPhone)");
    expect(edge).toContain('p_max_requests: 20');
    expect(edge).toContain('p_max_requests: 3');
    expect(edge).toContain("Deno.env.get('CONSULTATION_SERVICE_ROLE_KEY')");
    expect(edge).not.toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
    expect(edge).toContain("'apikey': serviceRoleKey");
    expect(edge).toContain("'authorization': `Bearer ${serviceRoleKey}`");
    expect(edge).toContain('signal: AbortSignal.timeout(rpcTimeoutMs)');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('grant execute on function public.check_consultation_intake_rate_limit(text, integer) to service_role');
    expect(migration).toContain("interval '1 hour'");
    expect(migration).toContain('consultation_intake_rate_limits_window_started_at_idx');
  });

  it('claims a service-only UUID ledger before Notion and completes or releases it explicitly', () => {
    const edge = read('supabase/functions/consultation-intake/index.ts');
    const migration = read('supabase/migrations/20260804045106_consultation_intake_rate_limit.sql');

    for (const action of ['claim', 'complete', 'fail']) {
      expect(edge).toContain(`${action}_consultation_intake_submission`);
      expect(migration).toContain(`public.${action}_consultation_intake_submission`);
    }
    expect(edge.indexOf('await checkConsultationRateLimit')).toBeLessThan(edge.indexOf('await claimSubmission'));
    expect(edge.indexOf('await claimSubmission')).toBeLessThan(edge.indexOf('await fetch(notionUrl'));
    expect(edge).toContain("claim === 'completed'");
    expect(edge).toContain('deduplicated: true');
    expect(edge).toContain("claim === 'pending'");
    expect(edge).toContain("claim === 'reconcile'");
    expect(edge).toContain('findNotionPageBySubmission');
    expect(edge).toContain('/v1/data_sources/${dataSourceId}/query');
    expect(edge).toContain('submissionMarker(submissionId)');
    expect(edge).toContain('}, 409)');
    expect(edge).toContain('signal: AbortSignal.timeout(notionTimeoutMs)');
    expect(edge).toContain("'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info'");
    expect(edge).toContain('if (notionResponse.status < 500) await failSubmission');
    expect(edge).not.toContain('trackingDelayed: true');
    expect(edge).toContain('status === 204 ? null');
    expect(migration).toContain('submission_id uuid primary key');
    expect(migration).toContain('notion_page_id text');
    expect(migration).toContain("interval '2 minutes'");
    expect(migration).toContain('consultation_intake_submissions_updated_at_idx');
    expect(migration).toContain('alter table public.consultation_intake_submissions enable row level security');
    expect(migration).toMatch(/revoke all on function public[.]claim_consultation_intake_submission\(uuid\) from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public[.]claim_consultation_intake_submission\(uuid\) to service_role/);
    expect(migration).toMatch(/grant execute on function public[.]complete_consultation_intake_submission\(uuid, text\) to service_role/);
  });

  it('keeps Notion credentials server-side and configures the function as public with in-function checks', () => {
    const edge = read('supabase/functions/consultation-intake/index.ts');
    const config = read('supabase/config.toml');
    const browser = read('src/main.js');

    expect(edge).toContain("Deno.env.get('NOTION_API_KEY')");
    expect(edge).toContain("Deno.env.get('NOTION_CONSULTATION_DATABASE_ID')");
    expect(edge).toContain('isAllowedOrigin');
    expect(edge).toContain("https://api.notion.com/v1/pages");
    expect(config).toMatch(/\[functions[.]consultation-intake\]\s+verify_jwt = false/);
    expect(browser).not.toMatch(/NOTION_API|secret_/);
  });
});
