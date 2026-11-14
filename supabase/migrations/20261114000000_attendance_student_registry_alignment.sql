-- Align attendance business records with the operational student registry.
-- The original attendance migration predates public.students, so this must run after
-- 20261031010000_student_registry.sql in a fresh database and in production backfill.

alter table public.attendance_records
  drop constraint attendance_records_student_id_fkey;

alter table public.attendance_records
  add constraint attendance_records_student_id_fkey
  foreign key (student_id) references public.students(id) on delete restrict;
