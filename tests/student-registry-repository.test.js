import { describe, expect, it, vi } from 'vitest';
import {
  createStudentRegistryRepository,
  isMissingStudentRegistryBackend,
  loadPersistentStudentRegistry,
  normalizeStudentRegistryRow,
} from '../src/portal/student-registry-repository.js';

describe('student registry repository', () => {
  it('classifies only exact missing table or expected RPC errors as staged rollout', () => {
    expect(isMissingStudentRegistryBackend({ code: 'PGRST205', message: "Could not find the table 'public.students'" })).toBe(true);
    expect(isMissingStudentRegistryBackend({ code: '42P01', message: 'relation "public.students" does not exist' })).toBe(true);
    expect(isMissingStudentRegistryBackend({ code: 'PGRST202', message: 'Could not find public.admin_create_student' })).toBe(true);
    expect(isMissingStudentRegistryBackend({ code: 'PGRST202', message: 'Could not find public.admin_update_student' })).toBe(true);
    expect(isMissingStudentRegistryBackend({ code: '42501', message: 'permission denied for table students' })).toBe(false);
    expect(isMissingStudentRegistryBackend({ code: 'PGRST205', message: "Could not find the table 'public.profiles'" })).toBe(false);
    expect(isMissingStudentRegistryBackend({ code: 'PGRST205', message: "Could not find the table 'public.students_archive'" })).toBe(false);
    expect(isMissingStudentRegistryBackend({ code: '42P01', message: 'relation "public.students_private" does not exist' })).toBe(false);
    expect(isMissingStudentRegistryBackend({ code: 'PGRST202', message: 'Could not find public.other_rpc' })).toBe(false);
  });

  it('normalizes null, object, and array relation shapes without exposing login profile data', () => {
    const base = {
      id: 'student-1', name: '홍길동1', status: 'active', grade: '중등 1학년', school: '테스트중학교',
      is_test_data: true, account_profile_id: null, registered_on: '2026-10-31', note: '테스트',
    };
    expect(normalizeStudentRegistryRow({ ...base, guardians: null, enrollments: null })).toMatchObject({
      guardianName: '', guardianPhone: '', course: '', classGroup: '', accountProfileId: null,
    });
    expect(normalizeStudentRegistryRow({
      ...base,
      guardians: { name: '보호자', phone: '010-0000-0001', is_primary: true },
      enrollments: { status: 'active', courses: { name: '중등과정' }, class_groups: { name: 'A반' } },
    })).toMatchObject({ guardianName: '보호자', guardianPhone: '010-0000-0001', course: '중등과정', classGroup: 'A반' });
    expect(normalizeStudentRegistryRow({
      ...base,
      guardians: [{ name: '보조', phone: 'x', is_primary: false }, { name: '주보호자', phone: 'y', is_primary: true }],
      enrollments: [{ status: 'paused', courses: [{ name: '이전과정' }], class_groups: null }, { status: 'active', courses: [{ name: '현재과정' }], class_groups: [{ name: 'B반' }] }],
    })).toMatchObject({ guardianName: '주보호자', guardianPhone: 'y', course: '현재과정', classGroup: 'B반' });
  });

  it('loads rows through the admin-only table projection and maps create/update RPC parameters', async () => {
    const rows = [{ id: 'student-1', name: '홍길동1', status: 'active', grade: '', school: '', is_test_data: true, guardians: [], enrollments: [] }];
    const order = vi.fn().mockResolvedValue({ data: rows, error: null });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: 'created-id', error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const repository = createStudentRegistryRepository({ from, rpc });

    await expect(repository.list()).resolves.toMatchObject([{ id: 'student-1', name: '홍길동1', isTestData: true }]);
    expect(from).toHaveBeenCalledWith('students');
    expect(select.mock.calls[0][0]).toContain('guardians(name,phone,is_primary)');
    expect(select.mock.calls[0][0]).not.toContain('profiles');

    const payload = {
      name: '홍길동4', grade: '중등 1학년', school: '테스트중학교', status: 'active',
      isTestData: true, guardianName: '테스트 보호자', guardianPhone: '010-0000-0004', registeredOn: '2026-10-31', note: '테스트',
    };
    await expect(repository.create(payload)).resolves.toBe('created-id');
    await expect(repository.update('student-1', payload)).resolves.toBeUndefined();
    expect(rpc.mock.calls[0]).toEqual(['admin_create_student', expect.objectContaining({ p_name: '홍길동4', p_is_test_data: true })]);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('created_by');
    expect(rpc.mock.calls[1]).toEqual(['admin_update_student', expect.objectContaining({ p_student_id: 'student-1', p_name: '홍길동4' })]);
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('p_is_test_data');
  });

  it('falls back only for a missing registry backend and rethrows permission failures', async () => {
    await expect(loadPersistentStudentRegistry({ list: vi.fn().mockRejectedValue({ code: 'PGRST205', message: "Could not find the table 'public.students'" }) }))
      .resolves.toEqual({ available: false, students: null });
    const permission = { code: '42501', message: 'permission denied for table students' };
    await expect(loadPersistentStudentRegistry({ list: vi.fn().mockRejectedValue(permission) })).rejects.toBe(permission);
  });
});
