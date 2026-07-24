import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAllowedOrigin } from '../supabase/functions/_shared/origin.ts';
const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
describe('student portal security boundary', () => {
  it('removes public signup', () => {
    expect(read('src/auth.js')).not.toContain('auth.signUp');
    expect(read('index.html')).not.toMatch(/회원가입|signupSubmit|authPanelSignup/);
  });
  it('disables signup in local auth config', () => {
    const config = read('supabase/config.toml');
    expect(config.match(/enable_signup = false/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it('defines isolated roles, RLS and private storage', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toContain('create table public.user_roles');
    expect(sql).toContain('alter table public.user_roles enable row level security');
    expect(sql).not.toMatch(/user_roles[^;]*for (insert|update|delete)/i);
    for (const table of ['assignments', 'submissions', 'feedback']) expect(sql).toContain('alter table public.' + table + ' enable row level security');
    expect(sql).toMatch(/insert into storage[.]buckets[\s\S]+false/i);
    expect(sql).toContain('allowed_mime_types');
    for (const mime of ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']) expect(sql).toContain(mime);
    expect(read('src/portal/student.js')).toContain('file.accept');
    expect(read('admin/index.html')).toMatch(/type=(?:"file"|file)[^>]*accept=/i);
    expect(sql).toContain("bucket_id = 'submission-files'");
  });
  it('bootstraps an admin only when exactly one legacy profile exists', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toMatch(/update public[.]user_roles[\s\S]*set role = 'admin'[\s\S]*select count[(][*][)] from public[.]profiles[)] = 1/i);
  });
  it('grants only the Data API operations required by each portal workflow', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toMatch(/grant select on table public[.]user_roles to authenticated/i);
    expect(sql).toMatch(/grant select on table public[.]profiles to authenticated/i);
    expect(sql).toMatch(/grant select, insert, update, delete on table public[.]assignments to authenticated/i);
    expect(sql).toMatch(/grant select, insert on table public[.]submissions to authenticated/i);
    expect(sql).toMatch(/grant select on table public[.]feedback to authenticated/i);
    expect(sql).toMatch(/revoke all on table public[.](user_roles|assignments|submissions|feedback) from anon/i);
    expect(sql).toMatch(/revoke all on table public[.]profiles from anon/i);
    expect(sql).toMatch(/revoke[^;]*update[^;]*on table public[.]profiles from authenticated/i);
    expect(sql).not.toMatch(/grant[^;]*update[^;]*public[.]submissions/i);
    expect(sql).not.toContain('admins update submission reviews');
  });
  it('keeps historically unrecorded schema migrations idempotent', () => {
    expect(read('supabase/migrations/20260711174427_add_profile_name.sql')).toMatch(/add column if not exists name text/i);
    expect(read('supabase/migrations/20260711190000_withdrawn_phones.sql')).toMatch(/create table if not exists public[.]withdrawn_phones/i);
  });
  it('revokes legacy security-definer functions from every API role', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toMatch(/revoke all on function public[.]delete_own_account[(][)] from public, anon, authenticated/i);
    expect(sql).toMatch(/revoke all on function public[.]is_withdrawn_phone[(]text[)] from public, anon, authenticated/i);
    expect(sql).toMatch(/revoke all on function public[.]handle_new_user[(][)] from public, anon, authenticated/i);
  });
  it('models immutable one-to-many attempts and guarded retries', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toMatch(/create type public[.]submission_status as enum \('submitted', 'needs_revision', 'completed'\)/i);
    expect(sql).toContain('attempt_no integer not null');
    expect(sql).toMatch(/unique [(]assignment_id, attempt_no[)]/i);
    expect(sql).not.toMatch(/unique [(]assignment_id, student_id[)]/i);
    expect(sql).toContain("latest.status <> 'needs_revision'");
    expect(sql).not.toMatch(/create policy ["']students[^"']*["'] on public[.]submissions for update/i);
    expect(sql).not.toMatch(/create policy ["']students[^"']*["'] on public[.]submissions for delete/i);
    expect(sql).toContain('create or replace function public.review_submission');
  });
  it('accepts only uploaded submission files owned by that student and assignment', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toMatch(/prepare_submission_attempt[\s\S]*unnest[(]new[.]file_paths[)][\s\S]*auth[.]uid[(][)][\s\S]*new[.]assignment_id/i);
    expect(sql).toMatch(/prepare_submission_attempt[\s\S]*storage[.]objects[\s\S]*bucket_id = 'submission-files'[\s\S]*o[.]name = path/i);
    expect(sql).toMatch(/cardinality[(]new[.]file_paths[)] > 3/i);
  });
  it('uses six-digit PINs and exposes complete portal controls', () => {
    const pinCode = [read('src/portal/domain.js'), read('supabase/functions/admin-users/index.ts')].join('\n');
    expect(pinCode.match(/\\d\{6\}/g)).toHaveLength(2);
    for (const path of ['admin/index.html', 'student/index.html', 'index.html']) { const html = read(path); expect(html).not.toContain('4자리'); expect(html).toMatch(/maxlength=['"]?6/); }
    expect(read('PORTAL_MVP.md')).toContain('정확히 숫자 6자리');
    expect(read('admin/index.html')).toContain('assignmentForm');
    expect(read('admin/index.html')).toContain('workflows');
    expect(read('src/portal/admin.js')).toContain("rpc('review_submission'");
    expect(read('src/portal/student.js')).toContain('canSubmitAttempt');
  });
  it('forces initial and reset PIN changes at the server boundary', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    const changePin = read('supabase/functions/change-pin/index.ts');
    const adminUsers = read('supabase/functions/admin-users/index.ts');
    expect(sql).toMatch(/profiles add column if not exists must_change_pin boolean not null default true/i);
    expect(sql).not.toContain('complete_pin_change');
    expect(sql).toMatch(/create or replace function public[.]is_active_user[(][)][\s\S]*must_change_pin = false/i);
    expect(changePin).toMatch(/auth[.]admin[.]updateUserById[\s\S]*must_change_pin: false/);
    expect(changePin).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(adminUsers).toMatch(/select[(]'suspended_at,must_change_pin'[)][\s\S]*must_change_pin[\s\S]*forbidden/);
    expect(adminUsers).toMatch(/action === 'reset'[\s\S]*rpc\('mark_pin_reset'/);
    for (const path of ['admin/index.html', 'student/index.html']) expect(read(path)).toContain('pinChangeForm');
    for (const path of ['src/portal/admin.js', 'src/portal/student.js']) {
      const source = read(path);
      expect(source).toContain("select('name,must_change_pin')");
      expect(source).toContain("invokeAuthenticated('change-pin'");
      expect(source).toContain("await signIn(currentUser.email.split('@')[0], pin)");
      expect(source).not.toContain("functions.invoke('change-pin'");
      expect(source).not.toContain('auth.updateUser');
      expect(source).not.toContain("rpc('complete_pin_change')");
    }
  });
  it('routes landing users by their protected role', () => {
    const main = read('src/main.js');
    expect(main).toContain("from('user_roles').select('role')");
    expect(main).toMatch(/role === 'admin'[^\n]*['"`]\.\/admin\//);
    expect(read('index.html')).toContain('id="navPortalLink"');
  });
  it('lets CORS preflight reach functions that authenticate callers internally', () => {
    const config = read('supabase/config.toml');
    for (const name of ['admin-users', 'change-pin']) {
      expect(config).toMatch(new RegExp(`\\[functions\\.${name}\\][\\s\\S]*?verify_jwt = false`));
      const source = read(`supabase/functions/${name}/index.ts`);
      expect(source).toContain("request.headers.get('authorization')");
      expect(source).toContain('/auth/v1/user');
      expect(source).not.toContain('auth.getUser(token)');
    }
  });
  it('allows only production, owned HTTPS previews, and explicit localhost origins', () => {
    const edge = read('supabase/functions/admin-users/index.ts') + read('supabase/functions/_shared/origin.ts');
    expect(edge).toContain("hostname.endsWith(previewSuffix)");
    expect(edge).toContain("url.protocol === 'https:'");
    expect(edge).toMatch(/localhost[^\n]*127[.]0[.]0[.]1/);
    expect(edge).not.toContain("origin.startsWith('http://localhost:')");
    for (const allowed of ['https://we-math.pages.dev', 'https://abc-123.we-math.pages.dev', 'http://localhost:5173', 'http://127.0.0.1:4173']) expect(isAllowedOrigin(allowed)).toBe(true);
    for (const denied of ['http://we-math.pages.dev', 'https://we-math.pages.dev.evil.test', 'https://evilwe-math.pages.dev', 'https://abc.we-math.pages.dev.evil.test', 'https://we-math.pages.dev/path', 'https://user@we-math.pages.dev', 'null']) expect(isAllowedOrigin(denied)).toBe(false);
  });
  it('blocks suspended users even while an old access token remains valid', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toMatch(/create or replace function public[.]is_active_user[(][)][\s\S]*suspended_at is null/i);
    expect(sql).toMatch(/create or replace function public[.]is_admin[(][)][\s\S]*suspended_at is null/i);
    expect(sql).toMatch(/prepare_submission_attempt[\s\S]*not public[.]is_active_user[(][)]/i);
    expect(sql).toMatch(/roles visible to self or admin[^;]*public[.]is_not_suspended[(][)]/i);
    expect(read('supabase/functions/admin-users/index.ts')).toMatch(/suspended_at[\s\S]*forbidden/);
  });
  it('prevents a concurrent admin reset from being cleared by an older PIN change', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    const adminEdge = read('supabase/functions/admin-users/index.ts');
    const changeEdge = read('supabase/functions/change-pin/index.ts');
    expect(sql).toMatch(/pin_generation bigint not null default 0/i);
    expect(sql).toMatch(/mark_pin_reset[\s\S]*pin_generation = pin_generation [+] 1/i);
    expect(sql).toMatch(/grant execute on function public[.]mark_pin_reset[(]uuid[)] to service_role/i);
    expect(adminEdge).toContain("rpc('mark_pin_reset'");
    expect(adminEdge.indexOf('updateUserById(userId')).toBeLessThan(adminEdge.indexOf("rpc('mark_pin_reset'"));
    expect(changeEdge).toContain('pin_generation');
    expect(changeEdge).toMatch(/[.]eq[(]'pin_generation', profile[.]pin_generation[)]/);
  });
  it('fails closed when account profile mutations are partial', () => {
    const edge = read('supabase/functions/admin-users/index.ts');
    expect(edge).toMatch(/roleError[\s\S]*profileError[\s\S]*forbidden/);
    expect(edge).toMatch(/updateProfile[\s\S]*[.]select[(]'id'[)][.]single[(][)]/); expect(edge.match(/await updateProfile[(]/g)?.length).toBeGreaterThanOrEqual(2);
    const suspendBlock = edge.slice(edge.indexOf("action === 'suspend'"), edge.indexOf("action === 'reactivate'"));
    expect(suspendBlock.indexOf("suspended_at: new Date().toISOString()")).toBeLessThan(suspendBlock.indexOf("ban_duration: '876000h'"));
  });
  it('keeps service credentials server-side only', () => {
    const browser = [read("src/auth.js"), read("src/portal/student.js"), read("src/portal/admin.js")].join();
    expect(browser).not.toMatch(/SERVICE_ROLE|service_role/i);
    expect(read('supabase/functions/admin-users/index.ts')).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
