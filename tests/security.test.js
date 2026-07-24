import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAllowedOrigin } from '../supabase/functions/admin-users/origin.ts';
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
    expect(sql).toContain("bucket_id = 'submission-files'");
  });
  it('keeps historically unrecorded schema migrations idempotent', () => {
    expect(read('supabase/migrations/20260711174427_add_profile_name.sql')).toMatch(/add column if not exists name text/i);
    expect(read('supabase/migrations/20260711190000_withdrawn_phones.sql')).toMatch(/create table if not exists public[.]withdrawn_phones/i);
  });
  it('revokes legacy security-definer functions from every API role', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toMatch(/revoke all on function public[.]delete_own_account[(][)] from public, anon, authenticated/i);
    expect(sql).toMatch(/revoke all on function public[.]is_withdrawn_phone[(]text[)] from public, anon, authenticated/i);
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
  it('forces initial and reset PIN changes through an authenticated self-only RPC', () => {
    const sql = read('supabase/migrations/20260724000000_student_portal_mvp.sql');
    expect(sql).toMatch(/profiles add column if not exists must_change_pin boolean not null default true/i);
    expect(sql).toMatch(/create or replace function public[.]complete_pin_change[(][)] returns void[\s\S]*security definer/i);
    expect(sql).toMatch(/update public[.]profiles set must_change_pin = false where id = auth[.]uid[(][)]/i);
    expect(sql).toMatch(/revoke all on function public[.]complete_pin_change[(][)] from public, anon/i);
    expect(sql).toMatch(/grant execute on function public[.]complete_pin_change[(][)] to authenticated/i);
    expect(read('supabase/functions/admin-users/index.ts')).toMatch(/action === 'reset'[\s\S]*must_change_pin: true/);
    for (const path of ['admin/index.html', 'student/index.html']) expect(read(path)).toContain('pinChangeForm');
    for (const path of ['src/portal/admin.js', 'src/portal/student.js']) {
      const source = read(path);
      expect(source).toContain("select('name,must_change_pin')");
      expect(source).toContain('auth.updateUser');
      expect(source).toContain("rpc('complete_pin_change')");
    }
  });
  it('routes landing users by their protected role', () => {
    const main = read('src/main.js');
    expect(main).toContain("from('user_roles').select('role')");
    expect(main).toMatch(/role === 'admin'[^\n]*['"`]\.\/admin\//);
    expect(read('index.html')).toContain('id="navPortalLink"');
  });
  it('allows only production, owned HTTPS previews, and explicit localhost origins', () => {
    const edge = read('supabase/functions/admin-users/index.ts') + read('supabase/functions/admin-users/origin.ts');
    expect(edge).toContain("hostname.endsWith(previewSuffix)");
    expect(edge).toContain("url.protocol === 'https:'");
    expect(edge).toMatch(/localhost[^\n]*127[.]0[.]0[.]1/);
    expect(edge).not.toContain("origin.startsWith('http://localhost:')");
    for (const allowed of ['https://we-math.pages.dev', 'https://abc-123.we-math.pages.dev', 'http://localhost:5173', 'http://127.0.0.1:4173']) expect(isAllowedOrigin(allowed)).toBe(true);
    for (const denied of ['http://we-math.pages.dev', 'https://we-math.pages.dev.evil.test', 'https://evilwe-math.pages.dev', 'https://abc.we-math.pages.dev.evil.test', 'https://we-math.pages.dev/path', 'https://user@we-math.pages.dev', 'null']) expect(isAllowedOrigin(denied)).toBe(false);
  });
  it('keeps service credentials server-side only', () => {
    const browser = [read("src/auth.js"), read("src/portal/student.js"), read("src/portal/admin.js")].join();
    expect(browser).not.toMatch(/SERVICE_ROLE|service_role/i);
    expect(read('supabase/functions/admin-users/index.ts')).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
