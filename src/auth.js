import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

const DOMAIN = '@wemath.kr';
const PIN_PREFIX = 'wm';
const PIN_SUFFIX = 'sq';

function phoneToEmail(phone) {
  return phone.replace(/[^0-9]/g, '') + DOMAIN;
}

// 4자리 PIN → Supabase 최소 길이(6) 우회를 위해 내부적으로 패딩
function padPin(pin) {
  return PIN_PREFIX + pin + PIN_SUFFIX;
}

export async function signUp(phone, pin, name) {
  const email = phoneToEmail(phone);
  const { data, error } = await supabase.auth.signUp({
    email,
    password: padPin(pin),
    options: { data: { name } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(phone, pin) {
  const email = phoneToEmail(phone);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: padPin(pin) });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
}

export async function getUser() {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('name, phone')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateProfileName(userId, name) {
  const { error } = await supabase.from('profiles').update({ name }).eq('id', userId);
  if (error) throw error;
}

export async function deleteAccount() {
  const { error } = await supabase.rpc('delete_own_account');
  if (error) throw error;
  await supabase.auth.signOut();
}
