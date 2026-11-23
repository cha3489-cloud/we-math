import { createClient } from 'npm:@supabase/supabase-js@2';
import { isAllowedOrigin, productionOrigin } from '../_shared/origin.ts';
import { dispatchClaims, dispatchResponse, selectProvider, type Claim } from './domain.ts';

// Runs the parent-message outbox. Callable by an authenticated admin (manual "발송 처리")
// or by a scheduler presenting the service role key. Provider defaults to dry-run.
const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const json = (body: unknown, status: number, origin: string) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'vary': 'Origin' },
});

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') ?? productionOrigin;
  if (!isAllowedOrigin(origin)) return new Response(JSON.stringify({ error: 'origin denied' }), { status: 403, headers: { 'content-type': 'application/json', 'vary': 'Origin' } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, apikey, content-type', 'access-control-allow-methods': 'POST', 'vary': 'Origin' } });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);

  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!token) return json({ error: 'unauthorized' }, 401, origin);
  if (token !== serviceKey) {
    const userClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: 'Bearer ' + token } } });
    const { data: isAdmin, error } = await userClient.rpc('is_admin');
    if (error || isAdmin !== true) return json({ error: 'forbidden' }, 403, origin);
  }

  let provider;
  try {
    provider = selectProvider({ PARENT_MESSAGE_PROVIDER: Deno.env.get('PARENT_MESSAGE_PROVIDER') });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'provider unavailable' }, 503, origin);
  }

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: claims, error: claimError } = await service.rpc('service_claim_parent_messages', { p_provider: provider.name, p_limit: 20 });
  if (claimError) return json({ error: 'claim failed' }, 500, origin);

  const summary = await dispatchClaims((claims ?? []) as Claim[], provider, async (result) => {
    const { error } = await service.rpc('service_record_delivery_result', {
      p_message_id: result.message_id,
      p_attempt_no: result.attempt_no,
      p_claim_nonce: result.claim_nonce,
      p_outcome: result.outcome,
      p_result_code: result.result_code,
      p_provider_request_id: result.provider_request_id,
      p_dry_run: result.dry_run,
    });
    // dispatchClaims logs a fixed line; never log the error text, ids, or the nonce here.
    if (error) throw new Error('record failed');
  });
  const response = dispatchResponse(summary);
  return json(response.body, response.status, origin);
});
