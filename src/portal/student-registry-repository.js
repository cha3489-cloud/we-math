const STUDENT_REGISTRY_SELECT = [
  'id', 'name', 'status', 'grade', 'school', 'is_test_data', 'account_profile_id', 'registered_on', 'note',
  'guardians(name,phone,is_primary)',
  'enrollments(status,enrolled_on,ended_on,courses(name),class_groups(name))',
].join(',');

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function firstRelation(value) {
  return asArray(value)[0] || null;
}

export function isMissingStudentRegistryBackend(error) {
  const code = String(error?.code || '');
  const message = `${error?.message || ''} ${error?.details || ''}`;
  if ((code === 'PGRST205' || code === '42P01') && /(?:^|[^A-Za-z0-9_$])public[.]students(?![A-Za-z0-9_$])/i.test(message)) return true;
  return code === 'PGRST202' && /public[.](admin_create_student|admin_update_student)\b/i.test(message);
}

export function normalizeStudentRegistryRow(row) {
  const guardians = asArray(row?.guardians);
  const guardian = guardians.find((entry) => entry?.is_primary) || guardians[0] || null;
  const enrollments = asArray(row?.enrollments);
  const enrollment = enrollments.find((entry) => entry?.status === 'active') || enrollments[0] || null;
  const course = firstRelation(enrollment?.courses);
  const classGroup = firstRelation(enrollment?.class_groups);
  return {
    id: String(row?.id || ''),
    name: String(row?.name || ''),
    status: String(row?.status || ''),
    grade: String(row?.grade || ''),
    school: String(row?.school || ''),
    course: String(course?.name || ''),
    classGroup: String(classGroup?.name || ''),
    guardianName: String(guardian?.name || ''),
    guardianPhone: String(guardian?.phone || ''),
    registeredOn: String(row?.registered_on || ''),
    note: String(row?.note || ''),
    isTestData: row?.is_test_data === true,
    accountProfileId: row?.account_profile_id || null,
  };
}

function rpcPayload(payload) {
  return {
    p_name: String(payload?.name || '').trim(),
    p_grade: String(payload?.grade || '').trim(),
    p_school: String(payload?.school || '').trim(),
    p_status: String(payload?.status || ''),
    p_guardian_name: String(payload?.guardianName || '').trim(),
    p_guardian_phone: String(payload?.guardianPhone || '').trim(),
    p_registered_on: payload?.registeredOn || null,
    p_note: String(payload?.note || '').trim(),
  };
}

export function createStudentRegistryRepository(client) {
  return {
    async list() {
      const { data, error } = await client.from('students').select(STUDENT_REGISTRY_SELECT).order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map(normalizeStudentRegistryRow);
    },
    async create(payload) {
      const parameters = { ...rpcPayload(payload), p_is_test_data: payload?.isTestData === true };
      const { data, error } = await client.rpc('admin_create_student', parameters);
      if (error) throw error;
      return data;
    },
    async update(studentId, payload) {
      const parameters = { ...rpcPayload(payload), p_student_id: studentId };
      const { error } = await client.rpc('admin_update_student', parameters);
      if (error) throw error;
    },
  };
}

export async function loadPersistentStudentRegistry(repository) {
  try {
    return { available: true, students: await repository.list() };
  } catch (error) {
    if (isMissingStudentRegistryBackend(error)) return { available: false, students: null };
    throw error;
  }
}
