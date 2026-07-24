import { createClient } from 'npm:@supabase/supabase-js@2';
import { isAllowedOrigin, productionOrigin } from '../_shared/origin.ts';
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
  const [{ data: role, error: roleError }, { data: profile, error: profileError }] = await Promise.all([
    service.from('user_roles').select('role').eq('user_id', caller.id).single(),
    service.from('profiles').select('suspended_at,must_change_pin').eq('id', caller.id).single(),
  ]);
  if (roleError || profileError || role?.role !== 'admin' || profile?.suspended_at || profile?.must_change_pin) return json({ error: 'forbidden' }, 403, origin);
  const updateProfile = async (userId: string, values: Record<string, unknown>) => {
    const { data, error } = await service.from('profiles').update(values).eq('id', userId).select('id').single();
    if (error || !data) throw error ?? new Error('profile not updated');
  };
  try {
    const body = await request.json();
    if (body.action === 'create') {
      const cleanPhone = phone(body.phone); const cleanPin = pin(body.pin); const name = String(body.name ?? '').trim();
      if (!name || name.length > 40 || !['student', 'admin'].includes(body.role)) throw new Error('invalid account');
      const { data, error } = await service.auth.admin.createUser({ email: cleanPhone + '@wemath.kr', password: 'wm' + cleanPin + 'sq', email_confirm: true, user_metadata: { name } });
      if (error) throw error;
      const { data: updatedRole, error: roleUpdateError } = await service.from('user_roles').update({ role: body.role }).eq('user_id', data.user.id).select('user_id').single();
      if (roleUpdateError || !updatedRole) { await service.auth.admin.deleteUser(data.user.id); throw roleUpdateError ?? new Error('role not updated'); }
      return json({ id: data.user.id }, 201, origin);
    }
    const userId = String(body.userId ?? ''); if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('invalid user');
    if (body.action === 'reset') {
      const cleanPin = pin(body.pin);
      const { error } = await service.auth.admin.updateUserById(userId, { password: 'wm' + cleanPin + 'sq' }); if (error) throw error;
      const { error: resetStateError } = await service.rpc('mark_pin_reset', { p_user_id: userId });
      if (resetStateError) { await service.auth.admin.updateUserById(userId, { ban_duration: '876000h' }); throw resetStateError; }
    }
    else if (body.action === 'suspend') { if (userId === caller.id) throw new Error('cannot suspend self'); await updateProfile(userId, { suspended_at: new Date().toISOString() }); const { error } = await service.auth.admin.updateUserById(userId, { ban_duration: '876000h' }); if (error) throw error; }
    else if (body.action === 'reactivate') { const { error } = await service.auth.admin.updateUserById(userId, { ban_duration: 'none' }); if (error) throw error; await updateProfile(userId, { suspended_at: null }); }
    else return json({ error: 'unknown action' }, 400, origin);
    return json({ ok: true }, 200, origin);
  } catch (error) { console.error(error); return json({ error: error instanceof Error ? error.message : 'request failed' }, 400, origin); }
});
