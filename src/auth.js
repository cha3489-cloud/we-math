import { supabase, phoneToEmail, padPin } from './portal/client.js';
export async function signIn(phone, pin) { const { data, error } = await supabase.auth.signInWithPassword({ email: phoneToEmail(phone), password: padPin(pin) }); if (error) throw error; return data; }
export async function signOut() { const { error } = await supabase.auth.signOut(); if (error) throw error; }
export function onAuthChange(callback) { return supabase.auth.onAuthStateChange((_event, session) => callback(session?.user ?? null)); }
export async function getUser() { const { data, error } = await supabase.auth.getUser(); if (error) throw error; return data.user; }
export async function getProfile(userId) { const { data, error } = await supabase.from('profiles').select('name, phone').eq('id', userId).single(); if (error) throw error; return data; }
