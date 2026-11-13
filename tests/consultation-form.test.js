import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('consultation form UI', () => {
  it('keeps the landing page concise and moves consultation intake to a dedicated page', () => {
    const landing = read('index.html');
    const consultation = read('consultation/index.html');
    const consultationHrefs = [...landing.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .filter((match) => /상담 신청|첫 학습 진단 상담/.test(match[2]))
      .map((match) => match[1]);

    expect(landing).not.toContain('<form class="contact-form-card');
    expect(landing).not.toContain('href="#contact"');
    expect(consultationHrefs.length).toBeGreaterThanOrEqual(6);
    expect(new Set(consultationHrefs)).toEqual(new Set(['/consultation/']));
    expect(consultation).toContain('<form class="contact-form-card');
    expect(consultation).toContain('href="/"');
  });

  it('offers a saved 15-question habit diagnostic and clearly marks Kakao consultation as unavailable until launch', () => {
    const html = read('consultation/index.html');
    expect(html).toContain('id="consultation-paths"');
    expect(html).toContain('id="openMathCheck"');
    expect(html).toContain('수학 공부 습관 진단');
    expect(html).toContain('15개 질문');
    expect(html).toContain('카카오톡 채널 상담');
    expect(html).toContain('채널 준비 중');
    expect(html).not.toMatch(/href="https:\/\/pf[.]kakao[.]com\//);
    expect(html).toContain('id="mathCheckDialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="habitDiagnosticWidget"');
    expect(html).not.toContain('답변은 전송되거나 저장되지 않습니다');
  });

  it('keeps an empty toast fully hidden until a status message is shown', () => {
    const css = read('src/style.css');
    expect(css).toMatch(/\.toast \{[\s\S]*?opacity: 0;[\s\S]*?visibility: hidden;/);
    expect(css).toMatch(/\.toast\.show \{[\s\S]*?opacity: 1;[\s\S]*?visibility: visible;/);
  });

  it('collects the five diagnostic fields and explicit privacy consent in a real form', () => {
    const html = read('consultation/index.html');
    expect(html).toContain('<form class="contact-form-card');
    for (const id of [
      'f-name', 'f-phone', 'f-grade', 'f-type', 'f-difficulties',
      'f-habit', 'f-goal', 'f-msg', 'f-contact-time', 'f-privacy', 'f-website',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="f-privacy"[^>]*type="checkbox"[^>]*required/);
    expect(html).toMatch(/id="f-website"[^>]*name="website"[^>]*tabindex="-1"[^>]*autocomplete="off"/);
    expect(html).toMatch(/id="formSubmit"[^>]*type="submit"/);
    for (const disclosure of [
      '수집 항목:', '이용 목적:', '보유기간: 상담 종료 후 1년',
      '동의를 거부할 권리', '동의 거부 시 상담 신청이 불가', '위 내용을 확인하고 동의',
    ]) expect(html).toContain(disclosure);
  });

  it('submits through the server function and resets only after confirmed success', () => {
    const source = read('src/main.js');
    expect(source).toContain("supabase.functions.invoke('consultation-intake'");
    expect(source).toContain("form.addEventListener('submit', async (event)");
    expect(source).toContain('submitButton.disabled = true');
    expect(source).toContain('form.reset();');
    expect(source).toContain('AbortSignal.timeout(15_000)');
    expect(source).toContain('|| crypto.randomUUID()');
    expect(source).toContain("sessionStorage.getItem(submissionStorageKey)");
    expect(source).toContain('sessionStorage.setItem(submissionStorageKey, submissionId)');
    expect(source).toContain('submissionId,');
    expect(source.indexOf('form.reset();')).toBeLessThan(source.lastIndexOf('submissionId = crypto.randomUUID();'));
    expect(source.indexOf('if (error) throw error')).toBeLessThan(source.indexOf('form.reset();'));
    expect(source).toContain('catch (error)');
    expect(source).toContain('접수되지 않았습니다');
    expect(source).toContain('문자를 남겨주세요');
    expect(source).not.toContain('전화 상담도 가능합니다');
  });

  it('offers contact times only from 1pm onward', () => {
    const html = read('consultation/index.html');
    const select = html.match(/<select id="f-contact-time"[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(select).not.toContain('오전 9시 ~ 12시');
    expect(select).not.toContain('점심시간(12시 ~ 1시)');
    expect(select).toContain('오후 1시 ~ 6시');
    expect(select).toContain('저녁 6시 이후');
  });

  it('sets expectations for text-first phone consultation without a daily limit', () => {
    const html = read('consultation/index.html');
    expect(html).toContain('id="consultation-fallback"');
    expect(html).toContain('href="sms:010-2496-4031"');
    expect(html).toContain('1인 원장으로 운영');
    expect(html).toContain('문자를 남겨주시면 순차적으로 연락드리겠습니다');
    expect(html).not.toContain('상담 품질을 위해 하루 최대 2회만 진행');
    expect(html).not.toContain('전화 상담도 가능합니다');
  });

  it('uses only Notion-compatible option labels', () => {
    const html = read('consultation/index.html');
    for (const option of [
      '개념 이해', '문제 해석', '계산', '풀이 습관',
      '학습 습관', '학습 자신감', '진도 부적응', '기타',
      '있음', '부분적으로 있음', '없음', '확인 필요',
    ]) expect(html).toContain(`value="${option}"`);
  });
});
