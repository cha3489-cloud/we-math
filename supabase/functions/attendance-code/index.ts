import { createClient } from 'npm:@supabase/supabase-js@2';
import { DB_REQUEST_TIMEOUT_MS, fetchWithTimeout } from '../_shared/retry.ts';
import { createAttendanceCodeHandler } from './domain.ts';

// Narrow HTTPS boundary for six-digit attendance codes.
//  * op "kiosk": public (publishable key only). Computes the HMAC verifier and calls the
//    service_role-only transition RPC. The raw code never reaches PostgREST or the database.
//  * op "issue": authenticated admin only (user-scoped client + is_admin). Generates a random code,
//    stores only its verifier through the admin RPC, and returns the plaintext exactly once.
// ATTENDANCE_CODE_HMAC_SECRET is a function secret (>= 32 chars). It is never stored in the DB.
const url = Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const boundedFetch = fetchWithTimeout(DB_REQUEST_TIMEOUT_MS);
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

const service = createClient(url, serviceKey, { ...clientOptions, global: { fetch: boundedFetch } });

const handler = createAttendanceCodeHandler({
  env: (name) => {
    if (name === 'ATTENDANCE_CODE_HMAC_SECRET') return Deno.env.get('ATTENDANCE_CODE_HMAC_SECRET');
    if (name === 'SUPABASE_SERVICE_ROLE_KEY') return serviceKey;
    return undefined;
  },
  serviceRpc: async (fn, args) => {
    const { data, error } = await service.rpc(fn, args);
    return { data, error: error ? { code: error.code } : null };
  },
  userClient: (jwt) => {
    const user = createClient(url, anonKey, {
      ...clientOptions,
      global: { fetch: boundedFetch, headers: { Authorization: 'Bearer ' + jwt } },
    });
    return {
      rpc: async (fn, args) => {
        const { data, error } = await user.rpc(fn, args);
        return { data, error: error ? { code: error.code } : null };
      },
    };
  },
  // Only fixed, non-sensitive labels and error codes are ever logged.
  log: (...args) => console.error(...args),
});

Deno.serve(handler);
