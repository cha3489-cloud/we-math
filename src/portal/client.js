import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://tcpitbsrfouwmfkkdqhg.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_-i657_vcEQefJ-SO6eIVPQ_fZLXYwdb';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export function isMissingFeedbackSourceColumn(error) {
  return error?.code === '42703' && String(error?.message || '').includes('auto_composed');
}
export function isMissingExplicitFeedbackRpc(error) {
  const message = String(error?.message || '') + ' ' + String(error?.details || '');
  return error?.code === 'PGRST202'
    && message.includes('review_submission_v2')
    && message.includes('p_auto_composed');
}
export async function invokeAuthenticated(name, body) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.access_token) throw new Error('다시 로그인하세요.');
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('서버 응답을 확인할 수 없습니다.'); }
  if (!response.ok || data?.error) throw new Error(data?.error || `요청에 실패했습니다 (${response.status}).`);
  return data;
}
export const phoneToEmail = (phone) => phone.replace(/[^0-9]/g, '') + '@wemath.kr';
export const padPin = (pin) => 'wm' + pin + 'sq';
