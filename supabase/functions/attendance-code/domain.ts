// Attendance-code HMAC boundary. Pure, dependency-injected so it can be tested without Deno or network.
//
// Invariants:
//  * The raw six-digit code exists only in this function's memory (kiosk input / one-time admin reply).
//  * The database receives only verifier = HMAC-SHA-256(ATTENDANCE_CODE_HMAC_SECRET, domain || code).
//  * The HMAC secret comes only from the function environment; it is never sent, stored, or logged.
//  * Nothing sensitive (code, verifier, device token, JWT, names, phones) is logged.
import { isAllowedOrigin, productionOrigin } from '../_shared/origin.ts';

export const MIN_HMAC_SECRET_LENGTH = 32;
const VERIFIER_DOMAIN = 'sequence-attendance-code:v1:';
const CODE_PATTERN = /^\d{6}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1024;
const MAX_ISSUE_ATTEMPTS = 6;
const KIOSK_ACTIONS = new Set(['check_in', 'check_out']);
const KIOSK_RESULT_KEYS = ['result', 'status', 'student_label', 'at'] as const;
const TRIVIAL_CODES = new Set(['012345', '123456', '234567', '345678', '456789', '987654', '876543', '765432', '654321', '543210']);
const SECRET_ERROR = 'attendance code secret is not configured';

type EnvGetter = (name: string) => string | undefined;
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>;
type RandomFill = (array: Uint32Array) => Uint32Array;

export type AttendanceRequest =
  | { op: 'kiosk'; deviceToken: string; action: 'check_in' | 'check_out'; code: string }
  | { op: 'issue'; studentId: string };

export function readHmacSecret(env: EnvGetter): string {
  const value = env('ATTENDANCE_CODE_HMAC_SECRET');
  const secret = typeof value === 'string' ? value.trim() : '';
  // Fail closed on missing, short, or obviously low-entropy values. Never echo the value.
  if (secret.length < MIN_HMAC_SECRET_LENGTH || new Set(secret).size < 8) throw new Error(SECRET_ERROR);
  return secret;
}

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

export async function attendanceVerifier(secret: string, code: string): Promise<string> {
  if (!CODE_PATTERN.test(code)) throw new Error('invalid attendance code');
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(VERIFIER_DOMAIN + code));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isTrivialCode(code: string) {
  return /^(\d)\1{5}$/.test(code) || TRIVIAL_CODES.has(code);
}

// Uniform over 000000..999999 via rejection sampling of 32-bit draws, then skips trivial codes.
export function generateAttendanceCode(random: RandomFill = (array) => crypto.getRandomValues(array)): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const draw = new Uint32Array(1);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const value = random(draw)[0];
    if (value >= limit) continue;
    const code = String(value % 1_000_000).padStart(6, '0');
    if (!isTrivialCode(code)) return code;
  }
  throw new Error('could not generate attendance code');
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseAttendanceRequest(raw: unknown): AttendanceRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (body.op === 'kiosk') {
    if (!hasExactKeys(body, ['op', 'device_token', 'action', 'code'])) return null;
    const { device_token: deviceToken, action, code } = body;
    if (typeof deviceToken !== 'string' || !TOKEN_PATTERN.test(deviceToken)) return null;
    if (typeof action !== 'string' || !KIOSK_ACTIONS.has(action)) return null;
    if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return null;
    return { op: 'kiosk', deviceToken, action: action as 'check_in' | 'check_out', code };
  }
  if (body.op === 'issue') {
    if (!hasExactKeys(body, ['op', 'student_id'])) return null;
    const studentId = body.student_id;
    if (typeof studentId !== 'string' || !UUID_PATTERN.test(studentId)) return null;
    return { op: 'issue', studentId: studentId.toLowerCase() };
  }
  return null;
}

// Supabase's gateway sets these; only a syntactically plausible IP is forwarded to rate limiting.
export function clientIp(headers: Headers): string {
  const candidates = [
    headers.get('cf-connecting-ip'),
    headers.get('x-real-ip'),
    (headers.get('x-forwarded-for') ?? '').split(',')[0],
  ];
  for (const candidate of candidates) {
    const value = (candidate ?? '').trim();
    if (value && value.length <= 45 && /^[0-9a-fA-F:.]+$/.test(value)) return value;
  }
  return '';
}

