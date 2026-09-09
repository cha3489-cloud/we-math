import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('quick observation fields source contracts', () => {
  it('adds one optional difficulty question to the student submission form', () => {
    const student = read('src/portal/student.js');
    const domain = read('src/portal/domain.js');
    expect(student).toContain('어디가 가장 어려웠나요? (선택)');
    for (const label of ['문제 이해', '식 세우기', '계산', '설명하기', '마무리 확인']) {
      expect(domain).toContain(label);
    }
    expect(student).toContain('composeSubmissionBodyWithDifficulty');
  });

  it('adds the admin quick observation block without changing the student-visible feedback fields', () => {
    const adminHtml = read('admin/index.html');
    const admin = read('src/portal/admin.js');
    expect(adminHtml).toContain('빠른 관찰');
    for (const id of ['observationCauses', 'observationExplanation', 'observationRetry', 'observationIntensity', 'applyObservationNote']) {
      expect(adminHtml).toContain('id=' + id);
    }
    expect(admin).toContain('composeObservationInternalNote');
    expect(admin).toContain('collectQuickObservation');
  });

  it('keeps the private observation database names out of the student source and built contract', () => {
    const student = read('src/portal/student.js');
    expect(student).not.toMatch(/review_internal_notes|upsert_review_internal_note|internalNote|원장확인|집중흐름/);
  });
});
