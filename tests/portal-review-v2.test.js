import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('portal review v2 security and workflow', () => {
  const migration = read('supabase/migrations/20260726000000_portal_review_v2.sql');

  it('keeps structured feedback and review events behind RLS', () => {
    for (const table of ['feedback_items', 'review_events']) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toMatch(new RegExp(`revoke all on table public[.]${table} from public, anon, authenticated`, 'i'));
    }
    expect(migration).toMatch(/feedback items readable by owner or admin[\s\S]*s[.]student_id = auth[.]uid[(][)]/i);
    expect(migration).toMatch(/admins log review opened[\s\S]*actor_id = auth[.]uid[(][)][\s\S]*event_type = 'review_opened'/i);
  });

  it('makes the v2 review RPC fail closed and transactional', () => {
    expect(migration).toMatch(/review_submission_v2[\s\S]*security definer set search_path = ''/i);
    expect(migration).toMatch(/if not public[.]is_admin[(][)] then raise exception 'admin required'/i);
    expect(migration).toMatch(/from public[.]submissions where id = p_submission_id for update/i);
    expect(migration).toContain('only latest attempt is reviewable');
    expect(migration).toContain('needs_revision requires at least one redo item');
    expect(migration).toContain('completed cannot include redo items');
    expect(migration).toMatch(/revoke all on function public[.]review_submission_v2[^;]+from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public[.]review_submission_v2[^;]+to authenticated/i);
    expect(migration).toMatch(/create or replace function public[.]review_submission[\s\S]*structured feedback required; use review_submission_v2[\s\S]*perform public[.]review_submission_v2/i);
    expect(migration).toMatch(/revoke all on function public[.]review_submission[(]uuid, text, public[.]submission_status[)] from public, anon, authenticated/i);
  });

  it('does not add AI-derived student judgments in v1', () => {
    expect(migration).not.toMatch(/ai_observations|submission_pages|정서[· ]습관/i);
    for (const tag of ['풀이 시작 보완', '조건·문제 이해 확인', '개념 연결 보완', '계산·부호 확인', '풀이 마무리·검산']) {
      expect(migration).toContain(tag);
    }
  });

  it('queries every submitted review with stable keyset pagination and supports both images and PDFs', () => {
    const admin = read('src/portal/admin.js');
    const student = read('src/portal/student.js');
    expect(admin).toContain("supabase.from('assignments').select(QUEUE_SELECT)");
    expect(admin).toContain('submissions(id,attempt_no,status,body,file_paths,submitted_at)');
    expect(admin).toContain('const nextQueue = reviewQueue(activeAssignments)');
    expect(admin).toContain("order('id').limit(pageSize)");
    expect(admin).toContain('collectKeysetPages(fetchQueuePage, REMOTE_PAGE_SIZE)');
    expect(read('src/portal/domain.js')).toContain('return rows.sort');
    expect(admin).not.toContain('.limit(100);');
    const adminHtml = read('admin/index.html');
    const studentHtml = read('student/index.html');
    expect(adminHtml).toContain('adminFrame');
    expect(studentHtml).toContain('viewerFrame');
    expect(adminHtml).not.toMatch(/id=adminFrame[^>]*sandbox/);
    expect(studentHtml).not.toMatch(/id=viewerFrame[^>]*sandbox/);
    expect(admin).toContain('/[.]pdf$/i');
    expect(student).toContain('/[.]pdf$/i');
    expect(admin).toContain('imageRequest');
    expect(student).toContain('viewerRequest');
  });

  it('preserves read-only assignment history without a legacy review UI', () => {
    const admin = read('src/portal/admin.js');
    const html = read('admin/index.html');
    expect(html).toContain('전체 과제·제출 현황');
    expect(html).toContain('workflows');
    expect(admin).toContain('loadWorkflows');
    expect(admin).toContain('.range(from, to)');
    expect(admin).toContain("profiles!assignments_student_id_fkey(name,suspended_at)");
    expect(admin).toContain("accountStatus.textContent = '정지 계정'");
    expect(read('src/portal/portal.css')).toContain('.status-suspended');
    expect(admin).toContain("byId('workflowNext').disabled = true");
    expect(admin).not.toContain("rpc('review_submission'");
  });

  it('adds keyboard and dialog safeguards', () => {
    const admin = read('src/portal/admin.js');
    const student = read('src/portal/student.js');
    const html = read('student/index.html');
    expect(html).toMatch(/role=dialog[^>]*aria-modal=true/);
    expect(read('src/portal/portal.css')).toContain('[hidden]{display:none!important}');
    expect(student).toContain("event.key === 'Escape'");
    expect(student).toContain('selectingFiles');
    expect(admin).toContain("event.key === 'ArrowRight'");
  });
});
