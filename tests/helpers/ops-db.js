import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { attendanceVerifier } from '../../supabase/functions/attendance-code/domain.ts';

// Test-only HMAC key. The database never sees it: PGlite tests store and look up
// precomputed verifiers exactly like the Edge Function does in production.
const TEST_HMAC_KEY = 'pglite-test-only-hmac-key-not-a-real-secret';
export const testVerifier = (code) => attendanceVerifier(TEST_HMAC_KEY, code);

let codeCounter = 0;
// Simulates the Edge Function issue path: plaintext stays in the test, only the verifier is stored.
export async function issueTestCode(db, studentId, code = String(400000 + (codeCounter += 7919) % 500000).padStart(6, '0')) {
  await db.query(`select public.admin_store_attendance_code_verifier($1, $2)`, [studentId, await testVerifier(code)]);
  return code;
}

const migrations = new URL('../../supabase/migrations/', import.meta.url);
export const ADMIN = '00000000-0000-0000-0000-0000000000a1';
export const STUDENT_PROFILE = '00000000-0000-0000-0000-0000000000b1';
export const OTHER_PROFILE = '00000000-0000-0000-0000-0000000000b2';

export const CHAIN = [
  '20261028000000_attendance_makeup_operations.sql',
  '20261031010000_student_registry.sql',
  '20261114000000_attendance_student_registry_alignment.sql',
];

// Supabase grants new public tables, sequences and functions created by the migration role directly
// to anon, authenticated and service_role (ALTER DEFAULT PRIVILEGES), so a `revoke ... from public`
// alone leaves them reachable in production. `supabaseDefaultPrivileges` reproduces that before the
// chain runs so catalog tests see the real grants.
export async function createOpsDb(extra = [], { supabaseDefaultPrivileges = false } = {}) {
  const db = new PGlite();
  await db.exec(`create role authenticated; create role anon; create role service_role;`);
  if (supabaseDefaultPrivileges) {
    await db.exec(`
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    `);
  }
  await db.exec(`
    create schema auth;
    create table public.profiles (id uuid primary key, name text, suspended_at timestamptz, must_change_pin boolean not null default false);
    insert into public.profiles (id, name) values
      ('${ADMIN}', '관리자'), ('${STUDENT_PROFILE}', '학생계정'), ('${OTHER_PROFILE}', '다른계정');
    create table public.user_roles (user_id uuid primary key references public.profiles(id), role text not null);
    insert into public.user_roles (user_id, role) values
      ('${ADMIN}', 'admin'), ('${STUDENT_PROFILE}', 'student'), ('${OTHER_PROFILE}', 'student');
    create function public.is_admin() returns boolean language sql stable as $$
      select coalesce(current_setting('test.admin', true), 'on') = 'on'
    $$;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(current_setting('test.uid', true), '${ADMIN}'), '')::uuid
    $$;
    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function public.is_admin() to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;

    -- Student-portal homework/review source tables, column-for-column with
    -- 20260724000000_student_portal_mvp.sql, 20260726000000_portal_review_v2.sql and
    -- 20260726010000_portal_operational_hardening.sql. Storage-dependent submission
    -- triggers and portal RLS policies are omitted: tests seed rows as the owner and
    -- API roles get no direct grants, exactly as the generator only reads them as definer.
    create type public.submission_status as enum ('submitted', 'needs_revision', 'completed');
    create table public.assignments (
      id uuid primary key default gen_random_uuid(), student_id uuid not null references public.profiles(id) on delete cascade,
      created_by uuid not null references public.profiles(id), title text not null check (char_length(title) between 1 and 120),
      description text not null default '', due_at timestamptz, attachment_paths text[] not null default '{}',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table public.submissions (
      id uuid primary key default gen_random_uuid(), assignment_id uuid not null references public.assignments(id) on delete cascade,
      student_id uuid not null references public.profiles(id) on delete cascade, attempt_no integer not null check (attempt_no > 0),
      status public.submission_status not null default 'submitted', body text not null default '', file_paths text[] not null default '{}',
      submitted_at timestamptz not null default now(), reviewed_at timestamptz, unique (assignment_id, attempt_no),
      check (body <> '' or cardinality(file_paths) > 0)
    );
    create table public.feedback (
      id uuid primary key default gen_random_uuid(), submission_id uuid not null unique references public.submissions(id) on delete cascade,
      author_id uuid not null references public.profiles(id), body text not null check (char_length(body) between 1 and 4000), created_at timestamptz not null default now(),
      auto_composed boolean
    );
    create table public.feedback_items (
      id uuid primary key default gen_random_uuid(),
      feedback_id uuid not null references public.feedback(id) on delete cascade,
      problem_ref text not null check (char_length(problem_ref) between 1 and 40),
      review_tag text not null check (review_tag in
        ('풀이 시작 보완','조건·문제 이해 확인','개념 연결 보완','계산·부호 확인','풀이 마무리·검산')),
      comment text not null default '' check (char_length(comment) <= 1000),
      redo_required boolean not null default false,
      created_at timestamptz not null default now()
    );
    alter table public.assignments enable row level security;
    alter table public.submissions enable row level security;
    alter table public.feedback enable row level security;
    alter table public.feedback_items enable row level security;
    revoke all on table public.assignments, public.submissions, public.feedback, public.feedback_items from public, anon, authenticated;
  `);
  for (const file of [...CHAIN, ...extra]) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'));
  }
  return db;
}

export async function asActor(db, { uid = ADMIN, admin = true } = {}) {
  await db.exec(`select set_config('test.uid', '${uid ?? ''}', false), set_config('test.admin', '${admin ? 'on' : 'off'}', false)`);
}

export async function seedClass(db, { name = '가나다', capacity = 8 } = {}) {
  await asActor(db);
  const student = (await db.query(`select public.admin_create_student($1, '중2', '', 'active', true, '보호자', '010-0000-0000') as id`, [name])).rows[0].id;
  const course = (await db.query(`insert into public.courses (name, is_test_data) values ($1, true) returning id`, ['과정-' + name + '-' + Math.random()])).rows[0].id;
  const group = (await db.query(`insert into public.class_groups (course_id, name, is_test_data) values ($1, '반A', true) returning id`, [course])).rows[0].id;
  await db.query(`insert into public.enrollments (student_id, course_id, class_group_id) values ($1, $2, $3)`, [student, course, group]);
  return { student, course, group, capacity };
}

export const OPS_MIGRATIONS = [
  '20261115000000_kiosk_attendance_core.sql',
  '20261115010000_parent_message_outbox.sql',
  '20261115020000_daily_learning_plans.sql',
  '20261115030000_makeup_offers.sql',
  '20261115040000_admin_operations_snapshot.sql',
  '20261115050000_recurring_schedules_operations_tick.sql',
  '20261115060000_learning_plan_autogeneration.sql',
  '20261115070000_learning_device_sessions.sql',
];
