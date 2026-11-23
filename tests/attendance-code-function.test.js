import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attendanceVerifier,
  clientIp,
  createAttendanceCodeHandler,
  generateAttendanceCode,
  MIN_HMAC_SECRET_LENGTH,
  parseAttendanceRequest,
  readHmacSecret,
} from '../supabase/functions/attendance-code/domain.ts';

const root = resolve(import.meta.dirname, '..');
// Test-only key material. Not a real secret; never used outside this test file.
const TEST_KEY = 'test-only-hmac-key-0123456789abcdefghijklmnop';
const TOKEN = 'a'.repeat(64);
const SERVICE_KEY = 'test-service-role-key';
const STUDENT = '00000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://sequencemath.co.kr';

function request(body, { auth, origin = ORIGIN, ip = '198.51.100.7', method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json', origin, 'x-forwarded-for': `${ip}, 10.0.0.1` };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('https://example.test/functions/v1/attendance-code', {
    method,
    headers,
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

function harness({ env = { ATTENDANCE_CODE_HMAC_SECRET: TEST_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, serviceRpc, userRpc, random } = {}) {
  const logs = [];
  const service = vi.fn(serviceRpc ?? (async () => ({ data: { result: 'not_found' }, error: null })));
  const user = vi.fn(userRpc ?? (async (fn) => (fn === 'is_admin' ? { data: true, error: null } : { data: { issue_kind: 'issued' }, error: null })));
  const userClient = vi.fn(() => ({ rpc: user }));
  const handler = createAttendanceCodeHandler({
    env: (name) => env[name],
    serviceRpc: service,
    userClient,
    random,
    log: (...args) => logs.push(args.map(String).join(' ')),
  });
  return { handler, service, user, userClient, logs };
}

describe('attendance code HMAC domain', () => {
  it('computes a deterministic 64-hex HMAC-SHA-256 verifier that depends on the key', async () => {
    const one = await attendanceVerifier(TEST_KEY, '482913');
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(await attendanceVerifier(TEST_KEY, '482913')).toBe(one);
    expect(await attendanceVerifier(TEST_KEY, '482914')).not.toBe(one);
    expect(await attendanceVerifier(TEST_KEY + 'x', '482913')).not.toBe(one);
    expect(one).not.toContain('482913');
    await expect(attendanceVerifier(TEST_KEY, '48291')).rejects.toThrow();
  });

  it('fails closed on a missing or weak secret without echoing it', () => {
    expect(MIN_HMAC_SECRET_LENGTH).toBeGreaterThanOrEqual(32);
    expect(readHmacSecret(() => TEST_KEY)).toBe(TEST_KEY);
    for (const weak of [undefined, '', '   ', 'short-secret', 'a'.repeat(64), 'ab'.repeat(20)]) {
      let message = '';
      try { readHmacSecret(() => weak); } catch (error) { message = error.message; }
      expect(message).toBe('attendance code secret is not configured');
      if (weak) expect(message).not.toContain(weak.trim() || '\u0000');
    }
  });

  it('generates uniformly sampled six-digit codes and rejects biased or trivial draws', () => {
    for (let i = 0; i < 200; i += 1) expect(generateAttendanceCode()).toMatch(/^\d{6}$/);
    // 4294967295 is above the rejection threshold, 111111 is trivial, 482913 is accepted.
    const draws = [4294967295, 111111, 123456, 482913];
    const fake = (array) => { array[0] = draws.shift(); return array; };
    expect(generateAttendanceCode(fake)).toBe('482913');
    expect(() => generateAttendanceCode((array) => { array[0] = 0; return array; })).toThrow(/could not generate/);
  });

  it('parses kiosk and issue bodies strictly', () => {
    expect(parseAttendanceRequest({ op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '482913' }))
      .toEqual({ op: 'kiosk', deviceToken: TOKEN, action: 'check_in', code: '482913' });
    expect(parseAttendanceRequest({ op: 'issue', student_id: STUDENT })).toEqual({ op: 'issue', studentId: STUDENT });
    for (const bad of [
      null, [], 'x',
      { op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '48291' },
      { op: 'kiosk', device_token: TOKEN, action: 'check_in', code: 482913 },
      { op: 'kiosk', device_token: TOKEN, action: 'delete', code: '482913' },
      { op: 'kiosk', device_token: 'short', action: 'check_in', code: '482913' },
      { op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '482913', extra: 1 },
      { op: 'issue', student_id: 'not-a-uuid' },
      { op: 'issue', student_id: STUDENT, code: '482913' },
      { op: 'other' },
    ]) expect(parseAttendanceRequest(bad)).toBeNull();
  });

  it('takes the gateway client address and ignores malformed values', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }))).toBe('198.51.100.7');
    expect(clientIp(new Headers({ 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.7' }))).toBe('203.0.113.5');
    expect(clientIp(new Headers({ 'x-forwarded-for': '<script>' }))).toBe('');
    expect(clientIp(new Headers())).toBe('');
  });
});

describe('attendance-code edge handler: kiosk operation', () => {
  it('sends only the verifier (never the raw code) to the service-only RPC and returns a masked whitelist', async () => {
    const { handler, service, logs } = harness({
      serviceRpc: async () => ({ data: { result: 'checked_in', status: 'late', student_label: '가○○', at: '2099-11-16T07:15:00+00:00', student_id: 'leak', phone: '010' }, error: null }),
    });
    const response = await handler(request({ op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '482913' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'checked_in', status: 'late', student_label: '가○○', at: '2099-11-16T07:15:00+00:00' });
    expect(service).toHaveBeenCalledTimes(1);
    const [fn, args] = service.mock.calls[0];
    expect(fn).toBe('service_kiosk_attendance');
    expect(args).toEqual({
      p_device_token: TOKEN,
      p_action: 'check_in',
      p_code_verifier: await attendanceVerifier(TEST_KEY, '482913'),
      p_client_ip: '198.51.100.7',
    });
    expect(JSON.stringify(args)).not.toContain('482913');
    expect(logs).toEqual([]);
  });

  it('fails closed before any database call when the HMAC secret is missing or weak', async () => {
    for (const secret of [undefined, 'too-short']) {
      const { handler, service, user, logs } = harness({ env: { ATTENDANCE_CODE_HMAC_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY } });
      const kiosk = await handler(request({ op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '482913' }));
      expect(kiosk.status).toBe(503);
      const issue = await handler(request({ op: 'issue', student_id: STUDENT }, { auth: 'admin-jwt' }));
      expect(issue.status).toBe(503);
      expect(service).not.toHaveBeenCalled();
      expect(user).not.toHaveBeenCalled();
      const text = JSON.stringify(await kiosk.json()) + logs.join('\n');
      if (secret) expect(text).not.toContain(secret);
    }
  });

  it('rejects malformed bodies, foreign origins and non-POST methods without reaching the database', async () => {
    const { handler, service } = harness();
    expect((await handler(request({ op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '12' }))).status).toBe(400);
    expect((await handler(request('{not json'))).status).toBe(400);
    expect((await handler(request('x'.repeat(5000)))).status).toBe(400);
    expect((await handler(request({ op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '482913' }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handler(request(null, { method: 'GET' }))).status).toBe(405);
    expect(service).not.toHaveBeenCalled();
  });

  it('logs nothing sensitive when the service RPC fails', async () => {
    const { handler, logs } = harness({ serviceRpc: async () => ({ data: null, error: { code: 'XX000', message: `boom ${TOKEN} 482913` } }) });
    const response = await handler(request({ op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '482913' }));
    expect(response.status).toBe(502);
    const all = logs.join('\n') + JSON.stringify(await response.json());
    const verifier = await attendanceVerifier(TEST_KEY, '482913');
    for (const secret of [TOKEN, '482913', verifier, TEST_KEY, SERVICE_KEY]) expect(all).not.toContain(secret);
  });
});

describe('attendance-code edge handler: admin issue operation', () => {
  it('requires a bearer token, refuses the service-role key as admin proof, and requires is_admin', async () => {
    const none = harness();
    expect((await none.handler(request({ op: 'issue', student_id: STUDENT }))).status).toBe(401);
    const service = harness();
    expect((await service.handler(request({ op: 'issue', student_id: STUDENT }, { auth: SERVICE_KEY }))).status).toBe(403);
    expect(service.userClient).not.toHaveBeenCalled();
    const nonAdmin = harness({ userRpc: async (fn) => (fn === 'is_admin' ? { data: false, error: null } : { data: null, error: null }) });
    expect((await nonAdmin.handler(request({ op: 'issue', student_id: STUDENT }, { auth: 'student-jwt' }))).status).toBe(403);
    expect(nonAdmin.user.mock.calls.map((c) => c[0])).toEqual(['is_admin']);
    for (const h of [none, service, nonAdmin]) expect(h.service).not.toHaveBeenCalled();
  });

  it('stores only the verifier through the user-scoped admin RPC and returns the plaintext once', async () => {
    const { handler, user, userClient, service, logs } = harness();
    const response = await handler(request({ op: 'issue', student_id: STUDENT }, { auth: 'admin-jwt' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.code).toMatch(/^\d{6}$/);
    expect(Object.keys(body).sort()).toEqual(['code', 'issue_kind']);
    expect(userClient).toHaveBeenCalledWith('admin-jwt');
    const store = user.mock.calls.find((c) => c[0] === 'admin_store_attendance_code_verifier');
    expect(store[1]).toEqual({ p_student_id: STUDENT, p_code_verifier: await attendanceVerifier(TEST_KEY, body.code) });
    expect(JSON.stringify(store[1])).not.toContain(body.code);
    expect(service).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain(body.code);
  });

  it('retries a verifier uniqueness collision with a fresh code, boundedly', async () => {
    let stores = 0;
    const collide = harness({
      userRpc: async (fn) => {
        if (fn === 'is_admin') return { data: true, error: null };
        stores += 1;
        return stores < 3 ? { data: null, error: { code: '23505', message: 'duplicate' } } : { data: { issue_kind: 'rotated' }, error: null };
      },
    });
    const ok = await collide.handler(request({ op: 'issue', student_id: STUDENT }, { auth: 'admin-jwt' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).issue_kind).toBe('rotated');
    const verifiers = collide.user.mock.calls.filter((c) => c[0] !== 'is_admin').map((c) => c[1].p_code_verifier);
    expect(new Set(verifiers).size).toBe(3);

    const always = harness({ userRpc: async (fn) => (fn === 'is_admin' ? { data: true, error: null } : { data: null, error: { code: '23505', message: 'duplicate' } }) });
    const failed = await always.handler(request({ op: 'issue', student_id: STUDENT }, { auth: 'admin-jwt' }));
    expect(failed.status).toBe(409);
    expect(always.user.mock.calls.filter((c) => c[0] !== 'is_admin').length).toBeLessThanOrEqual(8);
    expect(await failed.json()).not.toHaveProperty('code');
  });

  it('maps admin RPC permission and missing-student errors without returning a code', async () => {
    const denied = harness({ userRpc: async (fn) => (fn === 'is_admin' ? { data: true, error: null } : { data: null, error: { code: '42501', message: 'admin required' } }) });
    const r1 = await denied.handler(request({ op: 'issue', student_id: STUDENT }, { auth: 'admin-jwt' }));
    expect(r1.status).toBe(403);
    expect(await r1.json()).not.toHaveProperty('code');
    const missing = harness({ userRpc: async (fn) => (fn === 'is_admin' ? { data: true, error: null } : { data: null, error: { code: '23503', message: 'student not found' } }) });
    expect((await missing.handler(request({ op: 'issue', student_id: STUDENT }, { auth: 'admin-jwt' }))).status).toBe(404);
  });
});

describe('attendance-code deployment wiring', () => {
  const index = readFileSync(resolve(root, 'supabase/functions/attendance-code/index.ts'), 'utf8');
  const config = readFileSync(resolve(root, 'supabase/config.toml'), 'utf8');
  const workflow = readFileSync(resolve(root, '.github/workflows/supabase-operations-functions.yml'), 'utf8');

  it('reads the HMAC secret only from the environment and never persists or logs it', () => {
    expect(index).toContain("Deno.env.get('ATTENDANCE_CODE_HMAC_SECRET')");
    expect(index).not.toMatch(/console\.(log|info|debug)/);
    for (const sql of ['20261115000000_kiosk_attendance_core.sql', '20261115030000_makeup_offers.sql']) {
      const text = readFileSync(resolve(root, 'supabase/migrations', sql), 'utf8');
      expect(text).not.toContain('ATTENDANCE_CODE_HMAC_SECRET');
      expect(text).not.toContain('app_secrets');
    }
  });

  it('registers the function and deploys it with parent-message-dispatch only from main after checks', () => {
    expect(config).toMatch(/\[functions\.attendance-code\]\nverify_jwt = false/);
    expect(config).toMatch(/\[functions\.parent-message-dispatch\]\nverify_jwt = false/);
    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
    expect(workflow).not.toContain('pull_request');
    expect(workflow).toContain('supabase/functions/attendance-code/**');
    expect(workflow).toContain('supabase/functions/parent-message-dispatch/**');
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npx --yes deno check supabase/functions/attendance-code/index.ts');
    expect(workflow).toContain('npx --yes deno check supabase/functions/parent-message-dispatch/index.ts');
    expect(workflow).toContain('npx supabase functions deploy attendance-code');
    expect(workflow).toContain('npx supabase functions deploy parent-message-dispatch');
    expect(workflow).toContain('ATTENDANCE_CODE_HMAC_SECRET');
    // The secret is verified by name only; the workflow never sets or prints it.
    expect(workflow).not.toContain('secrets set');
    expect(workflow).not.toContain('secrets.ATTENDANCE_CODE_HMAC_SECRET');
  });
});
