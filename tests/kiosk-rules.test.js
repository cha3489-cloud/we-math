import { describe, expect, it } from 'vitest';
import { classifyArrival, isMissingAttendance, isCheckoutOverdue, maskStudentName, kstEndOfDay, applyKeypadKey, kioskResultCopy } from '../src/kiosk/rules.js';

const start = '2026-11-16T07:00:00.000Z'; // 16:00 KST

describe('kiosk arrival classification', () => {
  it('treats arrival before or exactly at start as present and up to exactly 15 minutes later as late', () => {
    expect(classifyArrival(start, '2026-11-16T06:58:00.000Z')).toBe('present');
    expect(classifyArrival(start, start)).toBe('present');
    expect(classifyArrival(start, '2026-11-16T07:00:00.001Z')).toBe('late');
    expect(classifyArrival(start, '2026-11-16T07:15:00.000Z')).toBe('late');
  });
});

describe('follow-up eligibility', () => {
  const session = { starts_at: start, ends_at: '2026-11-16T08:30:00.000Z', status: 'scheduled' };
  it('flags missing attendance only after more than 15 minutes without a check-in', () => {
    const record = { status: 'scheduled', checked_in_at: null };
    expect(isMissingAttendance(record, session, '2026-11-16T07:15:00.000Z')).toBe(false);
    expect(isMissingAttendance(record, session, '2026-11-16T07:15:00.001Z')).toBe(true);
    expect(isMissingAttendance({ status: 'late', checked_in_at: start }, session, '2026-11-16T07:30:00.000Z')).toBe(false);
    expect(isMissingAttendance(record, { ...session, status: 'cancelled' }, '2026-11-16T07:30:00.000Z')).toBe(false);
  });
  it('suppresses missing attendance while a planned exception is active', () => {
    const record = { status: 'scheduled', checked_in_at: null };
    expect(isMissingAttendance(record, session, '2026-11-16T07:30:00.000Z', { status: 'active', exception_type: 'expected_late' })).toBe(false);
    expect(isMissingAttendance(record, session, '2026-11-16T07:30:00.000Z', { status: 'cancelled', exception_type: 'expected_late' })).toBe(true);
  });
  it('requires checkout follow-up only after scheduled end plus 30 minutes', () => {
    const checkedIn = { status: 'present', checked_in_at: start, checked_out_at: null };
    expect(isCheckoutOverdue(checkedIn, session, '2026-11-16T09:00:00.000Z')).toBe(false);
    expect(isCheckoutOverdue(checkedIn, session, '2026-11-16T09:00:00.001Z')).toBe(true);
    expect(isCheckoutOverdue({ ...checkedIn, checked_out_at: '2026-11-16T08:31:00.000Z' }, session, '2026-11-16T10:00:00.000Z')).toBe(false);
    expect(isCheckoutOverdue({ status: 'scheduled', checked_in_at: null }, session, '2026-11-16T10:00:00.000Z')).toBe(false);
  });
  it('rejects malformed inputs without inventing work', () => {
    expect(isMissingAttendance(null, session, start)).toBe(false);
    expect(isMissingAttendance({ status: 'scheduled' }, { starts_at: 'bad' }, start)).toBe(false);
    expect(isCheckoutOverdue({ status: 'present', checked_in_at: start }, null, start)).toBe(false);
    expect(classifyArrival('bad', start)).toBe(null);
  });
});

describe('kiosk privacy and input helpers', () => {
  it('masks all but the first character of a student name', () => {
    expect(maskStudentName('가나다')).toBe('가○○');
    expect(maskStudentName('가나')).toBe('가○');
    expect(maskStudentName('가')).toBe('가');
    expect(maskStudentName('  ')).toBe('학생');
    expect(maskStudentName(null)).toBe('학생');
  });
  it('computes the end of the Asia/Seoul calendar day of the send moment', () => {
    // 2026-11-16 23:30 KST == 14:30Z
    expect(kstEndOfDay('2026-11-16T14:30:00.000Z').toISOString()).toBe('2026-11-16T14:59:59.999Z');
    // 2026-11-17 00:10 KST == 2026-11-16 15:10Z belongs to the next KST date
    expect(kstEndOfDay('2026-11-16T15:10:00.000Z').toISOString()).toBe('2026-11-17T14:59:59.999Z');
    expect(kstEndOfDay('bad')).toBe(null);
  });
  it('accepts only up to six digits from the keypad and supports clear/back', () => {
    let code = '';
    for (const key of ['1', '2', '3', '4', '5', '6', '7']) code = applyKeypadKey(code, key);
    expect(code).toBe('123456');
    expect(applyKeypadKey(code, 'back')).toBe('12345');
    expect(applyKeypadKey(code, 'clear')).toBe('');
    expect(applyKeypadKey('12', 'x')).toBe('12');
    expect(applyKeypadKey('12', 'Backspace')).toBe('1');
  });
  it('renders minimal masked copy for kiosk results without exposing details', () => {
    expect(kioskResultCopy({ result: 'checked_in', status: 'late', student_label: '가○○', at: '2026-11-16T07:02:00.000Z' }, 'check_in'))
      .toEqual({ tone: 'success', title: '가○○ 학생', detail: '16:02 등원 확인 · 지각', hint: '학습 태블릿에서 전화번호와 PIN으로 로그인하세요.' });
    expect(kioskResultCopy({ result: 'already_checked_in', student_label: '가○○', at: '2026-11-16T07:02:00.000Z' }, 'check_in').detail).toBe('이미 16:02에 등원 처리되었습니다.');
    expect(kioskResultCopy({ result: 'checked_out', student_label: '가○○', at: '2026-11-16T08:31:00.000Z' }, 'check_out').detail).toBe('17:31 하원 확인');
    expect(kioskResultCopy({ result: 'already_checked_out', student_label: '가○○', at: '2026-11-16T08:31:00.000Z' }, 'check_out').detail).toBe('이미 17:31에 하원 처리되었습니다.');
    expect(kioskResultCopy({ result: 'not_found' }, 'check_in')).toEqual({ tone: 'error', title: '번호를 확인해 주세요', detail: '번호가 맞지 않거나 오늘 처리할 수업이 없습니다.', hint: '계속 안 되면 선생님께 말해 주세요.' });
    expect(kioskResultCopy({ result: 'rate_limited' }, 'check_in').title).toBe('잠시 후 다시 시도해 주세요');
    expect(kioskResultCopy({ result: 'device_not_registered' }, 'check_in').title).toBe('등록되지 않은 출석 기기입니다');
    expect(kioskResultCopy({ result: 'not_checked_in' }, 'check_out').title).toBe('등원 기록이 없습니다');
    expect(kioskResultCopy(null, 'check_in').tone).toBe('error');
  });
});
