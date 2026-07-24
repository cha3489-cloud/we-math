import { createClient } from 'npm:@supabase/supabase-js@2';
import { isAllowedOrigin, productionOrigin } from './origin.ts';
const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const json = (body: unknown, status = 200, origin = productionOrigin) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'vary': 'Origin' } });
const phone = (value: unknown) => { const clean = String(value ?? '').replace(/[^0-9]/g, ''); if (!/^01[016789][0-9]{7,8}$/.test(clean)) throw new Error('invalid phone'); return clean; };
const pin = (value: unknown) => { const clean = String(value ?? ''); if (!/^\d{6}$/.test(clean)) throw new Error('invalid PIN'); return clean; };
Deno.serve(async (request) => {
  const origin = request.headers.get('origin') ?? productionOrigin;
  if (!isAllowedOrigin(origin)) return new Response(JSON.stringify({ error: 'origin denied' }), { status: 403, headers: { 'content-type': 'application/json', 'vary': 'Origin' } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, apikey, content-type', 'access-control-allow-methods': 'POST', 'vary': 'Origin' } });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401, origin);
  const callerClient = createClient(url, anonKey);
  const { data: { user: caller } } = await callerClient.auth.getUser(token);
  if (!caller) return json({ error: 'unauthorized' }, 401, origin);
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: role } = await service.from('user_roles').select('role').eq('user_id', caller.id).single();
  if (role?.role !== 'admin') return json({ error: 'forbidden' }, 403, origin);
  try {
    const body = await request.json();
    if (body.action === 'create') {
      const cleanPhone = phone(body.phone); const cleanPin = pin(body.pin); const name = String(body.name ?? '').trim();
      if (!name || name.length > 40 || !['student', 'admin'].includes(body.role)) throw new Error('invalid account');
      const { data, error } = await service.auth.admin.createUser({ email: cleanPhone + '@wemath.kr', password: 'wm' + cleanPin + 'sq', email_confirm: true, user_metadata: { name } });
      if (error) throw error;
      const { error: roleError } = await service.from('user_roles').update({ role: body.role }).eq('user_id', data.user.id);
      if (roleError) { await service.auth.admin.deleteUser(data.user.id); throw roleError; }
      return json({ id: data.user.id }, 201, origin);
    }
    const userId = String(body.userId ?? ''); if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('invalid user');
    if (body.action === 'reset') { const { error } = await service.auth.admin.updateUserById(userId, { password: 'wm' + pin(body.pin) + 'sq' }); if (error) throw error; await service.from('profiles').update({ must_change_pin: true }).eq('id', userId).throwOnError(); }
    else if (body.action === 'suspend') { if (userId === caller.id) throw new Error('cannot suspend self'); const { error } = await service.auth.admin.updateUserById(userId, { ban_duration: '876000h' }); if (error) throw error; await service.from('profiles').update({ suspended_at: new Date().toISOString() }).eq('id', userId).throwOnError(); }
    else if (body.action === 'reactivate') { const { error } = await service.auth.admin.updateUserById(userId, { ban_duration: 'none' }); if (error) throw error; await service.from('profiles').update({ suspended_at: null }).eq('id', userId).throwOnError(); }
    else return json({ error: 'unknown action' }, 400, origin);
    return json({ ok: true }, 200, origin);
  } catch (error) { console.error(error); return json({ error: error instanceof Error ? error.message : 'request failed' }, 400, origin); }
});
