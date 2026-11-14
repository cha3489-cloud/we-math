import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrations = new URL('../supabase/migrations/', import.meta.url);
let db;
afterEach(async () => { if (db) await db.close(); db = null; });

describe('attendance migration executable contract', () => {
  it('runs the migration chain and enforces registry, transitions, contact, and immutable audit rules', async () => {
    const attendanceSql = await readFile(new URL('20261028000000_attendance_makeup_operations.sql', migrations), 'utf8');
    const registrySql = await readFile(new URL('20261031010000_student_registry.sql', migrations), 'utf8');
    const alignmentSql = await readFile(new URL('20261114000000_attendance_student_registry_alignment.sql', migrations), 'utf8');
    const admin = '00000000-0000-0000-0000-000000000001';
    const fakeId = '00000000-0000-0000-0000-000000000099';
    db = new PGlite();
    await db.exec(`
      create role authenticated;
      create role anon;
      create schema auth;
      create table public.profiles (id uuid primary key, name text, suspended_at timestamptz);
      insert into public.profiles (id, name) values ('${admin}', '관리자');
      create function public.is_admin() returns boolean language sql stable as $$ select true $$;
      create function auth.uid() returns uuid language sql stable as $$ select '${admin}'::uuid $$;
    `);
    await db.exec(attendanceSql);
    await db.exec(registrySql);
    await db.exec(alignmentSql);

    const studentResult = await db.query(`insert into public.students (name) values ('비로그인 학생') returning id`);
    const studentId = studentResult.rows[0].id;
    const attendance = await db.query(`
      insert into public.attendance_records
        (id, student_id, scheduled_at, status, note, created_by, updated_by, created_at, updated_at)
      values ($1, $2, '2026-11-14T10:00:00Z', 'scheduled', '첫 기록', $3, $3, '2000-01-01', '2000-01-01')
      returning id, created_at
    `, [fakeId, studentId, admin]);
    const attendanceId = attendance.rows[0].id;
    expect(attendanceId).not.toBe(fakeId);
    expect(new Date(attendance.rows[0].created_at).getUTCFullYear()).toBeGreaterThan(2025);

    await db.query(`update public.attendance_records set status='absent', note='결석 확인' where id=$1`, [attendanceId]);
    await expect(db.query(`update public.attendance_records set status='present', checked_in_at=now() where id=$1`, [attendanceId]))
      .rejects.toThrow(/final attendance status is immutable/);

    await db.query(`update public.attendance_records set guardian_contact_status='unreachable', guardian_contacted_at=now() where id=$1`, [attendanceId]);
    await expect(db.query(`
      insert into public.makeup_plans (attendance_id, scheduled_at, method, created_by, updated_by)
      values ($1, '2026-11-15T10:00:00Z', 'in_person', $2, $2)
    `, [attendanceId, admin])).rejects.toThrow(/guardian contact outcome required/);

    await db.query(`update public.attendance_records set guardian_contact_status='contacted', guardian_contacted_at=now() where id=$1`, [attendanceId]);
    await expect(db.query(`update public.attendance_records set guardian_contact_status='unreachable', guardian_contacted_at=now() where id=$1`, [attendanceId]))
      .rejects.toThrow(/completed guardian contact is immutable/);

    const makeup = await db.query(`
      insert into public.makeup_plans (attendance_id, scheduled_at, method, note, created_by, updated_by)
      values ($1, '2026-11-15T10:00:00Z', 'in_person', '보강 메모', $2, $2)
      returning id
    `, [attendanceId, admin]);
    await db.query(`update public.makeup_plans set status='completed', completed_at=now() where id=$1`, [makeup.rows[0].id]);
    await expect(db.query(`update public.makeup_plans set note='변조' where id=$1`, [makeup.rows[0].id]))
      .rejects.toThrow(/completed makeup is immutable/);

    const events = await db.query(`select id, event_type, details from public.attendance_events where attendance_id=$1 order by created_at, id`, [attendanceId]);
    expect(events.rows.length).toBe(6);
    const attendanceUpdate = events.rows.find((row) => row.event_type === 'attendance_updated' && row.details?.before?.note === '첫 기록');
    expect(attendanceUpdate?.details?.after?.note).toBe('결석 확인');
    const makeupCreated = events.rows.find((row) => row.event_type === 'makeup_created');
    expect(makeupCreated?.details?.before).toBeNull();
    expect(makeupCreated?.details?.after?.note).toBe('보강 메모');
    await expect(db.query(`delete from public.attendance_events where id=$1`, [events.rows[0].id]))
      .rejects.toThrow(/attendance audit rows are immutable/);
  }, 30_000);
});