function maskedKioskResult(data: unknown) {
  const source = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const out: Record<string, unknown> = {};
  for (const key of KIOSK_RESULT_KEYS) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  if (typeof out.result !== 'string') out.result = 'not_found';
  return out;
}

export interface HandlerDeps {
  env: EnvGetter;
  serviceRpc: Rpc;
  userClient: (jwt: string) => { rpc: Rpc };
  random?: RandomFill;
  log?: (...args: unknown[]) => void;
}

export function createAttendanceCodeHandler(deps: HandlerDeps) {
  const log = deps.log ?? (() => {});
  const cors = (origin: string) => ({ 'access-control-allow-origin': origin, vary: 'Origin' });
  const json = (body: unknown, status: number, origin: string) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) },
  });

  async function readBody(request: Request): Promise<AttendanceRequest | null> {
    const text = await request.text();
    if (encoder.encode(text).length > MAX_BODY_BYTES) return null;
    try { return parseAttendanceRequest(JSON.parse(text)); } catch { return null; }
  }

  async function kiosk(parsed: Extract<AttendanceRequest, { op: 'kiosk' }>, secret: string, request: Request, origin: string) {
    const verifier = await attendanceVerifier(secret, parsed.code);
    const { data, error } = await deps.serviceRpc('service_kiosk_attendance', {
      p_device_token: parsed.deviceToken,
      p_action: parsed.action,
      p_code_verifier: verifier,
      p_client_ip: clientIp(request.headers),
    });
    if (error) {
      log('attendance-code kiosk transition failed', String(error.code ?? 'unknown'));
      return json({ error: 'attendance service unavailable' }, 502, origin);
    }
    return json(maskedKioskResult(data), 200, origin);
  }

  async function issue(parsed: Extract<AttendanceRequest, { op: 'issue' }>, secret: string, request: Request, origin: string) {
    const jwt = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
    // The service-role key is never proof of an admin; issuance must run as the admin user.
    const serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY');
    if (serviceKey && jwt === serviceKey) return json({ error: 'forbidden' }, 403, origin);
    const user = deps.userClient(jwt);
    const { data: isAdmin, error: adminError } = await user.rpc('is_admin');
    if (adminError || isAdmin !== true) return json({ error: 'forbidden' }, 403, origin);

    for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
      const code = generateAttendanceCode(deps.random);
      const verifier = await attendanceVerifier(secret, code);
      const { data, error } = await user.rpc('admin_store_attendance_code_verifier', {
        p_student_id: parsed.studentId,
        p_code_verifier: verifier,
      });
      if (!error) {
        const issueKind = (data as Record<string, unknown> | null)?.issue_kind;
        // The plaintext leaves the function exactly once, in this response.
        return json({ code, issue_kind: issueKind === 'rotated' ? 'rotated' : 'issued' }, 200, origin);
      }
      if (error.code === '23505') continue;
      if (error.code === '42501') return json({ error: 'forbidden' }, 403, origin);
      if (error.code === '23503') return json({ error: 'student not found' }, 404, origin);
      log('attendance-code issue failed', String(error.code ?? 'unknown'));
      return json({ error: 'attendance code could not be issued' }, 502, origin);
    }
    log('attendance-code issue exhausted collision retries');
    return json({ error: 'attendance code could not be issued; retry' }, 409, origin);
  }

  return async function handle(request: Request): Promise<Response> {
    const origin = request.headers.get('origin') ?? productionOrigin;
    if (!isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: 'origin denied' }), { status: 403, headers: { 'content-type': 'application/json', vary: 'Origin' } });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors(origin), 'access-control-allow-headers': 'authorization, apikey, content-type', 'access-control-allow-methods': 'POST' } });
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);

    let secret: string;
    try { secret = readHmacSecret(deps.env); } catch {
      log('attendance-code disabled: secret missing or too weak');
      return json({ error: 'attendance service unavailable' }, 503, origin);
    }

    const parsed = await readBody(request);
    if (!parsed) return json({ error: 'invalid request' }, 400, origin);
    try {
      return parsed.op === 'kiosk' ? await kiosk(parsed, secret, request, origin) : await issue(parsed, secret, request, origin);
    } catch {
      log('attendance-code request failed', parsed.op);
      return json({ error: 'attendance service unavailable' }, 502, origin);
    }
  };
}
