import { createClient } from 'npm:@supabase/supabase-js@2';
import { isAllowedOrigin, productionOrigin } from '../_shared/origin.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const json = (body: unknown, status: number, origin: string) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'vary': 'Origin' } });
const pin = (value: unknown) => { const clean = String(value ?? ''); if (!/^\d{6}$/.test(clean)) throw new Error('invalid PIN'); return clean; };

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') ?? productionOrigin;
  if (!isAllowedOrigin(origin)) return new Response(JSON.stringify({ error: 'origin denied' }), { status: 403, headers: { 'content-type': 'application/json', 'vary': 'Origin' } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, apikey, content-type', 'access-control-allow-methods': 'POST', 'vary': 'Origin' } });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401, origin);
  const callerClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !user) return json({ error: 'unauthorized' }, 401, origin);
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: profile, error: profileError } = await service.from('profiles').select('suspended_at,must_change_pin,pin_generation').eq('id', user.id).single();
    if (profileError || !profile || profile.suspended_at) return json({ error: 'forbidden' }, 403, origin);
    if (!profile.must_change_pin) return json({ error: 'PIN change is not required' }, 409, origin);
    const body = await request.json(); const cleanPin = pin(body.pin);
    const { error: authError } = await service.auth.admin.updateUserById(user.id, { password: 'wm' + cleanPin + 'sq' });
    if (authError) throw authError;
    const { data: updated, error: updateError } = await service.from('profiles').update({ must_change_pin: false }).eq('id', user.id).eq('pin_generation', profile.pin_generation).eq('must_change_pin', true).select('id').maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return json({ error: 'PIN reset changed; sign in with the latest PIN' }, 409, origin);
    return json({ ok: true }, 200, origin);
  } catch (error) {
    console.error(error); return json({ error: error instanceof Error ? error.message : 'request failed' }, 400, origin);
  }
});
