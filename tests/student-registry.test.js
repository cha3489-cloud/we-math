import { describe, expect, it } from 'vitest';
import {
  TEST_STUDENTS,
  filterStudentRegistry,
  updateStudentRecord,
} from '../src/portal/student-registry.js';

describe('student registry pilot records', () => {
  it('provides exactly three clearly marked synthetic students without login-account linkage', () => {
    expect(TEST_STUDENTS.map((student) => student.name)).toEqual(['홍길동1', '홍길동2', '홍길동3']);
    expect(new Set(TEST_STUDENTS.map((student) => student.id)).size).toBe(3);
    for (const student of TEST_STUDENTS) {
      expect(student.isTestData).toBe(true);
      expect(student.accountProfileId).toBeNull();
      expect(student.school).toContain('테스트');
      expect(student.guardianPhone).toMatch(/^010-0000-000[123]$/);
    }
  });

  it('filters synthetic students by status and Korean name or school search', () => {
    expect(filterStudentRegistry(TEST_STUDENTS, { status: 'paused' }).map((student) => student.name)).toEqual(['홍길동2']);
    expect(filterStudentRegistry(TEST_STUDENTS, { query: '길동3' }).map((student) => student.name)).toEqual(['홍길동3']);
    expect(filterStudentRegistry(TEST_STUDENTS, { query: '테스트중' }).map((student) => student.name)).toEqual(['홍길동2']);
  });

  it('updates an allowed operating field without mutating identity or test-data boundaries', () => {
    const updated = updateStudentRecord(TEST_STUDENTS, 'test-student-2', {
      status: 'active',
      course: '중등 수학 테스트 과정 B',
    });
    const target = updated.find((student) => student.id === 'test-student-2');
    expect(target).toMatchObject({
      name: '홍길동2',
      status: 'active',
      course: '중등 수학 테스트 과정 B',
      isTestData: true,
      accountProfileId: null,
    });
    expect(TEST_STUDENTS.find((student) => student.id === 'test-student-2')?.status).toBe('paused');
  });

  it('rejects unknown students and protected-field edits', () => {
    expect(() => updateStudentRecord(TEST_STUDENTS, 'missing', { status: 'active' })).toThrow('학생을 찾을 수 없습니다.');
    expect(() => updateStudentRecord(TEST_STUDENTS, 'test-student-1', { id: 'changed' })).toThrow('수정할 수 없는 학생 항목입니다.');
    expect(() => updateStudentRecord(TEST_STUDENTS, 'test-student-1', { isTestData: false })).toThrow('수정할 수 없는 학생 항목입니다.');
    expect(() => updateStudentRecord(TEST_STUDENTS, 'test-student-1', { status: 'deleted' })).toThrow('올바른 재원 상태가 아닙니다.');
  });
});
