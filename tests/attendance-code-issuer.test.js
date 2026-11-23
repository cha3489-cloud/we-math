import { describe, expect, it, vi } from 'vitest';
import { createAttendanceCodeIssuer } from '../src/portal/attendance-code.js';

const STUDENT = '00000000-0000-4000-8000-000000000001';

describe('admin attendance code issuer', () => {
  it('calls the authenticated attendance-code Edge Function issue operation', async () => {
    const invoke = vi.fn(async () => ({ code: '482913', issue_kind: 'issued' }));
    await expect(createAttendanceCodeIssuer(invoke)(STUDENT)).resolves.toEqual({ code: '482913', issue_kind: 'issued' });
    expect(invoke).toHaveBeenCalledWith('attendance-code', { op: 'issue', student_id: STUDENT });
  });

  it('rejects malformed responses and invalid student ids instead of showing a wrong number', async () => {
    await expect(createAttendanceCodeIssuer(vi.fn(async () => ({ code: '12' })))(STUDENT)).rejects.toThrow(/출석번호/);
    const invoke = vi.fn();
    await expect(createAttendanceCodeIssuer(invoke)('test-student-1')).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
