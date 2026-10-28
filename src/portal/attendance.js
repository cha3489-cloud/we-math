const ATTENDANCE_BACKEND_TABLES = ['attendance_records', 'makeup_plans', 'attendance_events'];

function relationRows(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

export function attendanceNextAction(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.status === 'scheduled') return 'check_in';
  if (record.status !== 'absent' && record.status !== 'excused') return null;
  if (!record.guardian_contact_status) return 'guardian_contact';

  const plans = relationRows(record.makeup_plans);
  if (plans.some((plan) => plan?.status === 'completed')) return null;
  if (plans.some((plan) => plan?.status === 'planned')) return 'makeup_pending';
  return 'makeup_plan';
}

export function isAttendanceBackendMissing(error) {
  if (!error || !['42P01', 'PGRST205'].includes(error.code)) return false;
  const message = typeof error.message === 'string' ? error.message : '';
  return ATTENDANCE_BACKEND_TABLES.some((table) => message.includes(table));
}

export function areAttendanceBackendErrorsMissing(errors) {
  const presentErrors = Array.isArray(errors) ? errors.filter(Boolean) : [];
  return presentErrors.length > 0 && presentErrors.every(isAttendanceBackendMissing);
}
