import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('consultation form UI', () => {
  it('collects the five diagnostic fields and explicit privacy consent in a real form', () => {
    const html = read('index.html');
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
  });

  it('uses only Notion-compatible option labels', () => {
    const html = read('index.html');
    for (const option of [
      '개념 이해', '문제 해석', '계산', '풀이 습관',
      '학습 습관', '학습 자신감', '진도 부적응', '기타',
      '있음', '부분적으로 있음', '없음', '확인 필요',
    ]) expect(html).toContain(`value="${option}"`);
  });
});
